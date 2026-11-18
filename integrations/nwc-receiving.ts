import {createHash} from 'node:crypto';
import {getPublicKey,finalizeEvent,verifyEvent,nip04,nip44,type NostrEvent} from 'nostr-tools';
import * as bolt11 from 'bolt11';
import {validateConnectionUrl} from '../server/connection-transport.js';
import {nwcTransport,type NwcTransport} from '../server/nwc-transport.js';
import type {ReceivingAdapter,ReceivingContext,ReceivingIntent,ReceivingObservation} from '../shared/receiving.js';

const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):value is Record<string,any>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const hex=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value);
const unavailable=()=>new Error('The NWC receiving wallet is unavailable or returned an invalid response. Check its receiving permissions and online status.');
const invalid=()=>new Error('Invalid NWC receiving connection. Use public secure relays and a dedicated connection secret.');
const review='This NWC payment cannot be verified against the original invoice. Review it in the receiving wallet.';
const recovery=()=>new Error('NWC invoice creation may already have been attempted. Reconcile the original request; no replacement invoice was created.');
const methods=['get_info','make_invoice','lookup_invoice'] as const;
type Method=typeof methods[number];
type Encryption='nip04'|'nip44_v2';
export interface ParsedNwcConnection {walletPubkey:string;relayUrl:string;secret:string;clientPubkey:string}
export interface NwcReceivingConfig {connectionUri:string;transport?:NwcTransport;now?:()=>number}

/** The URI is an application connection credential, not a wallet seed. Never log it. */
export function parseNwcConnection(uri:unknown):ParsedNwcConnection {
 try{
  if(typeof uri!=='string'||uri.length>4096||/[\u0000-\u0020\u007f\\]/.test(uri)||/%(?![a-fA-F0-9]{2})/.test(uri))throw invalid();
  const url=new URL(uri);
  if(url.protocol!=='nostr+walletconnect:'||!hex(url.hostname)||url.username||url.password||url.port||url.hash||!['','/'].includes(url.pathname))throw invalid();
  for(const name of url.searchParams.keys())if(!['relay','secret','lud16'].includes(name)||name!=='relay'&&url.searchParams.getAll(name).length!==1)throw invalid();
  const secret=url.searchParams.get('secret');if(!hex(secret))throw invalid();
  const relays=url.searchParams.getAll('relay');if(!relays.length||relays.length>3)throw invalid();
  const validated=relays.map(relay=>{const value=new URL(relay);
   if(value.protocol!=='wss:'||value.search||value.hash||value.username||value.password)throw invalid();
   const https=new URL(value);https.protocol='https:';validateConnectionUrl(https.toString());return value.toString();
  });
  if(new Set(validated).size!==validated.length)throw invalid();
  // Wallets may export several relays. Use only the first; never fan out or retry a create.
  const relayUrl=new URL(validated[0]);
  const lud16=url.searchParams.get('lud16');if(lud16!==null&&(!/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(lud16)))throw invalid();
  const key=Uint8Array.from(Buffer.from(secret,'hex')),clientPubkey=getPublicKey(key);
  // This validates the remote curve point before any transport access.
  nip44.v2.utils.getConversationKey(key,url.hostname);
  return {walletPubkey:url.hostname,relayUrl:relayUrl.toString(),secret,clientPubkey};
 }catch{throw invalid();}
}

function signed(raw:unknown,walletPubkey:string,kind:number):NostrEvent {
 try{
  if(!object(raw)||raw.kind!==kind||raw.pubkey!==walletPubkey||!hex(raw.id)||typeof raw.sig!=='string'||!/^[0-9a-f]{128}$/.test(raw.sig)||!integer(raw.created_at)||raw.created_at<0||typeof raw.content!=='string'||Buffer.byteLength(raw.content)>64*1024||!Array.isArray(raw.tags)||raw.tags.length>32||raw.tags.some((tag:unknown)=>!Array.isArray(tag)||tag.length>8||tag.some((item:unknown)=>typeof item!=='string'||item.length>4096)))throw unavailable();
  // Pick fields explicitly: nostr-tools caches verification on a symbol property.
  const event:NostrEvent={kind:raw.kind,pubkey:raw.pubkey,id:raw.id,sig:raw.sig,created_at:raw.created_at,tags:raw.tags.map((tag:string[])=>[...tag]),content:raw.content};
  if(!verifyEvent(event))throw unavailable();return event;
 }catch{throw unavailable();}
}
function oneTag(event:NostrEvent,name:string):string|undefined {
 const tags=event.tags.filter(tag=>tag[0]===name);if(tags.length>1||tags.some(tag=>tag.length!==2))throw unavailable();return tags[0]?.[1];
}
function modeFor(event:NostrEvent):Encryption {
 const advertised=oneTag(event,'encryption');if(advertised===undefined)return 'nip04';
 const modes=advertised.split(' ');if(modes.includes('nip44_v2'))return 'nip44_v2';if(modes.includes('nip04'))return 'nip04';throw unavailable();
}
function client(config:NwcReceivingConfig){
 const parsed=parseNwcConnection(config.connectionUri),transport=config.transport??nwcTransport,now=config.now??(()=>Date.now());
 const key=Uint8Array.from(Buffer.from(parsed.secret,'hex')),conversation=nip44.v2.utils.getConversationKey(key,parsed.walletPubkey);
 async function call(method:Method,params:Record<string,unknown>,mode:Encryption):Promise<Record<string,any>>{
  if(!methods.includes(method))throw unavailable();
  try{
   const plaintext=JSON.stringify({method,params});
   const content=mode==='nip04'?nip04.encrypt(key,parsed.walletPubkey,plaintext):nip44.v2.encrypt(plaintext,conversation);
   const created_at=Math.floor(now()/1000),event=finalizeEvent({kind:23194,created_at,tags:[['p',parsed.walletPubkey],['encryption',mode],['expiration',String(created_at+30)]],content},key);
   const response=signed(await transport(parsed.relayUrl,event,{walletPubkey:parsed.walletPubkey,clientPubkey:parsed.clientPubkey}),parsed.walletPubkey,23195);
   if(oneTag(response,'e')!==event.id||oneTag(response,'p')!==parsed.clientPubkey||response.created_at<event.created_at-5||response.created_at>Math.floor(now()/1000)+60)throw unavailable();
   const tag=oneTag(response,'encryption');if(tag!==undefined&&tag!==mode)throw unavailable();
   const decrypted=mode==='nip04'?nip04.decrypt(key,parsed.walletPubkey,response.content):nip44.v2.decrypt(response.content,conversation);
   if(Buffer.byteLength(decrypted)>48*1024)throw unavailable();
   const body=JSON.parse(decrypted);
   if(!object(body)||body.result_type!==method||body.error!==undefined&&body.error!==null||!object(body.result))throw unavailable();return body.result;
  }catch{throw unavailable();}
 }
 let verified:Promise<Encryption>|undefined;
 async function ready():Promise<Encryption>{
  if(!verified)verified=(async()=>{
   if(typeof transport.info!=='function')throw unavailable();
   const event=signed(await transport.info(parsed.relayUrl,parsed.walletPubkey),parsed.walletPubkey,13194);
   if(event.created_at>Math.floor(now()/1000)+60||!methods.every(method=>event.content.split(' ').includes(method)))throw unavailable();
   const mode=modeFor(event),info=await call('get_info',{},mode);
   if(info.network!=='mainnet'||!Array.isArray(info.methods)||!methods.every(method=>info.methods.includes(method)))throw unavailable();
   return mode;
  })().catch(error=>{verified=undefined;throw error;});
  return verified;
 }
 return {parsed,call,ready,now};
}
/** Reads signed wallet metadata only. Supported methods do not prove grant scopes. */
export async function verifyNwcReceiving(config:NwcReceivingConfig):Promise<{network:'mainnet';encryption:Encryption}> {
 const c=client(config);return {network:'mainnet',encryption:await c.ready()};
}
function snapshot(context:ReceivingContext,connection:ParsedNwcConnection,now:number):string {
 if(context.mode!=='live'||context.method!=='lightning'||!['CAD','USD','EUR','GBP','KRW','SAT'].includes(context.currency)||!integer(context.amount)||context.amount<=0||typeof context.expectedAtomic!=='string'||!/^[1-9][0-9]{0,15}$/.test(context.expectedAtomic)||BigInt(context.expectedAtomic)*1000n>BigInt(Number.MAX_SAFE_INTEGER)||context.currency==='SAT'&&context.expectedAtomic!==String(context.amount))throw unavailable();
 if(typeof context.requestId!=='string'||!/^[A-Za-z0-9._:-]{1,192}$/.test(context.requestId)||typeof context.idempotencyKey!=='string'||!/^[A-Za-z0-9._:-]{1,192}$/.test(context.idempotencyKey))throw unavailable();
 const start=Date.parse(context.createdAt),end=Date.parse(context.expiresAt);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>7*86400000||start>now+60000)throw unavailable();
 return sha(JSON.stringify([context.requestId,context.idempotencyKey,context.method,context.amount,context.currency,context.expectedAtomic,context.createdAt,context.expiresAt,context.mode,connection.walletPubkey,connection.clientPubkey,connection.relayUrl]));
}
interface InvoiceDetails {hash:string;created:number;expires:number}
function decodeInvoice(value:unknown,context:ReceivingContext,now:number):InvoiceDetails {
 try{
  if(typeof value!=='string'||value.length>20000||!/^lnbc[0-9a-z]+$/.test(value))throw unavailable();
  const parsed=bolt11.decode(value);
  if(bolt11.encode(parsed,false).paymentRequest!==value||parsed.complete!==true||parsed.network?.bech32!=='bc'||parsed.millisatoshis!==(BigInt(context.expectedAtomic)*1000n).toString())throw unavailable();
  const tags=(name:string)=>parsed.tags.filter(tag=>tag.tagName===name),p=tags('payment_hash'),expiry=tags('expire_time');
  if(p.length!==1||!hex(p[0].data)||expiry.length>1||tags('payee_node_key').length>1||tags('feature_bits').length>1||tags('description').length+tags('purpose_commit_hash').length!==1)throw unavailable();
  if(tags('feature_bits').some(t=>object(t.data)&&(t.data as Record<string,any>).extra_bits?.has_required===true))throw unavailable();
  const seconds=expiry.length?expiry[0].data:3600,created=parsed.timestamp;
  if(!integer(created)||created<Math.floor(Date.parse(context.createdAt)/1000)||created>Math.floor(now/1000)+5||!integer(seconds)||seconds<=0||seconds>7*86400||!Number.isSafeInteger(created+seconds))throw unavailable();
  return {hash:p[0].data,created,expires:created+seconds};
 }catch{throw unavailable();}
}
/** Keep only exact receiving fields; metadata, preimages and secrets never leave this module. */
export function createNwcReceivingAdapter(config:NwcReceivingConfig&{id:string}):ReceivingAdapter {
 if(typeof config.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(config.id))throw invalid();
 const c=client(config),entries=new Map<string,{binding:string;attempted:boolean;task?:Promise<ReceivingIntent>;intent?:ReceivingIntent}>();
 function details(intent:ReceivingIntent,context:ReceivingContext){
  const binding=snapshot(context,c.parsed,c.now()),opaque=intent.opaque;
  if(!object(opaque)||opaque.binding!==binding||opaque.walletPubkey!==c.parsed.walletPubkey||opaque.clientPubkey!==c.parsed.clientPubkey||intent.network!=='mainnet'||intent.asset!=='BTC'||typeof intent.request!=='string'||!intent.request.startsWith('lightning:'))throw unavailable();
  const decoded=decodeInvoice(intent.request.slice(10),context,c.now());
  if(intent.providerId!==decoded.hash||opaque.hash!==decoded.hash||intent.allocationKey!==`lightning:mainnet:${c.parsed.walletPubkey}:${decoded.hash}`||intent.expiresAt!==new Date(Math.min(decoded.expires*1000,Date.parse(context.expiresAt))).toISOString())throw unavailable();
  return decoded;
 }
 function validTransaction(result:Record<string,any>,context:ReceivingContext,invoice:string,decoded:InvoiceDetails){
  if(result.type!=='incoming'||result.invoice!==undefined&&result.invoice!==null&&result.invoice!==invoice||result.payment_hash!==decoded.hash||result.amount!==Number(BigInt(context.expectedAtomic)*1000n))throw unavailable();
  if(result.created_at!==undefined&&(!integer(result.created_at)||result.created_at<Math.floor(Date.parse(context.createdAt)/1000)||result.created_at>Math.floor(c.now()/1000)+5))throw unavailable();
  if(result.expires_at!==undefined&&result.expires_at!==null&&result.expires_at!==decoded.expires)throw unavailable();
 }
 return {id:config.id,mode:'live',methods:['lightning'],walletOptionIds:['nwc'],label:'Nostr Wallet Connect',
  async create(input){
   const context=structuredClone(input),binding=snapshot(context,c.parsed,c.now());if(Date.parse(context.expiresAt)<=c.now())throw unavailable();
   let entry=entries.get(context.requestId);
   if(entry){if(entry.binding!==binding)throw recovery();if(entry.intent)return structuredClone(entry.intent);if(entry.task)return structuredClone(await entry.task);if(entry.attempted)throw recovery();}
   else{if(entries.size>=128)throw recovery();entry={binding,attempted:false};entries.set(context.requestId,entry);}
   const current=entry;
   current.task=(async()=>{
    const mode=await c.ready();if(Date.parse(context.expiresAt)<=c.now())throw unavailable();current.attempted=true;
    const result=await c.call('make_invoice',{amount:Number(BigInt(context.expectedAtomic)*1000n),description:`Quiet Ledger ${context.requestId}`,expiry:Math.max(1,Math.floor((Date.parse(context.expiresAt)-c.now())/1000))},mode);
    const decoded=decodeInvoice(result.invoice,context,c.now());validTransaction(result,context,result.invoice,decoded);
    if(Math.min(decoded.expires*1000,Date.parse(context.expiresAt))<=c.now()||result.settled_at!==undefined&&result.settled_at!==null||result.state!==undefined&&result.state!=='pending')throw unavailable();
    const intent:ReceivingIntent={providerId:decoded.hash,request:'lightning:'+result.invoice,network:'mainnet',asset:'BTC',cashuWalletHandoff:true,expiresAt:new Date(Math.min(decoded.expires*1000,Date.parse(context.expiresAt))).toISOString(),allocationKey:`lightning:mainnet:${c.parsed.walletPubkey}:${decoded.hash}`,opaque:{binding,walletPubkey:c.parsed.walletPubkey,clientPubkey:c.parsed.clientPubkey,hash:decoded.hash}};
    current.intent=structuredClone(intent);return intent;
   })();
   try{return structuredClone(await current.task);}catch{if(!current.attempted)entries.delete(context.requestId);throw unavailable();}finally{current.task=undefined;}
  },
  async recover(context){const entry=entries.get(context.requestId);if(!entry||entry.binding!==snapshot(context,c.parsed,c.now())||!entry.intent)throw recovery();return structuredClone(entry.intent);},
  async check(input,saved):Promise<ReceivingObservation>{
   const context=structuredClone(input),intent=structuredClone(saved);let decoded:InvoiceDetails;
   try{decoded=details(intent,context);if(c.now()>=Math.min(decoded.expires*1000,Date.parse(context.expiresAt)))return {status:'review',reason:'This NWC invoice expired. Check the original payment in the receiving wallet; automatic late confirmation is unavailable.'};}catch{return {status:'review',reason:review};}
   let result:Record<string,any>;
   try{result=await c.call('lookup_invoice',{payment_hash:decoded.hash},await c.ready());}catch{throw unavailable();}
   try{
    validTransaction(result,context,intent.request!.slice(10),decoded);
    // A wallet may report its creation time as settled_at. A lookup finishing
    // outside the original window therefore cannot authorize automatic credit.
    if(c.now()>=Math.min(decoded.expires*1000,Date.parse(context.expiresAt)))throw unavailable();
    const settled=result.settled_at!==undefined&&result.settled_at!==null;
    if(result.state!==undefined&&(!['pending','accepted','settled'].includes(result.state)||(result.state==='settled')!==settled))throw unavailable();
    if(!settled)return {status:'pending'};
    if(!integer(result.settled_at)||result.settled_at<Math.floor(Date.parse(context.createdAt)/1000)||result.settled_at>Math.floor(c.now()/1000)+5||result.settled_at>decoded.expires||result.settled_at*1000>Date.parse(context.expiresAt))throw unavailable();
    if(result.preimage!==undefined&&result.preimage!==null&&(!hex(result.preimage)||sha(Buffer.from(result.preimage,'hex'))!==decoded.hash))throw unavailable();
    return {status:'paid',paymentId:`lightning:mainnet:${decoded.hash}`,reference:context.requestId,amount:context.amount,currency:context.currency};
   }catch{return {status:'review',reason:review};}
  }
 };
}
