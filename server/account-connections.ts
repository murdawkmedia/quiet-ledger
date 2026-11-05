import {Router,type Request,type Response} from 'express';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {Store,DomainError,type StoredSession} from './store.js';
import {CONNECTION_PROVIDERS,normalizeConnection,buildConnectionAdapter,verifyConnection,type NormalizedConnection} from './connection-providers.js';
import type {ConnectionSummary} from '../shared/connections.js';
import type {ReceivingAdapter} from '../shared/receiving.js';
import type {HttpFetch} from '../integrations/http.js';

const TABLE='account_connections',UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable=()=>new DomainError(502,'The provider connection could not be verified. Check its details, permissions and network, then try again. No payment was created.');
interface StoredConnection extends NormalizedConnection {id:string;workspace:string;createdAt:string;verifiedAt?:string;status:ConnectionSummary['status'];detail:string;methods:ConnectionSummary['methods']}
interface Options {store:Store;publicOrigin:string;now:()=>Date;getSession:(req:Request,res:Response)=>StoredSession|undefined;fetcher?:HttpFetch;allowInsecureLoopback?:boolean}
export function createAccountConnections(options:Options){
 const {store,publicOrigin,now}=options;
 if(!store.encrypted)throw new Error('Account connections require encrypted private storage.');
 store.db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE}(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL);CREATE INDEX IF NOT EXISTS account_connections_workspace ON ${TABLE}(workspace)`);
 const router=Router(),busy=new Set<string>();
 function identity(req:Request,res:Response){
  if(req.headers.authorization!==undefined||res.locals.apiAccess)throw new DomainError(403,'Use your signed-in account to manage connections.');
  const session=options.getSession(req,res);
  if(!session||!Number.isFinite(Date.parse(session.expires))||Date.parse(session.expires)<=now().getTime())throw new DomainError(401,'Sign in to manage connections.');
  if(session.role!=='owner'||!session.accountId||!UUID.test(session.accountId)||!UUID.test(session.workspace))throw new DomainError(403,'Connections belong to a private account workspace.');
  if(!['GET','HEAD'].includes(req.method)){
   const supplied=req.get('X-CSRF-Token')??'',expected=session.csrf;
   if(!supplied||supplied.length>512||!expected||Buffer.byteLength(supplied)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))throw new DomainError(403,'The session security token is missing or invalid.');
   const origin=req.get('Origin');if(origin&&origin!==publicOrigin)throw new DomainError(403,'Cross-origin requests are not permitted.');
  }
  return session;
 }
 function read(id:string,workspace:string):StoredConnection{
  const row=store.db.prepare(`SELECT id,workspace,data FROM ${TABLE} WHERE id=? AND workspace=?`).get(id,workspace);if(!row)throw new DomainError(404,'Connection not found.');
  const value=store.decode<StoredConnection>(row.data,TABLE,id,workspace);
  if(value.id!==id||value.workspace!==workspace)throw new DomainError(503,'Private connection storage is unavailable.');return value;
 }
 function summary(value:StoredConnection):ConnectionSummary{const {id,provider,label,mode,status,detail,methods,createdAt,verifiedAt}=value;return {id,provider,label,mode,status,detail,methods,createdAt,...(verifiedAt?{verifiedAt}:{})};}
 const rows=(workspace:string)=>store.db.prepare(`SELECT id,data FROM ${TABLE} WHERE workspace=? ORDER BY created_at,id LIMIT 21`).all(workspace);
 function checkBudget(workspace:string){if(rows(workspace).length>=20)throw new DomainError(429,'This workspace has reached its 20 saved connections. Disconnect an unused connection first.');store.assertWriteBudget();}
 async function exclusive<T>(workspace:string,fn:()=>Promise<T>){if(busy.has(workspace))throw new DomainError(409,'A connection check is already running. Wait for it to finish.');if(busy.size>=100)throw new DomainError(429,'Connection checks are busy. Try again shortly.');busy.add(workspace);try{return await fn();}finally{busy.delete(workspace);}}
 function savedRetry(workspace:string,key:string|undefined,input:unknown){
  if(!key||!/^[A-Za-z0-9._:-]{1,128}$/.test(key))throw new DomainError(400,'A valid Idempotency-Key header is required.');
  const scope='connections:'+workspace;
  if(!store.db.prepare('SELECT 1 FROM idempotency WHERE scope=? AND key=?').get(scope,key))return undefined;
  const result=store.idempotent<{connection:ConnectionSummary}>(scope,key,input,201,()=>{throw new DomainError(409,'Saved connection operation unavailable.');});
  if(!store.db.prepare(`SELECT 1 FROM ${TABLE} WHERE id=? AND workspace=?`).get(result.body.connection.id,workspace))throw new DomainError(409,'This connection was disconnected. Start a new connection instead of replaying the old setup.');
  return {status:result.status,body:{connection:summary(read(result.body.connection.id,workspace))}};
 }
 router.get('/api/account/connections',(req,res)=>{const session=identity(req,res);res.json({providers:CONNECTION_PROVIDERS,connections:rows(session.workspace).map(row=>summary(read(String(row.id),session.workspace)))});});
 router.post('/api/account/connections',async(req,res)=>{
  const session=identity(req,res),workspace=session.workspace,retry=req.get('Idempotency-Key');const prior=savedRetry(workspace,retry,req.body);if(prior)return res.status(prior.status).json(prior.body);
  const result=await exclusive(workspace,async()=>{
   const prior=savedRetry(workspace,retry,req.body);if(prior)return prior;checkBudget(workspace);
   const id='conn-'+randomUUID();let normalized:NormalizedConnection;
   try{normalized=normalizeConnection(req.body,{id,publicOrigin,allowInsecureLoopback:options.allowInsecureLoopback});}catch{throw new DomainError(400,'Connection fields are invalid. Use the fields and network listed for this provider.');}
   let verified:Awaited<ReturnType<typeof verifyConnection>>;
   try{verified=await verifyConnection(normalized,{id,publicOrigin,fetcher:options.fetcher,allowInsecureLoopback:options.allowInsecureLoopback});}catch{throw unavailable();}
   return store.idempotent('connections:'+workspace,retry,req.body,201,()=>{
    checkBudget(workspace);const createdAt=now().toISOString();const value:StoredConnection={...normalized,id,workspace,createdAt,verifiedAt:createdAt,...verified};
    store.db.prepare(`INSERT INTO ${TABLE}(id,workspace,created_at,data) VALUES(?,?,?,?)`).run(id,workspace,createdAt,store.encode(value,TABLE,id,workspace));
    store.audit(workspace,'connection.saved','A private receiving connection was saved.',createdAt);return {connection:summary(value)};
   });
  });res.status(result.status).json(result.body);
 });
 router.post('/api/account/connections/:id/check',async(req,res)=>{
  const workspace=identity(req,res).workspace,id=String(req.params.id);if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length)throw new DomainError(400,'Connection checks accept an empty object.');
  const result=await exclusive(workspace,async()=>{
   const saved=read(id,workspace);let verified:Awaited<ReturnType<typeof verifyConnection>>|undefined;
   try{verified=await verifyConnection(saved,{id,publicOrigin,fetcher:options.fetcher,allowInsecureLoopback:options.allowInsecureLoopback});}catch{}
   const value=store.transaction(()=>{const current=read(id,workspace);store.assertWriteBudget();if(verified){current.status=verified.status;current.detail=verified.detail;current.methods=verified.methods;current.verifiedAt=now().toISOString();}else{current.status='unavailable';current.detail='The last provider check failed. Check the provider account and network, then recheck this saved connection.';}
    store.db.prepare(`UPDATE ${TABLE} SET data=? WHERE id=? AND workspace=?`).run(store.encode(current,TABLE,id,workspace),id,workspace);return current;});return summary(value);
  });res.json({connection:result});
 });
 router.delete('/api/account/connections/:id',(req,res)=>{const workspace=identity(req,res).workspace,id=String(req.params.id);store.transaction(()=>{read(id,workspace);store.db.prepare(`DELETE FROM ${TABLE} WHERE id=? AND workspace=?`).run(id,workspace);store.audit(workspace,'connection.disconnected','A receiving connection was disconnected. Existing provider requests were not cancelled.',now().toISOString());});res.json({disconnected:true});});
 function revision(workspace:string){return createHash('sha256').update(JSON.stringify(rows(workspace))).digest('hex');}
 function adaptersForWorkspace(workspace:string):ReceivingAdapter[]{
  return rows(workspace).map(row=>read(String(row.id),workspace)).filter(value=>value.status!=='unavailable').map(value=>{
   const adapter=buildConnectionAdapter(value,{id:value.id,publicOrigin,fetcher:options.fetcher,allowInsecureLoopback:options.allowInsecureLoopback});
   function active(){const current=read(value.id,workspace);if(current.status==='unavailable')throw new DomainError(503,'Recheck this connection before receiving.');}
   return {...adapter,label:CONNECTION_PROVIDERS.find(provider=>provider.id===value.provider)?.name??'Merchant receiving',async create(context){active();return adapter.create(context);},async check(context,intent,evidence){active();return adapter.check(context,intent,evidence);},...(adapter.recover?{async recover(context:Parameters<NonNullable<ReceivingAdapter['recover']>>[0]){active();return adapter.recover!(context);}}:{})};
  });
 }
 return {router,revision,adaptersForWorkspace};
}
