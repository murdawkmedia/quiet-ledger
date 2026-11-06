import {createHash,createHmac} from 'node:crypto';
import type {MethodId} from '../shared/payment-methods.js';
import type {ReceivingAdapter,ReceivingContext,ReceivingIntent,ReceivingObservation} from '../shared/receiving.js';
import {bounded,minorAmount,type HttpFetch} from './http.js';

type BitcoinNetwork='mainnet'|'testnet'|'signet'|'regtest';
type LiquidNetwork='liquid'|'liquidtestnet'|'elementsregtest';
interface CommonConfig {id:string;mode?:'live'|'test';fetcher?:HttpFetch;allowLoopbackHttp?:boolean}
interface RpcConfig extends CommonConfig {rpcUrl:string;rpcUsername:string;rpcPassword:string;minConfirmations?:number;address?:string}
export type CryptoAdapterConfig=
  | (RpcConfig&{kind:'bitcoin-core';network?:BitcoinNetwork})
  | (RpcConfig&{kind:'liquid';network?:LiquidNetwork})
  | (CommonConfig&{kind:'lnd';network?:BitcoinNetwork;baseUrl:string;macaroonHex:string;invoiceHmacSecret:string})
  | (CommonConfig&{kind:'manual';method:Extract<MethodId,'bitcoin'|'lightning'|'liquid'|'cashu'|'ark'|'usdt'|'usdc'>;address:string;network?:string});

const review=(reason:string):ReceivingObservation=>({status:'review',reason});
const pending=(reason:string):ReceivingObservation=>({status:'pending',reason});
const hex64=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const object=(value:unknown):value is Record<string,any>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
function nativeAtomic(value:unknown):bigint {
  if(typeof value!=='string'||!/^[1-9][0-9]{0,15}$/.test(value))throw new Error('Native amount must be a positive atomic-unit integer.');
  const result=BigInt(value);if(result>2_100_000_000_000_000n)throw new Error('Native amount is too large.');return result;
}
function integer(value:unknown):bigint|null {
  if(typeof value==='string'&&/^(0|[1-9][0-9]{0,17})$/.test(value))return BigInt(value);
  if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)return BigInt(value);
  return null;
}
function btcAtomic(value:unknown):bigint|null {
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>21_000_000)return null;
  const decimal=value.toFixed(8);if(Number(decimal)!==value)return null;
  return BigInt(decimal.replace('.',''));
}
function nativeText(value:bigint,places:number):string {const padded=value.toString().padStart(places+1,'0');return `${padded.slice(0,-places)}.${padded.slice(-places)}`;}
function binding(context:ReceivingContext):string {return digest(JSON.stringify([context.requestId,context.method,context.expectedAtomic,context.amount,context.currency,context.createdAt,context.expiresAt,context.mode]));}
function validateContext(context:ReceivingContext,method:MethodId,mode:'live'|'test'):void {
  bounded(context.requestId,'receive request',192);bounded(context.idempotencyKey,'retry key',192);minorAmount(context.amount);nativeAtomic(context.expectedAtomic);
  if(context.method!==method)throw new Error('Receiving method does not match this adapter.');
  if(context.mode!==mode)throw new Error('Receiving mode does not match this adapter.');
  if(!['CAD','USD','EUR','GBP','KRW'].includes(context.currency))throw new Error('Invalid invoice currency.');
  const start=Date.parse(context.createdAt),end=Date.parse(context.expiresAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>7*86400_000)throw new Error('Invalid receiving time window.');
}
function inWindow(value:unknown,context:ReceivingContext):boolean {
  // Node timestamps have one-second precision. Baseline exclusion/fresh invoice hashes
  // bind the starting second; the ambiguous final second always requires review.
  const date=integer(value);return date!==null&&date>=BigInt(Math.floor(Date.parse(context.createdAt)/1000))&&date<BigInt(Math.floor(Date.parse(context.expiresAt)/1000));
}
function trustedUrl(raw:string,allowLoopbackHttp:boolean):string {
  let url:URL;try{url=new URL(raw);}catch{throw new Error('Invalid configured crypto endpoint.');}
  const loopback=['127.0.0.1','[::1]','localhost'].includes(url.hostname);
  if(url.username||url.password||url.hash||url.search||!(url.protocol==='https:'||(url.protocol==='http:'&&loopback&&allowLoopbackHttp)))throw new Error('Crypto endpoint requires HTTPS or explicitly allowed loopback HTTP, without URL credentials.');
  return url.toString().replace(/\/$/,'');
}
class TransportError extends Error {constructor(readonly status?:number,readonly code?:number){super('Crypto provider request unavailable; reconcile the existing request before retrying.');}}
async function json(fetcher:HttpFetch,url:string,init:RequestInit):Promise<any>{
  let result:Response;try{result=await fetcher(url,{...init,redirect:'error',signal:AbortSignal.timeout(10_000)});}catch{throw new TransportError();}
  // Never include URLs, response bodies or error messages: they may contain credentials/preimages.
  let body:any;try{const raw=await result.text();if(raw.length>1_000_000)throw new Error();body=JSON.parse(raw);}catch{throw new TransportError(result.status);}
  if(!result.ok)throw new TransportError(result.status,typeof body?.code==='number'?body.code:typeof body?.error?.code==='number'?body.error.code:undefined);
  return body;
}
function paid(context:ReceivingContext,paymentId:string):ReceivingObservation {return {status:'paid',paymentId,amount:context.amount,currency:context.currency,reference:context.requestId};}
function assertIntent(context:ReceivingContext,intent:ReceivingIntent,kind:string,network:string,asset:string,providerId:string):void {
  if(intent.providerId!==providerId||intent.network!==network||intent.asset!==asset||intent.opaque?.binding!==binding(context)||intent.opaque?.kind!==kind)throw new Error('Receiving intent binding mismatch.');
}
function serialCreation():<T>(key:string,fingerprint:string,fn:()=>Promise<T>)=>Promise<T> {
  const active=new Map<string,{fingerprint:string;task:Promise<unknown>}>();
  return async<T>(key:string,fingerprint:string,fn:()=>Promise<T>):Promise<T>=>{
    const current=active.get(key);if(current){if(current.fingerprint!==fingerprint)throw new Error('Receiving request creation conflicts with the existing request snapshot.');return current.task as Promise<T>;}
    const task=fn();active.set(key,{fingerprint,task});try{return await task;}finally{active.delete(key);}
  };
}

/** Receive/watch only. The adapter never imports secrets, signs, spends, trades or locks coins. */
export function createCryptoAdapter(config:CryptoAdapterConfig):ReceivingAdapter {
  bounded(config.id,'crypto adapter id',80);if(!/^[a-zA-Z0-9_-]+$/.test(config.id))throw new Error('Invalid crypto adapter id.');
  const mode=config.mode??'live';if(!['live','test'].includes(mode))throw new Error('Invalid receiving mode.');
  if(config.kind==='manual')return manualAdapter(config,mode);
  if(config.kind==='lnd')return lndAdapter(config,mode);
  if(config.kind!=='bitcoin-core'&&config.kind!=='liquid')throw new Error('Unsupported crypto adapter kind.');
  return rpcAdapter(config,mode);
}

function rpcAdapter(config:Extract<CryptoAdapterConfig,{kind:'bitcoin-core'|'liquid'}>,mode:'live'|'test'):ReceivingAdapter {
  const liquid=config.kind==='liquid',method=liquid?'liquid':'bitcoin',asset=liquid?'L-BTC':'BTC';
  const network=config.network??(liquid?'liquid':'mainnet');
  const chains:Record<string,string>=liquid?{liquid:'liquidv1',liquidtestnet:'liquidtestnet',elementsregtest:'elementsregtest'}:{mainnet:'main',testnet:'test',signet:'signet',regtest:'regtest'};
  if(!chains[network]||(mode==='live')!==(network===(liquid?'liquid':'mainnet')))throw new Error('Crypto mode and configured network must agree.');
  const url=trustedUrl(config.rpcUrl,config.allowLoopbackHttp===true),fetcher=config.fetcher??fetch;
  bounded(config.rpcUsername,'RPC username',256);bounded(config.rpcPassword,'RPC password',4096);
  if(config.address)bounded(config.address,'watch destination',300);
  const confirmations=config.minConfirmations??(liquid?2:1);if(!Number.isSafeInteger(confirmations)||confirmations<1||confirmations>144)throw new Error('Minimum confirmations must be between 1 and 144.');
  const headers={'Content-Type':'application/json',Authorization:`Basic ${Buffer.from(`${config.rpcUsername}:${config.rpcPassword}`).toString('base64')}`};
  let sequence=0;
  async function rpc(method:string,params:unknown[]=[]):Promise<any>{
    const id=++sequence,body=await json(fetcher,url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'1.0',id,method,params})});
    if(!object(body)||body.id!==id)throw new TransportError();
    if(body.error!==null&&body.error!==undefined)throw new TransportError(undefined,typeof body.error?.code==='number'?body.error.code:undefined);
    if(!Object.hasOwn(body,'result'))throw new TransportError();return body.result;
  }
  async function health():Promise<void>{
    const info=await rpc('getblockchaininfo');
    if(!object(info)||info.chain!==chains[network])throw new Error('Configured crypto network does not match the node.');
    if(info.initialblockdownload!==false||typeof info.verificationprogress!=='number'||info.verificationprogress<0.999||!Number.isSafeInteger(info.blocks)||info.blocks<0||info.headers!==info.blocks||!hex64(info.bestblockhash))throw new Error('Crypto node has not completed chain synchronization.');
    const wallet=await rpc('getwalletinfo');
    if(!object(wallet)||wallet.scanning!==false||!object(wallet.lastprocessedblock)||wallet.lastprocessedblock.hash!==info.bestblockhash||wallet.lastprocessedblock.height!==info.blocks)throw new Error('Crypto receiving wallet synchronization cannot be established.');
  }
  async function destination(address:string,label?:string):Promise<{address:string;script:string}>{
    const info=await rpc('getaddressinfo',[address]);
    if(!object(info)||info.address!==address||(info.ismine!==true&&info.iswatchonly!==true)||typeof info.scriptPubKey!=='string'||!/^[0-9a-f]{4,10000}$/.test(info.scriptPubKey))throw new Error('Configured destination is not a recognized receiving/watch address.');
    if(label&&(!Array.isArray(info.labels)||!info.labels.some((row:any)=>row===label||row?.name===label)))throw new Error('Receiving address does not belong to this request label.');
    return {address,script:info.scriptPubKey};
  }
  async function received(address:string):Promise<{amount:unknown;txids:string[]}>{
    const rows=await rpc('listreceivedbyaddress',liquid?[0,true,true,address,'bitcoin']:[0,true,true,address]);
    if(!Array.isArray(rows)||rows.length>1)throw new Error('Invalid receiving history.');
    if(rows.length===0)return {amount:0,txids:[]};const row=rows[0];
    if(!object(row)||row.address!==address||!Array.isArray(row.txids)||row.txids.length>256||!row.txids.every(hex64)||new Set(row.txids).size!==row.txids.length)throw new Error('Invalid receiving history.');
    return {amount:row.amount,txids:row.txids};
  }
  const createOnce=serialCreation();
  const labelFor=(context:ReceivingContext)=>`quiet-ledger:${binding(context)}`;
  return {
    id:config.id,methods:[method],mode,
    async create(context){
      validateContext(context,method,mode);return createOnce(context.requestId,binding(context),async()=>{
        await health();const label=labelFor(context);let address=config.address;
        if(!address){
          let existing:any;try{existing=await rpc('getaddressesbylabel',[label]);}catch(error){if(!(error instanceof TransportError)||error.code!==-11)throw error;existing={};}
          if(!object(existing))throw new Error('Invalid receiving label response.');const entries=Object.entries(existing);
          if(entries.length>1||entries.some(([,data])=>!object(data)||data.purpose!=='receive'))throw new Error('Receiving label allocation is ambiguous.');
          address=entries.length?entries[0][0]:await rpc('getnewaddress',[label,'bech32']);
        }
        bounded(address!,'receive destination',300);const dest=await destination(address!,config.address?undefined:label),baseline=await received(address!);
        return {providerId:label,request:liquid?undefined:`bitcoin:${dest.address}?amount=${nativeText(nativeAtomic(context.expectedAtomic),8)}`,network,asset,allocationKey:`${liquid?'liquid':'bitcoin'}:${network}:${dest.script}`,instructions:[{label:'Receive destination',value:dest.address},{label:'Native amount',value:`${nativeText(nativeAtomic(context.expectedAtomic),8)} ${asset}`},{label:'Network',value:network},...(liquid?[{label:'Verification',value:'Confidential Liquid amount and asset require owner review.'}]:[])],opaque:{kind:config.kind,binding:binding(context),address:dest.address,script:dest.script,baselineTxids:baseline.txids}};
      });
    },
    async check(context,intent){
      try{
        validateContext(context,method,mode);assertIntent(context,intent,config.kind,network,asset,labelFor(context));
        await health();const address=intent.opaque?.address,script=intent.opaque?.script,baseline=intent.opaque?.baselineTxids;
        if(typeof address!=='string'||!Array.isArray(baseline)||!baseline.every(hex64))return review('Receiving allocation is incomplete.');
        const dest=await destination(address,config.address?undefined:labelFor(context));
        if(dest.script!==script||intent.allocationKey!==`${liquid?'liquid':'bitcoin'}:${network}:${script}`||(config.address&&address!==config.address))return review('Receiving destination binding mismatch.');
        const history=await received(address);
        if(history.txids.length===0)return Date.now()>Date.parse(context.expiresAt)?review('Receive request expired without verified payment.'):pending('No native payment observed.');
        if(history.txids.some(tx=>baseline.includes(tx)))return review('Previously observed outputs require owner review.');
        // Elements RPC variants and blinded outputs cannot prove the exact native asset here.
        // Read the wallet transaction, but never promote an opaque/confidential amount to paid.
        if(liquid){for(const tx of history.txids.slice(0,4))await rpc('gettransaction',[tx,true,false,'bitcoin']);return review('Liquid receipt observed; confidential amount, asset and destination require owner review.');}
        const expected=nativeAtomic(context.expectedAtomic),total=btcAtomic(history.amount);
        if(total===null||total!==expected)return review('Native payment amount differs from the exact request.');
        if(history.txids.length!==1)return review('Multiple transactions require owner review.');
        const id=history.txids[0],tx=await rpc('gettransaction',[id,true]);
        if(!object(tx)||tx.txid!==id||!Number.isSafeInteger(tx.confirmations)||tx.confirmations<0||!Array.isArray(tx.walletconflicts)||tx.walletconflicts.length||tx.generated===true||!Array.isArray(tx.details)||tx.details.length>256)return review('Transaction state is incomplete or conflicted.');
        if(!inWindow(tx.timereceived,context)||!inWindow(tx.time,context))return review('Payment falls outside the receiving time window.');
        const outputs=tx.details.filter((row:any)=>row?.address===address);
        if(!outputs.length||outputs.some((row:any)=>row.category!=='receive'||!Number.isSafeInteger(row.vout)||row.vout<0||btcAtomic(row.amount)===null)||new Set(outputs.map((row:any)=>row.vout)).size!==outputs.length||outputs.reduce((sum:bigint,row:any)=>sum+btcAtomic(row.amount)!,0n)!==expected)return review('Transaction output does not match the exact destination and amount.');
        if(tx.confirmations<confirmations)return pending('Waiting for required native confirmations.');
        if(!hex64(tx.blockhash)||!inWindow(tx.blocktime,context))return review('Payment confirmation falls outside the receiving time window.');
        return paid(context,`bitcoin:${network}:${id}:${outputs.map((row:any)=>row.vout).sort((a:number,b:number)=>a-b).join('-')}`);
      }catch{return review('Authoritative native verification is unavailable or the request binding differs.');}
    },
  };
}

function lndAdapter(config:Extract<CryptoAdapterConfig,{kind:'lnd'}>,mode:'live'|'test'):ReceivingAdapter {
  const network=config.network??'mainnet';if(!['mainnet','testnet','signet','regtest'].includes(network)||(mode==='live')!==(network==='mainnet'))throw new Error('Lightning mode and configured network must agree.');
  const url=trustedUrl(config.baseUrl,config.allowLoopbackHttp===true),fetcher=config.fetcher??fetch;
  if(!/^(?:[a-fA-F0-9]{2}){16,4096}$/.test(config.macaroonHex))throw new Error('Invalid LND credential.');
  bounded(config.invoiceHmacSecret,'stable invoice secret',4096);if(config.invoiceHmacSecret.length<32)throw new Error('Stable invoice secret must contain at least 32 characters.');
  const headers={'Content-Type':'application/json','Grpc-Metadata-macaroon':config.macaroonHex};
  const get=(path:string)=>json(fetcher,`${url}${path}`,{method:'GET',headers});
  const secretFor=(context:ReceivingContext)=>createHmac('sha256',config.invoiceHmacSecret).update(`quiet-ledger:lnd:${config.id}:${binding(context)}`).digest();
  const hashFor=(context:ReceivingContext)=>createHash('sha256').update(secretFor(context)).digest('hex');
  const memoFor=(context:ReceivingContext)=>`Quiet Ledger ${binding(context)}`;
  async function node():Promise<string>{
    const info=await get('/v1/getinfo');
    if(!object(info)||!Array.isArray(info.chains)||info.chains.length!==1||info.chains[0]?.chain!=='bitcoin'||info.chains[0]?.network!==network)throw new Error('Configured Lightning network does not match the node.');
    if(info.synced_to_chain!==true)throw new Error('Lightning node has not completed chain synchronization.');
    if(typeof info.identity_pubkey!=='string'||!/^(02|03)[0-9a-f]{64}$/.test(info.identity_pubkey))throw new Error('Invalid Lightning destination.');return info.identity_pubkey;
  }
  function invoiceValid(invoice:any,context:ReceivingContext):boolean{
    const expected=nativeAtomic(context.expectedAtomic),hash=hashFor(context);
    return object(invoice)&&invoice.r_hash===Buffer.from(hash,'hex').toString('base64')&&invoice.memo===memoFor(context)&&integer(invoice.value)===expected&&integer(invoice.value_msat)===expected*1000n&&typeof invoice.payment_request==='string'&&invoice.payment_request.length<=12000&&invoice.payment_request.startsWith(network==='mainnet'?'lnbc':network==='regtest'?'lnbcrt':'lntb')&&integer(invoice.expiry)!==null&&integer(invoice.expiry)!>0n&&integer(invoice.expiry)!<=604800n&&inWindow(invoice.creation_date,context)&&invoice.is_amp!==true&&invoice.is_keysend!==true;
  }
  async function validateInvoice(invoice:any,context:ReceivingContext,destination:string):Promise<void>{
    if(!invoiceValid(invoice,context))throw new Error('Lightning invoice binding mismatch.');
    const decoded=await get(`/v1/payreq/${encodeURIComponent(invoice.payment_request)}`),expected=nativeAtomic(context.expectedAtomic);
    if(!object(decoded)||decoded.payment_hash!==hashFor(context)||decoded.destination!==destination||integer(decoded.num_satoshis)!==expected||integer(decoded.num_msat)!==expected*1000n||decoded.description!==memoFor(context)||integer(decoded.timestamp)!==integer(invoice.creation_date)||integer(decoded.expiry)!==integer(invoice.expiry)||Number(integer(invoice.creation_date)!+integer(invoice.expiry)!)*1000>Date.parse(context.expiresAt))throw new Error('Lightning payment request does not bind the native amount and destination.');
  }
  const createOnce=serialCreation();
  return {
    id:config.id,methods:['lightning'],mode,creationRetrySafe:true,
    async create(context){
      validateContext(context,'lightning',mode);return createOnce(context.requestId,binding(context),async()=>{
        const destination=await node(),hash=hashFor(context);let invoice:any;
        try{invoice=await get(`/v1/invoice/${hash}`);}catch(error){
          if(!(error instanceof TransportError)||error.status!==404||error.code!==5)throw error;
          const expiry=Math.floor((Date.parse(context.expiresAt)-Date.now())/1000);if(expiry<1||expiry>604800)throw new Error('Lightning receiving time window has expired.');
          const added=await json(fetcher,`${url}/v1/invoices`,{method:'POST',headers,body:JSON.stringify({memo:memoFor(context),r_preimage:secretFor(context).toString('base64'),value:context.expectedAtomic,expiry:String(expiry)})});
          if(!object(added)||added.r_hash!==Buffer.from(hash,'hex').toString('base64'))throw new Error('Lightning invoice response has an unexpected payment hash.');
          invoice=await get(`/v1/invoice/${hash}`);
        }
        await validateInvoice(invoice,context,destination);
        return {providerId:hash,request:`lightning:${invoice.payment_request}`,expiresAt:new Date(Number(integer(invoice.creation_date)!+integer(invoice.expiry)!)*1000).toISOString(),network,asset:'BTC',...(mode==='live'&&network==='mainnet'?{cashuWalletHandoff:true as const}:{}),allocationKey:`lightning:${network}:${destination}:${hash}`,instructions:[{label:'Network',value:network},{label:'Native amount',value:`${context.expectedAtomic} satoshis`}],opaque:{kind:'lnd',binding:binding(context),destination}};
      });
    },
    async check(context,intent){
      try{
        validateContext(context,'lightning',mode);const hash=hashFor(context);assertIntent(context,intent,'lnd',network,'BTC',hash);
        const destination=await node();if(intent.opaque?.destination!==destination||intent.allocationKey!==`lightning:${network}:${destination}:${hash}`)return review('Lightning destination binding mismatch.');
        const invoice=await get(`/v1/invoice/${hash}`);await validateInvoice(invoice,context,destination);
        if(intent.request!==`lightning:${invoice.payment_request}`)return review('Lightning payment request binding mismatch.');
        if(invoice.state==='CANCELED')return review('Lightning invoice was canceled.');
        if(invoice.state!=='SETTLED')return ['OPEN','ACCEPTED'].includes(invoice.state)?(Date.now()>Date.parse(context.expiresAt)?review('Lightning invoice expired without settlement.'):pending('Lightning invoice is not settled.')):review('Unknown Lightning invoice state.');
        const expected=nativeAtomic(context.expectedAtomic),settled=integer(invoice.settle_date),created=integer(invoice.creation_date)!,expires=created+integer(invoice.expiry)!;
        if(invoice.settled!==true||integer(invoice.amt_paid_sat)!==expected||integer(invoice.amt_paid_msat)!==expected*1000n||!inWindow(invoice.settle_date,context)||settled===null||settled<created||settled>=expires)return review('Lightning settlement differs from the exact native amount or receiving window.');
        return paid(context,`lightning:${network}:${hash}`);
      }catch{return review('Authoritative Lightning verification is unavailable or the request binding differs.');}
    },
  };
}

function manualAdapter(config:Extract<CryptoAdapterConfig,{kind:'manual'}>,mode:'live'|'test'):ReceivingAdapter {
  const stable=config.method==='usdt'||config.method==='usdc';
  if(!['bitcoin','lightning','liquid','cashu','ark','usdt','usdc'].includes(config.method))throw new Error('Unsupported manual crypto method.');
  bounded(config.address,'manual receive destination',12000);
  if(/[\u0000-\u0020\u007f]/.test(config.address))throw new Error('Invalid manual receive destination.');
  if(/^cashu[AB]/.test(config.address))throw new Error('Manual destination cannot be a Cashu bearer token.');
  if(config.address.includes('://')){try{const parsed=new URL(config.address);if(parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error();}catch{throw new Error('Invalid manual receive destination.');}}
  if(stable&&config.network!=='ethereum-mainnet'&&config.network!=='ethereum-sepolia')throw new Error('Stablecoin instructions require an explicit supported Ethereum network.');
  if(stable&&!/^0x[0-9a-fA-F]{40}$/.test(config.address))throw new Error('Invalid stablecoin destination.');
  const network=config.network??(config.method==='liquid'?'liquid':'mainnet');bounded(network,'manual network',50);
  const liveNetwork=['mainnet','liquid','ethereum-mainnet'].includes(network);if((mode==='live')!==liveNetwork)throw new Error('Manual mode and network must agree.');
  const asset=stable?config.method.toUpperCase():config.method==='liquid'?'L-BTC':'BTC';
  const address=stable?config.address.toLowerCase():config.address;
  const allocationKey=`${stable?'ethereum':config.method}:${network}:${address}`;
  return {
    id:config.id,methods:[config.method],mode,
    async create(context){validateContext(context,config.method,mode);return {providerId:`manual:${binding(context)}`,network,asset,allocationKey,instructions:[{label:'Receive destination',value:address},{label:'Network',value:network},{label:'Native amount',value:`${nativeText(nativeAtomic(context.expectedAtomic),stable?6:8)} ${asset}`},{label:'Verification',value:'Owner verification required; this destination has no automatic settlement proof.'}],opaque:{kind:'manual',binding:binding(context)}};},
    async check(){return review('Manual receipt requires independent owner verification; payer evidence does not establish settlement.');},
  };
}
