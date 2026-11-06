import {createHash,timingSafeEqual} from 'node:crypto';
import type {RequestHandler} from 'express';

export type ApiScope='invoices:read'|'invoices:write'|'receiving:read'|'receiving:write'|'collateral:read'|'payments:confirm'|'records:read';
const SCOPES:readonly ApiScope[]=['invoices:read','invoices:write','receiving:read','receiving:write','collateral:read','payments:confirm','records:read'];
export interface ApiAccess {readonly keyId:string;readonly scopes:readonly ApiScope[];readonly version:'v1'|'legacy';readonly workspace?:string;readonly accountId?:string}
export interface ApiAccessOptions {keys:{token:string;scopes:ApiScope[]}[];resolve?:(token:string)=>{keyId:string;scopes:ApiScope[];workspace:string;accountId:string}|undefined}
const digest=(token:string)=>createHash('sha256').update(token).digest();
export const validApiToken=(token:unknown):token is string=>typeof token==='string'&&/^[\x21-\x7e]{32,512}$/.test(token);
const ID='[A-Za-z0-9_-]{1,128}';
const resources:{path:RegExp;methods:Partial<Record<string,ApiScope>>;paginated?:boolean}[]=[
  {path:/^\/payment-methods$/,methods:{GET:'invoices:read'}},
  {path:/^\/invoices$/,methods:{GET:'invoices:read',POST:'invoices:write'},paginated:true},
  {path:new RegExp(`^/invoices/${ID}$`),methods:{GET:'invoices:read'}},
  {path:new RegExp(`^/invoices/${ID}/revoke-links$`),methods:{POST:'invoices:write'}},
  {path:new RegExp(`^/invoices/${ID}/ledger$`),methods:{GET:'invoices:read'}},
  {path:new RegExp(`^/invoices/${ID}/(?:credits|void)$`),methods:{POST:'invoices:write'}},
  {path:/^\/invoice-ledger\/export\.csv$/,methods:{GET:'records:read'}},
  {path:/^\/receiving$/,methods:{GET:'receiving:read',POST:'receiving:write'},paginated:true},
  {path:new RegExp(`^/receiving/${ID}$`),methods:{GET:'receiving:read'}},
  {path:new RegExp(`^/receiving/${ID}/(?:check|recover)$`),methods:{POST:'receiving:write'}},
  {path:new RegExp(`^/(?:payment-reports|receiving)/${ID}/confirm$`),methods:{POST:'payments:confirm'}},
  {path:/^\/(?:collateral|ark)$/,methods:{GET:'collateral:read'}},
  {path:/^\/evidence\/export$/,methods:{GET:'records:read'}},
];

/** Must run before cookie-session/owner/CSRF middleware. It never creates a session. */
export function createApiAccess(options:ApiAccessOptions):RequestHandler {
  if(!options||!Array.isArray(options.keys))throw new Error('Invalid API key configuration.');
  const keys=options.keys.map((key,index)=>{
    if(!key||!validApiToken(key.token)||!Array.isArray(key.scopes)||key.scopes.some(scope=>!SCOPES.includes(scope)))throw new Error('Invalid API key configuration.');
    return {hash:digest(key.token),keyId:`key-${index+1}`,scopes:Object.freeze([...new Set(key.scopes)])};
  });
  for(let i=0;i<keys.length;i++)for(let j=0;j<i;j++)if(timingSafeEqual(keys[i].hash,keys[j].hash))throw new Error('Invalid API key configuration.');
  return (req,res,next)=>{
    const path=req.url.split('?',1)[0];
    const version=/^\/api\/v1(?:\/|$)/i.test(path)?'v1':'legacy';
    // Express routes are case-insensitive by default. Detect API-like paths broadly,
    // then require the exact spelling before granting any bearer access.
    if(!/^\/api(?:\/|$)/i.test(path))return next();
    const authorization=req.headers.authorization;
    if(version==='legacy'&&authorization===undefined)return next();
    const denied=()=>{res.status(403).json({error:'This API resource or operation is not permitted.'});};
    const unauthorized=()=>{res.setHeader('WWW-Authenticate','Bearer realm="quiet-ledger"');res.status(401).json({error:'A valid scoped API bearer token is required.'});};
    if(version==='v1'&&authorization===undefined)return unauthorized();
    // Match the raw path, with no decoding, slash folding, case folding or dot normalization.
    const exactPrefix=path.startsWith(version==='v1'?'/api/v1/':'/api/');
    const suffix=exactPrefix?path.slice(version==='v1'?7:4):'\u0000';
    const resource=resources.find(resource=>resource.path.test(suffix));
    if(!resource)return denied();
    if(version==='legacy'&&typeof authorization==='string'&&!/^Bearer(?:\s|$)/i.test(authorization))return next();
    const required=resource?.methods[req.method];
    if(!required)return denied();
    const query=req.url.includes('?')?req.url.slice(req.url.indexOf('?')+1):'';
    if(query){
      if(req.method!=='GET'||!resource.paginated||/[^A-Za-z0-9_=&%+.-]/.test(query))return denied();
      const params=new URLSearchParams(query),seen=new Set<string>();
      for(const [key,value] of params){
        if(seen.has(key)||!['limit','cursor'].includes(key))return denied();seen.add(key);
        if(key==='limit'&&(!/^[1-9][0-9]{0,2}$/.test(value)||Number(value)>100))return denied();
        if(key==='cursor'&&!/^[A-Za-z0-9_-]{1,512}$/.test(value))return denied();
      }
    }
    const bearer=typeof authorization==='string'?/^Bearer ([\x21-\x7e]{32,512})$/i.exec(authorization):null;
    if(!bearer){
      return unauthorized();
    }
    if(req.rawHeaders.filter((value,index)=>index%2===0&&value.toLowerCase()==='authorization').length!==1)return unauthorized();
    const submitted=digest(bearer[1]);let matched:typeof keys[number]|undefined;
    // Every comparison has a fixed digest length and every key is examined.
    for(const key of keys)if(timingSafeEqual(submitted,key.hash))matched=key;
    let resolved:ReturnType<NonNullable<ApiAccessOptions['resolve']>>;
    if(!matched&&options.resolve){try{resolved=options.resolve(bearer[1]);}catch{return unauthorized();}}
    const identity=matched??resolved;if(!identity)return unauthorized();
    if(!identity.scopes.includes(required))return denied();
    const access:ApiAccess=Object.freeze({keyId:identity.keyId,scopes:Object.freeze([...identity.scopes]),version,...(resolved?{workspace:resolved.workspace,accountId:resolved.accountId}:{})});
    res.locals.apiAccess=access;
    if(version==='v1')req.url='/api'+suffix+(req.url.includes('?')?req.url.slice(req.url.indexOf('?')):'');
    next();
  };
}
