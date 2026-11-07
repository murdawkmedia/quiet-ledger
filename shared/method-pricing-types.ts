import type {Currency,Invoice} from './contracts.js';
import type {MethodId,PaymentMethod} from './payment-methods.js';

/**
 * Method-priced invoice agreements (v1). An optional per-method adjustment is
 * additional to the issued global discount/premium, uses the same
 * adjustment-eligible line base, and is confirmed exactly once by the public
 * checkout bearer. All amounts are integer minor units of the invoice currency;
 * SAT invoices are whole satoshis and never carry a CAD reference.
 */

/** A single canonical-method price rule stored on the immutable issued invoice. */
export interface MethodPricingRule {
  /** Canonical method id only; the square/bank_transfer aliases are rejected. */
  method:MethodId;
  /** Integer basis points 0..10000; at least one rate must be present and nonzero. */
  discountBps?:number;
  premiumBps?:number;
}

/** Exact arithmetic result of one method price, in invoice minor units. */
export interface MethodPriceAmounts {
  currency:Currency;
  /** Adjustment-eligible line base shared with the issued global adjustments. */
  eligibleSubtotal:number;
  issuedSubtotal:number;
  issuedDiscountAmount:number;
  issuedPremiumAmount:number;
  issuedTax:number;
  issuedTotal:number;
  /** The method rule's own rates. */
  discountBps:number;
  premiumBps:number;
  /** Method-only, nonnegative. */
  discountAmount:number;
  premiumAmount:number;
  /** After global and method adjustments, pre-tax. */
  adjustedSubtotal:number;
  effectiveTax:number;
  /** Signed: effectiveTax - issuedTax. */
  taxAdjustment:number;
  effectiveTotal:number;
  /** Signed: effectiveTotal - issuedTotal. */
  totalAdjustment:number;
  /** Legacy fixed CAD reference prorated to the effective price; never a fresh FX quote. Absent for SAT. */
  referenceTotalCad?:number;
  /** Legacy demonstration reference prorated to the effective price; the exact total for SAT invoices. */
  referenceAmountSats?:number;
}

/** A server-recomputed price shown to the payer before any commitment. */
export interface MethodPriceOffer extends MethodPriceAmounts {
  method:MethodId;
  /** 64 lowercase hex characters covering invoice id, canonical method and all amounts. */
  offerHash:string;
}

/** One permanent payer-confirmed price lock; append-only, at most one per invoice. */
export interface InvoiceMethodAgreement extends MethodPriceAmounts {
  id:string;
  invoiceId:string;
  method:MethodId;
  offerHash:string;
  confirmedAt:string;
  confirmation:'public_checkout_token';
}

/**
 * Public-safe agreement projection: removes invoiceId and the labelled CAD
 * reference. The id is an identifier, not a bearer credential, and the
 * projection grants no checkout, receipt or owner capability.
 */
export type PublicMethodAgreement = Omit<InvoiceMethodAgreement,'invoiceId'|'referenceTotalCad'>;

/**
 * Local additive intersection until shared contracts carry the pricing fields
 * natively; the parent wires these into Invoice/PublicInvoice after SAT lands.
 */
export type MethodPricedInvoice = Invoice & {methodPricing?:MethodPricingRule[];priceAgreement?:InvoiceMethodAgreement};

/** Structural slice of an issued invoice snapshot the pure pricing engine reads. */
export type MethodPricingInput = Pick<Invoice,'items'|'taxBps'|'subtotal'|'tax'|'total'|'currency'|'discountBps'|'premiumBps'|'discountAmount'|'premiumAmount'|'totalCad'|'amountSats'>;

/** Validation context for strict persisted-rule checking. */
export interface MethodPricingContext {currency:string;acceptedMethods?:PaymentMethod[]}
