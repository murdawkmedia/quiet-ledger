import type {Currency,Invoice,PaymentMethod} from './contracts.js';

export interface InvoiceBalance {
 total:number;paid:number;credited:number;due:number;overpaid:number;currency:Currency;
 state:'unpaid'|'partially_paid'|'paid'|'credited'|'void';mode:'live'|'simulation';
}
export interface InvoiceLedgerEntry {
 id:string;kind:'payment'|'credit'|'void';amount:number;currency:Currency;createdAt:string;
 reason?:string;method?:PaymentMethod;verification?:'provider'|'manual';receiptToken?:string;receiptNumber?:string;
}
export interface InvoiceLedgerView {invoice:Invoice;balance:InvoiceBalance;entries:InvoiceLedgerEntry[]}
