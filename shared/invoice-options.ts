import type {Currency,InvoiceItem} from './contracts.js';
import type {PaymentMethod} from './payment-methods.js';
import {methodInfo} from './payment-methods.js';
export interface InvoiceDraft {customerName:string;customerEmail?:string;title:string;currency:Currency;items:InvoiceItem[];taxBps?:number;issueDate?:string;dueDate?:string;discountBps?:number;premiumBps?:number;acceptedMethods?:PaymentMethod[];note?:string}
export interface InvoiceTemplate {id:string;label:string;draft:InvoiceDraft}
export const INVOICE_CURRENCIES=['CAD','USD','KRW','EUR','GBP'] as const;
export function currencyScale(currency:string){return currency==='KRW'?1:100;}
export function parseInvoiceAmount(text:string,currency:string){const value=text.trim(),scale=currencyScale(currency);if(!(scale===1?/^\d+$/:/^\d+(\.\d{1,2})?$/).test(value))throw new Error(scale===1?'Enter a whole-won amount.':'Enter an amount with up to two decimal places.');const [whole,decimal='']=value.split('.');const result=BigInt(whole)*BigInt(scale)+(scale===1?0n:BigInt(decimal.padEnd(2,'0')));if(result<0n||result>1000000000n)throw new Error('Amount is outside the supported range.');return Number(result);}
export function formatInvoiceAmount(minor:number,currency:string){if(!Number.isSafeInteger(minor))throw new Error('Invalid invoice amount.');return new Intl.NumberFormat('en-CA',{style:'currency',currency}).format(minor/currencyScale(currency));}
export function calculateInvoiceAmounts(items:InvoiceItem[],taxBps=0,discountBps=0,premiumBps=0){const subtotal=items.reduce((n,item)=>n+BigInt(item.quantity)*BigInt(item.unitAmount),0n);const discount=(subtotal*BigInt(discountBps)+5000n)/10000n,premium=(subtotal*BigInt(premiumBps)+5000n)/10000n;const adjusted=subtotal-discount+premium;const tax=(adjusted*BigInt(taxBps)+5000n)/10000n;return {subtotal:Number(subtotal),discountAmount:Number(discount),premiumAmount:Number(premium),tax:Number(tax),total:Number(adjusted+tax)};}
export function invoiceAllowsMethod(invoice:{acceptedMethods?:PaymentMethod[]},method:PaymentMethod){const canonical=(value:PaymentMethod)=>value==='square'?'card':value==='bank_transfer'?'bank':value;return invoice.acceptedMethods===undefined||invoice.acceptedMethods.some(value=>canonical(value)===canonical(method));}
export function invoiceRequiresManualReport(invoice:{acceptedMethods?:PaymentMethod[]},method:PaymentMethod){
 if(!['manual','adjustment'].includes(methodInfo(method).family))return false;
 // The legacy transfer button simulates payment unless the merchant explicitly
 // offered only the owner-confirmed bank method for this invoice.
 return method!=='bank_transfer'||Boolean(invoice.acceptedMethods?.includes('bank')&&!invoice.acceptedMethods.includes('bank_transfer'));
}
