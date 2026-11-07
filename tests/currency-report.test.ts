import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeInvoiceBalances} from '../shared/currency-report.js';
import type {Currency} from '../shared/contracts.js';
import type {InvoiceBalance} from '../shared/invoice-ledger.js';
import type {InvoiceMethodAgreement} from '../shared/method-pricing-types.js';
function invoice(currency:Currency,total:number,values:Partial<InvoiceBalance>={}){
 const balance:InvoiceBalance={total,effectiveTotal:total,paid:0,credited:0,due:total,overpaid:0,currency,state:'unpaid',mode:'live',...values};
 return {currency,total,balance,totalCad:987654321,amountSats:888888888};
}
test('native currency totals use ledger allocations, not fixed conversion references',()=>{
 const input=[invoice('USD',10000,{paid:2500,credited:1000,due:6500,state:'partially_paid'}),invoice('CAD',10000,{paid:12000,due:0,overpaid:2000,state:'paid'}),invoice('KRW',150001),invoice('USD',10000,{credited:2000,due:0,state:'void'})];
 const before=JSON.stringify(input);assert.deepEqual(summarizeInvoiceBalances(input),[
 {currency:'CAD',mode:'live',invoiceCount:1,issued:10000,effective:10000,paid:12000,credited:0,voided:0,due:0,overpaid:2000,methodDiscount:0,methodPremium:0,methodTaxAdjustment:0},
 {currency:'USD',mode:'live',invoiceCount:2,issued:20000,effective:20000,paid:2500,credited:3000,voided:8000,due:6500,overpaid:0,methodDiscount:0,methodPremium:0,methodTaxAdjustment:0},
 {currency:'KRW',mode:'live',invoiceCount:1,issued:150001,effective:150001,paid:0,credited:0,voided:0,due:150001,overpaid:0,methodDiscount:0,methodPremium:0,methodTaxAdjustment:0},
 ]);assert.equal(JSON.stringify(input),before);
});
test('live and simulation records never share a summary row, regardless of input ordering',()=>{
 const live=invoice('CAD',500),simulation=invoice('CAD',500,{mode:'simulation',paid:500,due:0,state:'paid'});
 const result=summarizeInvoiceBalances([simulation,live]);assert.deepEqual(result.map(row=>[row.mode,row.issued,row.effective,row.paid,row.due]),[['live',500,500,0,500],['simulation',500,500,500,0]]);assert.deepEqual(result,summarizeInvoiceBalances([live,simulation]));assert.deepEqual(summarizeInvoiceBalances([]),[]);
});
test('missing, mismatched and unsafe amounts fail closed instead of using guessed totals',()=>{
 assert.throws(()=>summarizeInvoiceBalances([{currency:'USD',total:100}]),/balance/i);
 assert.throws(()=>summarizeInvoiceBalances([invoice('USD',100,{currency:'CAD'})]),/balance/i);
 assert.throws(()=>summarizeInvoiceBalances([invoice('USD',100,{total:101})]),/balance/i);
 assert.throws(()=>summarizeInvoiceBalances([invoice('CAD',100,{paid:0.5})]),/amount|balance/i);
 assert.throws(()=>summarizeInvoiceBalances([invoice('CAD',Number.MAX_SAFE_INTEGER),invoice('CAD',1)]),/precision|amount/i);
});
/** Worked example agreement: issued 283500, lightning −10% on the 200000 eligible base → effective 262500. */
function agreement(effectiveTotal:number,values:Partial<InvoiceMethodAgreement>={}):InvoiceMethodAgreement{
 return {id:'fictional-agreement',invoiceId:'fictional-invoice',method:'lightning',offerHash:'0'.repeat(64),confirmedAt:'2026-11-06T00:00:00Z',confirmation:'public_checkout_token',
  currency:'CAD',eligibleSubtotal:200000,issuedSubtotal:280000,issuedDiscountAmount:0,issuedPremiumAmount:0,issuedTax:13500,issuedTotal:283500,discountBps:1000,premiumBps:0,
  discountAmount:20000,premiumAmount:0,adjustedSubtotal:250000,effectiveTax:12500,taxAdjustment:-1000,effectiveTotal,totalAdjustment:effectiveTotal-283500,referenceTotalCad:262500,referenceAmountSats:2625000,...values};
}
test('agreements summarize against effective totals with signed method adjustments',()=>{
 const priced={...invoice('CAD',283500,{effectiveTotal:262500,due:262500}),priceAgreement:agreement(262500)};
 const premium={...invoice('CAD',283500,{effectiveTotal:287700,paid:287700,due:0,state:'paid'}),priceAgreement:agreement(287700,{method:'card',discountBps:0,premiumBps:200,discountAmount:0,premiumAmount:4000,adjustedSubtotal:274000,effectiveTax:13700,taxAdjustment:200,totalAdjustment:4200,referenceTotalCad:287700})};
 const result=summarizeInvoiceBalances([priced,premium]);
 assert.deepEqual(result,[{currency:'CAD',mode:'live',invoiceCount:2,issued:567000,effective:550200,paid:287700,credited:0,voided:0,due:262500,overpaid:0,methodDiscount:20000,methodPremium:4000,methodTaxAdjustment:-800}]);
});
test('agreement balances must match the authoritative effective totals before summarizing',()=>{
 assert.throws(()=>summarizeInvoiceBalances([{...invoice('CAD',283500,{effectiveTotal:262500,due:262500}),priceAgreement:agreement(287700)}]),/balance/i);
 assert.throws(()=>summarizeInvoiceBalances([{...invoice('CAD',283500),priceAgreement:agreement(262500)}]),/balance/i);
});
