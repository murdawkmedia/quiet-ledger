import express,{type Request,type Response} from 'express';
import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {generateRegistrationOptions,generateAuthenticationOptions,verifyRegistrationResponse,verifyAuthenticationResponse,type RegistrationResponseJSON,type AuthenticationResponseJSON} from '@simplewebauthn/server';
import {decodeAttestationObject} from '@simplewebauthn/server/helpers';
import {getEventHash,verifyEvent,type Event} from 'nostr-tools/pure';
import {z} from 'zod';
import {Store,DomainError} from './store.js';

type Action='register'|'login'|'link';
type Account={id:string;workspaceId:string;createdAt:string;displayName?:string};
type Session={accountId?:string;workspace:string;csrf:string};
type Credential={id:string;accountId:string;type:'nostr'|'passkey';createdAt:string;nostrPubkey?:string;passkey?:{id:string;publicKey:string;counter:number;userHandle:string;transports?:string[];deviceType:string;backedUp:boolean}};
type Challenge={id:string;type:'nostr'|'passkey';action:Action;nonce:string;createdAt:number;expiresAt:number;binding:string;accountId?:string;pubkey?:string;displayName?:string;userHandle?:string};
export interface AccountAuthOptions {
  store:Store;publicOrigin:string;now?:()=>Date;
  onAuthenticated(req:Request,res:Response,account:{id:string;workspaceId:string}):void;
  getSession(req:Request,res:Response):Session|undefined;
  /** The caller may resolve a validated platform client address after its authenticated proxy gate. */
  getClientIp?(req:Request,res:Response):string;
}
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const same=(a:string,b:string)=>timingSafeEqual(Buffer.from(sha(a),'hex'),Buffer.from(sha(b),'hex'));
const authFailure=()=>new DomainError(401,'The sign-in proof was not accepted. Start a fresh sign-in attempt.');
const inputFailure=()=>new DomainError(400,'Invalid account request. Use the documented sign-in fields.');
const action=z.enum(['register','login','link']);
const alias=z.string().trim().min(1).max(80).optional();
const hex64=z.string().regex(/^[a-f0-9]{64}$/);
const uuid=z.string().uuid();
const nonce=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const nostrInput=z.object({action,pubkey:hex64,displayName:alias}).strict();
const nostrPayload=z.object({challengeId:uuid,nonce,action,pubkey:hex64,displayName:alias}).strict();
const passkeyInput=z.object({action,displayName:alias}).strict();
const passkeyPayload=z.object({challengeId:uuid,response:z.record(z.string(),z.unknown())}).strict();
const eventSchema=z.object({id:hex64,pubkey:hex64,created_at:z.number().int().nonnegative().safe(),kind:z.literal(27235),tags:z.array(z.array(z.string().max(2048)).length(2)).min(3).max(8),content:z.literal(''),sig:z.string().regex(/^[a-f0-9]{128}$/)}).strict();
const parse=<T>(schema:z.ZodType<T>,value:unknown):T=>{const result=schema.safeParse(value);if(!result.success)throw inputFailure();return result.data;};
function canonicalOrigin(value:string){
  const url=new URL(value);const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.origin!==value||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!(url.protocol==='https:'||(loopback&&url.protocol==='http:')))throw new Error('Account public origin must be an HTTPS origin.');
  return url;
}
function authCookie(req:Request){const value=req.headers.cookie?.split(';').map(part=>part.trim()).find(part=>part.startsWith('ql_auth='))?.slice(8);return value&&/^[A-Za-z0-9_-]{43}$/.test(value)?value:undefined;}
function credentialId(value:unknown):string{if(typeof value!=='string'||value.length<1||value.length>1400||!/^[A-Za-z0-9_-]+$/.test(value)||Buffer.from(value,'base64url').toString('base64url')!==value)throw authFailure();return value;}

/** Passwordless hosted-account endpoints. Does not contact a relay, identity provider or wallet. */
export function createAccountAuth(options:AccountAuthOptions){
  const {store}=options,publicUrl=canonicalOrigin(options.publicOrigin),now=options.now??(()=>new Date()),router=express.Router();
  const verifyUrl=publicUrl.origin+'/api/auth/nostr/verify',rpID=publicUrl.hostname;
  const cookieOptions={httpOnly:true,secure:publicUrl.protocol==='https:',sameSite:'strict' as const,path:'/api/auth',maxAge:120000};
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS auth_settings(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_accounts(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_credentials(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES auth_accounts(id),type TEXT NOT NULL,lookup_hash TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS auth_credential_account ON auth_credentials(account_id);
    CREATE TABLE IF NOT EXISTS auth_challenges(id TEXT PRIMARY KEY,binding_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS auth_challenge_expiry ON auth_challenges(expires_at);
  `);
  const lookupKey=store.transaction(()=>{
    const row=store.db.prepare('SELECT data FROM auth_settings WHERE id=?').get('lookup-key');
    if(row)return Buffer.from(store.decode<{key:string}>(row.data,'auth_settings','lookup-key').key,'base64url');
    const key=randomBytes(32);store.db.prepare('INSERT INTO auth_settings(id,data) VALUES(?,?)').run('lookup-key',store.encode({key:key.toString('base64url')},'auth_settings','lookup-key'));return key;
  });
  if(lookupKey.length!==32)throw new Error('Account authentication storage is invalid.');
  const lookup=(type:string,id:string)=>createHmac('sha256',lookupKey).update(type+'\0'+id).digest('hex');
  const limits=new Map<string,{start:number;count:number}>();
  router.use('/api/auth',(req,res,next)=>{
    res.set('Cache-Control','no-store');
    if(req.method==='POST'){
      if(req.get('origin')&&req.get('origin')!==publicUrl.origin)return next(new DomainError(403,'Cross-origin account requests are not permitted.'));
      if(req.get('sec-fetch-site')==='cross-site')return next(new DomainError(403,'Cross-site account requests are not permitted.'));
      if(!req.is('application/json'))return next(inputFailure());
      const client=options.getClientIp?.(req,res)??req.ip??'unknown';if(typeof client!=='string'||!client||client.length>128||/[\u0000-\u0020\u007f]/.test(client))return next(new DomainError(403,'The account client identity is invalid.'));const time=now().getTime();let limit=limits.get(client);
      if(!limit||time-limit.start>=900000){limit={start:time,count:0};if(limits.size>=2000){for(const [key,value] of limits)if(time-value.start>=900000)limits.delete(key);if(limits.size>=2000)return next(new DomainError(429,'Account sign-in is busy. Try again later.'));}limits.set(client,limit);}
      if(++limit.count>100)return next(new DomainError(429,'Too many account sign-in attempts. Try again later.'));
    }
    next();
  });
  function current(req:Request,res:Response,csrf=false):Session&{accountId:string}{
    const session=options.getSession(req,res);if(!session?.accountId)throw new DomainError(401,'Sign in to manage account credentials.');
    const account=readAccount(session.accountId);if(account.workspaceId!==session.workspace)throw authFailure();
    if(csrf&&(!req.get('x-csrf-token')||!same(req.get('x-csrf-token')!,session.csrf)))throw new DomainError(403,'The account security token is missing or invalid.');
    return session as Session&{accountId:string};
  }
  function readAccount(id:string):Account{const row=store.db.prepare('SELECT data FROM auth_accounts WHERE id=?').get(id);if(!row)throw authFailure();return store.decode<Account>(row.data,'auth_accounts',id,id);}
  function readCredential(row:any):Credential|undefined{if(!row)return undefined;return store.decode<Credential>(row.data,'auth_credentials',String(row.id),String(row.account_id));}
  function credentialFor(type:string,id:string){return readCredential(store.db.prepare('SELECT id,account_id,data FROM auth_credentials WHERE lookup_hash=? AND type=?').get(lookup(type,id),type));}
  function profile(accountId:string){
    const account=readAccount(accountId);const rows=store.db.prepare('SELECT id,account_id,data FROM auth_credentials WHERE account_id=? ORDER BY rowid').all(accountId);
    return {account,credentials:rows.map(row=>{const credential=readCredential(row)!;return {id:credential.id,type:credential.type,createdAt:credential.createdAt,label:credential.type==='nostr'?'Nostr signer':'Passkey'};})};
  }
  function addAccount(displayName?:string){
    if(Number(store.db.prepare('SELECT COUNT(*) as n FROM auth_accounts').get()!.n)>=10000)throw new DomainError(503,'New account registration is temporarily unavailable.');
    const id=randomUUID(),account:Account={id,workspaceId:id,createdAt:now().toISOString(),...(displayName?{displayName}:{})};
    store.db.prepare('INSERT INTO auth_accounts(id,workspace_id,data) VALUES(?,?,?)').run(id,id,store.encode(account,'auth_accounts',id,id));return account;
  }
  function addCredential(account:Account,type:Credential['type'],identity:string,data:Partial<Credential>){
    if(Number(store.db.prepare('SELECT COUNT(*) as n FROM auth_credentials WHERE account_id=?').get(account.id)!.n)>=16)throw new DomainError(409,'This account already has the maximum number of sign-in credentials.');
    const id=randomUUID(),credential:Credential={...data,id,accountId:account.id,type,createdAt:now().toISOString()};
    store.db.prepare('INSERT INTO auth_credentials(id,account_id,type,lookup_hash,data) VALUES(?,?,?,?,?)').run(id,account.id,type,lookup(type,identity),store.encode(credential,'auth_credentials',id,account.id));return credential;
  }
  function challengeBase(req:Request,res:Response,type:Challenge['type'],requested:Action,displayName?:string){
    const session=requested==='link'?current(req,res,true):undefined;const time=now().getTime();
    store.db.prepare('DELETE FROM auth_challenges WHERE expires_at<=?').run(time);
    if(Number(store.db.prepare('SELECT COUNT(*) as n FROM auth_challenges').get()!.n)>=2000)throw new DomainError(429,'Account sign-in is busy. Try again later.');
    const secret=randomBytes(32).toString('base64url'),id=randomUUID();res.cookie('ql_auth',secret,cookieOptions);
    return {id,type,action:requested,nonce:randomBytes(32).toString('base64url'),createdAt:time,expiresAt:time+120000,binding:sha(secret),...(session?{accountId:session.accountId}:{}),...(displayName?{displayName}:{})} as Challenge;
  }
  function saveChallenge(challenge:Challenge){store.db.prepare('INSERT INTO auth_challenges(id,binding_hash,expires_at,data) VALUES(?,?,?,?)').run(challenge.id,challenge.binding,challenge.expiresAt,store.encode(challenge,'auth_challenges',challenge.id));}
  function readChallenge(req:Request,res:Response,id:string,type:Challenge['type']):Challenge{
    const row=store.db.prepare('SELECT binding_hash,expires_at,data FROM auth_challenges WHERE id=?').get(id),secret=authCookie(req);
    if(!row||!secret||Number(row.expires_at)<=now().getTime()||!same(String(row.binding_hash),sha(secret)))throw authFailure();
    const challenge=store.decode<Challenge>(row.data,'auth_challenges',id);
    if(challenge.id!==id||challenge.type!==type||challenge.expiresAt<=now().getTime())throw authFailure();
    if(challenge.action==='link'&&current(req,res,true).accountId!==challenge.accountId)throw authFailure();
    return challenge;
  }
  function consume(req:Request,res:Response,challenge:Challenge){readChallenge(req,res,challenge.id,challenge.type);if(store.db.prepare('DELETE FROM auth_challenges WHERE id=?').run(challenge.id).changes!==1)throw authFailure();}
  function complete(req:Request,res:Response,account:Account,requested:Action){
    res.clearCookie('ql_auth',{httpOnly:true,secure:cookieOptions.secure,sameSite:'strict',path:'/api/auth'});
    if(requested==='link')res.json(profile(account.id));else options.onAuthenticated(req,res,account);
  }
  router.get('/api/auth/config',(_req,res)=>res.json({mode:'hosted',methods:['passkey','nostr'],registrationOpen:Number(store.db.prepare('SELECT COUNT(*) as n FROM auth_accounts').get()!.n)<10000,publicOrigin:publicUrl.origin}));
  router.get('/api/auth/account',(req,res)=>res.json(profile(current(req,res).accountId)));
  router.post('/api/auth/nostr/challenge',(req,res)=>{
    const input=parse(nostrInput,req.body);const challenge={...challengeBase(req,res,'nostr',input.action,input.displayName),pubkey:input.pubkey};saveChallenge(challenge);
    const payload={challengeId:challenge.id,nonce:challenge.nonce,action:challenge.action,pubkey:challenge.pubkey,...(challenge.displayName?{displayName:challenge.displayName}:{})};
    res.json({challengeId:challenge.id,nonce:challenge.nonce,action:challenge.action,expiresAt:new Date(challenge.expiresAt).toISOString(),verifyUrl,payload});
  });
  router.post('/api/auth/nostr/verify',(req,res)=>{
    if(req.originalUrl!=='/api/auth/nostr/verify'||req.method!=='POST')throw authFailure();
    let input:z.infer<typeof nostrPayload>;try{input=parse(nostrPayload,req.body);}catch{throw authFailure();}
    const challenge=readChallenge(req,res,input.challengeId,'nostr');
    if(challenge.nonce!==input.nonce||challenge.action!==input.action||challenge.pubkey!==input.pubkey||challenge.displayName!==input.displayName)throw authFailure();
    const raw=res.locals.rawBody,authorization=req.get('authorization');
    if(!Buffer.isBuffer(raw)||raw.length>32768||!authorization||authorization.length>20000||!/^Nostr [A-Za-z0-9+/]+={0,2}$/.test(authorization)||req.rawHeaders.filter((value,index)=>index%2===0&&value.toLowerCase()==='authorization').length!==1)throw authFailure();
    let event:z.infer<typeof eventSchema>;
    try{const encoded=authorization.slice(6),bytes=Buffer.from(encoded,'base64');if(bytes.toString('base64')!==encoded)throw new Error();event=eventSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{throw authFailure();}
    const tags=new Map<string,string>();for(const tag of event.tags){if(tags.has(tag[0]))throw authFailure();tags.set(tag[0],tag[1]);}
    if(event.pubkey!==challenge.pubkey||Math.abs(event.created_at*1000-now().getTime())>60000||tags.get('u')!==verifyUrl||tags.get('method')!=='POST'||tags.get('payload')!==sha(raw))throw authFailure();
    try{if(getEventHash(event as Event)!==event.id||!verifyEvent(event as Event))throw authFailure();}catch{throw authFailure();}
    store.transaction(()=>{
      consume(req,res,challenge);let credential=credentialFor('nostr',event.pubkey),account:Account;
      if(challenge.action==='link'){
        account=readAccount(challenge.accountId!);if(credential&&credential.accountId!==account.id)throw new DomainError(409,'This credential already belongs to another account.');
        if(!credential)addCredential(account,'nostr',event.pubkey,{nostrPubkey:event.pubkey});
      }else if(credential)account=readAccount(credential.accountId);
      else{if(challenge.action==='login')throw authFailure();account=addAccount(challenge.displayName);addCredential(account,'nostr',event.pubkey,{nostrPubkey:event.pubkey});}
      complete(req,res,account,challenge.action);
    });
  });
  router.post('/api/auth/passkey/options',async(req,res)=>{
    const input=parse(passkeyInput,req.body),challenge=challengeBase(req,res,'passkey',input.action,input.displayName);
    if(input.action==='login'){
      const data=await generateAuthenticationOptions({rpID,challenge:challenge.nonce,userVerification:'required',timeout:120000});challenge.nonce=data.challenge;saveChallenge(challenge);return res.json({challengeId:challenge.id,options:data});
    }
    challenge.userHandle=randomBytes(32).toString('base64url');
    const existing=challenge.accountId?store.db.prepare('SELECT id,account_id,data FROM auth_credentials WHERE account_id=? AND type=?').all(challenge.accountId,'passkey').map(row=>readCredential(row)!):[];
    const data=await generateRegistrationOptions({rpName:'Quiet Ledger',rpID,userName:challenge.displayName??'Private workspace',userDisplayName:challenge.displayName??'Private workspace',userID:Buffer.from(challenge.userHandle,'base64url'),challenge:challenge.nonce,attestationType:'none',timeout:120000,supportedAlgorithmIDs:[-7,-257,-8],authenticatorSelection:{residentKey:'required',userVerification:'required'},excludeCredentials:existing.map(value=>({id:value.passkey!.id,transports:value.passkey!.transports}))});
    challenge.nonce=data.challenge;saveChallenge(challenge);res.json({challengeId:challenge.id,options:data});
  });
  router.post('/api/auth/passkey/verify',async(req,res)=>{
    let input:z.infer<typeof passkeyPayload>;try{input=parse(passkeyPayload,req.body);}catch{throw authFailure();}
    const challenge=readChallenge(req,res,input.challengeId,'passkey'),id=credentialId(input.response.id);
    if(challenge.action==='login'){
      const credential=credentialFor('passkey',id);if(!credential?.passkey)throw authFailure();const passkey=credential.passkey;
      if((input.response.response as any)?.userHandle!==passkey.userHandle)throw authFailure();
      let verified:Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
      try{verified=await verifyAuthenticationResponse({response:input.response as unknown as AuthenticationResponseJSON,expectedChallenge:challenge.nonce,expectedOrigin:publicUrl.origin,expectedRPID:rpID,requireUserVerification:true,credential:{id:passkey.id,publicKey:new Uint8Array(Buffer.from(passkey.publicKey,'base64url')),counter:passkey.counter,transports:passkey.transports as any}});if(!verified.verified||!verified.authenticationInfo.userVerified)throw authFailure();}catch{throw authFailure();}
      store.transaction(()=>{
        consume(req,res,challenge);const currentCredential=credentialFor('passkey',id);if(!currentCredential?.passkey||currentCredential.passkey.counter!==passkey.counter)throw authFailure();
        currentCredential.passkey.counter=verified.authenticationInfo.newCounter;currentCredential.passkey.deviceType=verified.authenticationInfo.credentialDeviceType;currentCredential.passkey.backedUp=verified.authenticationInfo.credentialBackedUp;
        store.db.prepare('UPDATE auth_credentials SET data=? WHERE id=?').run(store.encode(currentCredential,'auth_credentials',currentCredential.id,currentCredential.accountId),currentCredential.id);
        complete(req,res,readAccount(currentCredential.accountId),challenge.action);
      });return;
    }
    let verified:Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try{
      // The browser was asked for no device attestation. Do not process arbitrary
      // certificate chains or their network revocation locations during signup.
      const encoded=(input.response.response as any)?.attestationObject;
      if(typeof encoded!=='string'||encoded.length>45000||!/^[A-Za-z0-9_-]+$/.test(encoded)||Buffer.from(encoded,'base64url').toString('base64url')!==encoded)throw authFailure();
      const attestation=decodeAttestationObject(new Uint8Array(Buffer.from(encoded,'base64url')));
      if(attestation.get('fmt')!=='none'||attestation.get('attStmt').size!==0)throw authFailure();
      verified=await verifyRegistrationResponse({response:input.response as unknown as RegistrationResponseJSON,expectedChallenge:challenge.nonce,expectedOrigin:publicUrl.origin,expectedRPID:rpID,requireUserPresence:true,requireUserVerification:true,supportedAlgorithmIDs:[-7,-257,-8]});if(!verified.verified||!verified.registrationInfo.userVerified||verified.registrationInfo.credential.id!==id)throw authFailure();
    }catch{throw authFailure();}
    if(!verified.verified)throw authFailure();const info=verified.registrationInfo;
    store.transaction(()=>{
      consume(req,res,challenge);if(credentialFor('passkey',id))throw new DomainError(409,'This passkey is already registered. Sign in with it instead.');
      const account=challenge.action==='link'?readAccount(challenge.accountId!):addAccount(challenge.displayName);
      addCredential(account,'passkey',id,{passkey:{id,publicKey:Buffer.from(info.credential.publicKey).toString('base64url'),counter:info.credential.counter,userHandle:challenge.userHandle!,transports:info.credential.transports,deviceType:info.credentialDeviceType,backedUp:info.credentialBackedUp}});
      complete(req,res,account,challenge.action);
    });
  });
  return {router,profile};
}
