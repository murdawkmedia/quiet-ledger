// Coinos names-service receiving-only POS adapter for the Count Zapula demo slice.
// Receiving only: three exact routes, a bearer terminal token, no spend/send/
// withdraw/revoke/history call, no payer-supplied endpoint. Errors are fixed and
// redacted: the provider token, invoice strings and preimages never appear in them.
import {createHash} from 'node:crypto';
import * as bolt11 from 'bolt11';
import type {ReceivingAdapter,ReceivingContext,ReceivingIntent,ReceivingObservation} from '../shared/receiving.js';
import {bounded,minorAmount,type HttpFetch} from './http.js';
import {connectionFetch} from '../server/connection-transport.js';

const ORIGIN='https://names.coinos.io';
const ME_PATH='/pos/me',CREATE_PATH='/pos/invoice';
const MAX_JSON=256*1024,TIMEOUT_MS=10_000,MAX_CACHED=128;
const digest=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const object=(v:unknown):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const hex64=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v);
const UNAVAILABLE='Coinos POS provider is unavailable or returned an invalid response.';
const MISMATCH='Coinos POS receiver verification failed; payment creation stays disabled.';
const INVALID='Coinos POS invoice could not be verified against this request.';
const RECOVERY='A Coinos POS invoice creation may already have been attempted for this request. Reconcile the existing request; another invoice was not created.';
const CONFLICT='This receiving request no longer matches its saved Coinos POS snapshot.';
const REVIEW_BINDING='The saved Coinos POS invoice no longer matches this receiving request. Owner review is required.';
const REVIEW_SETTLEMENT='Coinos POS settlement cannot be verified against the saved invoice and receiving window. Owner review is required.';
class PosError extends Error {
  constructor(message:string,readonly code:'UNAVAILABLE'|'MALFORMED'|'RECEIVER_MISMATCH'|'INVOICE_INVALID'|'RECOVERY_REQUIRED'|'SNAPSHOT_CONFLICT'){super(message);}
}
const unavailable=()=>new PosError(UNAVAILABLE,'UNAVAILABLE');
const metadataFor=(address:string)=>JSON.stringify([['text/plain','Paying '+address],['text/identifier',address]]);

export interface CoinosPosAdapterConfig {
  id:string;token:string;expectedAddress:string;fetcher?:HttpFetch;now?:()=>number;
}

/** SAT/lightning/mainnet only: strict binding of the request snapshot to the receiver. */
function validateContext(context:ReceivingContext,expectedAddress:string,now:()=>number):string {
  bounded(context.requestId,'receive request',192);bounded(context.idempotencyKey,'retry key',192);
  minorAmount(context.amount);
  if(context.method!=='lightning')throw new Error('Receiving method does not match the Coinos POS adapter.');
  if(context.mode!=='live')throw new Error('Coinos POS receiving mode must be live mainnet only.');
  if(context.currency!=='SAT')throw new Error('Coinos POS receiving currency must be SAT only.');
  if(context.expectedAtomic!==String(context.amount)||!/^[1-9][0-9]{0,15}$/.test(context.expectedAtomic))throw new Error('Invalid native amount.');
  const start=Date.parse(context.createdAt),end=Date.parse(context.expiresAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>7*86400_000||start>now()+60_000)throw new Error('Invalid receiving window.');
  return digest(JSON.stringify([context.requestId,context.idempotencyKey,'lightning',context.amount,'SAT',context.expectedAtomic,context.createdAt,context.expiresAt,'live',expectedAddress]));
}

/** Canonical reconstruction preserves the signed invoice byte-for-byte before any check. */
function decodedInvoice(pr:unknown,metadataHash:string,context:ReceivingContext,now:()=>number):{hash:string;expires:number} {
  if(typeof pr!=='string'||pr.length>20000||!/^[a-z0-9]+$/.test(pr))throw new PosError(INVALID,'INVOICE_INVALID');
  let parsed:ReturnType<typeof bolt11.decode>;
  try{parsed=bolt11.decode(pr);}catch{throw new PosError(INVALID,'INVOICE_INVALID');}
  try{if(bolt11.encode(parsed,false).paymentRequest!==pr)throw new Error('noncanonical');}catch{throw new PosError(INVALID,'INVOICE_INVALID');}
  if(parsed.network?.bech32!=='bc'||parsed.complete!==true)throw new PosError(INVALID,'INVOICE_INVALID');
  if(parsed.millisatoshis!==(BigInt(context.expectedAtomic)*1000n).toString())throw new PosError(INVALID,'INVOICE_INVALID');
  const tags=(name:string)=>parsed.tags.filter(t=>t.tagName===name);
  const p=tags('payment_hash'),h=tags('purpose_commit_hash'),x=tags('expire_time'),n=tags('payee_node_key');
  if(p.length!==1||!hex64(p[0].data)||h.length!==1||h[0].data!==metadataHash||tags('description').length||x.length>1||n.length>1)throw new PosError(INVALID,'INVOICE_INVALID');
  if(tags('feature_bits').length>1||tags('feature_bits').some(t=>object(t.data)&&(t.data as Record<string,any>).extra_bits?.has_required===true))throw new PosError(INVALID,'INVOICE_INVALID');
  const expiry=x.length?x[0].data:3600,timestamp=parsed.timestamp;
  if(!integer(expiry)||expiry<1||expiry>7*86400||!integer(timestamp)||timestamp<Math.floor(Date.parse(context.createdAt)/1000)||timestamp>Math.floor(now()/1000)+5)throw new PosError(INVALID,'INVOICE_INVALID');
  const expires=timestamp+expiry;
  if(!Number.isSafeInteger(expires)||expires*1000<=now())throw new PosError(INVALID,'INVOICE_INVALID');
  return {hash:p[0].data,expires};
}

/** Receiving only: no payer endpoint, no wallet secret, no outgoing call exists here. */
export function createCoinosPosAdapter(config:CoinosPosAdapterConfig):ReceivingAdapter {
  bounded(config.id,'Coinos POS adapter id',80);
  if(!/^[a-zA-Z0-9_-]+$/.test(config.id))throw new Error('Invalid Coinos POS adapter id.');
  if(!hex64(config.token))throw new Error('Coinos POS token must be a 64-hex provider-generated bearer.');
  const address=config.expectedAddress.toLowerCase();
  if(!/^[a-z0-9_-]{1,64}@coinos\.io$/.test(address))throw new Error('Coinos POS expected address must be a canonical username@coinos.io address.');
  const fetcher=config.fetcher??connectionFetch,now=config.now??(()=>Date.now());
  const metadataHash=digest(metadataFor(address));
  type Entry={binding:string;attempted:boolean;intent?:ReceivingIntent;task?:Promise<ReceivingIntent>};
  const entries=new Map<string,Entry>();
  async function json(url:URL,method:'GET'|'POST',body?:string,malformed:'unavailable'|'malformed'='unavailable'):Promise<any> {
    let response:Response;
    try{
      response=await fetcher(url.toString(),{method,redirect:'error',signal:AbortSignal.timeout(TIMEOUT_MS),
        headers:{Accept:'application/json','User-Agent':'Quiet-Ledger-receiving/0.1',Authorization:`Bearer ${config.token}`,...(body!==undefined?{'Content-Type':'application/json'}:{})},
        ...(body!==undefined?{body}:{})});
    }catch{throw unavailable();}
    if(!response.ok||response.redirected)throw unavailable();
    const reader=response.body?.getReader();if(!reader)throw unavailable();
    const chunks:Uint8Array[]=[];let length=0;
    try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>MAX_JSON)throw unavailable();chunks.push(part.value);}}
    catch{throw unavailable();}
    finally{await reader.cancel().catch(()=>{});}
    try{
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!object(value))throw new Error('shape');
      return value;
    }catch{
      if(malformed==='malformed')throw new PosError('Coinos POS provider returned a malformed status response.','MALFORMED');
      throw unavailable();
    }
  }
  /** Merchant identity is re-verified against the configured receiver before every provider use. */
  async function verifyReceiver():Promise<void> {
    const me=await json(new URL(ME_PATH,ORIGIN),'GET');
    if(typeof me.address!=='string'||typeof me.username!=='string')throw unavailable();
    const verified=me.address===address&&me.username===address.slice(0,address.indexOf('@'));
    if(!verified)throw new PosError(MISMATCH,'RECEIVER_MISMATCH');
  }
  function buildIntent(context:ReceivingContext,pr:string,hash:string,created:number,expires:number,binding:string):ReceivingIntent {
    return {
      providerId:hash,request:`lightning:${pr}`,network:'mainnet',asset:'BTC',cashuWalletHandoff:true,
      expiresAt:new Date(Math.min(expires*1000,Date.parse(context.expiresAt))).toISOString(),allocationKey:`lightning:mainnet:${hash}`,
      opaque:{binding,requestId:context.requestId,amount:context.amount,currency:'SAT',
        expectedAtomic:context.expectedAtomic,createdAt:context.createdAt,expiresAt:context.expiresAt,
        created,hash,receiver:address},
    };
  }
  function bindingOf(context:ReceivingContext,intent:ReceivingIntent):string|null {
    const opaque=intent.opaque;
    if(!object(opaque)||opaque.binding!==validateContext(context,address,now))return null;
    if(!hex64(opaque.hash)||opaque.hash!==intent.providerId||opaque.receiver!==address||opaque.currency!=='SAT')return null;
    if(opaque.requestId!==context.requestId||opaque.amount!==context.amount||opaque.expectedAtomic!==context.expectedAtomic)return null;
    if(opaque.createdAt!==context.createdAt||opaque.expiresAt!==context.expiresAt)return null;
    if(intent.network!=='mainnet'||intent.asset!=='BTC'||intent.allocationKey!==`lightning:mainnet:${opaque.hash}`)return null;
    if(typeof intent.request!=='string'||!intent.request.startsWith('lightning:'))return null;
    const details=decodedInvoice(intent.request.slice(10),metadataHash,context,now);
    if(details.hash!==opaque.hash||intent.expiresAt!==new Date(Math.min(details.expires*1000,Date.parse(context.expiresAt))).toISOString())return null;
    if(!integer(opaque.created)||opaque.created<Date.parse(context.createdAt)||opaque.created>now()+5000||opaque.created>=details.expires*1000)return null;
    return opaque.hash;
  }
  return {
    id:config.id,methods:['lightning'],mode:'live',supportedCurrencies:['SAT'],label:'Coinos POS',
    async create(input:ReceivingContext):Promise<ReceivingIntent> {
      const context=structuredClone(input),binding=validateContext(context,address,now);
      let entry=entries.get(context.requestId);
      if(entry){
        if(entry.binding!==binding)throw new PosError(CONFLICT,'SNAPSHOT_CONFLICT');
        if(entry.intent)return structuredClone(entry.intent);
        if(entry.task)return structuredClone(await entry.task);
        if(entry.attempted)throw new PosError(RECOVERY,'RECOVERY_REQUIRED');
      }else{
        if(entries.size>=MAX_CACHED)throw new PosError(RECOVERY,'RECOVERY_REQUIRED');
        entry={binding,attempted:false};entries.set(context.requestId,entry);
      }
      const current=entry;
      const task=(async()=>{
        await verifyReceiver();
        current.attempted=true;
        const response=await json(new URL(CREATE_PATH,ORIGIN),'POST',JSON.stringify({amount:context.amount}));
        const {hash:invoiceHash,expires}=decodedInvoice(response.hash,metadataHash,context,now);
        if(!hex64(response.id)||response.id!==invoiceHash||!integer(response.amount)||response.amount!==context.amount||!integer(response.created))throw new PosError(INVALID,'INVOICE_INVALID');
        const created=response.created;
        if(created<Date.parse(context.createdAt)||created>now()+5000||created>=expires*1000)throw new PosError(INVALID,'INVOICE_INVALID');
        const intent=buildIntent(context,response.hash,invoiceHash,created,expires,binding);
        current.intent=structuredClone(intent);return intent;
      })();
      current.task=task;
      try{return structuredClone(await task);}
      catch(error){if(!current.attempted)entries.delete(context.requestId);throw error;}
      finally{current.task=undefined;}
    },
    async check(input:ReceivingContext,saved:ReceivingIntent):Promise<ReceivingObservation> {
      const context=structuredClone(input),intent=structuredClone(saved);
      let hash:string|null;try{hash=bindingOf(context,intent);}catch{return {status:'review',reason:REVIEW_BINDING};}
      if(!hash)return {status:'review',reason:REVIEW_BINDING};
      await verifyReceiver();
      let state:any;
      try{state=await json(new URL(`${CREATE_PATH}/${hash}`,ORIGIN),'GET',undefined,'malformed');}
      catch(error){
        if(error instanceof PosError&&error.code==='MALFORMED')return {status:'review',reason:REVIEW_SETTLEMENT};
        throw error;
      }
      const opaque=intent.opaque as Record<string,any>;
      const requested=opaque.amount,invoiceCreated=opaque.created,expiry=Date.parse(intent.expiresAt??'');
      if(state.id!==hash)return {status:'review',reason:REVIEW_SETTLEMENT};
      if(!integer(state.amount)||state.amount!==requested||!integer(state.created)||state.created!==invoiceCreated)return {status:'review',reason:REVIEW_SETTLEMENT};
      if(!integer(state.tip)||!integer(state.received)||state.tip<0||state.received<0)return {status:'review',reason:REVIEW_SETTLEMENT};
      if(state.paid===null){
        if(state.received!==0||state.tip!==0)return {status:'review',reason:REVIEW_SETTLEMENT};
        return {status:'pending'};
      }
      const paid=state.paid;
      if(!integer(paid)||paid<invoiceCreated||paid>now()||!Number.isFinite(expiry)||paid>=expiry)return {status:'review',reason:REVIEW_SETTLEMENT};
      if(state.received!==requested||state.tip!==0)return {status:'review',reason:REVIEW_SETTLEMENT};
      return {status:'paid',paymentId:hash,amount:context.amount,currency:'SAT',reference:context.requestId};
    },
    async recover(input:ReceivingContext):Promise<ReceivingIntent> {
      const context=structuredClone(input),binding=validateContext(context,address,now),entry=entries.get(context.requestId);
      if(!entry||entry.binding!==binding)throw new PosError(RECOVERY,'RECOVERY_REQUIRED');
      if(entry.intent)return structuredClone(entry.intent);
      if(entry.task)return structuredClone(await entry.task);
      throw new PosError(RECOVERY,'RECOVERY_REQUIRED');
    },
  };
}
