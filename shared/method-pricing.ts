import type {InvoiceItem} from './contracts.js';
import {METHOD_DEFINITIONS,type MethodId,type PaymentMethod} from './payment-methods.js';
import {invoiceAllowsMethod,currencyAllowsMethod} from './invoice-options.js';
import type {MethodPriceAmounts,MethodPricingContext,MethodPricingInput,MethodPricingRule} from './method-pricing-types.js';

/** Upper bound on stored rules: one per canonical method. */
export const METHOD_PRICING_MAX_RULES = METHOD_DEFINITIONS.length;
/** The application's existing final-total bound in minor units. */
const MAX_TOTAL = 1_000_000_000n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Adjustment-eligible line base. This is the same eligibility expression as
 * calculateInvoiceAmounts: a missing flag keeps legacy invoices eligible and an
 * explicit adjustmentEligible choice overrides kind. Parent should deduplicate
 * calculateInvoiceAmounts onto this helper once the SAT change lands.
 */
export function eligibleInvoiceSubtotal(items:readonly InvoiceItem[]):bigint{
  let eligible=0n;
  for(const item of items){
    const amount=BigInt(item.quantity)*BigInt(item.unitAmount);
    if(item.adjustmentEligible??item.kind!=='expense')eligible+=amount;
  }
  return eligible;
}

/** roundHalfUp(n,d) = (n + d/2) / d for nonnegative integer arithmetic. */
export function roundHalfUp(numerator:bigint,denominator:bigint):bigint{
  if(denominator<=0n)throw new Error('Method pricing requires a positive divisor.');
  if(numerator<0n)throw new Error('Method pricing rounding requires nonnegative values.');
  return (numerator+denominator/2n)/denominator;
}

function safeInteger(value:bigint,label:string):number{
  if(value>MAX_SAFE||value<-MAX_SAFE)throw new Error(`Method pricing ${label} exceeds the supported precision.`);
  return Number(value);
}

/**
 * Strict validation of a persisted/drafted methodPricing array. Absent input
 * returns undefined (legacy invoices keep their issued price). An empty array,
 * aliases, duplicates, unaccepted methods, SAT-incompatible methods, fractional
 * or out-of-range rates, absent or all-zero rates and unknown fields all throw.
 */
export function parseMethodPricingRules(input:unknown,context:MethodPricingContext):MethodPricingRule[]|undefined{
  if(input===undefined)return undefined;
  if(!Array.isArray(input)||input.length===0)throw new Error('Method pricing requires at least one rule.');
  if(input.length>METHOD_PRICING_MAX_RULES)throw new Error(`Method pricing accepts at most ${METHOD_PRICING_MAX_RULES} rules.`);
  const canonical=new Set<string>(METHOD_DEFINITIONS.map(definition=>definition.id)),seen=new Set<string>(),rules:MethodPricingRule[]=[];
  for(const entry of input){
    if(!entry||typeof entry!=='object'||Array.isArray(entry))throw new Error('Each method pricing rule must be an object.');
    const record=entry as Record<string,unknown>;
    for(const key of Object.keys(record))if(!['method','discountBps','premiumBps'].includes(key))throw new Error('Method pricing rules accept only method, discountBps and premiumBps.');
    const method=record.method;
    if(typeof method!=='string'||!canonical.has(method))throw new Error('Method pricing rules accept canonical payment methods only.');
    if(seen.has(method))throw new Error('Select each priced method only once.');
    seen.add(method);
    for(const [,value] of [['discountBps',record.discountBps],['premiumBps',record.premiumBps]] as [string,unknown][])
      if(value!==undefined&&(!Number.isSafeInteger(value)||(value as number)<0||(value as number)>10000))throw new Error('Method adjustment rates must be whole basis points between 0 and 10000.');
    if(record.discountBps===undefined&&record.premiumBps===undefined)throw new Error('A method pricing rule needs a discount or premium rate.');
    if((record.discountBps??0)===0&&(record.premiumBps??0)===0)throw new Error('A method pricing rule needs a nonzero discount or premium rate.');
    if(!invoiceAllowsMethod({acceptedMethods:context.acceptedMethods},method as PaymentMethod))throw new Error('Priced methods must be accepted for this invoice.');
    if(!currencyAllowsMethod(context.currency,method as PaymentMethod))throw new Error(`Priced methods must support ${context.currency} invoices.`);
    rules.push({method:method as MethodId,...(record.discountBps!==undefined?{discountBps:record.discountBps as number}:{}),...(record.premiumBps!==undefined?{premiumBps:record.premiumBps as number}:{})});
  }
  return rules;
}

/**
 * Pure method-price calculation from an issued invoice snapshot. The eligible-only
 * method adjustment stacks on the issued global adjustments and tax is computed
 * exactly once on the final adjusted subtotal (never as separately rounded
 * components). Every product and division uses BigInt with round-half-up.
 */
export function calculateMethodPrice(invoice:MethodPricingInput,rule:MethodPricingRule):MethodPriceAmounts{
  const eligible=eligibleInvoiceSubtotal(invoice.items);
  const issuedSubtotal=BigInt(invoice.subtotal),issuedDiscount=BigInt(invoice.discountAmount??0),issuedPremium=BigInt(invoice.premiumAmount??0),issuedTax=BigInt(invoice.tax),issuedTotal=BigInt(invoice.total);
  // Fail closed when the issued snapshot no longer matches its own lines.
  let itemsTotal=0n;
  for(const item of invoice.items)itemsTotal+=BigInt(item.quantity)*BigInt(item.unitAmount);
  if(itemsTotal!==issuedSubtotal)throw new Error('Invoice subtotal does not match its items.');
  if(roundHalfUp(eligible*BigInt(invoice.discountBps??0),10000n)!==issuedDiscount||roundHalfUp(eligible*BigInt(invoice.premiumBps??0),10000n)!==issuedPremium)throw new Error('Invoice adjustments do not match their eligible base.');
  if(issuedSubtotal-issuedDiscount+issuedPremium+issuedTax!==issuedTotal)throw new Error('Invoice totals are inconsistent.');
  const discountBps=BigInt(rule.discountBps??0),premiumBps=BigInt(rule.premiumBps??0);
  const methodDiscount=roundHalfUp(eligible*discountBps,10000n),methodPremium=roundHalfUp(eligible*premiumBps,10000n);
  const issuedAdjusted=issuedSubtotal-issuedDiscount+issuedPremium;
  const adjusted=issuedAdjusted-methodDiscount+methodPremium;
  if(adjusted<0n)throw new Error('The method adjustment exceeds the adjusted invoice subtotal.');
  const effectiveTax=roundHalfUp(adjusted*BigInt(invoice.taxBps),10000n),effectiveTotal=adjusted+effectiveTax;
  if(effectiveTotal<1n||effectiveTotal>MAX_TOTAL)throw new Error('Effective invoice total is outside the supported range.');
  const amounts:MethodPriceAmounts={
    currency:invoice.currency,
    eligibleSubtotal:safeInteger(eligible,'eligible subtotal'),issuedSubtotal:safeInteger(issuedSubtotal,'issued subtotal'),
    issuedDiscountAmount:safeInteger(issuedDiscount,'issued discount'),issuedPremiumAmount:safeInteger(issuedPremium,'issued premium'),
    issuedTax:safeInteger(issuedTax,'issued tax'),issuedTotal:safeInteger(issuedTotal,'issued total'),
    discountBps:Number(discountBps),premiumBps:Number(premiumBps),
    discountAmount:safeInteger(methodDiscount,'method discount'),premiumAmount:safeInteger(methodPremium,'method premium'),
    adjustedSubtotal:safeInteger(adjusted,'adjusted subtotal'),effectiveTax:safeInteger(effectiveTax,'effective tax'),
    taxAdjustment:safeInteger(effectiveTax-issuedTax,'tax adjustment'),effectiveTotal:safeInteger(effectiveTotal,'effective total'),
    totalAdjustment:safeInteger(effectiveTotal-issuedTotal,'total adjustment'),
  };
  if(invoice.currency==='SAT'){
    // SAT binds exact whole satoshis and never gains a fiat reference.
    amounts.referenceAmountSats=amounts.effectiveTotal;
  }else{
    // Legacy fixed references prorated to the effective price; never a fresh FX quote.
    if(invoice.totalCad!==undefined)amounts.referenceTotalCad=safeInteger(roundHalfUp(BigInt(invoice.totalCad)*effectiveTotal,issuedTotal),'CAD reference');
    if(invoice.amountSats!==undefined)amounts.referenceAmountSats=safeInteger(roundHalfUp(BigInt(invoice.amountSats)*effectiveTotal,issuedTotal),'satoshi reference');
  }
  return amounts;
}

/**
 * Fixed canonical serialization covered by the server offer hash: invoice id,
 * canonical method and the complete MethodPriceAmounts in a stable field order,
 * with absent optional references encoded as null.
 */
export function canonicalMethodPriceOfferInput(invoiceId:string,method:MethodId,amounts:MethodPriceAmounts):string{
  return JSON.stringify(['method-price-offer-v1',invoiceId,method,amounts.currency,
    amounts.eligibleSubtotal,amounts.issuedSubtotal,amounts.issuedDiscountAmount,amounts.issuedPremiumAmount,
    amounts.issuedTax,amounts.issuedTotal,amounts.discountBps,amounts.premiumBps,
    amounts.discountAmount,amounts.premiumAmount,amounts.adjustedSubtotal,
    amounts.effectiveTax,amounts.taxAdjustment,amounts.effectiveTotal,amounts.totalAdjustment,
    amounts.referenceTotalCad??null,amounts.referenceAmountSats??null]);
}
