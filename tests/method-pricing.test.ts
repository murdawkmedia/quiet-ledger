import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateMethodPrice,canonicalMethodPriceOfferInput,eligibleInvoiceSubtotal,parseMethodPricingRules,roundHalfUp} from '../shared/method-pricing.js';
import type {MethodPricingContext,MethodPricingInput} from '../shared/method-pricing-types.js';

// Worked contract from the implementation design: labour 200000 is eligible,
// flights 80000 are excluded, global discount 5%, tax 5%. Issued adjusted
// subtotal 270000, tax 13500, original total 283500.
const issued:MethodPricingInput={
  currency:'CAD',
  items:[{description:'Fictional labour',quantity:1,unitAmount:200000},{description:'Fictional flights',quantity:1,unitAmount:80000,kind:'expense'}],
  taxBps:500,discountBps:500,
  subtotal:280000,discountAmount:10000,tax:13500,total:283500,totalCad:283500,amountSats:2835000,
};

test('method discounts and premiums use eligible overrides and tax once',()=>{
  assert.equal(eligibleInvoiceSubtotal(issued.items),200000n);
  const lightning=calculateMethodPrice(issued,{method:'lightning',discountBps:1000});
  assert.deepEqual(lightning,{currency:'CAD',eligibleSubtotal:200000,issuedSubtotal:280000,issuedDiscountAmount:10000,issuedPremiumAmount:0,issuedTax:13500,issuedTotal:283500,
    discountBps:1000,premiumBps:0,discountAmount:20000,premiumAmount:0,adjustedSubtotal:250000,effectiveTax:12500,taxAdjustment:-1000,
    effectiveTotal:262500,totalAdjustment:-21000,referenceTotalCad:262500,referenceAmountSats:2625000});
  const card=calculateMethodPrice(issued,{method:'card',premiumBps:200});
  assert.deepEqual(card,{currency:'CAD',eligibleSubtotal:200000,issuedSubtotal:280000,issuedDiscountAmount:10000,issuedPremiumAmount:0,issuedTax:13500,issuedTotal:283500,
    discountBps:0,premiumBps:200,discountAmount:0,premiumAmount:4000,adjustedSubtotal:274000,effectiveTax:13700,taxAdjustment:200,
    effectiveTotal:287700,totalAdjustment:4200,referenceTotalCad:287700,referenceAmountSats:2877000});
  // Excluded flights contribute zero to every method base: 10% of 200000, not of 280000.
  assert.equal(lightning.discountAmount,20000);assert.equal(card.premiumAmount,4000);
});

test('effective tax is not a sum of separately rounded tax components',()=>{
  // eligible 12345, tax 5%, method discount 10%: issued tax 617, method discount 1235.
  // Direct tax on the final adjusted subtotal is (11110*500+5000)/10000 = 556.
  // Separately rounding the tax on the discount would give 617 - 62 = 555, which
  // differs by one minor unit; the direct result is required.
  const input:MethodPricingInput={currency:'CAD',items:[{description:'Fictional odd service',quantity:1,unitAmount:12345}],taxBps:500,subtotal:12345,tax:617,total:12962};
  const amounts=calculateMethodPrice(input,{method:'lightning',discountBps:1000});
  assert.deepEqual([amounts.discountAmount,amounts.adjustedSubtotal,amounts.effectiveTax,amounts.taxAdjustment],[1235,11110,556,-61]);
  assert.notEqual(amounts.effectiveTax,555);assert.notEqual(amounts.taxAdjustment,-62);
});

test('legacy missing flags and zero-rate methods preserve the issued price',()=>{
  // Untyped items stay eligible, matching calculateInvoiceAmounts.
  assert.equal(eligibleInvoiceSubtotal([{description:'Fictional legacy service',quantity:2,unitAmount:50}]),100n);
  assert.equal(eligibleInvoiceSubtotal([{description:'Fictional explicit expense',quantity:1,unitAmount:70,kind:'expense',adjustmentEligible:true}]),70n);
  // Absent rules keep the legacy branch: undefined input is not an error.
  assert.equal(parseMethodPricingRules(undefined,{currency:'CAD'}),undefined);
  // A zero-rate rule (rejected at persistence, allowed in arithmetic) reproduces
  // the issued price exactly: no method fields, effective totals equal issued.
  const amounts=calculateMethodPrice(issued,{method:'bank',discountBps:0,premiumBps:0});
  assert.deepEqual([amounts.discountAmount,amounts.premiumAmount,amounts.effectiveTax,amounts.effectiveTotal,amounts.taxAdjustment,amounts.totalAdjustment],[0,0,13500,283500,0,0]);
});

test('invalid rule shapes cannot produce a price',()=>{
  const context:MethodPricingContext={currency:'CAD',acceptedMethods:['lightning','card']};
  assert.throws(()=>parseMethodPricingRules([],context),{message:/at least one rule/});
  assert.throws(()=>parseMethodPricingRules(null,context));
  assert.throws(()=>parseMethodPricingRules('lightning',context));
  assert.throws(()=>parseMethodPricingRules([{}],context));
  assert.throws(()=>parseMethodPricingRules([{method:'lightning'}],context),{message:/discount or premium rate/});
  assert.throws(()=>parseMethodPricingRules([{method:'lightning',discountBps:0,premiumBps:0}],context),{message:/nonzero/});
  assert.throws(()=>parseMethodPricingRules([{method:'lightning',discountBps:1000},{method:'lightning',premiumBps:200}],context),{message:/only once/});
  assert.throws(()=>parseMethodPricingRules([{method:'square',discountBps:100}],context),{message:/canonical/});
  assert.throws(()=>parseMethodPricingRules([{method:'bank_transfer',discountBps:100}],context),{message:/canonical/});
  assert.throws(()=>parseMethodPricingRules([{method:'fictional',discountBps:100}],context),{message:/canonical/});
  assert.throws(()=>parseMethodPricingRules([{method:'bank',discountBps:100}],context),{message:/accepted/});
  assert.throws(()=>parseMethodPricingRules([{method:'card',premiumBps:200}],{currency:'SAT'}),{message:/SAT/});
  assert.throws(()=>parseMethodPricingRules([{method:'lightning',discountBps:1.5}],context));
  assert.throws(()=>parseMethodPricingRules([{method:'lightning',discountBps:-1}],context));
  assert.throws(()=>parseMethodPricingRules([{method:'lightning',discountBps:10001}],context));
  assert.throws(()=>parseMethodPricingRules([{method:'lightning',discountBps:1000,unknown:'field'}],context),{message:/only method/});
  assert.throws(()=>parseMethodPricingRules(Array.from({length:28},()=>({method:'lightning',discountBps:100})),context));
  assert.deepEqual(parseMethodPricingRules([{method:'lightning',discountBps:1000},{method:'card',premiumBps:200}],context),[{method:'lightning',discountBps:1000},{method:'card',premiumBps:200}]);
  // Calculation-level guards: zero effective total, overflow and broken snapshots.
  const simple:MethodPricingInput={currency:'CAD',items:[{description:'Fictional full discount',quantity:1,unitAmount:100}],taxBps:0,subtotal:100,tax:0,total:100};
  assert.throws(()=>calculateMethodPrice(simple,{method:'lightning',discountBps:10000}),{message:/supported range/});
  const huge:MethodPricingInput={currency:'CAD',items:[{description:'Fictional overflow',quantity:2,unitAmount:600000000}],taxBps:0,subtotal:1200000000,tax:0,total:1200000000};
  assert.throws(()=>calculateMethodPrice(huge,{method:'card',premiumBps:200}),{message:/supported range/});
  assert.throws(()=>calculateMethodPrice({...issued,subtotal:280001},{method:'lightning',discountBps:1000}),{message:/does not match its items/});
  assert.throws(()=>calculateMethodPrice({...issued,tax:13501},{method:'lightning',discountBps:1000}),{message:/inconsistent/});
});

test('SAT prices are exact whole satoshis with no CAD reference',()=>{
  const sat:MethodPricingInput={currency:'SAT',items:[{description:'Fictional satoshi work',quantity:1,unitAmount:100000}],taxBps:0,subtotal:100000,tax:0,total:100000,amountSats:100000};
  const discount=calculateMethodPrice(sat,{method:'lightning',discountBps:1000});
  assert.equal(discount.effectiveTotal,90000);assert.equal(discount.referenceAmountSats,90000);
  assert.equal('referenceTotalCad' in discount,false);
  const premium=calculateMethodPrice(sat,{method:'ark',premiumBps:200});
  assert.equal(premium.effectiveTotal,102000);assert.equal(premium.referenceAmountSats,102000);
  assert.equal('referenceTotalCad' in premium,false);
});

test('fiat references prorate the legacy fixed values exactly',()=>{
  // issued total 999, CAD reference 777... use clean odd values: total 999,
  // totalCad 999, amountSats 9990, eligible 999, 50% method discount -> 499.
  const input:MethodPricingInput={currency:'CAD',items:[{description:'Fictional odd fiat',quantity:1,unitAmount:999}],taxBps:0,subtotal:999,tax:0,total:999,totalCad:999,amountSats:9990};
  const amounts=calculateMethodPrice(input,{method:'lightning',discountBps:5000});
  assert.deepEqual([amounts.effectiveTotal,amounts.referenceTotalCad,amounts.referenceAmountSats],[499,499,4990]);
  assert.equal(roundHalfUp(999n*499n,999n),499n);
});

test('offer hash input is canonical and binding-sensitive',()=>{
  const amounts=calculateMethodPrice(issued,{method:'lightning',discountBps:1000});
  const reordered={...amounts,premiumBps:amounts.premiumBps,discountBps:amounts.discountBps};
  assert.equal(canonicalMethodPriceOfferInput('invoice-a','lightning',amounts),canonicalMethodPriceOfferInput('invoice-a','lightning',reordered));
  assert.notEqual(canonicalMethodPriceOfferInput('invoice-a','lightning',amounts),canonicalMethodPriceOfferInput('invoice-b','lightning',amounts));
  assert.notEqual(canonicalMethodPriceOfferInput('invoice-a','card',amounts),canonicalMethodPriceOfferInput('invoice-a','lightning',amounts));
  assert.notEqual(canonicalMethodPriceOfferInput('invoice-a','lightning',{...amounts,effectiveTotal:amounts.effectiveTotal+1}),canonicalMethodPriceOfferInput('invoice-a','lightning',amounts));
});
