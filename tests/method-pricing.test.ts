import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateMethodPrice,canonicalMethodPriceOfferInput,eligibleInvoiceSubtotal,parseMethodPricingRules,resolveMethodRule,roundHalfUp} from '../shared/method-pricing.js';
import type {MethodPricingContext,MethodPricingInput,MethodPricingRule} from '../shared/method-pricing-types.js';
import type {MethodId} from '../shared/payment-methods.js';

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

// Fictional monthly-pilot basis case: services 200000 are eligible, flights
// 80000 are excluded, no tax and no global adjustments. Issued total 280000.
// Bitcoin/Lightning 15% on eligible labour gives 250000; an all-fiat 5%
// whole-invoice premium gives 294000.
const pilot:MethodPricingInput={
  currency:'CAD',
  items:[{description:'Fictional monthly services',quantity:1,unitAmount:200000},{description:'Fictional excluded flights',quantity:1,unitAmount:80000,kind:'expense'}],
  taxBps:0,discountBps:0,premiumBps:0,
  subtotal:280000,discountAmount:0,premiumAmount:0,tax:0,total:280000,totalCad:280000,amountSats:2800000,
};

test('eligible-basis Bitcoin discount and whole-subtotal fiat premium each use their own base',()=>{
  const lightning=calculateMethodPrice(pilot,{method:'lightning',discountBps:1500});
  assert.equal('basis' in lightning,false);
  assert.deepEqual([lightning.discountAmount,lightning.premiumAmount,lightning.adjustedSubtotal,lightning.effectiveTotal,lightning.totalAdjustment],[30000,0,250000,250000,-30000]);
  const fiat=calculateMethodPrice(pilot,{method:'fiat',basis:'subtotal',premiumBps:500});
  assert.equal(fiat.basis,'subtotal');
  assert.deepEqual([fiat.discountAmount,fiat.premiumAmount,fiat.adjustedSubtotal,fiat.effectiveTotal,fiat.totalAdjustment],[0,14000,294000,294000,14000]);
  // The excluded flights contribute to the whole-invoice base but never to the eligible base.
  assert.deepEqual([lightning.eligibleSubtotal,fiat.eligibleSubtotal,fiat.issuedSubtotal],[200000,200000,280000]);
  // An explicit eligible basis reproduces legacy arithmetic while carrying its basis metadata.
  const explicit=calculateMethodPrice(pilot,{method:'lightning',basis:'eligible',discountBps:1500});
  assert.deepEqual([explicit.discountAmount,explicit.effectiveTotal],[30000,250000]);
  assert.equal(explicit.basis,'eligible');
});

test('whole-subtotal basis keeps one final tax computation with exact rounding',()=>{
  // Same fictional pilot with 5% tax: issued tax 14000 on 280000, issued total 294000.
  const taxed:MethodPricingInput={...pilot,taxBps:500,tax:14000,total:294000,totalCad:294000,amountSats:2940000};
  const fiat=calculateMethodPrice(taxed,{method:'fiat',basis:'subtotal',premiumBps:500});
  assert.deepEqual([fiat.premiumAmount,fiat.adjustedSubtotal,fiat.effectiveTax,fiat.effectiveTotal],[14000,294000,14700,308700]);
  // Fractional-rate rounding on an odd whole-subtotal base: 5% of 999 is 49.95 -> 50 half-up;
  // tax is then computed once on the final adjusted subtotal (1049*5% = 52.45 -> 52), not as
  // separately rounded components (50 + round(50*5%) = 53).
  const odd:MethodPricingInput={currency:'CAD',items:[{description:'Fictional odd service',quantity:1,unitAmount:999}],taxBps:500,subtotal:999,tax:50,total:1049};
  const amounts=calculateMethodPrice(odd,{method:'bank',basis:'subtotal',premiumBps:500});
  assert.deepEqual([amounts.premiumAmount,amounts.adjustedSubtotal,amounts.effectiveTax,amounts.effectiveTotal],[50,1049,52,1101]);
});

test('the all-fiat group rule covers settlement-fiat methods and concrete rules override it',()=>{
  const rules:MethodPricingRule[]=[{method:'fiat',basis:'subtotal',premiumBps:500},{method:'card',premiumBps:200}];
  // A concrete rule replaces the group for that exact method.
  assert.deepEqual(resolveMethodRule(rules,'card'),{method:'card',premiumBps:200});
  // Catalog settlement===fiat inherits the group, including manual bank/cash/check.
  for(const method of ['bank','cash','check','ach','sepa','wire','interac','paypal','ideal','pay_by_bank','stripe_dynamic','venmo','apple_pay'] as MethodId[])
    assert.deepEqual(resolveMethodRule(rules,method),{method,basis:'subtotal',premiumBps:500});
  // Bitcoin-native, stablecoin and noncash methods never inherit the fallback.
  for(const method of ['bitcoin','lightning','liquid','cashu','ark','usdt','usdc','gift_card','coupon','no_charge'] as MethodId[])
    assert.deepEqual(resolveMethodRule(rules,method),{method});
  assert.deepEqual(resolveMethodRule([],'lightning'),{method:'lightning'});
});

test('group rules accept one fiat target with an optional basis; invalid targets and bases fail',()=>{
  const context:MethodPricingContext={currency:'CAD',acceptedMethods:['lightning','card','bank']};
  assert.deepEqual(parseMethodPricingRules([{method:'fiat',basis:'subtotal',premiumBps:500},{method:'lightning',discountBps:1500}],context),[{method:'fiat',basis:'subtotal',premiumBps:500},{method:'lightning',discountBps:1500}]);
  assert.throws(()=>parseMethodPricingRules([{method:'fiat',premiumBps:100},{method:'fiat',discountBps:100}],context),{message:/only once/});
  assert.throws(()=>parseMethodPricingRules([{method:'lightning',basis:'whole',discountBps:100}],context),{message:/basis/});
  assert.throws(()=>parseMethodPricingRules([{method:'lightning',basis:'subtotal',discountBps:100,unknown:'field'}],context),{message:/only method/});
  // SAT rejects fiat-group rules outright.
  assert.throws(()=>parseMethodPricingRules([{method:'fiat',premiumBps:100}],{currency:'SAT'}),{message:/SAT/});
  // The group target needs no accepted-method match of its own.
  assert.deepEqual(parseMethodPricingRules([{method:'fiat',premiumBps:100}],{currency:'CAD',acceptedMethods:['lightning']}),[{method:'fiat',premiumBps:100}]);
  // An explicit eligible basis is accepted and preserved.
  assert.deepEqual(parseMethodPricingRules([{method:'lightning',basis:'eligible',discountBps:1500}],context),[{method:'lightning',basis:'eligible',discountBps:1500}]);
});

test('offer hash keeps the exact legacy v1 form without a basis and binds a new basis with a versioned form',()=>{
  const legacy=calculateMethodPrice(issued,{method:'lightning',discountBps:1000});
  const input=canonicalMethodPriceOfferInput('invoice-a','lightning',legacy);
  // Byte-exact legacy v1 serialization: unchanged field order, no basis member.
  assert.deepEqual(JSON.parse(input),['method-price-offer-v1','invoice-a','lightning','CAD',200000,280000,10000,0,13500,283500,1000,0,20000,0,250000,12500,-1000,262500,-21000,262500,2625000]);
  const subtotal=calculateMethodPrice(issued,{method:'lightning',discountBps:1000,basis:'subtotal'});
  const v2=canonicalMethodPriceOfferInput('invoice-a','lightning',subtotal);
  assert.equal(JSON.parse(v2)[0],'method-price-offer-v2');
  assert.notEqual(v2,canonicalMethodPriceOfferInput('invoice-a','lightning',{...subtotal,basis:'eligible'}));
  assert.notEqual(v2,input);
});

test('SAT rules can use the whole-subtotal basis in exact whole satoshis',()=>{
  const sat:MethodPricingInput={currency:'SAT',items:[{description:'Fictional satoshi work',quantity:1,unitAmount:100000},{description:'Fictional excluded expense',quantity:1,unitAmount:30000,kind:'expense'}],taxBps:0,subtotal:130000,tax:0,total:130000,amountSats:130000};
  const premium=calculateMethodPrice(sat,{method:'lightning',basis:'subtotal',premiumBps:500});
  assert.deepEqual([premium.premiumAmount,premium.effectiveTotal,premium.referenceAmountSats],[6500,136500,136500]);
  assert.equal('referenceTotalCad' in premium,false);
});
