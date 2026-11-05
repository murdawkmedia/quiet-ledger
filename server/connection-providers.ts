import {MANUAL_RAIL_CURRENCIES} from '../shared/receiving.js';
import {randomBytes} from 'node:crypto';
import {createCryptoAdapter} from '../integrations/crypto-receiving.js';
import {createLnurlAdapter} from '../integrations/lnurl-receiving.js';
import {createArkAdapter} from '../integrations/ark-receiving.js';
import {createFiatAdapter} from '../integrations/fiat-receiving.js';
import {createSquareReceivingAdapter,verifySquareReceivingConnection,type SquareReceivingConfig} from '../integrations/square-receiving.js';
import type {HttpFetch} from '../integrations/http.js';
import type {ConnectionProviderDefinition,ConnectionProviderField} from '../shared/connections.js';
import type {ReceivingAdapter,ReceivingContext} from '../shared/receiving.js';
import type {MethodId} from '../shared/payment-methods.js';
import {connectionFetch,validateConnectionUrl} from './connection-transport.js';

const field=(key:string,label:string,type:ConnectionProviderField['type']='text',help?:string,required=true):ConnectionProviderField=>({key,label,type,required,...(help?{help}:{})});
const choice=(key:string,label:string,values:string[]):ConnectionProviderField=>({...field(key,label,'select'),options:values.map(value=>({value,label:value}))});
const rpcFields=[field('rpcUrl','Public HTTPS wallet RPC endpoint','url','Only public HTTPS on port 443 is supported. Local, Umbrel and LAN endpoints cannot be reached from the hosted app.'),field('rpcUsername','RPC username'),field('rpcPassword','RPC password','password','Use narrowly scoped receiving/read permissions. Never supply a seed or private key.'),field('minConfirmations','Required confirmations','text','An integer from 1 to 144. Leave blank for the default.',false)];
const country=field('merchantCountry','Merchant country','text','Two-letter country code, such as CA, US or GB. Provider eligibility still applies.');
const manualWarning='Save merchant-supplied receiving instructions. Confirm every payment independently; this does not connect to a bank API.';
export const CONNECTION_PROVIDERS:ConnectionProviderDefinition[]=[
  {id:'lightning-address',name:'Lightning Address',description:'Read public LNURL metadata, then create exact Lightning invoices when requested. Settlement proof depends on receiver support.',fields:[field('lightningAddress','Lightning Address','text','For example merchant@example.com. No private key or seed.')],walletOptionIds:['lnurl'],modes:['live'],verification:'automatic',methods:['lightning']},
  {id:'lnurl',name:'LNURL pay endpoint',description:'Public HTTPS LNURL-pay metadata and same-origin callbacks. Connecting reads metadata without creating an invoice.',fields:[field('url','LNURL-pay HTTPS endpoint','url')],walletOptionIds:['lnurl'],modes:['live'],verification:'automatic',methods:['lightning']},
  {id:'bitcoin-core',name:'Bitcoin Core',description:'Mainnet receiving through a synchronized wallet RPC. Receiving may allocate a new wallet address; never signs or sends.',fields:rpcFields,walletOptionIds:['bitcoin-core'],modes:['live'],verification:'automatic',methods:['bitcoin']},
  {id:'watch-only',name:'Bitcoin watch-only destination',description:'Synchronized mainnet RPC and a dedicated watched address. One address cannot be allocated to multiple requests; no address pool is supplied.',fields:[...rpcFields,field('address','Dedicated watch-only address')],walletOptionIds:['watch-only'],modes:['live'],verification:'automatic',methods:['bitcoin']},
  {id:'lnd',name:'LND',description:'Mainnet Lightning receiving. Connection verification only reads node metadata; use an invoice/read macaroon.',fields:[field('baseUrl','Public HTTPS LND REST endpoint','url'),field('macaroonHex','Invoice/read macaroon (hex)','password','Prefer a least-privilege macaroon. The app never calls signing or sending endpoints.')],walletOptionIds:['lnd'],modes:['live'],verification:'automatic',methods:['lightning']},
  {id:'liquid',name:'Liquid Elements',description:'Mainnet Elements receiving RPC. Confidential asset and amount verification requires merchant review.',fields:[...rpcFields,field('address','Dedicated receive address (optional)','text','A fixed address can be allocated only once. Otherwise RPC may allocate a fresh address.',false)],walletOptionIds:['liquid'],modes:['live'],verification:'automatic',methods:['liquid']},
  {id:'bark',name:'Ark · Bark',description:'Read an existing indexed Bark address and pinned server identity. VTXO observations require manual invoice attribution; no address pool is created.',fields:[field('baseUrl','Public HTTPS Bark origin','url'),field('token','Bark API token','password','Bark tokens can grant full wallet authority. This app restricts requests to receiving and read endpoints.'),field('expectedServerPubkey','Pinned Ark server public key'),field('addressIndex','Existing dedicated address index'),field('expectedAddress','Existing dedicated Ark address')],walletOptionIds:['ark'],modes:['live'],verification:'automatic',methods:['ark']},
  {id:'stripe',name:'Stripe',description:'Hosted checkout and authoritative payment readback. Country, account, method and device eligibility apply.',fields:[field('secretKey','Stripe secret/restricted key','password'),field('accountId','Stripe account ID'),country],walletOptionIds:['stripe'],modes:['live','test'],verification:'automatic',methods:['card','apple_pay','google_pay','cash_app_pay','ach','sepa','ideal','stripe_dynamic']},
  {id:'paypal',name:'PayPal',description:'Authenticate API credentials. Merchant ID and country require manual confirmation; approved orders remain unpaid until separately captured. This app never captures.',fields:[field('clientId','PayPal client ID'),field('clientSecret','PayPal client secret','password'),field('merchantId','PayPal merchant ID'),country],walletOptionIds:['paypal'],modes:['live','test'],verification:'manual',methods:['paypal','venmo']},
  {id:'revolut',name:'Revolut Merchant',description:'Verify an online Merchant location and use hosted checkout. Country and payment-method availability remain conditional.',fields:[field('secretKey','Revolut Merchant secret key','password'),field('locationId','Online location ID'),country],walletOptionIds:['revolut'],modes:['live','test'],verification:'automatic',methods:['card','apple_pay','google_pay','revolut_pay','pay_by_bank']},
  {id:'square',name:'Square',description:'Hosted card checkout and exact order/payment readback. Connecting only reads location identity and card-processing capability; no payment is created or captured.',fields:[field('accessToken','Square access token','password'),field('locationId','Square location ID'),field('merchantId','Square merchant ID'),country,choice('currency','Location currency',['CAD','USD','EUR','GBP'])],walletOptionIds:['square'],modes:['live','test'],verification:'automatic',methods:['card']},
  {id:'bank-instructions',name:'Bank / Interac / Wise instructions',description:`${manualWarning} Suitable for eligible Wise, Tangerine or other bank receiving details.`,fields:[choice('method','Receiving method',['bank','interac','wire','ach','sepa']),field('recipient','Payee / recipient name'),field('instructions','Receiving instructions','textarea','These instructions are shown to the payer. Include the bank details or Interac address you intend to share; never a password, PIN or private key.')],walletOptionIds:['manual-fiat'],modes:['live','test'],verification:'manual',methods:['bank','interac','wire','ach','sepa']},
  {id:'static-crypto',name:'Dedicated crypto receiving instructions',description:'Manual confirmation only. A saved address is a single dedicated allocation, not an address pool; reuse across requests is blocked.',fields:[choice('method','Asset',['bitcoin','liquid','usdt','usdc']),field('address','Dedicated public receive address'),choice('network','Network',['mainnet','liquid','ethereum-mainnet','testnet','liquidtestnet','ethereum-sepolia'])],walletOptionIds:['watch-only','manual'],modes:['live','test'],verification:'manual',methods:['bitcoin','liquid','usdt','usdc']},
];

export interface NormalizedConnection {provider:string;label:string;mode:'live'|'test';fields:Record<string,string>}
export interface ConnectionBuildOptions {id:string;publicOrigin:string;fetcher?:HttpFetch;/** Trusted local hosted fixture only; never accepted in tenant fields. */allowInsecureLoopback?:boolean;/** Internal fixture deadline; never accepted in tenant fields. */verificationTimeoutMs?:number}
export interface ConnectionVerification {status:'connected'|'manual';detail:string;methods:MethodId[]}
const invalid=()=>new Error('Invalid connection settings. Check the documented provider fields and public HTTPS endpoint.');
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
type ConnectionOriginOptions=Pick<ConnectionBuildOptions,'id'|'publicOrigin'|'allowInsecureLoopback'>;
function configuredOrigin(options:ConnectionOriginOptions):URL {
  const raw=options.publicOrigin;
  if(typeof raw!=='string'||/[\u0000-\u0020\u007f\\?#]/.test(raw))throw invalid();
  let url:URL;try{url=new URL(raw);}catch{throw invalid();}
  if(raw!==url.origin&&raw!==`${url.origin}/`)throw invalid();
  if(options.allowInsecureLoopback===true&&url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))return url;
  return validateConnectionUrl(raw);
}
function optionsValid(options:ConnectionOriginOptions):void {
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(options.id))throw invalid();
  const url=configuredOrigin(options);
  if(url.pathname!=='/'||url.search)throw invalid();
}
function endpoint(value:string,originOnly=false):string {
  const url=validateConnectionUrl(value);
  if(url.search||originOnly&&url.pathname!=='/')throw invalid();
  return originOnly?url.origin:url.toString().replace(/\/$/,'');
}
function validateFields(provider:string,mode:'live'|'test',fields:Record<string,string>){
  const f=fields;
  if(['bitcoin-core','watch-only','liquid'].includes(provider)){
    f.rpcUrl=endpoint(f.rpcUrl);
    if(f.minConfirmations&&!/^(?:[1-9]|[1-9][0-9]|1[0-3][0-9]|14[0-4])$/.test(f.minConfirmations))throw invalid();
  }
  if(provider==='lnd'){f.baseUrl=endpoint(f.baseUrl);if(!/^(?:[a-fA-F0-9]{2}){16,4096}$/.test(f.macaroonHex))throw invalid();}
  if(provider==='bark'){
    f.baseUrl=endpoint(f.baseUrl,true);
    if(!/^[A-Za-z0-9_-]{44}$/.test(f.token)||Buffer.from(f.token,'base64url').length!==33||Buffer.from(f.token,'base64url')[0]!==0||!/^(02|03)[0-9a-f]{64}$/.test(f.expectedServerPubkey)||!/^(0|[1-9][0-9]{0,9})$/.test(f.addressIndex)||Number(f.addressIndex)>0x7fffffff)throw invalid();
  }
  if(provider==='lightning-address'){
    if(!/^[a-z0-9_.+-]{1,128}@[a-z0-9.-]+$/.test(f.lightningAddress))throw invalid();
    const [user,domain]=f.lightningAddress.split('@');validateConnectionUrl(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}`);
  }
  if(provider==='lnurl')validateConnectionUrl(f.url);
  if(['stripe','paypal','revolut','square'].includes(provider)){f.merchantCountry=f.merchantCountry.toUpperCase();if(!/^[A-Z]{2}$/.test(f.merchantCountry))throw invalid();}
  if(provider==='static-crypto'){
    const expected={bitcoin:mode==='live'?'mainnet':'testnet',liquid:mode==='live'?'liquid':'liquidtestnet',usdt:mode==='live'?'ethereum-mainnet':'ethereum-sepolia',usdc:mode==='live'?'ethereum-mainnet':'ethereum-sepolia'};
    if(f.network!==expected[f.method as keyof typeof expected])throw invalid();
    if(f.method==='bitcoin'&&!/^(bc1|[13]|tb1|[mn2])[a-zA-Z0-9]{20,100}$/.test(f.address))throw invalid();
  }
}
/** The caller supplies only form data; stable server secrets are generated once before encryption. */
export function normalizeConnection(input:unknown,options:ConnectionOriginOptions):NormalizedConnection {
  try{
    optionsValid(options);
    if(!object(input)||Object.keys(input).some(key=>!['provider','label','mode','fields'].includes(key))||typeof input.provider!=='string'||!object(input.fields))throw invalid();
    const definition=CONNECTION_PROVIDERS.find(provider=>provider.id===input.provider);
    if(!definition||!definition.modes.includes(input.mode as 'live'|'test')||input.label!==undefined&&(typeof input.label!=='string'||input.label.length>80||/[\u0000-\u001f\u007f]/.test(input.label)))throw invalid();
    if(Object.keys(input.fields).some(key=>!definition.fields.some(field=>field.key===key)))throw invalid();
    const fields:Record<string,string>={};
    for(const field of definition.fields){
      const raw=input.fields[field.key];
      if(raw===undefined||raw===''){if(field.required)throw invalid();continue;}
      if(typeof raw!=='string'||raw.length>(field.key==='macaroonHex'?8192:field.type==='textarea'?8000:4096)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)||/nsec1|(?:xprv|tprv)[1-9A-HJ-NP-Za-km-z]+|BEGIN [A-Z ]*PRIVATE KEY/.test(raw))throw invalid();
      const value=raw.trim();if(field.required&&!value||field.options&&!field.options.some(option=>option.value===value))throw invalid();
      if(value)fields[field.key]=value;
    }
    const normalized:NormalizedConnection={provider:definition.id,label:typeof input.label==='string'&&input.label.trim()?input.label.trim():definition.name,mode:input.mode as 'live'|'test',fields};
    validateFields(normalized.provider,normalized.mode,fields);
    if(normalized.provider==='lnd')fields.invoiceHmacSecret=randomBytes(32).toString('hex');
    // Constructing an adapter validates provider-specific formats without network IO.
    buildConnectionAdapter(normalized,options);return normalized;
  }catch{throw invalid();}
}

export function buildConnectionAdapter(connection:NormalizedConnection,options:ConnectionBuildOptions):ReceivingAdapter {
  optionsValid(options);
  const {provider,mode,fields:f}=connection,fetcher=options.fetcher??connectionFetch,id=options.id;
  const definition=CONNECTION_PROVIDERS.find(row=>row.id===provider);if(!definition||!definition.modes.includes(mode))throw invalid();
  const shared={id,mode,fetcher};let adapter:ReceivingAdapter;
  if(provider==='lightning-address'||provider==='lnurl')adapter=createLnurlAdapter({...shared,...(provider==='lightning-address'?{lightningAddress:f.lightningAddress}:{url:f.url})});
  else if(provider==='bitcoin-core'||provider==='watch-only'||provider==='liquid')adapter=createCryptoAdapter({...shared,kind:provider==='liquid'?'liquid':'bitcoin-core',rpcUrl:f.rpcUrl,rpcUsername:f.rpcUsername,rpcPassword:f.rpcPassword,minConfirmations:f.minConfirmations?Number(f.minConfirmations):undefined,...(f.address?{address:f.address}:{})});
  else if(provider==='lnd')adapter=createCryptoAdapter({...shared,kind:'lnd',baseUrl:f.baseUrl,macaroonHex:f.macaroonHex,invoiceHmacSecret:f.invoiceHmacSecret});
  else if(provider==='bark')adapter=createArkAdapter({...shared,baseUrl:f.baseUrl,token:f.token,expectedServerPubkey:f.expectedServerPubkey,addressIndex:Number(f.addressIndex),expectedAddress:f.expectedAddress});
  else if(provider==='stripe')adapter=createFiatAdapter({...shared,provider,secretKey:f.secretKey,accountId:f.accountId,merchantCountry:f.merchantCountry,returnUrl:new URL('/payment-methods',options.publicOrigin).toString()});
  else if(provider==='paypal')adapter=createFiatAdapter({...shared,provider,clientId:f.clientId,clientSecret:f.clientSecret,merchantId:f.merchantId,merchantCountry:f.merchantCountry,returnUrl:new URL('/payment-methods',options.publicOrigin).toString()});
  else if(provider==='revolut'){
    const config={...shared,provider:'revolut' as const,secretKey:f.secretKey,locationId:f.locationId,merchantCountry:f.merchantCountry,returnUrl:new URL('/payment-methods',options.publicOrigin).toString()};
    adapter=createFiatAdapter(config);adapter.recover=context=>createFiatAdapter({...config,recoverOnly:true}).create(context);
  }
  else if(provider==='square')adapter=createSquareReceivingAdapter(squareConfig(connection,options));
  else if(provider==='static-crypto')adapter=createCryptoAdapter({...shared,kind:'manual',method:f.method as 'bitcoin'|'liquid'|'usdt'|'usdc',address:f.address,network:f.network});
  else if(provider==='bank-instructions')adapter={id,mode,creationRetrySafe:true,methods:[f.method as MethodId],supportedCurrencies:['CAD','USD','EUR','GBP'],supportedCurrenciesByMethod:MANUAL_RAIL_CURRENCIES,
    async create(context){
      if(context.mode!==mode||context.method!==f.method||context.expectedAtomic!==String(context.amount)||!Number.isSafeInteger(context.amount)||context.amount<=0||!['CAD','USD','EUR','GBP'].includes(context.currency)||(context.method==='interac'&&context.currency!=='CAD')||(context.method==='ach'&&context.currency!=='USD')||(context.method==='sepa'&&context.currency!=='EUR'))throw invalid();
      return {providerId:context.requestId,asset:context.currency,network:'manual',instructions:[{label:'Recipient',value:f.recipient},{label:'Receiving instructions',value:f.instructions},{label:'Payment reference',value:context.requestId},{label:'Confirmation',value:'The merchant must independently confirm the exact received amount. Payer reports do not prove payment.'}]};
    },async check(){return {status:'review',reason:'The merchant must independently confirm this manual payment.'};}};
  else throw invalid();
  if(provider==='stripe'||provider==='paypal'||provider==='revolut'){
    const callback=(context:ReceivingContext):string=>{
      // The receiving service generates this URL from its saved bearer token.
      const raw=(context as ReceivingContext&{returnUrl?:string}).returnUrl;
      if(!raw)return new URL('/payment-methods',options.publicOrigin).toString();
      if(/[\u0000-\u0020\u007f\\?#]/.test(raw))throw invalid();
      const origin=configuredOrigin(options),url=new URL(raw);
      if(!(options.allowInsecureLoopback===true&&mode==='test'&&origin.protocol==='http:'&&url.origin===origin.origin))validateConnectionUrl(raw);
      if(url.origin!==origin.origin||url.username||url.password||url.hash||url.search||!/^\/receive\/[A-Za-z0-9_-]{16,192}$/.test(url.pathname))throw invalid();
      return url.toString();
    };
    const forContext=(context:ReceivingContext,recoverOnly=false)=>{
      const common={...shared,merchantCountry:f.merchantCountry,returnUrl:callback(context)};
      if(provider==='stripe')return createFiatAdapter({...common,provider,secretKey:f.secretKey,accountId:f.accountId});
      if(provider==='paypal')return createFiatAdapter({...common,provider,clientId:f.clientId,clientSecret:f.clientSecret,merchantId:f.merchantId});
      return createFiatAdapter({...common,provider:'revolut',secretKey:f.secretKey,locationId:f.locationId,recoverOnly});
    };
    adapter.create=async context=>forContext(context).create(context);
    if(provider==='revolut')adapter.recover=async context=>forContext(context,true).create(context);
  }
  adapter.walletOptionIds=[...definition.walletOptionIds];return adapter;
}
function squareConfig(connection:NormalizedConnection,options:ConnectionBuildOptions):SquareReceivingConfig {
  const f=connection.fields;
  return {id:options.id,mode:connection.mode,accessToken:f.accessToken,locationId:f.locationId,merchantId:f.merchantId,merchantCountry:f.merchantCountry,currency:f.currency as SquareReceivingConfig['currency'],publicOrigin:options.publicOrigin,fetcher:options.fetcher??connectionFetch};
}

async function readJson(fetcher:HttpFetch,url:string,init:RequestInit={}):Promise<any>{
  const response=await fetcher(url,{...init,method:init.method??'GET',redirect:'error',signal:AbortSignal.timeout(10_000)});
  if(!response.ok||response.redirected)throw invalid();
  const reader=response.body?.getReader();if(!reader)throw invalid();
  const chunks:Uint8Array[]=[];let length=0;
  try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>1024*1024)throw invalid();chunks.push(part.value);}}
  finally{await reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function lnurlMetadata(value:any,endpoint:URL,address?:string):void {
  if(!object(value)||value.tag!=='payRequest'||!Number.isSafeInteger(value.minSendable)||!Number.isSafeInteger(value.maxSendable)||(value.minSendable as number)<1||(value.maxSendable as number)<(value.minSendable as number)||typeof value.metadata!=='string'||value.metadata.length>200000)throw invalid();
  const callback=validateConnectionUrl(value.callback);
  if(callback.origin!==endpoint.origin)throw invalid();
  const allowed=new Set(['tag','username','user','id','identifier','hash','payment_hash']);
  for(const [key,item]of callback.searchParams)if(!allowed.has(key)||callback.searchParams.getAll(key).length!==1||!item||item.length>192||!/^[a-zA-Z0-9_.@:+-]+$/.test(item)||(['hash','payment_hash'].includes(key)&&!/^[a-f0-9]{64}$/.test(item)))throw invalid();
  const rows=JSON.parse(value.metadata);
  if(!Array.isArray(rows)||rows.length>64||rows.some(row=>!Array.isArray(row)||row.length<2||typeof row[0]!=='string'))throw invalid();
  const text=rows.filter(row=>row[0]==='text/plain');
  if(text.length!==1||typeof text[0][1]!=='string'||!text[0][1]||text[0][1].length>8000||address&&!rows.some(row=>['text/identifier','text/email'].includes(row[0])&&row[1]===address))throw invalid();
  if(value.payerData!==undefined&&(!object(value.payerData)||Object.values(value.payerData).some(row=>!object(row)||row.mandatory!==false)))throw invalid();
}
const verificationUnavailable=()=>new Error('Connection verification unavailable or provider identity/network did not match. Check the settings and provider permissions. No payment was created.');
function beforeAbort<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
  return new Promise((resolve,reject)=>{
    const aborted=()=>reject(verificationUnavailable());
    if(signal.aborted){reject(verificationUnavailable());return;}
    signal.addEventListener('abort',aborted,{once:true});
    work.then(value=>{signal.removeEventListener('abort',aborted);resolve(value);},error=>{signal.removeEventListener('abort',aborted);reject(error);});
  });
}
/** A single deadline also bounds abort-ignoring fixture transports and sequential reads. */
export async function verifyConnection(connection:NormalizedConnection,options:ConnectionBuildOptions):Promise<ConnectionVerification>{
  const timeout=options.verificationTimeoutMs??12_000;
  if(!Number.isSafeInteger(timeout)||timeout<1)throw verificationUnavailable();
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(timeout,12_000));
  const underlying=options.fetcher??connectionFetch;
  const fetcher:HttpFetch=async(url,init={})=>{
    if(controller.signal.aborted)throw verificationUnavailable();
    const signal=init.signal?AbortSignal.any([controller.signal,init.signal]):controller.signal;
    return beforeAbort(underlying(url,{...init,signal}),signal);
  };
  try{return await beforeAbort(verifyConnectionMetadata(connection,{...options,fetcher}),controller.signal);}
  catch{throw verificationUnavailable();}
  finally{clearTimeout(timer);controller.abort();}
}
/** No invoice, address allocation, checkout, trade, capture, signature or send is performed. */
async function verifyConnectionMetadata(connection:NormalizedConnection,options:ConnectionBuildOptions):Promise<ConnectionVerification>{
  try{
    const adapter=buildConnectionAdapter(connection,options),{provider,fields:f}=connection,fetcher=options.fetcher??connectionFetch;
    const methods=[...adapter.methods];
    if(provider==='bank-instructions')return {status:'manual',detail:'Receiving instructions saved. Independently confirm each payment in your bank or provider; no bank API is connected.',methods};
    if(provider==='static-crypto')return {status:'manual',detail:'Dedicated public destination saved for manual confirmation. No address pool or automatic settlement proof is available; destination reuse across requests is blocked.',methods};
    if(provider==='lightning-address'||provider==='lnurl'){
      let raw=f.url;
      if(provider==='lightning-address'){const [user,domain]=f.lightningAddress.split('@');raw=`https://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}`;}
      const url=validateConnectionUrl(raw);lnurlMetadata(await readJson(fetcher,url.toString()),url,provider==='lightning-address'?f.lightningAddress:undefined);
      return {status:'connected',detail:'Public Lightning receiving metadata and callback validated. No invoice was created. Automatic settlement depends on receiver proof support.',methods};
    }
    if(['bitcoin-core','watch-only','liquid'].includes(provider)){
      let sequence=0;
      const rpc=async(method:string,params:unknown[]=[])=>{
        const id=++sequence,result=await readJson(fetcher,f.rpcUrl,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Basic ${Buffer.from(`${f.rpcUsername}:${f.rpcPassword}`).toString('base64')}`},body:JSON.stringify({jsonrpc:'1.0',id,method,params})});
        if(!object(result)||result.id!==id||result.error!==null&&result.error!==undefined||!Object.hasOwn(result,'result'))throw invalid();return result.result as any;
      };
      const chain=await rpc('getblockchaininfo');
      if(!object(chain)||chain.chain!==(provider==='liquid'?'liquidv1':'main')||chain.initialblockdownload!==false||typeof chain.verificationprogress!=='number'||chain.verificationprogress<0.999||!Number.isSafeInteger(chain.blocks)||(chain.blocks as number)<0||chain.headers!==chain.blocks||typeof chain.bestblockhash!=='string'||!/^[a-f0-9]{64}$/.test(chain.bestblockhash))throw invalid();
      const wallet=await rpc('getwalletinfo');
      if(!object(wallet)||wallet.scanning!==false||!object(wallet.lastprocessedblock)||wallet.lastprocessedblock.hash!==chain.bestblockhash||wallet.lastprocessedblock.height!==chain.blocks||provider==='watch-only'&&wallet.private_keys_enabled!==false)throw invalid();
      if(f.address){const address=await rpc('getaddressinfo',[f.address]);if(!object(address)||address.address!==f.address||(address.ismine!==true&&address.iswatchonly!==true)||typeof address.scriptPubKey!=='string'||!/^[a-f0-9]{4,10000}$/.test(address.scriptPubKey))throw invalid();}
      return {status:'connected',detail:provider==='liquid'?'Synchronized mainnet Elements wallet verified by read-only RPC. Confidential payment attribution still requires review.':'Synchronized mainnet receiving wallet verified by read-only RPC. No address was allocated or transaction created.',methods};
    }
    if(provider==='lnd'){
      const info=await readJson(fetcher,`${f.baseUrl}/v1/getinfo`,{headers:{'Grpc-Metadata-macaroon':f.macaroonHex}});
      if(!object(info)||!Array.isArray(info.chains)||info.chains.length!==1||info.chains[0]?.chain!=='bitcoin'||info.chains[0]?.network!=='mainnet'||info.synced_to_chain!==true||typeof info.identity_pubkey!=='string'||!/^(02|03)[a-f0-9]{64}$/.test(info.identity_pubkey))throw invalid();
      return {status:'connected',detail:'Synchronized mainnet Lightning node verified by read-only metadata. No invoice was created.',methods};
    }
    if(provider==='bark'){
      const headers={Authorization:`Bearer ${f.token}`,Accept:'application/json'};
      const info=await readJson(fetcher,`${f.baseUrl}/api/v1/wallet/ark-info`,{headers});
      if(!object(info)||info.network!=='bitcoin'||info.server_pubkey!==f.expectedServerPubkey)throw invalid();
      const address=await readJson(fetcher,`${f.baseUrl}/api/v1/wallet/addresses/index/${f.addressIndex}`,{headers});
      if(!object(address)||address.address!==f.expectedAddress)throw invalid();
      return {status:'connected',detail:'Pinned mainnet Ark server and existing indexed address verified by reads. Invoice attribution requires merchant review; no key or address was allocated.',methods};
    }
    if(provider==='stripe'){
      const account=await readJson(fetcher,'https://api.stripe.com/v1/account',{headers:{Authorization:`Bearer ${f.secretKey}`,'Stripe-Version':'2026-10-28.endive'}});
      if(!object(account)||account.id!==f.accountId||account.country!==f.merchantCountry||account.charges_enabled!==true)throw invalid();
      return {status:'connected',detail:'Stripe account, merchant country and charge capability verified by account read. Checkout method eligibility still applies.',methods};
    }
    if(provider==='paypal'){
      const base=connection.mode==='live'?'https://api-m.paypal.com':'https://api-m.sandbox.paypal.com';
      const token=await readJson(fetcher,`${base}/v1/oauth2/token`,{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${f.clientId}:${f.clientSecret}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'});
      if(!object(token)||typeof token.access_token!=='string'||!token.access_token||token.access_token.length>4096||token.token_type!=='Bearer'||!Number.isInteger(token.expires_in)||(token.expires_in as number)<60)throw invalid();
      return {status:'manual',detail:'PayPal API credentials authenticated. Merchant ID and country require independent confirmation. Approval alone does not settle an invoice; this app never captures a payment.',methods};
    }
    if(provider==='revolut'){
      const base=connection.mode==='live'?'https://merchant.revolut.com':'https://sandbox-merchant.revolut.com';
      const location=await readJson(fetcher,`${base}/api/locations/${encodeURIComponent(f.locationId)}`,{headers:{Authorization:`Bearer ${f.secretKey}`,'Revolut-Api-Version':'2026-08-17'}});
      if(!object(location)||location.id!==f.locationId||location.type!=='online'||!object(location.details)||typeof location.details.domain!=='string'||!location.details.domain)throw invalid();
      return {status:'connected',detail:'Revolut online Merchant location verified by read. Merchant country is supplied by you; method and account eligibility still apply.',methods};
    }
    if(provider==='square'){
      await verifySquareReceivingConnection(squareConfig(connection,options));
      return {status:'connected',detail:'Square merchant, active location, country, currency and card-processing capability verified by read. No checkout or payment was created.',methods};
    }
    throw invalid();
  }catch{throw verificationUnavailable();}
}
