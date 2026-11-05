import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {Router,type Request,type Response} from 'express';
import {z} from 'zod';
import type {ApiScope} from './api-access.js';
import {DomainError,Store,hash,type StoredSession} from './store.js';

export const ACCOUNT_API_SCOPES=['invoices:read','invoices:write','receiving:read','receiving:write','collateral:read','payments:confirm','records:read'] as const satisfies readonly ApiScope[];
export const DEFAULT_ACCOUNT_API_SCOPES:readonly ApiScope[]=['invoices:read','invoices:write','receiving:read','receiving:write','collateral:read'];
const TABLE='account_api_keys';
const DAY_MS=86400000;
const ID=/^[A-Za-z0-9_-]{1,128}$/;
const uniqueScopes=z.array(z.enum(ACCOUNT_API_SCOPES)).min(1).max(ACCOUNT_API_SCOPES.length).refine(values=>new Set(values).size===values.length);
const createSchema=z.object({
  label:z.string().trim().max(80).refine(value=>!/[\u0000-\u001f\u007f]/.test(value)).optional(),
  scopes:uniqueScopes,
  expiresInDays:z.number().int().min(1).max(90).default(30),
}).strict();
const storedSchema=z.object({
  id:z.string().regex(ID),accountId:z.string().regex(ID),workspace:z.string().regex(ID),
  tokenHash:z.string().regex(/^[0-9a-f]{64}$/),label:z.string().max(80).optional(),scopes:uniqueScopes,
  createdAt:z.string().datetime(),expiresAt:z.string().datetime(),revokedAt:z.string().datetime().optional(),
}).strict();
const pagingSchema=z.object({
  limit:z.string().regex(/^[1-9][0-9]{0,2}$/).refine(value=>Number(value)<=100).optional(),
  cursor:z.string().min(1).max(200).optional(),
}).strict();
type StoredKey=z.infer<typeof storedSchema>;
export type AccountApiKeyMetadata=Pick<StoredKey,'id'|'label'|'scopes'|'createdAt'|'expiresAt'|'revokedAt'>;
export interface ResolvedAccountApiKey {keyId:string;scopes:ApiScope[];workspace:string;accountId:string}
export interface AccountApiKeyOptions {
  store:Store;now?:()=>Date;
  getSession:(req:Request,res:Response)=>StoredSession|undefined;
}
type Row={id:unknown;account_id:unknown;workspace:unknown;token_hash:unknown;expires_at:unknown;revoked_at:unknown;data:unknown;rowid?:unknown};
const invalid=()=>new DomainError(400,'Invalid API key request.');
function parsed<T>(schema:z.ZodType<T>,value:unknown):T {const result=schema.safeParse(value);if(!result.success)throw invalid();return result.data;}
function metadata(record:StoredKey):AccountApiKeyMetadata {
  return {id:record.id,...(record.label?{label:record.label}:{}),scopes:[...record.scopes],createdAt:record.createdAt,expiresAt:record.expiresAt,...(record.revokedAt?{revokedAt:record.revokedAt}:{})};
}

/** Cookie-only management. Mount after the application's session/CSRF/origin boundary. */
export function createAccountApiKeys(options:AccountApiKeyOptions):{router:Router;resolve:(token:string)=>ResolvedAccountApiKey|undefined} {
  const {store}=options,now=options.now??(()=>new Date());
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS account_api_keys (
      id TEXT PRIMARY KEY,account_id TEXT NOT NULL,workspace TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,revoked_at TEXT,data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS account_api_keys_account ON account_api_keys(account_id,workspace);
  `);
  function currentTime():number {const value=now().getTime();if(!Number.isFinite(value))throw new DomainError(503,'API key management is unavailable.');return value;}
  function identity(req:Request,res:Response):StoredSession&{accountId:string} {
    if(req.headers.authorization!==undefined||res.locals.apiAccess)throw new DomainError(403,'Use your signed-in account session to manage API keys.');
    const session=options.getSession(req,res);
    if(!session||!Number.isFinite(Date.parse(session.expires))||Date.parse(session.expires)<=currentTime())throw new DomainError(401,'Sign in to manage API keys.');
    if(session.role!=='owner'||typeof session.accountId!=='string'||!ID.test(session.accountId)||typeof session.workspace!=='string'||!ID.test(session.workspace)||['owner','demo'].includes(session.workspace)||['owner','demo'].includes(session.accountId))throw new DomainError(403,'API keys belong to a private account workspace.');
    if(!['GET','HEAD','OPTIONS'].includes(req.method)){
      const submitted=req.get('X-CSRF-Token');
      if(typeof submitted!=='string'||typeof session.csrf!=='string'||!session.csrf||submitted.length>512)throw new DomainError(403,'The session security token is missing or invalid.');
      const expected=Buffer.from(session.csrf),received=Buffer.from(submitted);
      if(expected.length!==received.length||!timingSafeEqual(expected,received))throw new DomainError(403,'The session security token is missing or invalid.');
    }
    return session as StoredSession&{accountId:string};
  }
  function decode(row:Row):StoredKey {
    try{
      const record=storedSchema.parse(store.decode(row.data,TABLE,String(row.id),String(row.workspace)));
      if(record.id!==row.id||record.accountId!==row.account_id||record.workspace!==row.workspace||record.tokenHash!==row.token_hash||record.expiresAt!==row.expires_at||(record.revokedAt??null)!==(row.revoked_at??null))throw new Error();
      return record;
    }catch{throw new DomainError(503,'API key records are unavailable.');}
  }
  const router=Router();
  router.use('/api/account/api-keys',(req,res,next)=>{
    res.set('Cache-Control','no-store');
    try{res.locals.accountApiKeySession=identity(req,res);next();}catch(error){next(error);}
  });
  router.get('/api/account/api-keys',(req,res)=>{
    const session=res.locals.accountApiKeySession as StoredSession&{accountId:string};
    const query=parsed(pagingSchema,req.query),limit=query.limit?Number(query.limit):50;let before=Number.MAX_SAFE_INTEGER;
    if(query.cursor){
      if(!/^[A-Za-z0-9_-]+$/.test(query.cursor))throw invalid();
      const id=Buffer.from(query.cursor,'base64url').toString('utf8');
      if(!ID.test(id)||Buffer.from(id,'utf8').toString('base64url')!==query.cursor)throw invalid();
      const row=store.db.prepare('SELECT rowid FROM account_api_keys WHERE id=? AND account_id=? AND workspace=?').get(id,session.accountId,session.workspace);
      if(!row)throw invalid();before=Number(row.rowid);
    }
    const rows=store.db.prepare('SELECT rowid,* FROM account_api_keys WHERE account_id=? AND workspace=? AND rowid<? ORDER BY rowid DESC LIMIT ?').all(session.accountId,session.workspace,before,limit+1) as unknown as Row[];
    const page=rows.slice(0,limit);
    res.json({keys:page.map(row=>metadata(decode(row))),nextCursor:rows.length>limit?Buffer.from(String(page.at(-1)!.id),'utf8').toString('base64url'):null});
  });
  router.post('/api/account/api-keys',(req,res)=>{
    const session=res.locals.accountApiKeySession as StoredSession&{accountId:string};
    if(req.get('Idempotency-Key')!==undefined)throw new DomainError(400,'API keys are shown once. Do not retry creation automatically; inspect and revoke an uncertain key before creating another.');
    if(Object.keys(req.query).length)throw invalid();
    const input=parsed(createSchema,req.body);
    const result=store.transaction(()=>{
      const time=currentTime(),createdAt=new Date(time).toISOString();
      const active=store.db.prepare('SELECT COUNT(*) AS n FROM account_api_keys WHERE account_id=? AND revoked_at IS NULL AND expires_at>?').get(session.accountId,createdAt);
      if(Number(active?.n)>=20)throw new DomainError(409,'This account already has 20 active API keys. Revoke an unused key first.');
      const token=randomBytes(32).toString('base64url'),id=randomUUID();
      const record:StoredKey={id,accountId:session.accountId,workspace:session.workspace,tokenHash:hash(token),...(input.label?{label:input.label}:{}),scopes:[...input.scopes],createdAt,expiresAt:new Date(time+input.expiresInDays*DAY_MS).toISOString()};
      store.db.prepare('INSERT INTO account_api_keys(id,account_id,workspace,token_hash,expires_at,data) VALUES(?,?,?,?,?,?)').run(id,record.accountId,record.workspace,record.tokenHash,record.expiresAt,store.encode(record,TABLE,id,record.workspace));
      store.audit(record.workspace,'api_key.created',`API access key created with ${record.scopes.length} scoped permissions.`,createdAt);
      return {key:{...metadata(record),token}};
    });
    res.status(201).json(result);
  });
  router.delete('/api/account/api-keys/:id',(req,res)=>{
    const session=res.locals.accountApiKeySession as StoredSession&{accountId:string},id=String(req.params.id);
    if(!ID.test(id)||Object.keys(req.query).length)throw invalid();
    if(req.body!==undefined)parsed(z.object({}).strict(),req.body);
    store.transaction(()=>{
      const row=store.db.prepare('SELECT * FROM account_api_keys WHERE id=? AND account_id=? AND workspace=?').get(id,session.accountId,session.workspace) as unknown as Row|undefined;
      if(!row)throw new DomainError(404,'API key not found.');
      const record=decode(row);if(record.revokedAt)return;
      record.revokedAt=new Date(currentTime()).toISOString();
      store.db.prepare('UPDATE account_api_keys SET revoked_at=?,data=? WHERE id=? AND account_id=? AND workspace=?').run(record.revokedAt,store.encode(record,TABLE,id,record.workspace),id,session.accountId,session.workspace);
      store.audit(record.workspace,'api_key.revoked','API access key revoked.',record.revokedAt);
    });
    res.status(204).end();
  });
  function resolve(token:string):ResolvedAccountApiKey|undefined {
    try{
      if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return undefined;
      const row=store.db.prepare('SELECT * FROM account_api_keys WHERE token_hash=?').get(hash(token)) as unknown as Row|undefined;
      if(!row)return undefined;const record=decode(row);
      if(record.revokedAt||Date.parse(record.expiresAt)<=currentTime())return undefined;
      return {keyId:record.id,scopes:[...record.scopes],workspace:record.workspace,accountId:record.accountId};
    }catch{return undefined;}
  }
  return {router,resolve};
}
