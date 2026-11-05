import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {createHash,randomBytes,generateKeyPairSync,sign} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isoCBOR} from '@simplewebauthn/server/helpers';
import {verifyRegistrationResponse} from '@simplewebauthn/server';
import {finalizeEvent,getPublicKey} from 'nostr-tools/pure';
import {Store,DomainError,type StoredSession} from '../server/store.js';
import {createAccountAuth} from '../server/account-auth.js';

const origin='https://accounts.example';
const scalar=(n:number)=>{const key=new Uint8Array(32);key[31]=n;return key;};
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest();
const cookie=(response:any,name='ql_auth')=>String(response.headers['set-cookie']?.find((value:string)=>value.startsWith(name+'='))??'').split(';')[0];
function setup(path=':memory:',getClientIp?:(req:express.Request,res:express.Response)=>string){
  let clock=new Date('2026-11-05T00:00:00Z'),failSession=false;const store=new Store(path,{encryptionKey:Buffer.alloc(32,9)});
  const app=express();app.use(express.json({limit:'48kb',verify:(_req,res,buffer)=>{(res as any).locals.rawBody=Buffer.from(buffer);}}));
  app.use((req,res,next)=>{const token=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('ql_session='))?.slice(11);if(token)res.locals.session=store.session(token);next();});
  const auth=createAccountAuth({store,publicOrigin:origin,now:()=>clock,getClientIp,getSession:(_req,res)=>res.locals.session,onAuthenticated:(_req,res,account)=>{
    if(failSession)throw new Error('SYNTHETIC_SESSION_FAILURE');
    const value=randomBytes(32).toString('base64url');const session:StoredSession={role:'owner',accountId:account.id,workspace:account.workspaceId,csrf:randomBytes(24).toString('base64url'),expires:new Date(clock.getTime()+86400000).toISOString()};
    store.saveSession(value,session);res.cookie('ql_session',value,{httpOnly:true,sameSite:'strict'});res.json({authenticated:true,role:'owner',accountId:account.id,workspaceId:account.workspaceId,csrfToken:session.csrf});
  }});app.use(auth.router);app.use((error:any,_req:any,res:any,_next:any)=>res.status(error instanceof DomainError?error.status:500).json({error:error instanceof DomainError?error.message:'Synthetic generic failure'}));
  return {app,store,auth,setClock:(value:Date)=>{clock=value;},now:()=>clock,failSession:()=>{failSession=true;},close:()=>store.close()};
}
async function challenge(f:ReturnType<typeof setup>,key:Uint8Array,action='register',session?:{cookie:string;csrf:string},displayName='Fictional account'){
  let call=request(f.app).post('/api/auth/nostr/challenge').set('Origin',origin);
  if(session)call=call.set('Cookie',session.cookie).set('X-CSRF-Token',session.csrf);
  const result=await call.send({action,pubkey:getPublicKey(key),...(action==='register'?{displayName}:{})});assert.equal(result.status,200);
  return {...result.body,cookie:cookie(result)};
}
function proof(f:ReturnType<typeof setup>,c:any,key:Uint8Array,change:Record<string,unknown>={}){
  const raw=JSON.stringify(c.payload);const event=finalizeEvent({kind:27235,created_at:Math.floor(f.now().getTime()/1000),content:'',tags:[['u',c.verifyUrl],['method','POST'],['payload',hash(raw).toString('hex')]],...change} as any,key);
  return {raw,event,authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64')};
}
async function verify(f:ReturnType<typeof setup>,c:any,key:Uint8Array,session?:{cookie:string;csrf:string},change:Record<string,unknown>={}){
  const p=proof(f,c,key,change);let call=request(f.app).post('/api/auth/nostr/verify').set('Origin',origin).set('Content-Type','application/json').set('Cookie',[c.cookie,session?.cookie].filter(Boolean).join('; ')).set('Authorization',p.authorization);
  if(session)call=call.set('X-CSRF-Token',session.csrf);return call.send(p.raw);
}
async function signup(f:ReturnType<typeof setup>,n:number){const key=scalar(n),c=await challenge(f,key);const response=await verify(f,c,key);assert.equal(response.status,200);return {key,accountId:response.body.accountId,workspaceId:response.body.workspaceId,cookie:cookie(response,'ql_session'),csrf:response.body.csrfToken};}

test('account auth starts empty and exposes only passwordless methods',async()=>{
  const f=setup();try{const config=await request(f.app).get('/api/auth/config');assert.equal(config.status,200);assert.deepEqual(config.body.methods,['passkey','nostr']);assert.equal(config.body.mode,'hosted');assert.equal(f.store.db.prepare('SELECT COUNT(*) as n FROM auth_accounts').get()!.n,0);assert.equal((await request(f.app).get('/api/auth/account')).status,401);}finally{f.close();}
});
test('Nostr signup and repeat login verify actual signatures, retain one account and never expose private key material',async()=>{
  const f=setup();try{const a=await signup(f,1);const login=await verify(f,await challenge(f,a.key,'login'),a.key);assert.equal(login.status,200);assert.equal(login.body.accountId,a.accountId);assert.equal(login.body.workspaceId,a.workspaceId);assert.equal(f.store.db.prepare('SELECT COUNT(*) as n FROM auth_accounts').get()!.n,1);
    const account=await request(f.app).get('/api/auth/account').set('Cookie',a.cookie);assert.equal(account.status,200);assert.equal(account.body.account.id,a.accountId);assert.equal(account.body.credentials[0].type,'nostr');assert.ok(!JSON.stringify(account.body).includes(getPublicKey(a.key)));assert.ok(!JSON.stringify(account.body).includes(Buffer.from(a.key).toString('hex')));
    const duplicate=await verify(f,await challenge(f,a.key),a.key);assert.equal(duplicate.status,200);assert.equal(duplicate.body.accountId,a.accountId);
  }finally{f.close();}
});
test('Nostr replay and concurrent challenge consumption cannot create multiple sessions/accounts',async()=>{
  const f=setup();try{const key=scalar(2),c=await challenge(f,key);const results=await Promise.all([verify(f,c,key),verify(f,c,key)]);assert.deepEqual(results.map(x=>x.status).sort(),[200,401]);assert.equal(f.store.db.prepare('SELECT COUNT(*) as n FROM auth_accounts').get()!.n,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) as n FROM sessions').get()!.n,1);assert.equal((await verify(f,c,key)).status,401);}finally{f.close();}
});
test('Nostr proof is bound to the browser cookie, body, challenge, key and exact HTTP request',async(t)=>{
  for(const kind of ['cookie','body','nonce','key','method','url','timestamp','kind','content','duplicateTag','signature'] as const)await t.test(kind,async()=>{
    const f=setup();try{const key=scalar(3),c=await challenge(f,key);const changes:Record<string,unknown>={};let raw:string|undefined;
      if(kind==='cookie')c.cookie='ql_auth='+randomBytes(32).toString('base64url');
      if(kind==='nonce')c.payload.nonce=randomBytes(32).toString('base64url');
      if(kind==='method')changes.tags=[['u',c.verifyUrl],['method','GET'],['payload',hash(JSON.stringify(c.payload)).toString('hex')]];
      if(kind==='url')changes.tags=[['u','https://evil.example/api/auth/nostr/verify'],['method','POST'],['payload',hash(JSON.stringify(c.payload)).toString('hex')]];
      if(kind==='timestamp')changes.created_at=Math.floor(f.now().getTime()/1000)-61;
      if(kind==='kind')changes.kind=1;if(kind==='content')changes.content='not empty';
      if(kind==='duplicateTag')changes.tags=[['u',c.verifyUrl],['u',c.verifyUrl],['method','POST'],['payload',hash(JSON.stringify(c.payload)).toString('hex')]];
      const p=proof(f,c,kind==='key'?scalar(4):key,changes);if(kind==='body')raw=p.raw+' ';if(kind==='signature'){p.event.sig='0'.repeat(128);p.authorization='Nostr '+Buffer.from(JSON.stringify(p.event)).toString('base64');}
      const result=await request(f.app).post('/api/auth/nostr/verify').set('Origin',origin).set('Content-Type','application/json').set('Cookie',c.cookie).set('Authorization',p.authorization).send(raw??p.raw);assert.equal(result.status,401);assert.equal(f.store.db.prepare('SELECT COUNT(*) as n FROM auth_accounts').get()!.n,0);
    }finally{f.close();}
  });
});
test('expired challenges, cross-site options and private key shaped input fail closed',async()=>{
  const f=setup();try{const key=scalar(5),c=await challenge(f,key);f.setClock(new Date(f.now().getTime()+121000));assert.equal((await verify(f,c,key)).status,401);
    assert.equal((await request(f.app).post('/api/auth/nostr/challenge').set('Origin','https://evil.example').send({action:'register',pubkey:getPublicKey(key)})).status,403);
    assert.equal((await request(f.app).post('/api/auth/nostr/challenge').set('Sec-Fetch-Site','cross-site').send({action:'register',pubkey:getPublicKey(key)})).status,403);
    const rejected=await request(f.app).post('/api/auth/nostr/challenge').send({action:'register',pubkey:getPublicKey(key),privateKey:'SYNTHETIC_SECRET'});assert.equal(rejected.status,400);assert.ok(!JSON.stringify(rejected.body).includes('SYNTHETIC_SECRET'));
  }finally{f.close();}
});
test('linking requires current account and CSRF, proves the new key, and cannot steal another account credential',async()=>{
  const f=setup();try{const a=await signup(f,6),b=await signup(f,7),linked=scalar(8);
    assert.equal((await request(f.app).post('/api/auth/nostr/challenge').send({action:'link',pubkey:getPublicKey(linked)})).status,401);
    assert.equal((await request(f.app).post('/api/auth/nostr/challenge').set('Cookie',a.cookie).send({action:'link',pubkey:getPublicKey(linked)})).status,403);
    const linkedResult=await verify(f,await challenge(f,linked,'link',a),linked,a);assert.equal(linkedResult.status,200);assert.equal(linkedResult.body.account.id,a.accountId);assert.equal(linkedResult.body.credentials.length,2);
    assert.equal((await verify(f,await challenge(f,linked,'login'),linked)).body.accountId,a.accountId);
    const theft=await verify(f,await challenge(f,b.key,'link',a),b.key,a);assert.equal(theft.status,409);
    const switched=await challenge(f,scalar(9),'link',a);assert.equal((await verify(f,switched,scalar(9),b)).status,401);
  }finally{f.close();}
});

function authenticator(){
  const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=pair.publicKey.export({format:'jwk'});const id=randomBytes(32).toString('base64url');let userHandle='';let counter=0;
  function registration(options:any,verified=true,format:'none'|'packed'='none'){userHandle=options.user.id;const cose=new Map<any,any>([[1,2],[3,-7],[-1,1],[-2,new Uint8Array(Buffer.from(jwk.x!,'base64url'))],[-3,new Uint8Array(Buffer.from(jwk.y!,'base64url'))]]);const idBytes=Buffer.from(id,'base64url'),length=Buffer.alloc(2);length.writeUInt16BE(idBytes.length);const authData=Buffer.concat([hash(options.rp.id),Buffer.from([verified?0x45:0x41]),Buffer.alloc(4),Buffer.alloc(16),length,idBytes,Buffer.from(isoCBOR.encode(cose))]);const client=Buffer.from(JSON.stringify({type:'webauthn.create',challenge:options.challenge,origin,crossOrigin:false}));const attStmt=format==='none'?new Map():new Map<any,any>([['alg',-7],['sig',new Uint8Array(sign('sha256',Buffer.concat([authData,hash(client)]),pair.privateKey))]]);const attestation=isoCBOR.encode(new Map<any,any>([['fmt',format],['attStmt',attStmt],['authData',new Uint8Array(authData)]]));
    return {id,rawId:id,type:'public-key',response:{clientDataJSON:client.toString('base64url'),attestationObject:Buffer.from(attestation).toString('base64url'),transports:['internal']},clientExtensionResults:{},authenticatorAttachment:'platform'};
  }
  function authentication(options:any,extra:{origin?:string;verified?:boolean;userHandle?:string}={}){counter++;const count=Buffer.alloc(4);count.writeUInt32BE(counter);const authData=Buffer.concat([hash(options.rpId),Buffer.from([extra.verified===false?1:5]),count]);const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:options.challenge,origin:extra.origin??origin,crossOrigin:false}));const signature=sign('sha256',Buffer.concat([authData,hash(client)]),pair.privateKey);return {id,rawId:id,type:'public-key',response:{clientDataJSON:client.toString('base64url'),authenticatorData:authData.toString('base64url'),signature:signature.toString('base64url'),userHandle:extra.userHandle??userHandle},clientExtensionResults:{},authenticatorAttachment:'platform'};}
  return {id,registration,authentication};
}
async function passkeyOptions(f:ReturnType<typeof setup>,action='register',session?:{cookie:string;csrf:string}){
  let call=request(f.app).post('/api/auth/passkey/options').set('Origin',origin);if(session)call=call.set('Cookie',session.cookie).set('X-CSRF-Token',session.csrf);const response=await call.send({action,...(action==='register'?{displayName:'Fictional passkey account'}:{})});assert.equal(response.status,200);return {...response.body,cookie:cookie(response)};
}
async function passkeyVerify(f:ReturnType<typeof setup>,options:any,response:any,session?:{cookie:string;csrf:string}){let call=request(f.app).post('/api/auth/passkey/verify').set('Origin',origin).set('Cookie',[options.cookie,session?.cookie].filter(Boolean).join('; '));if(session)call=call.set('X-CSRF-Token',session.csrf);return call.send({challengeId:options.challengeId,response});}
test('passkey registration and login use actual WebAuthn attestation/assertion verification with required user verification',async()=>{
  const f=setup();try{const device=authenticator(),options=await passkeyOptions(f);assert.equal(options.options.attestation,'none');assert.equal(options.options.authenticatorSelection.userVerification,'required');assert.equal(options.options.authenticatorSelection.residentKey,'required');const response=device.registration(options.options);await verifyRegistrationResponse({response:response as any,expectedChallenge:options.options.challenge,expectedOrigin:origin,expectedRPID:'accounts.example',requireUserVerification:true,supportedAlgorithmIDs:[-7,-257,-8]});const registration=await passkeyVerify(f,options,response);assert.equal(registration.status,200);const accountId=registration.body.accountId;
    const loginOptions=await passkeyOptions(f,'login');assert.equal(loginOptions.options.userVerification,'required');const login=await passkeyVerify(f,loginOptions,device.authentication(loginOptions.options));assert.equal(login.status,200);assert.equal(login.body.accountId,accountId);
    const invalid=await passkeyOptions(f,'login');assert.equal((await passkeyVerify(f,invalid,device.authentication(invalid.options,{verified:false}))).status,401);
    const offsite=await passkeyOptions(f,'login');assert.equal((await passkeyVerify(f,offsite,device.authentication(offsite.options,{origin:'https://evil.example'}))).status,401);
    const wrongHandle=await passkeyOptions(f,'login');assert.equal((await passkeyVerify(f,wrongHandle,device.authentication(wrongHandle.options,{userHandle:randomBytes(32).toString('base64url')}))).status,401);
  }finally{f.close();}
});
test('passkeys bind registration to its browser/challenge and link only to the authenticated account',async()=>{
  const f=setup();try{const a=await signup(f,10),device=authenticator(),options=await passkeyOptions(f,'link',a);const registered=await passkeyVerify(f,options,device.registration(options.options),a);assert.equal(registered.status,200);assert.equal(registered.body.account.id,a.accountId);assert.deepEqual(registered.body.credentials.map((x:any)=>x.type).sort(),['nostr','passkey']);
    const login=await passkeyOptions(f,'login');assert.equal((await passkeyVerify(f,login,device.authentication(login.options))).body.accountId,a.accountId);
    assert.equal((await passkeyVerify(f,options,device.registration(options.options),a)).status,401);
    const wrong=await passkeyOptions(f);wrong.cookie='ql_auth='+randomBytes(32).toString('base64url');assert.equal((await passkeyVerify(f,wrong,authenticator().registration(wrong.options))).status,401);
  }finally{f.close();}
});
test('auth records remain encrypted on disk and accounts/credentials survive a restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'account-auth-')),path=join(dir,'synthetic.sqlite');let f=setup(path);
  try{const a=await signup(f,11);for(const file of [path,path+'-wal'])if(existsSync(file)){const bytes=readFileSync(file);assert.ok(!bytes.includes(Buffer.from('Fictional account')));assert.ok(!bytes.includes(Buffer.from(getPublicKey(a.key))));}f.close();f=setup(path);const login=await verify(f,await challenge(f,a.key,'login'),a.key);assert.equal(login.status,200);assert.equal(login.body.accountId,a.accountId);
  }finally{f.close();rmSync(dir,{recursive:true,force:true});}
});

test('new passkeys require verification and duplicate registration never authenticates or merges an existing account',async()=>{
  const f=setup();try{
    const invalid=await passkeyOptions(f);assert.equal((await passkeyVerify(f,invalid,authenticator().registration(invalid.options,false))).status,401);assert.equal(f.store.db.prepare('SELECT COUNT(*) as n FROM auth_accounts').get()!.n,0);
    const device=authenticator(),first=await passkeyOptions(f);assert.equal((await passkeyVerify(f,first,device.registration(first.options))).status,200);
    const duplicate=await passkeyOptions(f);const result=await passkeyVerify(f,duplicate,device.registration(duplicate.options));assert.equal(result.status,409);assert.equal(cookie(result,'ql_session'),'');assert.equal(f.store.db.prepare('SELECT COUNT(*) as n FROM auth_accounts').get()!.n,1);
  }finally{f.close();}
});
test('session failure rolls back account creation and challenge consumption atomically',async()=>{
  const f=setup();try{const key=scalar(12),c=await challenge(f,key);f.failSession();const result=await verify(f,c,key);assert.equal(result.status,500);assert.ok(!JSON.stringify(result.body).includes('SYNTHETIC_SESSION_FAILURE'));assert.equal(f.store.db.prepare('SELECT COUNT(*) as n FROM auth_accounts').get()!.n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) as n FROM auth_credentials').get()!.n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) as n FROM auth_challenges').get()!.n,1);}finally{f.close();}
});
test('auth options are rate-limited and challenge payloads have bounded field sizes',async()=>{
  const f=setup();try{const body={action:'register',pubkey:getPublicKey(scalar(13))};for(let i=0;i<100;i++)assert.equal((await request(f.app).post('/api/auth/nostr/challenge').send(body)).status,200);assert.equal((await request(f.app).post('/api/auth/nostr/challenge').send(body)).status,429);f.setClock(new Date(f.now().getTime()+900001));assert.equal((await request(f.app).post('/api/auth/nostr/challenge').send({...body,displayName:'x'.repeat(81)})).status,400);}finally{f.close();}
});
test('bad public-origin configuration fails without echoing invalid secret-shaped input',()=>{
  const f=setup();try{for(const publicOrigin of ['SYNTHETIC_SECRET_INVALID_URL','https://user:SYNTHETIC_SECRET@accounts.example','http://accounts.example','https://accounts.example/path'])assert.throws(()=>createAccountAuth({store:f.store,publicOrigin,onAuthenticated:()=>{},getSession:()=>undefined}),error=>error instanceof Error&&!error.message.includes('SYNTHETIC_SECRET'));}finally{f.close();}
});
test('Nostr authentication rejects duplicate Authorization headers rather than accepting a normalized first value',async()=>{
  const f=setup();try{const key=scalar(14),c=await challenge(f,key),p=proof(f,c,key);const result=await request(f.app).post('/api/auth/nostr/verify').set('Origin',origin).set('Content-Type','application/json').set('Cookie',c.cookie).set('Authorization',[p.authorization,p.authorization] as any).send(p.raw);assert.equal(result.status,401);assert.equal(f.store.db.prepare('SELECT COUNT(*) as n FROM auth_accounts').get()!.n,0);}finally{f.close();}
});
test('Nostr sign-in tolerates device clock skew inside its declared sixty-second window',async()=>{
  const f=setup();try{const key=scalar(15),c=await challenge(f,key);assert.equal((await verify(f,c,key,undefined,{created_at:Math.floor(f.now().getTime()/1000)-30})).status,200);}finally{f.close();}
});
test('Nostr signed URL binding rejects query, slash and case aliases of the verify endpoint',async(t)=>{
  for(const path of ['/api/auth/nostr/verify?ignored=1','/api/auth/nostr/verify/','/api/auth/NOSTR/verify'])await t.test(path,async()=>{const f=setup();try{const key=scalar(16),c=await challenge(f,key),p=proof(f,c,key);const result=await request(f.app).post(path).set('Origin',origin).set('Content-Type','application/json').set('Cookie',c.cookie).set('Authorization',p.authorization).send(p.raw);assert.equal(result.status,401);assert.equal(f.store.db.prepare('SELECT COUNT(*) as n FROM auth_accounts').get()!.n,0);}finally{f.close();}});
});
test('auth rate budgets use only an explicit trusted client resolver, never raw proxy-looking client headers',async()=>{
  const f=setup(':memory:',req=>req.get('x-synthetic-trusted-client')??'first');
  try{const body={action:'register',pubkey:getPublicKey(scalar(17))};for(let i=0;i<100;i++)assert.equal((await request(f.app).post('/api/auth/nostr/challenge').set('x-synthetic-trusted-client','first').send(body)).status,200);assert.equal((await request(f.app).post('/api/auth/nostr/challenge').set('x-synthetic-trusted-client','first').send(body)).status,429);assert.equal((await request(f.app).post('/api/auth/nostr/challenge').set('x-synthetic-trusted-client','second').send(body)).status,200);}finally{f.close();}
  const standalone=setup();try{const body={action:'register',pubkey:getPublicKey(scalar(18))};for(let i=0;i<100;i++)assert.equal((await request(standalone.app).post('/api/auth/nostr/challenge').send(body)).status,200);assert.equal((await request(standalone.app).post('/api/auth/nostr/challenge').set('x-quiet-ledger-client-ip','203.0.113.99').send(body)).status,429);}finally{standalone.close();}
});

test('passkey signup accepts only requested none attestation, without certificate-chain processing',async()=>{
  const f=setup();try{const device=authenticator(),options=await passkeyOptions(f);const response=device.registration(options.options,true,'packed');const result=await passkeyVerify(f,options,response);assert.equal(result.status,401);assert.equal(f.store.db.prepare('SELECT COUNT(*) as n FROM auth_accounts').get()!.n,0);}finally{f.close();}
});
