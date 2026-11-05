import test from 'node:test';import assert from 'node:assert/strict';import {assertCase,renderDemoReply} from '../server/demo-agent-admission.js';import {validateDemoInference} from '../server/demo-agent-replies.js';import type{DemoCase}from'../shared/demo-agents.js';
const context={fictional:true,currency:'KRW',lineAmount:150000,tax:0,total:144000,discountAmount:15000,premiumAmount:9000,status:'open',settlementMode:'simulation',receiptRecorded:false,version:4,asOf:'2026-11-05T00:00:00.000Z',invoiceNumber:'QL-0002',title:'Fictional Marmot workshop recording'} as DemoCase;
test('agents render the current KRW invoice adjustments without cents',()=>{assert.doesNotThrow(()=>assertCase(context));const reply=renderDemoReply('accountant','check-total',context);assert.match(reply,/144,000/);assert(!reply.includes('125.00'));assert.match(reply,/QL-0002/);assert.throws(()=>assertCase({...context,total:150000}));});


test('the company question uses the composed reply without protocol or sender boilerplate',()=>{
 const reply='We run hands-on workshops about private messaging. Useful filmed demos and captioned walkthroughs would help people try it themselves. Would you rather start with filming or the website?';
 assert.equal(renderDemoReply('client',{runtime:'hermes',model:'fixture',intent:'conversation',reply},context),reply);
});
test('the latest authoritative case wins over stale model financial claims',()=>{
 const stale={runtime:'hermes' as const,model:'fixture',intent:'explain-recorded-status' as const,reply:'Your payment of CAD 125.00 arrived.'};
 const open=renderDemoReply('accountant',stale,context);
 assert.match(open,/No .*payment.*recorded|No .*receipt.*recorded/i);assert(!open.includes('125.00'));
 const paid=renderDemoReply('accountant',stale,{...context,status:'paid',receiptRecorded:true,version:5});
 assert.match(paid,/144,000/);assert.match(paid,/simulated/i);assert(!paid.includes('125.00'));
 assert(!/snapshot|2026-11|AI demo|Jordan,/.test(paid));
});
test('unsafe financial prose cannot enter a conversational bubble',()=>{
 for(const reply of ['Your payment arrived.','You owe CAD 999.00.','The transfer cleared.','Your invoice is settled.','I have marked it paid.'])
  assert.throws(()=>renderDemoReply('client',{runtime:'hermes',model:'fixture',intent:'conversation',reply},context));
});

test('reply validation bounds generated prose and accepts only known worker fields',()=>{
 const base={runtime:'hermes',model:'fixture',intent:'conversation',reply:'Captioned walkthroughs would help our workshops.'};
 assert.deepEqual(validateDemoInference(base),base);
 for(const change of [{reply:'x'.repeat(1001)},{reply:'Hello\u0000there'},{reply:'Hello\u202ethere'},{reply:'First? Second?'},{reply:'  leading'},{reply:' '},{model:'bad model'},{tools:[]}])assert.throws(()=>validateDemoInference({...base,...change}));
 assert.deepEqual(validateDemoInference({runtime:'hermes',model:'fixture',intent:'check-total'}),{runtime:'hermes',model:'fixture',intent:'check-total'});
});

test('ordinary scope proposals and colleague references remain conversational',()=>{
 for(const reply of ['Riley runs the workshops; I help keep the scope clear.','I would start with one clear walkthrough, then try two captioned clips.'])assert.equal(renderDemoReply('accountant',{runtime:'hermes',model:'fixture',intent:'conversation',reply},context),reply);
});

test('creative-work verbs stay natural while financial record assertions are blocked',()=>{
 const safe=["I'm Riley, the workshop producer here at Marmot Field Lab.",'A screen-recorded walkthrough would help people follow the steps.','We can try a changed approach after the first edit.','The approved scope gives us something concrete to work from.','I received your idea; a captioned walkthrough sounds useful.','An authorized participant can join the workshop chat.','We can update the caption style after review.'];
 for(const reply of safe)assert.equal(renderDemoReply('client',{runtime:'hermes',model:'fixture',intent:'conversation',reply},context),reply);
 for(const reply of ['I recorded the invoice.','The invoice was approved.','I changed the ledger.','The ledger has been updated.','I received the bill.','I marked the invoice complete.','Your account is updated.','Approved invoices are ready.','The invoice status is open.','The bill is closed.','I saved the records.',"I've changed it."])assert.throws(()=>renderDemoReply('client',{runtime:'hermes',model:'fixture',intent:'conversation',reply},context));
});
