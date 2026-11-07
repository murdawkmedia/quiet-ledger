import test from 'node:test';
import assert from 'node:assert/strict';
import type {InvoiceLedgerView} from '../shared/invoice-ledger.js';
import type {Invoice} from '../shared/contracts.js';
import type {InvoiceMethodAgreement} from '../shared/method-pricing-types.js';
import {invoiceBalanceCsv} from '../server/invoice-csv.js';
import {previewInvoiceCsv} from '../shared/csv-preview.js';
function fixture(extra:Record<string,unknown>={}):InvoiceLedgerView{
 const invoice:Invoice={id:'fictional-invoice',token:'fictional-checkout',number:'QL-FIXTURE',customerName:'Fictional client',title:'Capture, edit and delivery',currency:'CAD',items:[{description:'Fictional service',quantity:1,unitAmount:12345}],taxBps:0,subtotal:12345,tax:0,total:12345,totalCad:12345,amountSats:123450,status:'open',createdAt:'2026-11-06T00:00:00Z',issueDate:'2026-11-06',dueDate:'2026-12-06',...extra};
 return {invoice,balance:{total:12345,effectiveTotal:12345,paid:3000,credited:1000,due:8345,overpaid:0,currency:'CAD',state:'partially_paid',mode:'live'},entries:[]};
}
/** Worked example: issued 283500 (tax 13500), lightning −10% on the 200000 eligible base → effective 262500. */
function lightningAgreement(values:Partial<InvoiceMethodAgreement>={}):InvoiceMethodAgreement{
 return {id:'1b6f9c2a-5f4e-4f3a-9d2b-7c8e6a5b4d3c',invoiceId:'fictional-invoice',method:'lightning',offerHash:'0'.repeat(64),confirmedAt:'2026-11-06T00:00:00Z',confirmation:'public_checkout_token',
  currency:'CAD',eligibleSubtotal:200000,issuedSubtotal:280000,issuedDiscountAmount:0,issuedPremiumAmount:0,issuedTax:13500,issuedTotal:283500,discountBps:1000,premiumBps:0,
  discountAmount:20000,premiumAmount:0,adjustedSubtotal:250000,effectiveTax:12500,taxAdjustment:-1000,effectiveTotal:262500,totalAdjustment:-21000,referenceTotalCad:262500,referenceAmountSats:2625000,...values};
}
test('invoice CSV preserves denomination and exact installment balances without valuation guesses',()=>{
 const result=invoiceBalanceCsv([fixture()]);assert.match(result,/"Invoice","Customer","Title","Currency","Total","Effective total","Pricing method","Original tax","Effective tax","Method discount","Method premium","Method tax adjustment","Paid","Credited","Due","Overpaid","State","Mode","Issue date","Due date","Agreement"\r\n/);
 assert.match(result,/"QL-FIXTURE","Fictional client","Capture, edit and delivery","CAD","123.45","123.45","","0.00","0.00","0.00","0.00","0.00","30.00","10.00","83.45","0.00","partially_paid","live","2026-11-06","2026-12-06",""\r\n$/);
 assert(!result.includes('token'));assert(!result.includes('totalCad'));assert(!result.includes('1b6f9c2a'));
});
test('agreement rows export the effective total, method and signed tax adjustment with the agreement id',()=>{
 const view=fixture({priceAgreement:lightningAgreement(),tax:13500,subtotal:280000,total:283500});
 view.balance={...view.balance,total:283500,effectiveTotal:262500,due:0,overpaid:0,paid:262500,credited:0,state:'paid'};
 const result=invoiceBalanceCsv([view]);
 assert.match(result,/"QL-FIXTURE","Fictional client","Capture, edit and delivery","CAD","2835.00","2625.00","lightning","135.00","125.00","200.00","0.00","-10.00","2625.00","0.00","0.00","0.00","paid","live","2026-11-06","2026-12-06","1b6f9c2a-5f4e-4f3a-9d2b-7c8e6a5b4d3c"\r\n$/);
 assert(!result.includes('referenceTotalCad'));assert(!result.includes('fictional-invoice'));
});
test('CSV escapes quotes and prevents spreadsheet formula injection including whitespace-prefixed cells',()=>{
 const result=invoiceBalanceCsv([fixture({customerName:' =HYPERLINK("https://fixture.invalid")',title:'@Fictional\nservice'})]);
 assert(result.includes('"\' =HYPERLINK(""https://fixture.invalid"")"'));assert(result.includes('"\'@Fictional\nservice"'));
 for(const value of ['+formula','-formula','\tformula','\rformula','\nformula'])assert(invoiceBalanceCsv([fixture({title:value})]).includes('"\''+value+'"'));
});
test('CSV uses whole won and rejects malformed or inconsistent monetary rows',()=>{
 const won=fixture({currency:'KRW'});won.balance={...won.balance,currency:'KRW'};
 assert(invoiceBalanceCsv([won]).includes('"KRW","12345","12345","","0","0","0","0","0","3000","1000","8345","0"'));
 for(const paid of [-1,0.1,NaN,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>invoiceBalanceCsv([{...fixture(),balance:{...fixture().balance,paid}}]));
 assert.throws(()=>invoiceBalanceCsv([{...fixture(),balance:{...fixture().balance,currency:'USD'}}]));
 assert.throws(()=>invoiceBalanceCsv([{...fixture(),balance:{...fixture().balance,due:1}}]));
});
test('exported agreement CSV round-trips through the preview parser',()=>{
 const view=fixture({priceAgreement:lightningAgreement(),tax:13500,subtotal:280000,total:283500});
 view.balance={...view.balance,total:283500,effectiveTotal:262500,due:0,overpaid:0,paid:262500,credited:0,state:'paid'};
 const preview=previewInvoiceCsv(invoiceBalanceCsv([view]));
 assert.deepEqual(preview.counts,{existing:0,duplicate:0,new:1,invalid:0});
 assert.equal(preview.rows[0].record?.pricingMethod,'lightning');
 assert.equal(preview.rows[0].record?.balance.effectiveTotal,262500);
 assert.equal(preview.rows[0].record?.methodTaxAdjustment,-1000);
 assert.equal(preview.rows[0].record?.agreementId,'1b6f9c2a-5f4e-4f3a-9d2b-7c8e6a5b4d3c');
});
test('agreement rows reject non-canonical methods, tax mismatches and inconsistent effective balances',()=>{
 const priced=fixture({tax:13500,priceAgreement:lightningAgreement()});
 priced.balance={...priced.balance,total:283500,effectiveTotal:262500,paid:262500,due:0,state:'paid'};
 for(const values of [lightningAgreement({method:'square' as never}),lightningAgreement({taxAdjustment:-2000}),lightningAgreement({effectiveTax:12400})]){
  const bad=fixture({tax:13500,priceAgreement:values});
  bad.balance={...priced.balance};
  assert.throws(()=>invoiceBalanceCsv([bad]),/agreement/i);
 }
 const mismatch=fixture({tax:13500,priceAgreement:lightningAgreement()});
 mismatch.balance={...mismatch.balance,total:283500,effectiveTotal:262500,due:262500};
 assert.throws(()=>invoiceBalanceCsv([mismatch]),/balance|Inconsistent/i);
 for(const adjustment of [0.5,-0.5,NaN])assert.throws(()=>invoiceBalanceCsv([fixture({tax:13500,priceAgreement:lightningAgreement({taxAdjustment:adjustment})})]),/agreement|adjustment/i);
});
