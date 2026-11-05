import {createHash} from 'node:crypto';
import {minorAmount,type HttpFetch} from './http.js';
import type {ReceivingAdapter,ReceivingContext,ReceivingObservation} from '../shared/receiving.js';

export interface SquareReceivingConfig {
  id:string;mode:'live'|'test';accessToken:string;locationId:string;merchantId:string;
  merchantCountry:string;currency:'CAD'|'USD'|'EUR'|'GBP';publicOrigin:string;
  /** Builders always supply the pinned hosted transport; fixtures may supply a synthetic transport. */
  fetcher:HttpFetch;
}
const unavailable=()=>new Error('Square receiving unavailable or account/request binding did not match.');
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,192}$/.test(value);
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameMoney=(value:any,amount:number,currency:string)=>value?.amount===amount&&value?.currency===currency;
const empty=(value:any)=>value===undefined||Array.isArray(value)&&value.length===0;
const review=():ReceivingObservation=>({status:'review',reason:'Square order or payment is incomplete, refunded, ambiguous or differs from the saved request. Merchant review is required.'});
function configuration(config:SquareReceivingConfig){
  if(!identifier(config.id)||!identifier(config.locationId)||!identifier(config.merchantId)||typeof config.accessToken!=='string'||!config.accessToken.trim()||config.accessToken.length>4096||/[\u0000-\u0020\u007f]/.test(config.accessToken)||!/^[A-Z]{2}$/.test(config.merchantCountry)||!['CAD','USD','EUR','GBP'].includes(config.currency)||!['live','test'].includes(config.mode))throw unavailable();
  const origin=new URL(config.publicOrigin);
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.hash||origin.search||origin.pathname!=='/')throw unavailable();
  const base=config.mode==='live'?'https://connect.squareup.com':'https://connect.squareupsandbox.com';
  const headers={Authorization:`Bearer ${config.accessToken}`,'Content-Type':'application/json','Square-Version':'2026-09-16'};
  const api=async(path:string,init:RequestInit={})=>{
    try{
      const response=await config.fetcher(base+path,{method:'GET',...init,headers,redirect:'error',signal:AbortSignal.timeout(10_000)});
      if(!response.ok||response.redirected)throw unavailable();const text=await response.text();if(Buffer.byteLength(text)>1024*1024)throw unavailable();
      const data=JSON.parse(text);if(data?.errors!==undefined&&(!Array.isArray(data.errors)||data.errors.length))throw unavailable();return data;
    }catch{throw unavailable();}
  };
  return {base,origin,api};
}
export async function verifySquareReceivingConnection(config:SquareReceivingConfig):Promise<void>{
  const {api}=configuration(config),{location}=await api(`/v2/locations/${encodeURIComponent(config.locationId)}`);
  if(location?.id!==config.locationId||location.merchant_id!==config.merchantId||location.country!==config.merchantCountry||location.currency!==config.currency||location.status!=='ACTIVE'||!Array.isArray(location.capabilities)||!location.capabilities.includes('CREDIT_CARD_PROCESSING'))throw unavailable();
}
/** Hosted card checkout plus read-only settlement. Never calls payment completion/capture. */
export function createSquareReceivingAdapter(config:SquareReceivingConfig):ReceivingAdapter {
  const {api,origin}=configuration(config);
  const binding=(c:ReceivingContext)=>hash([config.id,config.mode,c.requestId,c.idempotencyKey,c.method,c.amount,c.currency,c.expectedAtomic,c.createdAt,c.expiresAt]);
  function validate(c:ReceivingContext,creating=false){
    minorAmount(c.amount);
    if(!identifier(c.requestId)||!identifier(c.idempotencyKey)||c.mode!==config.mode||c.method!=='card'||c.currency!==config.currency||c.expectedAtomic!==String(c.amount)||!Number.isFinite(Date.parse(c.createdAt))||!Number.isFinite(Date.parse(c.expiresAt))||Date.parse(c.expiresAt)<=Date.parse(c.createdAt)||creating&&Date.parse(c.expiresAt)<=Date.now())throw unavailable();
  }
  const orderBound=(o:any,c:ReceivingContext,id:string)=>o?.id===id&&o.location_id===config.locationId&&o.reference_id===binding(c).slice(0,40)&&o.metadata?.receive_request===c.requestId&&o.metadata?.receive_method===c.method&&o.metadata?.receive_binding===binding(c)&&sameMoney(o.total_money,c.amount,c.currency);
  const returnUrl=(c:ReceivingContext)=>{
    const raw=(c as ReceivingContext&{returnUrl?:string}).returnUrl;
    if(!raw)return new URL('/payment-methods',origin).toString();
    const url=new URL(raw);
    if(url.origin!==origin.origin||url.username||url.password||url.hash||url.search||!/^\/receive\/[A-Za-z0-9_-]{16,192}$/.test(url.pathname))throw unavailable();return url.toString();
  };
  return {id:config.id,mode:config.mode,methods:['card'],walletOptionIds:['square'],supportedCurrencies:[config.currency],creationRetrySafe:true,
    async create(c){
      validate(c,true);const redirectUrl=returnUrl(c);await verifySquareReceivingConnection(config);
      const b=binding(c),result=await api('/v2/online-checkout/payment-links',{method:'POST',body:JSON.stringify({idempotency_key:b,order:{location_id:config.locationId,reference_id:b.slice(0,40),metadata:{receive_request:c.requestId,receive_method:c.method,receive_binding:b},line_items:[{name:'Invoice payment',quantity:'1',base_price_money:{amount:c.amount,currency:c.currency}}]},checkout_options:{allow_tipping:false,ask_for_shipping_address:false,redirect_url:redirectUrl},payment_note:`ql:${b}`})});
      const link=result.payment_link;if(!identifier(link?.id)||!identifier(link?.order_id)||typeof link.url!=='string'||link.url.length>2048)throw unavailable();
      let url:URL;try{url=new URL(link.url);}catch{throw unavailable();}
      if(url.protocol!=='https:'||url.hostname!==(config.mode==='live'?'square.link':'sandbox.square.link')||url.port||url.username||url.password||url.hash||url.search||!/^\/u\/[A-Za-z0-9_-]+$/.test(url.pathname))throw unavailable();
      const {order}=await api(`/v2/orders/${encodeURIComponent(link.order_id)}`);if(!orderBound(order,c,link.order_id))throw unavailable();
      return {providerId:link.order_id,url:url.toString(),network:'square',asset:c.currency,opaque:{binding:b,paymentLinkId:link.id,merchantId:config.merchantId},instructions:[{label:'Confirmation',value:'Only exact completed card payment readback issues a receipt. Approval, redirect or payer reports do not confirm payment.'}]};
    },
    async check(c,intent){
      try{
        validate(c);if(Date.parse(c.expiresAt)<=Date.now()||!identifier(intent.providerId)||intent.opaque?.binding!==binding(c)||intent.opaque?.merchantId!==config.merchantId||intent.network!=='square'||intent.asset!==c.currency)return review();
        await verifySquareReceivingConnection(config);
        const {order}=await api(`/v2/orders/${encodeURIComponent(intent.providerId)}`);
        if(!orderBound(order,c,intent.providerId)||!empty(order.refunds)||!empty(order.returns))return review();
        if(order.state!=='COMPLETED'||!Array.isArray(order.tenders)||!order.tenders.length)return {status:'pending',reason:'Square has not reported a completed paid order.'};
        if(order.tenders.length!==1||!sameMoney(order.net_amount_due_money,0,c.currency))return review();
        const tender=order.tenders[0];
        if(!identifier(tender.id)||!identifier(tender.payment_id)||tender.type!=='CARD'||tender.location_id!==config.locationId||!sameMoney(tender.amount_money,c.amount,c.currency))return review();
        const {payment}=await api(`/v2/payments/${encodeURIComponent(tender.payment_id)}`);
        if(payment?.id!==tender.payment_id||payment.status!=='COMPLETED'||payment.order_id!==intent.providerId||payment.location_id!==config.locationId||!sameMoney(payment.amount_money,c.amount,c.currency)||!sameMoney(payment.total_money,c.amount,c.currency)||payment.source_type!=='CARD'||payment.card_details?.status!=='CAPTURED'||payment.note!==`ql:${binding(c)}`||!empty(payment.refund_ids)||(payment.refunded_money!==undefined&&!sameMoney(payment.refunded_money,0,c.currency))||(payment.tip_money!==undefined&&!sameMoney(payment.tip_money,0,c.currency)))return review();
        return {status:'paid',paymentId:`square:${config.merchantId}:${payment.id}`,reference:c.requestId,amount:c.amount,currency:c.currency};
      }catch{return review();}
    },
  };
}
