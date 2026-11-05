import {createHmac,timingSafeEqual} from 'node:crypto';
import {bounded,minorAmount,providerJson,type HttpFetch} from './http.js';

const BASE='https://connect.squareupsandbox.com';
const VERSION='2026-09-16';
export function createSquareSandboxClient(options:{token:string;locationId:string;locationCurrency?:'CAD'|'USD';fetcher?:HttpFetch}){
  bounded(options.token,'Square sandbox credential',4096);bounded(options.locationId,'Square location');
  const fetcher=options.fetcher??fetch;
  const headers={'Authorization':`Bearer ${options.token}`,'Square-Version':VERSION,'Content-Type':'application/json'};
  return {
    async createPaymentLink(input:{amount:number;currency:'CAD'|'USD';title:string;idempotencyKey:string}){
      minorAmount(input.amount);bounded(input.title,'checkout title',200);bounded(input.idempotencyKey,'idempotency key');
      if(input.currency!==(options.locationCurrency??'CAD'))throw new Error('Checkout currency must match the configured Square location.');
      const result=await providerJson(fetcher,`${BASE}/v2/online-checkout/payment-links`,{method:'POST',headers,body:JSON.stringify({idempotency_key:input.idempotencyKey,quick_pay:{name:input.title,price_money:{amount:input.amount,currency:input.currency},location_id:options.locationId}})},'Square');
      const link=result?.payment_link;
      if(!link?.id||!link?.url||!link?.order_id)throw new Error('Square checkout response is incomplete.');
      bounded(link.id,'Square payment link id',200);bounded(link.order_id,'Square order id',200);bounded(link.url,'Square checkout URL',2048);
      let parsed:URL;try{parsed=new URL(link.url);}catch{throw new Error('Square checkout URL is invalid.');}
      if(parsed.protocol!=='https:'||parsed.hostname!=='sandbox.square.link'||parsed.username||parsed.password||parsed.port)throw new Error('Square sandbox checkout host is not recognized.');
      return {id:String(link.id),url:String(link.url),orderId:String(link.order_id),environment:'sandbox' as const};
    },
    async getPayment(paymentId:string){
      bounded(paymentId,'payment id',200);
      return (await providerJson(fetcher,`${BASE}/v2/payments/${encodeURIComponent(paymentId)}`,{method:'GET',headers},'Square')).payment;
    },
    async getOrder(orderId:string){
      bounded(orderId,'order id',200);
      return (await providerJson(fetcher,`${BASE}/v2/orders/${encodeURIComponent(orderId)}`,{method:'GET',headers},'Square')).order;
    },
  };
}

export async function listSquareSandboxLocations(token:string,fetcher:HttpFetch=fetch):Promise<{id:string;currency:'CAD'|'USD'}[]>{
  bounded(token,'Square sandbox credential',4096);
  const result=await providerJson(fetcher,`${BASE}/v2/locations`,{method:'GET',headers:{Authorization:`Bearer ${token}`,'Square-Version':VERSION}},'Square');
  if(!Array.isArray(result?.locations)||result.locations.length>100)throw new Error('Square sandbox locations response is invalid.');
  return result.locations.filter((location:any)=>location?.status==='ACTIVE'&&['CAD','USD'].includes(location.currency)).map((location:any)=>{bounded(location.id,'Square location',200);return {id:location.id,currency:location.currency};});
}

export function verifySquareSignature(input:{rawBody:string;notificationUrl:string;signatureKey:string;signature:string}):boolean{
  if(!input.signatureKey||!input.signature||input.signature.length>1000)return false;
  const expected=createHmac('sha256',input.signatureKey).update(input.notificationUrl+input.rawBody).digest('base64');
  const a=Buffer.from(expected),b=Buffer.from(input.signature);
  return a.length===b.length&&timingSafeEqual(a,b);
}
export function assertSquarePayment(payment:any,expected:{orderId:string;locationId:string;amount:number;currency:'CAD'|'USD'}):void{
  minorAmount(expected.amount);
  if(!payment||payment.status!=='COMPLETED'||payment.order_id!==expected.orderId||payment.location_id!==expected.locationId||payment.amount_money?.amount!==expected.amount||payment.amount_money?.currency!==expected.currency)throw new Error('Square payment is not settled for this exact order, location, currency and amount.');
}
