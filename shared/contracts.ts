export type Currency = 'CAD' | 'USD' | 'EUR' | 'GBP' | 'KRW';
export type {PaymentMethod} from './payment-methods.js';
import type {PaymentMethod} from './payment-methods.js';
export interface InvoiceItem { description: string; quantity: number; unitAmount: number }
/** Billing details captured when the invoice is issued; later contact edits do not change them. */
export interface InvoiceBilling {
  sellerName:string;
  sellerEmail?:string;
  sellerAddress?:string;
  sellerTaxId?:string;
  customerAddress?:string;
}
export interface Invoice {
  id: string; number: string; token: string; title: string; customerName: string;
  customerEmail?: string; issueDate?: string; dueDate?: string; discountBps?:number; premiumBps?:number; discountAmount?:number; premiumAmount?:number; acceptedMethods?:PaymentMethod[]; currency: Currency; items: InvoiceItem[]; taxBps: number;
  subtotal: number; tax: number; total: number; totalCad: number; amountSats: number;
  status: 'open' | 'paid'; paymentMethod?: PaymentMethod; createdAt: string;
  paidAt?: string; note?: string; billing?:InvoiceBilling; receiptToken?: string; settlementMode?:'simulation'|'live'; nativePayment?:{asset:string;atomicAmount:string;network:string;paymentId:string;verification:'provider'|'manual'};
}
export type PublicInvoice = Pick<Invoice, 'number' | 'title' | 'customerName' | 'currency' | 'items' | 'taxBps' | 'subtotal' | 'tax' | 'total' | 'amountSats' | 'status' | 'createdAt' | 'issueDate' | 'discountBps' | 'premiumBps' | 'discountAmount' | 'premiumAmount' | 'acceptedMethods' | 'dueDate' | 'paidAt' | 'note' | 'billing' | 'paymentMethod' | 'settlementMode' | 'nativePayment'>;
export interface Receipt {
  number: string; issuedAt: string; mode: 'simulation'|'live'; method: PaymentMethod; nativePayment?:Invoice['nativePayment'];
  amount: number; currency: Currency; amountSats?: number; invoiceNumber: string;
  title: string; customerName: string;
}
export type PayoutStatus = 'quoted' | 'funding_pending' | 'provider_processing' | 'provider_reported_paid' | 'received';
export interface Payout {
  id: string; invoiceId: string; invoiceNumber: string;
  provider: 'bullbitcoin' | 'bitcoinwell' | 'wise'; destinationType: 'bank' | 'bill';
  recipientLabel: string; amount: number; fee: number; totalDebit: number;
  netAmount: number; exchangeRate: number; expiresAt: string; createdAt: string;
  status: PayoutStatus; providerReference?: string; mode: 'simulation';
}
export interface AuditEvent { id: string; action: string; description: string; createdAt: string }
export interface Integration {
  id: string; name: string; category: string; status: string; description: string;
  capabilities: string[]; requirements: string[]; url: string; restrictions?: string | string[];
}
export interface SessionView {
  authenticated: boolean; role: 'demo' | 'owner' | null; csrfToken?: string;
  privateScenarioAvailable: boolean;authMode?:'local'|'hosted';accountId?:string;
  demoAvailable?:boolean;hackathonDemo?:boolean;marmotAvailable?:boolean;
}
export interface Dashboard {
  totals: { invoicedCad: number; receivedCad: number; availableCad: number; spentCad: number };
  invoices: Invoice[]; payouts: Payout[]; activity: AuditEvent[];
}
export interface PrivateScenario {
  title: string; sourceDate?: string; status?: string; summary?: string;
  metrics?: { label: string; amount?: number; value?: string | number; currency?: string; note?: string }[];
  obligations?: { label: string; amount: number; currency?: string; status?: string; note?: string }[];
  conditions?: { label: string; status?: string; note?: string }[];
  sources?: string[]; notes?: string[];
}
export interface SquareTestReceipt {
  number:string; mode:'square_sandbox'; amount:number; currency:'CAD'|'USD';
  invoiceNumber:string; verifiedAt:string;
}
export interface SquareTestCheckout {
  id:string; token:string; invoiceNumber:string; amount:number; currency:'CAD'|'USD';
  mode:'square_sandbox'; status:'creation_pending'|'awaiting_payment'|'paid';
  createdAt:string; url?:string; receipt?:SquareTestReceipt;
}
export interface SquareSandboxView {
  environment:'sandbox'; configured:boolean;
  connection:{currency:Currency;verifiedAt:string}|null;
  checkouts:(SquareTestCheckout & {invoiceId:string})[];
}
