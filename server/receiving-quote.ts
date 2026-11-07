import {currencyScale} from '../shared/invoice-options.js';
import type {Invoice} from '../shared/contracts.js';
import {methodInfo,type MethodId} from '../shared/payment-methods.js';
import {providerJson,type HttpFetch} from '../integrations/http.js';
import type {ReceivingQuote} from './receiving-service.js';
function ratio(value:unknown){
  if(typeof value!=='string'||value.length>40||!/^\d+(\.\d{1,18})?$/.test(value))throw new Error('Invalid price reference.');
  const [whole,decimal='']=value.split('.');const numerator=BigInt(whole+decimal),denominator=10n**BigInt(decimal.length);if(numerator<=0n)throw new Error('Invalid price reference.');return {numerator,denominator};
}
const round=(numerator:bigint,denominator:bigint)=>(numerator+denominator/2n)/denominator;
export async function quoteReceiving(invoice:Invoice,method:MethodId,mode:'live'|'test',fetcher:HttpFetch=fetch):Promise<ReceivingQuote>{
  const info=methodInfo(method),observedAt=new Date().toISOString();
  if(invoice.currency==='SAT'){
    // A SAT invoice binds its own exact satoshi amount. There is no fiat conversion,
    // no price reference and no network request in either mode.
    if(info.settlement!=='bitcoin')throw new Error('SAT invoices support Bitcoin-native receiving methods only.');
    return {expectedAtomic:String(invoice.total),cadEquivalent:undefined,source:'Exact SAT invoice denomination; no fiat conversion',observedAt};
  }
  if(mode==='test')return {expectedAtomic:String(info.settlement==='bitcoin'?invoice.amountSats:info.settlement==='stablecoin'?(invoice.currency==='USD'?invoice.total*10000:Math.round(invoice.totalCad!*1000000/140)):invoice.total),cadEquivalent:invoice.totalCad,source:'Explicit fixed demonstration rates; test mode only',observedAt};
  if(invoice.currency==='CAD'&&info.settlement!=='bitcoin'&&info.settlement!=='stablecoin')return {expectedAtomic:String(invoice.total),cadEquivalent:invoice.total,source:'Exact CAD invoice amount; no currency conversion',observedAt};
  const exchange=await providerJson(fetcher,`https://api.coinbase.com/v2/exchange-rates?currency=${invoice.currency}`,{method:'GET'},'Price reference');
  if(exchange?.data?.currency!==invoice.currency)throw new Error('Price-reference currency mismatch.');
  const cad=invoice.currency==='CAD'?{numerator:1n,denominator:1n}:ratio(exchange.data.rates?.CAD);
  const cadEquivalent=Number(round(BigInt(invoice.total)*cad.numerator*100n,cad.denominator*BigInt(currencyScale(invoice.currency))));
  if(!Number.isSafeInteger(cadEquivalent)||cadEquivalent<1)throw new Error('Invalid CAD reference value.');
  let expectedAtomic=BigInt(invoice.total);
  if(info.settlement==='bitcoin'){
    const response=await providerJson(fetcher,`https://api.coinbase.com/v2/prices/BTC-${invoice.currency}/spot`,{method:'GET'},'Bitcoin price reference');
    if(response?.data?.base!=='BTC'||response?.data?.currency!==invoice.currency)throw new Error('Bitcoin price-reference binding mismatch.');
    const price=ratio(response.data.amount);expectedAtomic=round(BigInt(invoice.total)*100000000n*price.denominator,BigInt(currencyScale(invoice.currency))*price.numerator);
  }else if(info.settlement==='stablecoin'){
    const usd=invoice.currency==='USD'?{numerator:1n,denominator:1n}:ratio(exchange.data.rates?.USD);
    expectedAtomic=round(BigInt(invoice.total)*1000000n*usd.numerator,usd.denominator*BigInt(currencyScale(invoice.currency)));
  }
  if(expectedAtomic<1n||expectedAtomic>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Native payment amount is outside the supported range.');
  return {expectedAtomic:String(expectedAtomic),cadEquivalent,source:'Coinbase public spot/FX reference at retrieval; not an executable exchange quote',observedAt};
}
