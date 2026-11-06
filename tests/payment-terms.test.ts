import test from 'node:test';import assert from 'node:assert/strict';
import {paymentDueDate} from '../shared/payment-terms.js';
import {Store} from '../server/store.js';import {createInvoice,publicInvoice} from '../server/domain.js';
import {InvoiceTemplates} from '../server/invoice-templates.js';import {InvoiceDelivery} from '../server/invoice-delivery.js';
const draft={customerName:'Fictional terms client',title:'Fictional service',currency:'CAD',items:[{description:'Fictional delivery',quantity:1,unitAmount:10000}]};
test('fixed days use calendar arithmetic through leap days, month/year ends and DST periods',()=>{
 for(const [date,days,due] of [['2024-01-31',30,'2024-03-01'],['2023-01-31',30,'2023-03-02'],['2026-12-31',60,'2027-03-01'],['2026-03-07',30,'2026-04-06'],['2026-11-01',0,'2026-11-01'],['2026-11-06',90,'2027-02-04']] as const)assert.equal(paymentDueDate(date,days),due);
 for(const [date,days] of [['2026-02-30',30],['2026-11-06',-1],['2026-11-06',1.5],['2026-11-06',3651],['9999-12-31',1]] as const)assert.throws(()=>paymentDueDate(date,days));
});
test('issued due date is authoritative and custom public terms remain separate from legacy note',()=>{
 const store=new Store(':memory:');try{
  const invoice=createInvoice(store,'owner',{...draft,issueDate:'2026-11-06',paymentTermDays:30,paymentTerms:'  Net 30. Delivery in two stages.\nPlease reference the invoice number.  ',note:'Fictional legacy planning note'},new Date('2026-11-06T23:45:00Z'));
  assert.equal(invoice.dueDate,'2026-12-06');assert.equal(invoice.paymentTermDays,30);assert.equal(publicInvoice(invoice).paymentTerms,'Net 30. Delivery in two stages.\nPlease reference the invoice number.');
  assert.throws(()=>createInvoice(store,'owner',{...draft,issueDate:'2026-11-06',dueDate:'2026-12-07',paymentTermDays:30},new Date()),/due date|terms/i);
  const fallback=createInvoice(store,'owner',{...draft,paymentTermDays:0},new Date('2026-11-06T23:45:00Z'));assert.equal(fallback.issueDate,'2026-11-06');assert.equal(fallback.dueDate,'2026-11-06');
  assert.throws(()=>createInvoice(store,'owner',{...draft,paymentTermDays:30,dueDate:'2026-12-07'},new Date('2026-11-06T23:45:00Z')),/due date|terms/i);
 }finally{store.close();}
});
test('templates retain relative terms and email previews include public terms without private note or sending',()=>{
 const store=new Store(':memory:');try{
  const templates=new InvoiceTemplates(store),template=templates.save('owner',{label:'Fictional monthly service',draft:{...draft,paymentTermDays:60,paymentTerms:'Payment in 60 calendar days.'}});assert.equal(templates.list('owner')[0].draft.paymentTermDays,60);
  const invoice=createInvoice(store,'owner',{...template.draft,issueDate:'2026-11-06',note:'Fictional private owner marker'},new Date('2026-11-06T00:00:00Z'));
  const mail=new InvoiceDelivery(store,{publicOrigin:'https://example.test'}),preview=mail.compose('owner',invoice.id,{action:'preview',to:['fictional@example.test']},'fictional-terms-email',{demo:false}).body;
  assert.match(preview.text,/Payment in 60 calendar days\./);assert.match(preview.text,/Due: 2027-01-05/);assert(!preview.text.includes('Fictional private owner marker'));assert.equal(preview.state,'preview');
 }finally{store.close();}
});
