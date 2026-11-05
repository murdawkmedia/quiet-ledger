import {createHash} from 'node:crypto';
import type {MethodId} from '../shared/payment-methods.js';
import type {ReceivingAdapter,ReceivingContext,ReceivingIntent,ReceivingObservation} from '../shared/receiving.js';
import {bounded,minorAmount,providerJson,type HttpFetch} from './http.js';

type CommonConfig={id?:string;mode?:'live'|'test';merchantCountry:string;returnUrl:string;fetcher?:HttpFetch};
export type FiatAdapterConfig=CommonConfig&(
  |{provider:'stripe';secretKey:string;accountId:string}
  |{provider:'paypal';clientId:string;clientSecret:string;merchantId:string}
  |{provider:'revolut';secretKey:string;locationId:string;recoverOnly?:boolean}
);
export class FiatCreationUncertainError extends Error {
  readonly code='FIAT_CREATION_UNCERTAIN';
  constructor(){super('Revolut creation is uncertain. Preserve this request and recover its exact reference; do not create a replacement.');this.name='FiatCreationUncertainError';}
}
const STRIPE_VERSION='2026-10-28.endive',REVOLUT_VERSION='2026-08-17';
const EUROPE='AT BE BG HR CY CZ DK EE FI FR DE GR HU IS IE IT LV LI LT LU MT NL NO PL PT RO SK SI ES SE'.split(' ');
const REVOLUT_COUNTRIES=[...EUROPE,'GB'];
const BANK_COUNTRIES='AT BE HR FI FR DE GR IE IT LT NL PT ES GB'.split(' ');
const STRIPE_EU_METHOD_COUNTRIES=[...EUROPE,'AU','CA','CH','GB','GI','HK','JP','MX','NZ','SG','US'];
const STRIPE_METHOD:Partial<Record<MethodId,string>>={card:'card',apple_pay:'card',google_pay:'card',cash_app_pay:'cashapp',ach:'us_bank_account',sepa:'sepa_debit',ideal:'ideal'};
const review=(reason:string):ReceivingObservation=>({status:'review',reason});
const pending=(reason:string):ReceivingObservation=>({status:'pending',reason});
const identifier=(value:unknown,name:string,pattern=/^[A-Za-z0-9_-]{1,192}$/):string=>{if(typeof value!=='string'||value.length>192||!pattern.test(value))throw new Error(`Invalid ${name} id.`);return value;};
const uuid=(value:unknown,name:string)=>identifier(value,name,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
function checkoutUrl(value:unknown,host:string,path?:string):string{
  if(typeof value!=='string'||value.length>4096)throw new Error('Invalid hosted checkout URL.');
  let url:URL;try{url=new URL(value);}catch{throw new Error('Invalid hosted checkout URL.');}
  if(url.protocol!=='https:'||url.hostname!==host||url.username||url.password||url.port||(path&&!url.pathname.startsWith(path)))throw new Error('Hosted checkout URL host is not recognized.');
  return value;
}
function returnUrl(value:string,mode:'live'|'test',revolut:boolean){
  bounded(value,'return URL',2000);let url:URL;try{url=new URL(value);}catch{throw new Error('Invalid return URL.');}
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.username||url.password||url.hash||(url.protocol!=='https:'&&!(mode==='test'&&!revolut&&local&&url.protocol==='http:'))||(revolut&&(local||/^\d+(\.\d+){3}$/.test(url.hostname))))throw new Error('Invalid return URL. HTTPS is required except explicit local test callbacks.');
}
function validate(c:ReceivingContext,mode:'live'|'test',methods:MethodId[],country:string,creating=false){
  identifier(c.requestId,'receive request');bounded(c.idempotencyKey,'idempotency key',256);minorAmount(c.amount);
  if(c.expectedAtomic!==String(c.amount))throw new Error('Fiat amount must match the expected atomic amount.');
  if(!['CAD','USD','EUR','GBP'].includes(c.currency))throw new Error('Unsupported fiat currency.');
  if(c.mode!==mode)throw new Error('Receiving mode does not match adapter mode.');
  if(!methods.includes(c.method))throw new Error('Method is unsupported or unavailable for this country/mode/sandbox.');
  const created=Date.parse(c.createdAt),expires=Date.parse(c.expiresAt);
  if(!Number.isFinite(created)||!Number.isFinite(expires)||expires<=created||(creating&&expires<=Date.now()))throw new Error('Invalid or expired receiving request.');
  if(c.method==='cash_app_pay'&&(c.currency!=='USD'||country!=='US'||c.amount<50))throw new Error('Cash App Pay requires an eligible US merchant, US customer and at least USD 0.50.');
  if(c.method==='ach'&&(c.currency!=='USD'||country!=='US'))throw new Error('This ACH route requires a US merchant and USD currency.');
  if(['sepa','ideal'].includes(c.method)&&(c.currency!=='EUR'||!STRIPE_EU_METHOD_COUNTRIES.includes(country)))throw new Error('This method requires EUR currency and an eligible merchant country.');
  if(c.method==='sepa'&&c.amount>=1_000_000)throw new Error('SEPA debit must be below EUR 10,000 in this adapter.');
  if(c.method==='venmo'&&(country!=='US'||c.currency!=='USD'))throw new Error('Venmo requires US merchants/consumers and USD currency.');
  if(c.method==='pay_by_bank'&&(!BANK_COUNTRIES.includes(country)||!(country==='GB'?c.currency==='GBP':c.currency==='EUR')))throw new Error('Pay by Bank requires an eligible country and local GBP/EUR currency.');
}
const stableKey=(config:FiatAdapterConfig,c:ReceivingContext)=>createHash('sha256').update(JSON.stringify([config.id??config.provider,c.mode,c.requestId,c.idempotencyKey,c.method,c.amount,c.currency])).digest('hex');
const paid=(c:ReceivingContext,paymentId:string):ReceivingObservation=>({status:'paid',paymentId,reference:c.requestId,amount:c.amount,currency:c.currency});
const meta=(obj:any,c:ReceivingContext)=>obj?.receive_request===c.requestId&&obj?.receive_method===c.method;
function sameMoney(money:any,c:ReceivingContext){return money?.currency_code===c.currency&&typeof money?.value==='string'&&money.value.length<=20&&/^\d+\.\d{2}$/.test(money.value)&&BigInt(money.value.replace('.',''))===BigInt(c.amount);}

export function createFiatAdapter(config:FiatAdapterConfig):ReceivingAdapter{
  const mode=config.mode??'live';if(!['live','test'].includes(mode))throw new Error('Invalid fiat adapter mode.');
  if(!/^[A-Z]{2}$/.test(config.merchantCountry))throw new Error('Invalid merchant country.');
  if(config.id)identifier(config.id,'adapter');returnUrl(config.returnUrl,mode,config.provider==='revolut');
  const fetcher=config.fetcher??fetch;
  let adapter:ReceivingAdapter;
  if(config.provider==='stripe')adapter=stripe(config,mode,fetcher);
  else if(config.provider==='paypal')adapter=paypal(config,mode,fetcher);
  else if(config.provider==='revolut')adapter=revolut(config,mode,fetcher);
  else throw new Error('Unsupported fiat provider.');
  adapter.supportedCurrencies=['CAD','USD','EUR','GBP'];
  return adapter;
}
function stripe(config:Extract<FiatAdapterConfig,{provider:'stripe'}>,mode:'live'|'test',fetcher:HttpFetch):ReceivingAdapter{
  bounded(config.secretKey,'Stripe credential',4096);identifier(config.accountId,'Stripe account',/^acct_[A-Za-z0-9]+$/);
  if(!new RegExp(`^(sk|rk)_${mode==='live'?'live':'test'}_[A-Za-z0-9_]+$`).test(config.secretKey))throw new Error('Stripe key must match the explicit live/test mode.');
  const methods:MethodId[]=['card','apple_pay','google_pay','stripe_dynamic'];
  if(config.merchantCountry==='US')methods.push('cash_app_pay','ach');
  if(STRIPE_EU_METHOD_COUNTRIES.includes(config.merchantCountry))methods.push('sepa','ideal');
  const headers={Authorization:`Bearer ${config.secretKey}`,'Stripe-Version':STRIPE_VERSION};
  const api=(path:string,init:RequestInit={})=>providerJson(fetcher,`https://api.stripe.com/v1/${path}`,{method:'GET',...init,headers:{...headers,...init.headers}},'Stripe');
  async function account(){const a=await api('account');if(a?.id!==config.accountId||a?.country!==config.merchantCountry)throw new Error('Stripe merchant account binding does not match configuration.');}
  function bound(s:any,c:ReceivingContext,id?:string){return s?.object==='checkout.session'&&typeof s.id==='string'&&s.id.length<=192&&new RegExp(`^cs_${mode==='live'?'live':'test'}_[A-Za-z0-9]+$`).test(s.id)&&(!id||s.id===id)&&s.mode==='payment'&&s.livemode===(mode==='live')&&s.client_reference_id===c.requestId&&meta(s.metadata,c)&&s.amount_total===c.amount&&s.currency===c.currency.toLowerCase();}
  return{id:config.id??'stripe',methods,mode,creationRetrySafe:true,
    async create(c){validate(c,mode,methods,config.merchantCountry,true);await account();
      const p=new URLSearchParams({mode:'payment',success_url:config.returnUrl,cancel_url:config.returnUrl,client_reference_id:c.requestId,'metadata[receive_request]':c.requestId,'metadata[receive_method]':c.method,'payment_intent_data[metadata][receive_request]':c.requestId,'payment_intent_data[metadata][receive_method]':c.method,'line_items[0][quantity]':'1','line_items[0][price_data][currency]':c.currency.toLowerCase(),'line_items[0][price_data][unit_amount]':String(c.amount),'line_items[0][price_data][product_data][name]':'Invoice payment'});
      if(c.method!=='stripe_dynamic')p.set('allowed_payment_method_types[0]',STRIPE_METHOD[c.method]!);
      // Checkout accepts expiry from 30 minutes to 24 hours; preserve the original deadline.
      const life=Date.parse(c.expiresAt)-Date.now();if(life<1_800_000||life>86_400_000)throw new Error('Stripe Checkout expiry must be between 30 minutes and 24 hours.');p.set('expires_at',String(Math.floor(Date.parse(c.expiresAt)/1000)));
      const s=await api('checkout/sessions',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':stableKey(config,c)},body:p.toString()});
      if(!bound(s,c))throw new Error('Stripe session does not match this receiving request.');
      const url=checkoutUrl(s.url,'checkout.stripe.com','/c/pay/');if(new URL(url).pathname!==`/c/pay/${s.id}`)throw new Error('Stripe checkout URL has a different session id.');
      return{providerId:s.id,url,opaque:{accountId:config.accountId},instructions:[{label:'Availability',value:'Hosted methods remain account, country and device eligible. Apple Pay and Google Pay require a compatible wallet/device.'}]};
    },
    async check(c,intent){validate(c,mode,methods,config.merchantCountry);if(Date.parse(c.expiresAt)<=Date.now())return review('Receiving request expired; late settlement requires owner review.');identifier(intent.providerId,'Stripe session',/^cs_(live|test)_[A-Za-z0-9]+$/);await account();
      const s=await api(`checkout/sessions/${encodeURIComponent(intent.providerId)}?expand%5B%5D=payment_intent.latest_charge`);
      if(!bound(s,c,intent.providerId))return review('Stripe session binding does not match the saved request.');
      if(s.payment_status!=='paid'||s.status!=='complete')return pending('Stripe has not confirmed a completed paid checkout.');
      const p=s.payment_intent,ch=p?.latest_charge;
      if(!p||typeof p.id!=='string'||p.id.length>192||!/^pi_[A-Za-z0-9]+$/.test(p.id)||p.status!=='succeeded'||p.livemode!==(mode==='live')||p.amount!==c.amount||p.amount_received!==c.amount||p.currency!==c.currency.toLowerCase()||!meta(p.metadata,c))return review('Stripe PaymentIntent is not an exact succeeded payment.');
      if(!ch||typeof ch.id!=='string'||ch.id.length>192||!/^ch_[A-Za-z0-9]+$/.test(ch.id)||ch.object!=='charge'||ch.payment_intent!==p.id||ch.status!=='succeeded'||ch.paid!==true||ch.captured!==true||ch.livemode!==(mode==='live')||ch.amount!==c.amount||ch.amount_captured!==c.amount||ch.currency!==c.currency.toLowerCase()||ch.amount_refunded!==0||ch.refunded!==false||ch.disputed!==false||(ch.refunds&&((ch.refunds.total_count!==undefined&&ch.refunds.total_count!==0)||ch.refunds.has_more!==false||ch.refunds.data?.length!==0)))return review('Stripe charge is incomplete, disputed, partial or refunded.');
      const d=ch.payment_method_details;if(typeof d?.type!=='string'||!d.type||d.type.length>64)return review('Stripe payment method details are incomplete.');
      if(c.method==='apple_pay'||c.method==='google_pay'){if(d?.type!=='card'||d.card?.wallet?.type!==c.method)return review('The actual Stripe wallet differs from the requested wallet.');}
      else if(c.method!=='stripe_dynamic'&&d?.type!==STRIPE_METHOD[c.method])return review('The actual Stripe method differs from the requested method.');
      return paid(c,`stripe:${config.accountId}:${ch.id}`);
    }};
}
function paypal(config:Extract<FiatAdapterConfig,{provider:'paypal'}>,mode:'live'|'test',fetcher:HttpFetch):ReceivingAdapter{
  bounded(config.clientId,'PayPal client id',2048);bounded(config.clientSecret,'PayPal credential',4096);identifier(config.merchantId,'PayPal merchant');
  const base=mode==='live'?'https://api-m.paypal.com':'https://api-m.sandbox.paypal.com';
  const methods:MethodId[]=config.merchantCountry==='US'?['paypal','venmo']:['paypal'];
  let token:Promise<string>|undefined,tokenUntil=0;
  async function access(){if(!token||Date.now()>=tokenUntil){token=(async()=>{const t=await providerJson(fetcher,`${base}/v1/oauth2/token`,{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'},'PayPal');if(typeof t?.access_token!=='string'||!t.access_token||t.access_token.length>4096||t.token_type!=='Bearer'||!Number.isInteger(t.expires_in)||t.expires_in<60)throw new Error('PayPal returned an invalid OAuth response.');tokenUntil=Date.now()+Math.min(t.expires_in-30,3600)*1000;return t.access_token;})();token.catch(()=>{token=undefined;});}return token;}
  async function api(path:string,init:RequestInit={}){return providerJson(fetcher,`${base}${path}`,{method:'GET',...init,headers:{Authorization:`Bearer ${await access()}`,'Content-Type':'application/json',...init.headers}},'PayPal');}
  function bound(o:any,c:ReceivingContext,id?:string){const u=o?.purchase_units;return typeof o?.id==='string'&&/^[A-Za-z0-9]{1,192}$/.test(o.id)&&(!id||o.id===id)&&o.intent==='CAPTURE'&&Array.isArray(u)&&u.length===1&&u[0].reference_id===c.requestId&&u[0].custom_id===c.requestId&&u[0].payee?.merchant_id===config.merchantId&&sameMoney(u[0].amount,c);}
  return{id:config.id??'paypal',methods,mode,creationRetrySafe:true,
    async create(c){validate(c,mode,methods,config.merchantCountry,true);const o=await api('/v2/checkout/orders',{method:'POST',headers:{'PayPal-Request-Id':stableKey(config,c).slice(0,38),Prefer:'return=representation'},body:JSON.stringify({intent:'CAPTURE',purchase_units:[{reference_id:c.requestId,custom_id:c.requestId,payee:{merchant_id:config.merchantId},amount:{currency_code:c.currency,value:`${Math.floor(c.amount/100)}.${String(c.amount%100).padStart(2,'0')}`}}],payment_source:{[c.method]:{experience_context:{return_url:config.returnUrl,cancel_url:config.returnUrl,shipping_preference:'NO_SHIPPING',user_action:'CONTINUE'}}}})});
      if(!bound(o,c))throw new Error('PayPal order does not match this receiving request.');
      const links=Array.isArray(o.links)?o.links.filter((l:any)=>['approve','payer-action'].includes(l.rel)&&l.method==='GET'):[];
      if(links.length!==1)throw new Error('PayPal returned no unique hosted approval URL.');
      const url=checkoutUrl(links[0].href,mode==='live'?'www.paypal.com':'www.sandbox.paypal.com','/checkoutnow');if(new URL(url).searchParams.get('token')!==o.id)throw new Error('PayPal approval URL has a different order id.');
      return{providerId:o.id,url,opaque:{merchantId:config.merchantId},instructions:[{label:'Approval only',value:'Complete eligible PayPal/Venmo approval at the provider. An approved order remains unpaid until separately captured; this app never captures it automatically.'}]};
    },
    async check(c,intent){validate(c,mode,methods,config.merchantCountry);if(Date.parse(c.expiresAt)<=Date.now())return review('Receiving request expired; late settlement requires owner review.');identifier(intent.providerId,'PayPal order',/^[A-Za-z0-9]{1,192}$/);const o=await api(`/v2/checkout/orders/${encodeURIComponent(intent.providerId)}`);
      if(!bound(o,c,intent.providerId))return review('PayPal order/merchant/reference/amount binding does not match.');
      if(o.status!=='COMPLETED')return pending('PayPal approval or authorisation is not a completed capture.');
      const u=o.purchase_units[0],captures=u.payments?.captures;
      if((u.payments?.refunds&&(!Array.isArray(u.payments.refunds)||u.payments.refunds.length))||!Array.isArray(captures)||captures.length!==1)return review('PayPal requires exactly one unrefunded capture.');
      const entry=captures[0];if(entry.status!=='COMPLETED'||entry.final_capture!==true||!sameMoney(entry.amount,c)||typeof entry.id!=='string'||!/^[A-Za-z0-9]{1,192}$/.test(entry.id))return review('PayPal capture is partial, unsettled or malformed.');
      if(!o.payment_source?.[c.method]||typeof o.payment_source[c.method]!=='object'||Array.isArray(o.payment_source[c.method])||(c.method==='venmo'&&o.payment_source?.paypal))return review('PayPal payment source does not match the requested wallet.');
      const p=await api(`/v2/payments/captures/${encodeURIComponent(entry.id)}`);
      if(p?.id!==entry.id||p.payee?.merchant_id!==config.merchantId||p.status!=='COMPLETED'||p.final_capture!==true||!sameMoney(p.amount,c)||p.supplementary_data?.related_ids?.order_id!==o.id)return review('Authoritative PayPal capture is not exact, completed and unrefunded.');
      return paid(c,`paypal:${config.merchantId}:${p.id}`);
    }};
}
function revolut(config:Extract<FiatAdapterConfig,{provider:'revolut'}>,mode:'live'|'test',fetcher:HttpFetch):ReceivingAdapter{
  bounded(config.secretKey,'Revolut credential',4096);uuid(config.locationId,'Revolut location');if(!REVOLUT_COUNTRIES.includes(config.merchantCountry))throw new Error('Revolut Merchant country is unsupported in this adapter.');
  const base=mode==='live'?'https://merchant.revolut.com':'https://sandbox-merchant.revolut.com';
  const methods:MethodId[]=['card','apple_pay','google_pay','revolut_pay'];if(mode==='live'&&BANK_COUNTRIES.includes(config.merchantCountry))methods.push('pay_by_bank');
  const headers={Authorization:`Bearer ${config.secretKey}`,'Revolut-Api-Version':REVOLUT_VERSION,'Content-Type':'application/json'};
  const api=(path:string,init:RequestInit={})=>providerJson(fetcher,`${base}/api/${path}`,{method:'GET',...init,headers:{...headers,...init.headers}},'Revolut');
  const uncertain=new Set<string>(),working=new Map<string,Promise<ReceivingIntent>>();
  function bound(o:any,c:ReceivingContext,id?:string){return o?.type==='payment'&&typeof o.id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(o.id)&&(!id||o.id===id)&&o.amount===c.amount&&o.currency===c.currency&&o.location_id===config.locationId&&o.merchant_order_data?.reference===c.requestId&&meta(o.metadata,c);}
  function intent(o:any,c:ReceivingContext){if(!bound(o,c))throw new Error('Revolut order does not match the receiving reference/location/amount.');identifier(o.token,'Revolut public token');const url=checkoutUrl(o.checkout_url,mode==='live'?'checkout.revolut.com':'sandbox-checkout.revolut.com','/payment-link/');if(new URL(url).pathname!==`/payment-link/${o.token}`)throw new Error('Revolut checkout URL has a different public token.');return{providerId:o.id,url,opaque:{locationId:config.locationId},instructions:[{label:'Availability',value:'Select the requested method if eligible at hosted checkout. Wallet/device and bank availability are conditional; a different payment method requires review.'}]} satisfies ReceivingIntent;}
  async function create(c:ReceivingContext){
    const matches=await api(`orders?merchant_order_data_reference=${encodeURIComponent(c.requestId)}&location_id=${encodeURIComponent(config.locationId)}&limit=2`);
    if(!Array.isArray(matches?.orders)||matches.orders.length>1)throw new Error('Revolut reference recovery is malformed or ambiguous.');
    if(matches.orders.length){uuid(matches.orders[0]?.id,'Revolut order');return intent(await api(`orders/${matches.orders[0].id}`),c);}
    if(config.recoverOnly||uncertain.has(c.requestId))throw new FiatCreationUncertainError();
    // Create-order has no documented idempotency guarantee. Mark uncertain before POST,
    // recover by reference only after any ambiguous response; never blind-retry here.
    uncertain.add(c.requestId);
    try{const o=await api('orders',{method:'POST',headers:{'Idempotency-Key':stableKey(config,c)},body:JSON.stringify({amount:c.amount,currency:c.currency,location_id:config.locationId,merchant_order_data:{reference:c.requestId},metadata:{receive_request:c.requestId,receive_method:c.method},redirect_url:config.returnUrl,expire_pending_after:`PT${Math.max(60,Math.min(2_592_000,Math.floor((Date.parse(c.expiresAt)-Date.now())/1000)))}S`})});return intent(o,c);}catch{throw new FiatCreationUncertainError();}
  }
  return{id:config.id??'revolut',methods,mode,
    async create(c){validate(c,mode,methods,config.merchantCountry,true);const key=stableKey(config,c);const active=working.get(key);if(active)return active;const result=create(c);working.set(key,result);try{return await result;}finally{working.delete(key);}},
    async check(c,intent){validate(c,mode,methods,config.merchantCountry);if(Date.parse(c.expiresAt)<=Date.now())return review('Receiving request expired; late settlement requires owner review.');uuid(intent.providerId,'Revolut order');const o=await api(`orders/${intent.providerId}`);
      if(!bound(o,c,intent.providerId))return review('Revolut order/location/reference/amount binding does not match.');
      if(o.state!=='completed')return pending('Revolut has not confirmed completed settlement.');
      if(o.outstanding_amount!==0||o.refunded_amount!==0||!Array.isArray(o.payments)||o.payments.length!==1)return review('Revolut order is partial, refunded or has multiple attempts requiring review.');
      const entry=o.payments[0];if(entry.state!=='completed'||entry.amount!==c.amount||entry.currency!==c.currency)return review('Revolut payment is not fully settled.');
      try{uuid(entry.id,'Revolut payment');}catch{return review('Revolut payment id is malformed.');}
      const p=await api(`payments/${entry.id}`);
      if(p?.id!==entry.id||p.order_id!==o.id||p.state!=='completed'||p.amount!==c.amount||p.currency!==c.currency)return review('Authoritative Revolut payment is not exactly settled for this order.');
      const allowed=c.method==='revolut_pay'?['revolut_pay_account','revolut_pay_card']:[c.method];
      // The published Merchant schema does not document a Pay by Bank method discriminator.
      // A completed order alone cannot prove that the requested bank method was used.
      if(c.method==='pay_by_bank')return review('Pay by Bank settlement needs provider method confirmation; its discriminator is not documented in this API schema.');
      if(!allowed.includes(p.payment_method?.type)||entry.payment_method?.type!==p.payment_method?.type)return review('The actual Revolut method differs from the requested method.');
      return paid(c,`revolut:${config.locationId}:${p.id}`);
    }};
}
