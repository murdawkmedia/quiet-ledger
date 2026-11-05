import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {createInvoice,publicInvoice} from '../server/domain.js';
const input={customerName:'Fictional client',title:'Workshop',currency:'CAD',items:[{description:'Work',quantity:1,unitAmount:10000}],dueDate:'2026-11-30'};
test('due date persists on invoice and public checkout without changing totals',()=>{const store=new Store(':memory:');try{const invoice=createInvoice(store,'fixture',input,new Date('2026-11-05T00:00:00Z'));assert.equal(invoice.dueDate,'2026-11-30');assert.equal(publicInvoice(invoice).dueDate,'2026-11-30');assert.equal(store.getInvoice(invoice.id,'fixture')?.dueDate,'2026-11-30');assert.equal(invoice.total,10000);}finally{store.close();}});
test('invalid calendar dates cannot be issued',()=>{const store=new Store(':memory:');try{assert.throws(()=>createInvoice(store,'fixture',{...input,dueDate:'2026-02-30'},new Date()));}finally{store.close();}});
