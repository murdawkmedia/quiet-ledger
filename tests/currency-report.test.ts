import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeInvoiceBalances} from '../shared/currency-report.js';
import type {Currency} from '../shared/contracts.js';
import type {InvoiceBalance} from '../shared/invoice-ledger.js';
function invoice(currency:Currency,total:number,values:Partial<InvoiceBalance>={}){
 const balance:InvoiceBalance={total,paid:0,credited:0,due:total,overpaid:0,currency,state:'unpaid',mode:'live',...values};
 return {currency,total,balance,totalCad:987654321,amountSats:888888888};
}
test('native currency totals use ledger allocations, not fixed conversion references',()=>{
 const input=[invoice('USD',10000,{paid:2500,credited:1000,due:6500,state:'partially_paid'}),invoice('CAD',10000,{paid:12000,due:0,overpaid:2000,state:'paid'}),invoice('KRW',150001),invoice('USD',10000,{credited:2000,due:0,state:'void'})];
 const before=JSON.stringify(input);assert.deepEqual(summarizeInvoiceBalances(input),[
 {currency:'CAD',mode:'live',invoiceCount:1,issued:10000,paid:12000,credited:0,voided:0,due:0,overpaid:2000},
 {currency:'USD',mode:'live',invoiceCount:2,issued:20000,paid:2500,credited:3000,voided:8000,due:6500,overpaid:0},
 {currency:'KRW',mode:'live',invoiceCount:1,issued:150001,paid:0,credited:0,voided:0,due:150001,overpaid:0},
 ]);assert.equal(JSON.stringify(input),before);
});
test('live and simulation records never share a summary row, regardless of input ordering',()=>{
 const live=invoice('CAD',500),simulation=invoice('CAD',500,{mode:'simulation',paid:500,due:0,state:'paid'});
 const result=summarizeInvoiceBalances([simulation,live]);assert.deepEqual(result.map(row=>[row.mode,row.issued,row.paid,row.due]),[['live',500,0,500],['simulation',500,500,0]]);assert.deepEqual(result,summarizeInvoiceBalances([live,simulation]));assert.deepEqual(summarizeInvoiceBalances([]),[]);
});
test('missing, mismatched and unsafe amounts fail closed instead of using guessed totals',()=>{
 assert.throws(()=>summarizeInvoiceBalances([{currency:'USD',total:100}]),/balance/i);
 assert.throws(()=>summarizeInvoiceBalances([invoice('USD',100,{currency:'CAD'})]),/balance/i);
 assert.throws(()=>summarizeInvoiceBalances([invoice('USD',100,{total:101})]),/balance/i);
 assert.throws(()=>summarizeInvoiceBalances([invoice('CAD',100,{paid:0.5})]),/amount|balance/i);
 assert.throws(()=>summarizeInvoiceBalances([invoice('CAD',Number.MAX_SAFE_INTEGER),invoice('CAD',1)]),/precision|amount/i);
});
