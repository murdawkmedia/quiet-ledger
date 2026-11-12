import type {Currency,Invoice} from './contracts.js';
import type {MethodId,PaymentMethod} from './payment-methods.js';

/**
 * Method-priced invoice agreements (v1). An optional per-method adjustment is
 * additional to the issued global discount/premium, uses the same
 * adjustment-eligible line base, and is confirmed exactly once by the public
 * checkout bearer. All amounts are integer minor units of the invoice currency;
 * SAT invoices are whole satoshis and never carry a CAD reference.
 */

/**
 * Optional adjustment base for one method rule: `eligible` keeps the exact
 * legacy eligible-line behaviour (and stays the default when absent), while
 * `subtotal` applies the rule's own rates to the whole invoice subtotal before
 * tax. Each rule uses one basis for its own rates.
 */
export type MethodPricingBasis='eligible'|'subtotal';

/**
 * Rule-target identifier for the single `All fiat methods` fallback rule. It is
 * a recommended-method selector value only: never a payable payment method,
 * never a member of the concrete canonical payment-method enum, and never
 * confirmed as a checkout rail.
 */
export const FIAT_RULE_TARGET='fiat' as const;
/** A rule addresses one concrete canonical method or the all-fiat group target. */
export type MethodPricingRuleTarget=MethodId|typeof FIAT_RULE_TARGET;

/** A single canonical-method price rule stored on the immutable issued invoice. */
export interface MethodPricingRule {
  /** Canonical method id only (the square/bank_transfer aliases are rejected), or the all-fiat group target. */
  method:MethodPricingRuleTarget;
  /** Optional adjustment base; absent keeps the legacy eligible-line base. */
  basis?:MethodPricingBasis;
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
  /** The adjustment base actually used by this rule; absent on legacy eligible-line results. */
  basis?:MethodPricingBasis;
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
