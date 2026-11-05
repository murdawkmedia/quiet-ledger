import {createHash} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {isIP} from 'node:net';
import * as bolt11 from 'bolt11';
import type {ReceivingAdapter,ReceivingContext,ReceivingIntent,ReceivingObservation} from '../shared/receiving.js';
import {bounded,minorAmount,type HttpFetch} from './http.js';

export interface LnurlAdapterConfig {
  kind?:'lnurl';id:string;url?:string;lightningAddress?:string;
  mode?:'live'|'test';network?:'mainnet'|'testnet'|'regtest';
  allowLoopbackHttp?:boolean;fetcher?:HttpFetch;
}
const digest=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const object=(v:unknown):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const hex64=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const review=():ReceivingObservation=>({status:'review',reason:'LNURL settlement cannot be verified against the saved invoice and receiving window. Owner review is required.'});
class LnurlError extends Error {
  constructor(message:string,readonly code?:'LNURL_CREATION_UNCERTAIN'|'LNURL_RECOVERY_REQUIRED'){super(message);}
}
const recoveryError=()=>new LnurlError('LNURL has no invoice-recovery protocol. Reconcile the existing request; another invoice was not created.','LNURL_RECOVERY_REQUIRED');
const unavailable=()=>new LnurlError('LNURL provider response is unavailable or invalid.');
function publicIp(ip:string):boolean {
  const family=isIP(ip);
  if(family===4){
    const [a,b,c]=ip.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||(b===0)||(b===88&&c===99)))||(a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
  }
  // Permit global unicast only; mapped IPv4, ULA, link-local and multicast fail closed.
  if(family===6){const normal=ip.toLowerCase();return /^[23][0-9a-f]{3}:/.test(normal)&&!/^2001:db8(?::|$)/.test(normal)&&!/^2001:0(?::|$)/.test(normal)&&!/^2002:/.test(normal);}
  return false;
}
const loopback=(hostname:string)=>['127.0.0.1','::1','localhost'].includes(hostname.replace(/^\[|\]$/g,'').toLowerCase());
function safeUrl(raw:unknown,allowLoopback:boolean,origin?:string,allowAmount=false):URL {
  if(typeof raw!=='string'||raw.length>2048||/[\u0000-\u0020\u007f\\]/.test(raw))throw new Error('Invalid LNURL endpoint.');
  let url:URL;try{url=new URL(raw);}catch{throw new Error('Invalid LNURL endpoint.');}
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase(),local=allowLoopback&&loopback(host)&&url.protocol==='http:';
  const privateHost=loopback(host)||(isIP(host)&&!publicIp(host))||(!isIP(host)&&!host.includes('.'))||/\.(local|localhost|internal|onion|home|lan)\.?$/.test(host);
  if(url.username||url.password||url.hash||!(url.protocol==='https:'||local)||(!local&&privateHost))throw new Error('LNURL requires a public HTTPS endpoint or explicitly allowed loopback HTTP, without credentials.');
  if(origin&&url.origin!==origin)throw new Error('LNURL endpoint origin differs from the configured receiver.');
  const allowed=new Set(['tag','username','user','id','identifier','hash','payment_hash']);
  if(allowAmount)allowed.add('amount');
  for(const [name,value]of url.searchParams){
    if(!allowed.has(name)||url.searchParams.getAll(name).length!==1||!value||value.length>192||!/[a-zA-Z0-9]/.test(value)||!/^[a-zA-Z0-9_.@:+-]+$/.test(value)||(['hash','payment_hash'].includes(name)&&!hex64(value)))throw new Error('LNURL endpoint contains unsupported query parameters.');
  }
  return url;
}
/** Native transport pins the validated DNS result to the actual socket lookup. */
function transport(allowLoopback:boolean):HttpFetch {
  return async(raw,init)=>{
    const url=safeUrl(raw,allowLoopback,undefined,true),host=url.hostname.replace(/^\[|\]$/g,''),local=allowLoopback&&loopback(host)&&url.protocol==='http:';
    // Amount is added only by the adapter after safeUrl validates the callback.
    const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true,verbatim:true});
    if(!addresses.length||addresses.some(x=>local?!loopback(x.address):!publicIp(x.address)))throw unavailable();
    return await new Promise<Response>((resolve,reject)=>{
      const request=url.protocol==='https:'?httpsRequest:httpRequest;
      const req=request(url,{method:'GET',headers:{Accept:'application/json'},signal:init?.signal??undefined,
        lookup:((_host:any,options:any,done:any)=>options?.all?done(null,addresses):done(null,addresses[0].address,addresses[0].family)) as any},res=>{
        const chunks:Buffer[]=[];let bytes=0;
        res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>262144){res.destroy();req.destroy();reject(unavailable());}else chunks.push(chunk);});
        res.on('error',()=>reject(unavailable()));
        res.on('end',()=>{try{resolve(new Response(res.statusCode===204?null:Buffer.concat(chunks),{status:res.statusCode??502}));}catch{reject(unavailable());}});
      });
      req.setTimeout(10_000,()=>req.destroy());req.on('error',()=>reject(unavailable()));req.end();
    });
  };
}
async function json(fetcher:HttpFetch,url:URL):Promise<any> {
  try{
    const result=await fetcher(url.toString(),{method:'GET',redirect:'error',headers:{Accept:'application/json'},signal:AbortSignal.timeout(10_000)});
    if(!result.ok||result.redirected||(result.url&&new URL(result.url).toString()!==url.toString()))throw unavailable();
    const reader=result.body?.getReader();if(!reader)throw unavailable();
    const chunks:Uint8Array[]=[];let length=0;
    try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>262144)throw unavailable();chunks.push(part.value);}}
    finally{await reader.cancel().catch(()=>{});}
    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!object(value)||value.status==='ERROR')throw unavailable();return value;
  }catch{throw unavailable();}
}
function contextBinding(context:ReceivingContext,mode:string,receiver:string):string {
  bounded(context.requestId,'receive request',192);bounded(context.idempotencyKey,'retry key',192);minorAmount(context.amount);
  if(context.method!=='lightning')throw new Error('Receiving method does not match LNURL.');
  if(context.mode!==mode)throw new Error('Receiving mode does not match LNURL.');
  if(typeof context.expectedAtomic!=='string'||!/^[1-9][0-9]{0,15}$/.test(context.expectedAtomic)||BigInt(context.expectedAtomic)>2_100_000_000_000_000n)throw new Error('Invalid native amount.');
  if(!['CAD','USD','EUR','GBP','KRW'].includes(context.currency))throw new Error('Invalid invoice currency.');
  const start=Date.parse(context.createdAt),end=Date.parse(context.expiresAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>7*86400_000)throw new Error('Invalid receiving window.');
  return digest(JSON.stringify([context.requestId,context.idempotencyKey,context.method,context.amount,context.currency,context.expectedAtomic,context.createdAt,context.expiresAt,context.mode,receiver]));
}
function invoiceDetails(pr:unknown,context:ReceivingContext,network:string,metadataHash:unknown):{hash:string;expires:number} {
  if(typeof pr!=='string'||pr.length>20000||!/^[a-z0-9]+$/.test(pr)||!hex64(metadataHash))throw unavailable();
  // Decode validates bech32 checksum, recovers the secp256k1 signer and checks
  // an explicit payee tag. Enforce missing/duplicate tag constraints ourselves.
  let parsed:ReturnType<typeof bolt11.decode>;try{parsed=bolt11.decode(pr);}catch{throw unavailable();}
  // The decoder accepts nonzero padding bits and some truncated tag encodings.
  // Canonical reconstruction must preserve the signed invoice byte-for-byte.
  try{if(bolt11.encode(parsed,false).paymentRequest!==pr)throw unavailable();}catch{throw unavailable();}
  const prefix=network==='mainnet'?'bc':network==='testnet'?'tb':'bcrt';
  if(parsed.network?.bech32!==prefix||parsed.complete!==true||parsed.millisatoshis!==(BigInt(context.expectedAtomic)*1000n).toString())throw unavailable();
  const tags=(name:string)=>parsed.tags.filter(t=>t.tagName===name);
  const p=tags('payment_hash'),h=tags('purpose_commit_hash'),x=tags('expire_time'),n=tags('payee_node_key');
  if(p.length!==1||!hex64(p[0].data)||h.length!==1||h[0].data!==metadataHash||tags('description').length||x.length>1||n.length>1)throw unavailable();
  if(tags('feature_bits').length>1||tags('feature_bits').some(t=>object(t.data)&&(t.data as Record<string,any>).extra_bits?.has_required===true))throw unavailable();
  const expiry=x.length?x[0].data:3600,timestamp=parsed.timestamp;
  if(typeof expiry!=='number'||!Number.isSafeInteger(expiry)||expiry<1||expiry>7*86400||typeof timestamp!=='number'||!Number.isSafeInteger(timestamp)||timestamp<Math.floor(Date.parse(context.createdAt)/1000)||timestamp>Math.floor(Date.now()/1000)+5)throw unavailable();
  const expires=timestamp+expiry;if(!Number.isSafeInteger(expires)||expires*1000<=Date.now())throw unavailable();
  return {hash:p[0].data,expires};
}

/** Receiving only: no payer-supplied endpoint, sender proof, wallet secrets or outgoing calls. */
export function createLnurlAdapter(config:LnurlAdapterConfig):ReceivingAdapter {
  bounded(config.id,'LNURL adapter id',80);if(!/^[a-zA-Z0-9_-]+$/.test(config.id))throw new Error('Invalid LNURL adapter id.');
  const mode=config.mode??'live',network=config.network??'mainnet',allowLoopback=config.allowLoopbackHttp===true;
  if(!['live','test'].includes(mode)||!['mainnet','testnet','regtest'].includes(network)||(mode==='live')!==(network==='mainnet'))throw new Error('LNURL mode and explicitly configured network must agree.');
  if(Boolean(config.url)===Boolean(config.lightningAddress))throw new Error('Configure exactly one LNURL pay URL or Lightning Address.');
  let configured=config.url,address=config.lightningAddress;
  if(address){
    if(!/^[a-z0-9_.+-]{1,128}@[a-z0-9.-]+$/.test(address))throw new Error('Invalid configured Lightning Address.');
    const [user,domain]=address.split('@');configured=`https://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}`;
  }
  const endpoint=safeUrl(configured,allowLoopback),receiver=digest(endpoint.toString()+':'+network),fetcher=config.fetcher??transport(allowLoopback);
  type Entry={binding:string;task?:Promise<ReceivingIntent>;intent?:ReceivingIntent;attempted:boolean};
  const cache=new Map<string,Entry>();
  const proof=(binding:string,pr:string,metadataHash:string,verifyUrl:unknown)=>digest(JSON.stringify([binding,pr,metadataHash,verifyUrl??null]));
  const binding=(context:ReceivingContext)=>contextBinding(context,mode,receiver);
  return {
    id:config.id,methods:['lightning'],mode,
    async create(input){
      const context=structuredClone(input);
      const bound=binding(context);if(Date.now()>=Date.parse(context.expiresAt))throw new Error('LNURL receiving request has expired.');
      const previous=cache.get(context.requestId);
      if(previous){if(previous.binding!==bound)throw new Error('LNURL request conflicts with the existing snapshot.');if(previous.intent)return structuredClone(previous.intent);if(previous.task)return structuredClone(await previous.task);throw recoveryError();}
      if(cache.size>=512)throw new Error('LNURL request cache is full; preserve existing intents before restarting.');
      const entry:Entry={binding:bound,attempted:false};cache.set(context.requestId,entry);
      const task=(async()=>{
        const metadataResponse=await json(fetcher,endpoint);
        if(metadataResponse.tag!=='payRequest'||!Number.isSafeInteger(metadataResponse.minSendable)||!Number.isSafeInteger(metadataResponse.maxSendable)||metadataResponse.minSendable<1||metadataResponse.maxSendable<metadataResponse.minSendable)throw unavailable();
        const amount=BigInt(context.expectedAtomic)*1000n;
        if(amount<BigInt(metadataResponse.minSendable)||amount>BigInt(metadataResponse.maxSendable))throw new Error('LNURL amount is outside the configured receiver bounds.');
        if(metadataResponse.payerData!==undefined&&(!object(metadataResponse.payerData)||Object.values(metadataResponse.payerData).some(v=>!object(v)||typeof v.mandatory!=='boolean'||v.mandatory)))throw new Error('LNURL requires unsupported payer identity data.');
        const metadata=metadataResponse.metadata;
        if(typeof metadata!=='string'||metadata.length>200000)throw new Error('Invalid LNURL metadata.');
        let rows:any;try{rows=JSON.parse(metadata);}catch{throw new Error('Invalid LNURL metadata.');}
        if(!Array.isArray(rows)||rows.length>64||rows.some(row=>!Array.isArray(row)||row.length<2||typeof row[0]!=='string'))throw new Error('Invalid LNURL metadata.');
        const text=rows.filter(row=>row[0]==='text/plain');
        if(text.length!==1||typeof text[0][1]!=='string'||!text[0][1]||text[0][1].length>8000)throw new Error('Invalid LNURL metadata.');
        if(address&&!rows.some(row=>['text/identifier','text/email'].includes(row[0])&&row[1]===address))throw new Error('LNURL metadata does not match the configured Lightning Address.');
        const callback=safeUrl(metadataResponse.callback,allowLoopback,endpoint.origin);callback.searchParams.set('amount',amount.toString());
        // LNURL-pay has no idempotency key. Once this GET may create an invoice,
        // failure must preserve uncertainty and never issue another callback.
        entry.attempted=true;
        try{
          const value=await json(fetcher,callback);
          if((value.status!==undefined&&value.status!=='OK')||!Array.isArray(value.routes)||value.routes.length)throw unavailable();
          const metadataHash=digest(metadata),details=invoiceDetails(value.pr,context,network,metadataHash);
          const verifyUrl=value.verify===undefined?undefined:safeUrl(value.verify,allowLoopback,endpoint.origin).toString();
          const intent:ReceivingIntent={providerId:details.hash,request:`lightning:${value.pr}`,network,asset:'BTC',allocationKey:`lightning:${network}:${details.hash}`,instructions:[{label:'Native amount',value:`${context.expectedAtomic} satoshis`},{label:'Network',value:network},...(!verifyUrl?[{label:'Verification',value:'This receiver does not support automatic verification. Owner review is required.'}]:[])],opaque:{kind:'lnurl',binding:bound,metadataHash,paymentHash:details.hash,...(verifyUrl?{verifyUrl}:{}),proofBinding:proof(bound,value.pr,metadataHash,verifyUrl)}};
          entry.intent=structuredClone(intent);return intent;
        }catch{throw new LnurlError('LNURL invoice creation may have completed. Preserve the existing request and reconcile it before any new invoice.','LNURL_CREATION_UNCERTAIN');}
      })();
      entry.task=task;
      try{return structuredClone(await task);}catch(error){if(!entry.attempted)cache.delete(context.requestId);throw error;}finally{entry.task=undefined;}
    },
    async recover(input){const context=structuredClone(input),bound=binding(context),entry=cache.get(context.requestId);if(!entry||entry.binding!==bound)throw recoveryError();if(entry.intent)return structuredClone(entry.intent);if(entry.task)return structuredClone(await entry.task);throw recoveryError();},
    async check(input,saved){
      try{
        const context=structuredClone(input),intent=structuredClone(saved);
        const bound=binding(context),opaque=intent.opaque;
        if(Date.now()>=Date.parse(context.expiresAt)||intent.asset!=='BTC'||intent.network!==network||opaque?.kind!=='lnurl'||opaque.binding!==bound||typeof intent.request!=='string'||!intent.request.startsWith('lightning:'))return review();
        const pr=intent.request.slice(10),details=invoiceDetails(pr,context,network,opaque.metadataHash);
        if(intent.providerId!==details.hash||opaque.paymentHash!==details.hash||intent.allocationKey!==`lightning:${network}:${details.hash}`||opaque.proofBinding!==proof(bound,pr,opaque.metadataHash as string,opaque.verifyUrl))return review();
        if(typeof opaque.verifyUrl!=='string')return review();
        const verify=safeUrl(opaque.verifyUrl,allowLoopback,endpoint.origin),value=await json(fetcher,verify);
        if(value.status!=='OK'||value.pr!==pr||typeof value.settled!=='boolean'||Date.now()>=Date.parse(context.expiresAt)||Date.now()>=details.expires*1000)return review();
        if(!value.settled)return value.preimage===null?{status:'pending',reason:'The configured LNURL receiver reports that this exact invoice is unsettled.'}:review();
        // LUD21 specifies a hex preimage. Never retain or return it, including
        // errors; base64 and permissively decoded strings are not accepted.
        if(typeof value.preimage!=='string'||!/^[a-fA-F0-9]{64}$/.test(value.preimage)||digest(Buffer.from(value.preimage,'hex'))!==details.hash)return review();
        return {status:'paid',paymentId:`lightning:${network}:${details.hash}`,amount:context.amount,currency:context.currency,reference:context.requestId};
      }catch{return review();}
    },
  };
}
