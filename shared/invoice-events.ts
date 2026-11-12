import type {Currency,PaymentMethod} from './contracts.js';

/** The only durable invoice event types; simulations never emit events. */
export type InvoiceEventType='payment.received'|'invoice.paid';

/** Whitelisted payment material; no tokens, names, emails, notes or provider ids. */
export interface InvoiceEventPayment {amount:number;method:PaymentMethod;verification:'provider'|'manual'}

/**
 * Append-only durable event row. The payload is a fixed whitelist: invoice
 * number/title, customer fields, billing, checkout/receipt bearer tokens,
 * provider payment ids, URLs, instructions, wallet material and notes are
 * never included.
 */
export interface InvoiceEvent {
  /** Deterministic: evt_ + first 32 hex of a domain-separated digest. */
  id:string;
  /** Per-workspace sequence 1..N. */
  seq:number;
  type:InvoiceEventType;
  /** Same instant as the ledger entry and receipt. */
  occurredAt:string;
  /** Opaque internal invoice UUID only, not a capability. */
  invoiceId:string;
  /** Original issued total, never rewritten. */
  total:number;
  /** Agreed settlement target, else the issued total. */
  effectiveTotal:number;
  currency:Currency;
  mode:'live';
  /** payment.received only. */
  payment?:InvoiceEventPayment;
}

/** Cursor-authenticated page; nextCursor is always present, usable and resumable. */
export interface InvoiceEventPage {events:InvoiceEvent[];nextCursor:string;hasMore:boolean}

export const INVOICE_EVENT_TYPES:readonly InvoiceEventType[]=['payment.received','invoice.paid'];
