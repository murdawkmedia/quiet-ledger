import test from 'node:test';
import assert from 'node:assert/strict';
import type {InvoiceLedgerView} from '../shared/invoice-ledger.js';
import type {Invoice} from '../shared/contracts.js';
import {invoiceBalanceCsv} from '../server/invoice-csv.js';
function fixture(extra:Record<string,unknown>={}):InvoiceLedgerView{
 const invoice:Invoice={id:'fictional-invoice',token:'fictional-checkout',number:'QL-FIXTURE',customerName:'Fictional client',title:'Capture, edit and delivery',currency:'CAD',items:[{description:'Fictional service',quantity:1,unitAmount:12345}],taxBps:0,subtotal:12345,tax:0,total:12345,totalCad:12345,amountSats:123450,status:'open',createdAt:'2026-11-06T00:00:00Z',issueDate:'2026-11-06',dueDate:'2026-12-06',...extra};
 return {invoice,balance:{total:12345,paid:3000,credited:1000,due:8345,overpaid:0,currency:'CAD',state:'partially_paid',mode:'live'},entries:[]};
}
test('invoice CSV preserves denomination and exact installment balances without valuation guesses',()=>{
 const result=invoiceBalanceCsv([fixture()]);assert.match(result,/"Invoice","Customer","Title","Currency","Total","Paid","Credited","Due","Overpaid","State","Mode","Issue date","Due date"\r\n/);
 assert.match(result,/"QL-FIXTURE","Fictional client","Capture, edit and delivery","CAD","123.45","30.00","10.00","83.45","0.00","partially_paid","live","2026-11-06","2026-12-06"\r\n$/);
 assert(!result.includes('token'));assert(!result.includes('totalCad'));
});
test('CSV escapes quotes and prevents spreadsheet formula injection including whitespace-prefixed cells',()=>{
 const result=invoiceBalanceCsv([fixture({customerName:' =HYPERLINK("https://fixture.invalid")',title:'@Fictional\nservice'})]);
 assert(result.includes('"\' =HYPERLINK(""https://fixture.invalid"")"'));assert(result.includes('"\'@Fictional\nservice"'));
 for(const value of ['+formula','-formula','\tformula','\rformula','\nformula'])assert(invoiceBalanceCsv([fixture({title:value})]).includes('"\''+value+'"'));
});
test('CSV uses whole won and rejects malformed or inconsistent monetary rows',()=>{
 const won=fixture({currency:'KRW'});won.balance={...won.balance,currency:'KRW'};
 assert(invoiceBalanceCsv([won]).includes('"KRW","12345","3000","1000","8345","0"'));
 for(const paid of [-1,0.1,NaN,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>invoiceBalanceCsv([{...fixture(),balance:{...fixture().balance,paid}}]));
 assert.throws(()=>invoiceBalanceCsv([{...fixture(),balance:{...fixture().balance,currency:'USD'}}]));
 assert.throws(()=>invoiceBalanceCsv([{...fixture(),balance:{...fixture().balance,due:1}}]));
});
