import * as sdk from '@cashu/cashu-ts-browser';
import {secp256k1} from '@noble/curves/secp256k1.js';

/** Browser-only bearer material. Never send this object to the application server. */
export interface PreparedCashuMelt {
 id:string;mint:string;invoice:string;paymentHash:string;invoiceSats:number;inputSats:number;inputFeeSats:number;
 feeReserveSats:number;maxDebitSats:number;expiresAt:number;inputTags:string[];
 private:{quote:Record<string,unknown>;inputs:Record<string,unknown>[];outputData:sdk.SerializedOutputData[];keysets:SavedKeyset[]};
}
interface SavedKeyset {id:string;unit:string;active:boolean;input_fee_ppk:number;final_expiry?:number;keys:Record<string,string>}
export interface CashuMeltResult {state:'pending'|'paid'|'unpaid'|'unknown';changeToken?:string;changeSats?:number;changePending?:boolean;actualDebitSats?:number}
export interface CashuMeltOptions {request?:sdk.RequestFn;now?:()=>number}
export class CashuMeltError extends Error {constructor(public readonly code='CASHU_INVALID'){super('The Cashu payment could not be safely prepared. Check the token, invoice and fee limit.');this.name='CashuMeltError';}}
import {CASHU_BROWSER_MINTS} from '../shared/cashu-browser-mints.js';
const MINTS:readonly string[]=CASHU_BROWSER_MINTS;
const enc=new TextEncoder(),MAX=100_000_000,MAX_BYTES=262144;
const fail=():never=>{throw new CashuMeltError();};
const object=(x:unknown):x is Record<string,any>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const integer=(x:unknown,min=0,max=MAX):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=min&&x<=max;
const number=(x:unknown,min=0,max=MAX)=>{if(x instanceof sdk.Amount)x=x.toString();const n=typeof x==='string'&&/^(0|[1-9][0-9]*)$/.test(x)?Number(x):x;if(!integer(n,min,max))return fail();return n;};
const hex=(b:Uint8Array)=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const unhex=(s:string)=>Uint8Array.from(s.match(/../g)??[],x=>parseInt(x,16));
const sha=async(x:string|Uint8Array)=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof x==='string'?enc.encode(x):x as BufferSource)));
const clone=<T>(x:T):T=>JSON.parse(JSON.stringify(x,(_k,v)=>typeof v==='bigint'?v.toString():v));
const unknown=():CashuMeltResult=>({state:'unknown'});
function wordsToBytes(words:number[],pad=false){let acc=0,bits=0;const out:number[]=[];for(const w of words){acc=(acc<<5)|w;bits+=5;while(bits>=8){bits-=8;out.push((acc>>bits)&255);}}if(pad&&bits)out.push((acc<<(8-bits))&255);else if(bits>=5||((acc<<(8-bits))&255)!==0)fail();return Uint8Array.from(out);}
/** Signed canonical mainnet BOLT11, amount and expiry; browser crypto only. */
export function invoiceCashuAmount(invoice:string,now:()=>number=Date.now):{invoiceSats:number;paymentHash:string;expiresAt:number} {
 try{
  if(typeof invoice!=='string'||invoice.length>8192||invoice!==invoice.toLowerCase())return fail();
  const at=invoice.lastIndexOf('1'),hrp=invoice.slice(0,at),match=/^lnbc([1-9][0-9]*)([munp]?)$/.exec(hrp);if(!match)return fail();
  const alphabet='qpzry9x8gf2tvdw0s3jn54khce6mua7l',words=Array.from(invoice.slice(at+1),c=>alphabet.indexOf(c));if(words.length<117||words.some(w=>w<0))return fail();
  let chk=1;const step=(v:number)=>{const top=chk>>>25;chk=((chk&0x1ffffff)<<5)^v;for(let i=0;i<5;i++)if((top>>>i)&1)chk^=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3][i];};for(const c of hrp)step(c.charCodeAt(0)>>>5);step(0);for(const c of hrp)step(c.charCodeAt(0)&31);for(const w of words)step(w);if(chk!==1)return fail();
  const body=words.slice(0,-6),data=body.slice(0,-104),sig=wordsToBytes(body.slice(-104));if(sig.length!==65||sig[64]>3)return fail();
  let timestamp=0;for(const w of data.slice(0,7))timestamp=timestamp*32+w;let paymentHash='',expiry=3600,payee='';const seen=new Set<number>();
  for(let i=7;i<data.length;){const tag=data[i++],length=data[i++]*32+data[i++];if(!Number.isInteger(length)||i+length>data.length)return fail();const value=data.slice(i,i+length);i+=length;if([1,6,19].includes(tag)){if(seen.has(tag))return fail();seen.add(tag);}if(tag===1){const b=wordsToBytes(value);if(b.length!==32)return fail();paymentHash=hex(b);}if(tag===6){if(!value.length||value.length>7)return fail();expiry=value.reduce((a,w)=>a*32+w,0);}if(tag===19){const b=wordsToBytes(value);if(b.length!==33)return fail();payee=hex(b);}}
  if(!paymentHash)return fail();
  const n=BigInt(match[1]),mult:Record<string,bigint>={'':100_000_000_000n,m:100_000_000n,u:100_000n,n:100n,p:1n};const pico=n*mult[match[2]],msat=match[2]==='p'?pico/10n:pico;if(match[2]==='p'&&pico%10n)return fail();if(msat%1000n)return fail();const sats=Number(msat/1000n);if(!integer(sats,1))return fail();
  const prefix=enc.encode(hrp),tail=wordsToBytes(data,true),message=new Uint8Array(prefix.length+tail.length);message.set(prefix);message.set(tail,prefix.length);
  // computeMessageDigest hashes strings only; Noble's prehash applies SHA-256 to these exact bytes.
  const compact=sig.slice(0,64),recovered=secp256k1.recoverPublicKey(Uint8Array.from([sig[64],...compact]),message,{prehash:true});if(!secp256k1.verify(compact,message,recovered,{prehash:true,lowS:false})||payee&&payee!==hex(recovered))return fail();
  const expiresAt=(timestamp+expiry)*1000;if(!Number.isSafeInteger(expiresAt)||expiresAt<=now()||timestamp*1000>now()+60000)return fail();return {invoiceSats:sats,paymentHash,expiresAt};
 }catch{return fail();}
}
function transport(mint:string,custom?:sdk.RequestFn):sdk.RequestFn {
 if(!MINTS.includes(mint))return fail();
 return async<T>(args:sdk.RequestOptions):Promise<T>=>{
  try{const url=new URL(args.endpoint),relative=args.endpoint.slice(mint.length);if(!args.endpoint.startsWith(mint+'/v1/')||url.username||url.password||url.hash||url.search||!(/^\/v1\/(?:keysets|keys(?:\/[0-9a-f]{16,66})?|melt\/quote\/bolt11(?:\/[A-Za-z0-9_-]{1,128})?|melt\/bolt11|restore)$/.test(relative)))return fail();
   const method=args.method??'GET';if(!['GET','POST'].includes(method)||method==='GET'&&args.requestBody!==undefined)return fail();const body=args.requestBody===undefined?undefined:JSON.stringify(args.requestBody);if(body&&enc.encode(body).length>MAX_BYTES)return fail();
   if(custom){const response=await custom<T>({...args,method,credentials:'omit',redirect:'error'});if(enc.encode(JSON.stringify(response)).length>MAX_BYTES)return fail();return response;}
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);try{const response=await fetch(url,{method,body,headers:body?{'Content-Type':'application/json','Accept':'application/json'}:{Accept:'application/json'},credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store',signal:controller.signal});if(!response.ok||!response.headers.get('content-type')?.toLowerCase().includes('application/json')||Number(response.headers.get('content-length')??0)>MAX_BYTES)return fail();const reader=response.body?.getReader();if(!reader)return fail();const parts:Uint8Array[]=[];let size=0;for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BYTES){await reader.cancel();return fail();}parts.push(value);}const bytes=new Uint8Array(size);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as T;}finally{clearTimeout(timer);}
  }catch{return fail();}
 };
}
async function call(request:sdk.RequestFn,mint:string,path:string,body?:Record<string,unknown>){return request<Record<string,any>>({endpoint:mint+path,method:body?'POST':'GET',requestBody:body});}
function checkedKeyset(meta:Record<string,any>,keys:Record<string,any>):SavedKeyset {
 if(meta.id!==keys.id||meta.unit!=='sat'||keys.unit!=='sat'||!object(keys.keys)||Object.keys(keys.keys).length>64)return fail();
 for(const field of ['input_fee_ppk','final_expiry'])if(meta[field]!==undefined&&keys[field]!==undefined&&meta[field]!==keys[field])return fail();
 const fee=meta.input_fee_ppk??keys.input_fee_ppk??0,expiry=meta.final_expiry??keys.final_expiry;
 if(!integer(fee)||expiry!==undefined&&!integer(expiry,0,10_000_000_000))return fail();
 const combined={...meta,input_fee_ppk:fee,...expiry!==undefined?{final_expiry:expiry}:{}};
 if(!sdk.Keyset.fromMintApi(combined as sdk.MintKeyset,keys as sdk.MintKeys).verify())return fail();
 return {id:meta.id,unit:'sat',active:meta.active===true,input_fee_ppk:fee,...expiry!==undefined?{final_expiry:expiry}:{},keys:keys.keys};
}
async function validateInputs(inputs:any[],keysets:SavedKeyset[]){
 if(!Array.isArray(inputs)||!inputs.length||inputs.length>64||!Array.isArray(keysets)||!keysets.length||keysets.length>65)return fail();for(const k of keysets)checkedKeyset(k,k);const seen=new Set<string>();let total=0,ppk=0;
 for(const p of inputs){if(!object(p)||typeof p.secret!=='string'||!p.secret.length||enc.encode(p.secret).length>1024||p.secret.trimStart().startsWith('[')||p.witness!==undefined||!object(p.dleq)||typeof p.C!=='string'||seen.has(p.secret))return fail();seen.add(p.secret);const amount=number(p.amount,1),k=keysets.find(k=>k.id===p.id);if(!k||k.unit!=='sat'||!integer(k.input_fee_ppk)||!k.keys[String(amount)]||(BigInt(amount)&(BigInt(amount)-1n))!==0n)return fail();sdk.pointFromHex(p.C);sdk.pointFromHex(k.keys[String(amount)]);if(!sdk.verifyDleqIfPresent({...p,amount:sdk.Amount.from(amount)} as sdk.Proof,k))return fail();total+=amount;ppk+=k.input_fee_ppk;if(!integer(total,1)||!integer(ppk,0,6_400_000))return fail();}
 return {inputSats:total,inputFeeSats:Math.ceil(ppk/1000)};
}
export async function prepareCashuMelt(args:{token:string;invoice:string;maxFeeSats:number}&CashuMeltOptions):Promise<PreparedCashuMelt>{
 try{const now=args.now??Date.now,facts=invoiceCashuAmount(args.invoice,now);if(!integer(args.maxFeeSats,0,10000)||typeof args.token!=='string'||enc.encode(args.token).length>65536||!/^(cashuA|cashuB)[A-Za-z0-9_-]+={0,2}$/.test(args.token))return fail();const metadata=sdk.getTokenMetadata(args.token);if(!MINTS.includes(metadata.mint)||metadata.unit!=='sat'||metadata.incompleteProofs.length<1||metadata.incompleteProofs.length>64||!integer(number(metadata.amount),1))return fail();const request=transport(metadata.mint,args.request),meta=await call(request,metadata.mint,'/v1/keysets');if(!Array.isArray(meta.keysets)||meta.keysets.length>128)return fail();const token=sdk.getDecodedToken(args.token,meta.keysets.map((k:any)=>k.id));const ids=[...new Set(token.proofs.map(p=>p.id))];if(ids.length>64)return fail();const active=meta.keysets.find((k:any)=>k.active===true&&k.unit==='sat');if(!active||typeof active.id!=='string')return fail();ids.push(active.id);const keysets:SavedKeyset[]=[];
 for(const id of new Set(ids)){if(!/^[0-9a-f]{16,66}$/.test(id))return fail();const m=meta.keysets.find((k:any)=>k.id===id&&k.unit==='sat');if(!m||!integer(m.input_fee_ppk??0))return fail();const response=await call(request,token.mint,'/v1/keys/'+id),k=response.keysets?.find((k:any)=>k.id===id&&k.unit==='sat');if(!k)return fail();keysets.push(checkedKeyset(m,k));}
 const inputs=clone(token.proofs) as unknown as Record<string,unknown>[],amounts=await validateInputs(inputs,keysets),quote=await call(request,token.mint,'/v1/melt/quote/bolt11',{request:args.invoice,unit:'sat'});if(typeof quote.quote!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(quote.quote)||quote.state!=='UNPAID'||quote.unit!==undefined&&quote.unit!=='sat'||number(quote.amount,1)!==facts.invoiceSats||quote.request!==undefined&&quote.request!==args.invoice)return fail();const feeReserveSats=number(quote.fee_reserve),expiresAt=Math.min(facts.expiresAt,number(quote.expiry,1,10_000_000_000)*1000),maxDebitSats=facts.invoiceSats+amounts.inputFeeSats+feeReserveSats;if(expiresAt<=now()||amounts.inputFeeSats+feeReserveSats>args.maxFeeSats||maxDebitSats>amounts.inputSats)return fail();const change=amounts.inputSats-facts.invoiceSats,outputData=Array.from({length:change>0?Math.max(1,Math.ceil(Math.log2(change))):0},()=>sdk.OutputData.serialize(sdk.OutputData.createSingleRandomData(0,active.id)));
 const inputTags=await Promise.all(inputs.map(p=>sha(token.mint+'\u0000'+p.secret)));return {id:crypto.randomUUID(),mint:token.mint,invoice:args.invoice,paymentHash:facts.paymentHash,invoiceSats:facts.invoiceSats,...amounts,feeReserveSats,maxDebitSats,expiresAt,inputTags,private:{quote:clone(quote),inputs,outputData,keysets}};
 }catch{return fail();}
}
async function preparedFacts(p:PreparedCashuMelt,now:()=>number,checkExpiry:boolean){
 if(!object(p)||!object(p.private)||!MINTS.includes(p.mint)||!Array.isArray(p.inputTags))return fail();const f=invoiceCashuAmount(p.invoice,()=>Math.min(now(),p.expiresAt-1)),a=await validateInputs(p.private.inputs,p.private.keysets);if(f.paymentHash!==p.paymentHash||f.invoiceSats!==p.invoiceSats||a.inputSats!==p.inputSats||a.inputFeeSats!==p.inputFeeSats||!integer(p.feeReserveSats)||p.maxDebitSats!==p.invoiceSats+p.inputFeeSats+p.feeReserveSats||p.maxDebitSats>p.inputSats||number(p.private.quote.amount,1)!==p.invoiceSats||number(p.private.quote.fee_reserve)!==p.feeReserveSats||typeof p.private.quote.quote!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(p.private.quote.quote)||p.expiresAt!==Math.min(f.expiresAt,number(p.private.quote.expiry,1,10_000_000_000)*1000)||checkExpiry&&p.expiresAt<=now())return fail();const tags=await Promise.all(p.private.inputs.map(proof=>sha(p.mint+'\u0000'+proof.secret)));if(JSON.stringify(tags)!==JSON.stringify(p.inputTags))return fail();if(!Array.isArray(p.private.outputData)||p.private.outputData.length>32)return fail();const outputs=p.private.outputData.map(o=>sdk.OutputData.deserialize(o));if(new Set(outputs.map(o=>o.blindedMessage.B_)).size!==outputs.length||outputs.length<(p.inputSats>p.invoiceSats?Math.max(1,Math.ceil(Math.log2(p.inputSats-p.invoiceSats))):0))return fail();for(const o of outputs){if(number(o.blindedMessage.amount)!==0||!p.private.keysets.some(k=>k.id===o.blindedMessage.id&&k.active))return fail();}return outputs;
}
function changeResult(p:PreparedCashuMelt,outputs:sdk.OutputData[],signatures:unknown):CashuMeltResult {
 const pending:CashuMeltResult={state:'paid',changePending:true};
 try {
  if(!Array.isArray(signatures)||signatures.length>outputs.length)return pending;
  const proofs:sdk.Proof[]=signatures.map((s:any,i:number)=>{
   if(!object(s)||!object(s.dleq)||s.id!==outputs[i].blindedMessage.id)return fail();
   const amount=number(s.amount,1);if((BigInt(amount)&(BigInt(amount)-1n))!==0n)return fail();
   const keyset=p.private.keysets.find(k=>k.id===s.id);if(!keyset||!keyset.keys[String(amount)])return fail();
   return outputs[i].toProof({...s,amount:sdk.Amount.from(amount)} as sdk.SerializedBlindedSignature,keyset);
  });
  if(new Set(proofs.map(proof=>proof.secret)).size!==proofs.length)return pending;
  let changeSats=0;for(const proof of proofs){const keyset=p.private.keysets.find(k=>k.id===proof.id)!;if(!sdk.verifyDleqIfPresent(proof,keyset))return pending;changeSats+=number(proof.amount,1);}
  const actualDebitSats=p.inputSats-changeSats;
  if(!integer(changeSats)||actualDebitSats<p.invoiceSats+p.inputFeeSats||actualDebitSats>p.maxDebitSats)return pending;
  return {state:'paid',changePending:false,changeSats,actualDebitSats,...proofs.length?{changeToken:sdk.getEncodedToken({mint:p.mint,unit:'sat',proofs})}:{}};
 }catch{return pending;}
}
async function result(p:PreparedCashuMelt,response:Record<string,any>,request:sdk.RequestFn,restore:boolean):Promise<CashuMeltResult>{
 if(!object(response)||response.quote!==p.private.quote.quote||response.unit!==undefined&&response.unit!=='sat'||response.amount!==undefined&&number(response.amount,1)!==p.invoiceSats||response.request!==undefined&&response.request!==p.invoice)return unknown();
 if(response.state==='PENDING')return {state:'pending'};
 if(response.state==='UNPAID')return {state:'unpaid'};
 if(response.state!=='PAID'||typeof response.payment_preimage!=='string'||!/^[0-9a-f]{64}$/.test(response.payment_preimage)||await sha(unhex(response.payment_preimage))!==p.paymentHash)return unknown();
 const outputs=p.private.outputData.map(o=>sdk.OutputData.deserialize(o));
 const change=changeResult(p,outputs,response.change??[]);
 if(!change.changePending||!restore||!outputs.length)return change;
 // Recovery reads only the original saved outputs; it never generates new secrets or repeats a melt.
 try {
  const found=await call(request,p.mint,'/v1/restore',{outputs:outputs.map(o=>o.blindedMessage)});
  if(!Array.isArray(found.outputs)||!Array.isArray(found.signatures)||found.outputs.length!==found.signatures.length||found.outputs.length>outputs.length)return change;
  const seen=new Set<string>();
  const ordered=found.outputs.map((o:any,i:number)=>{
   if(!object(o))return fail();
   const index=outputs.findIndex(output=>output.blindedMessage.B_===o.B_&&output.blindedMessage.id===o.id);
   if(index<0||seen.has(o.B_)||number(o.amount)!==0&&number(o.amount)!==number(found.signatures[i].amount,1))return fail();
   seen.add(o.B_);return {output:outputs[index],signature:found.signatures[i]};
  });
  return changeResult(p,ordered.map(pair=>pair.output),ordered.map(pair=>pair.signature));
 }catch{return change;}
}
const executed=new WeakSet<PreparedCashuMelt>();
export async function executeCashuMelt(p:PreparedCashuMelt,options:CashuMeltOptions={}):Promise<CashuMeltResult>{
 try{if(executed.has(p))return unknown();executed.add(p);const outputs=await preparedFacts(p,options.now??Date.now,true),request=transport(p.mint,options.request);const response=await call(request,p.mint,'/v1/melt/bolt11',{quote:p.private.quote.quote,inputs:p.private.inputs.map(i=>({...i,amount:number(i.amount,1)})),outputs:outputs.map(o=>({...o.blindedMessage,amount:number(o.blindedMessage.amount)}))});return await result(p,response,request,false);}catch{return unknown();}
}
export async function recoverCashuMelt(p:PreparedCashuMelt,options:CashuMeltOptions={}):Promise<CashuMeltResult>{
 try{await preparedFacts(p,options.now??Date.now,false);const request=transport(p.mint,options.request),response=await call(request,p.mint,'/v1/melt/quote/bolt11/'+p.private.quote.quote);return await result(p,response,request,true);}catch{return unknown();}
}
