import type {Currency,InvoiceBilling,InvoiceItem} from './contracts.js';
import type {PaymentMethod} from './payment-methods.js';
import {methodInfo} from './payment-methods.js';
import type {MethodPricingRule} from './method-pricing-types.js';
export interface InvoiceDraft {methodPricing?:MethodPricingRule[];customerName:string;customerEmail?:string;title:string;currency:Currency;items:InvoiceItem[];taxBps?:number;issueDate?:string;dueDate?:string;paymentTermDays?:number;paymentTerms?:string;discountBps?:number;premiumBps?:number;acceptedMethods?:PaymentMethod[];note?:string;billing?:InvoiceBilling}
export interface InvoiceTemplate {id:string;label:string;draft:InvoiceDraft}
export const INVOICE_CURRENCIES=['CAD','USD','KRW','EUR','GBP','SAT'] as const;
/** SAT and KRW use whole major units; other currencies use two decimal places. */
export function currencyScale(currency:string){return currency==='KRW'||currency==='SAT'?1:100;}
export function parseInvoiceAmount(text:string,currency:string){const value=text.trim(),scale=currencyScale(currency);if(!(scale===1?/^\d+$/:/^\d+(\.\d{1,2})?$/).test(value))throw new Error(scale===1?(currency==='SAT'?'Enter a whole-satoshi amount.':'Enter a whole-won amount.'):'Enter an amount with up to two decimal places.');const [whole,decimal='']=value.split('.');const result=BigInt(whole)*BigInt(scale)+(scale===1?0n:BigInt(decimal.padEnd(2,'0')));if(result<0n||result>1000000000n)throw new Error('Amount is outside the supported range.');return Number(result);}
/** SAT never reaches fiat currency formatting: whole satoshis with a plain decimal format. */
export function formatInvoiceAmount(minor:number,currency:string){if(!Number.isSafeInteger(minor))throw new Error('Invalid invoice amount.');if(currency==='SAT')return new Intl.NumberFormat('en-CA',{maximumFractionDigits:0}).format(minor)+' sats';return new Intl.NumberFormat('en-CA',{style:'currency',currency}).format(minor/currencyScale(currency));}
export function calculateInvoiceAmounts(items:InvoiceItem[],taxBps=0,discountBps=0,premiumBps=0){
 let subtotal=0n,eligibleSubtotal=0n;
 for(const item of items){
  const amount=BigInt(item.quantity)*BigInt(item.unitAmount);subtotal+=amount;
  // Missing flags keep legacy invoices eligible; an explicit choice overrides kind.
  if(item.adjustmentEligible??item.kind!=='expense')eligibleSubtotal+=amount;
 }
 const discount=(eligibleSubtotal*BigInt(discountBps)+5000n)/10000n,premium=(eligibleSubtotal*BigInt(premiumBps)+5000n)/10000n;
 const adjusted=subtotal-discount+premium;
 const tax=(adjusted*BigInt(taxBps)+5000n)/10000n;
 return {subtotal:Number(subtotal),discountAmount:Number(discount),premiumAmount:Number(premium),tax:Number(tax),total:Number(adjusted+tax)};
}
export function invoiceAllowsMethod(invoice:{acceptedMethods?:PaymentMethod[]},method:PaymentMethod){const canonical=(value:PaymentMethod)=>value==='square'?'card':value==='bank_transfer'?'bank':value;return invoice.acceptedMethods===undefined||invoice.acceptedMethods.some(value=>canonical(value)===canonical(method));}
/**
 * SAT-denominated invoices settle only in whole satoshis: Bitcoin-native methods and
 * owner-reviewed noncash adjustments. Fiat, bank, card and stablecoin rails are excluded
 * because paying sats through them would imply an unquoted conversion.
 */
export function currencyAllowsMethod(currency:string,method:PaymentMethod){if(currency!=='SAT')return true;const settlement=methodInfo(method).settlement;return settlement==='bitcoin'||settlement==='noncash';}
export function invoiceRequiresManualReport(invoice:{acceptedMethods?:PaymentMethod[]},method:PaymentMethod){
 if(!['manual','adjustment'].includes(methodInfo(method).family))return false;
 // The legacy transfer button simulates payment unless the merchant explicitly
 // offered only the owner-confirmed bank method for this invoice.
 return method!=='bank_transfer'||Boolean(invoice.acceptedMethods?.includes('bank')&&!invoice.acceptedMethods.includes('bank_transfer'));
}
