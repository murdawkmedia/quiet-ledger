import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {createApp} from '../server/app.js';

const ownerToken='fictional-line-owner',apiToken='fictional-line-api-token-at-least-32';
const draft={customerName:'Fictional line client',title:'Fictional service and travel',currency:'CAD',discountBps:500,items:[
 {description:'Fictional labour',quantity:1,unitAmount:200000,kind:'service',adjustmentEligible:true},
 {description:'Fictional flights',quantity:1,unitAmount:80000,kind:'expense',adjustmentEligible:false},
],paymentTermDays:30,paymentTerms:'Fictional public terms'};
function fixture(){return createApp({dbPath:':memory:',encryptionKey:Buffer.alloc(32,84),ownerToken,now:()=>new Date('2026-11-06T12:00:00Z'),apiKeys:[{token:apiToken,scopes:['invoices:read','invoices:write']}]});}
async function owner(app:ReturnType<typeof createApp>){const agent=request.agent(app),login=await agent.post('/api/session/owner').send({token:ownerToken}).expect(200);return {agent,post:(path:string,body:object,key:string=randomUUID())=>agent.post(path).set('X-CSRF-Token',login.body.csrfToken).set('Idempotency-Key',key).send(body)};}

test('API creates exact line adjustments, retries the snapshot and rejects changed eligibility under the same key',async()=>{
 const app=fixture();try{
  const post=(body:object,key:string)=>request(app).post('/api/v1/invoices').set('Authorization','Bearer '+apiToken).set('Idempotency-Key',key).send(body);
  const first=(await post(draft,'fictional-line-create').expect(201)).body;
  assert.equal(first.total,270000);assert.equal(first.discountAmount,10000);assert.deepEqual(first.items,draft.items);assert.equal(first.dueDate,'2026-12-06');
  assert.deepEqual((await post(draft,'fictional-line-create').expect(201)).body,first);
  await post({...draft,items:draft.items.map(item=>({...item,adjustmentEligible:true}))},'fictional-line-create').expect(409);
  const read=(await request(app).get('/api/v1/invoices/'+first.id).set('Authorization','Bearer '+apiToken).expect(200)).body;
  assert.deepEqual(read.items,draft.items);assert.equal(read.total,270000);
 }finally{app.locals.close();}
});

test('template edits cannot rewrite issued line flags, checkout totals or a simulated receipt',async()=>{
 const app=fixture();try{
  const user=await owner(app),template=(await user.post('/api/invoice-templates',{label:'Fictional travel template',draft}).expect(201)).body.template;
  assert.deepEqual(template.draft.items,draft.items);
  const invoice=(await user.post('/api/invoices',template.draft).expect(201)).body;
  const changed={...draft,items:draft.items.map(item=>({...item,adjustmentEligible:!item.adjustmentEligible}))};
  await user.post('/api/invoice-templates',{id:template.id,label:template.label,draft:changed}).expect(201);
  assert.deepEqual((await user.agent.get('/api/invoice-templates').expect(200)).body.templates[0].draft.items,changed.items);
  assert.deepEqual((await user.agent.get('/api/invoices/'+invoice.id).expect(200)).body.items,draft.items);
  const checkout=(await request(app).get('/api/checkout/'+invoice.token).expect(200)).body.invoice;
  assert.deepEqual(checkout.items,draft.items);assert.equal(checkout.total,270000);assert.equal(checkout.discountAmount,10000);
  const paid=(await request(app).post('/api/checkout/'+invoice.token+'/pay').set('Idempotency-Key','fictional-line-payment').send({method:'cashu'}).expect(200)).body;
  const receipt=(await request(app).get('/api/receipts/'+paid.receiptToken).expect(200)).body;
  assert.equal(receipt.receipt.mode,'simulation');assert.equal(receipt.receipt.amount,270000);assert.deepEqual(receipt.invoice.items,draft.items);assert.equal(receipt.invoice.total,270000);
 }finally{app.locals.close();}
});

test('manual recurrence freezes template eligibility and issues the reviewed snapshot once',async()=>{
 const app=fixture();try{
  const user=await owner(app),template=(await user.post('/api/invoice-templates',{label:'Fictional recurring travel',draft}).expect(201)).body.template;
  const plan=(await user.post('/api/recurring/plans',{templateId:template.id,label:'Fictional recurring service',startDate:'2026-11-06',frequency:{type:'monthly'}}).expect(201)).body.plan;
  assert.deepEqual(plan.templateDraft.items,draft.items);
  await user.post('/api/invoice-templates',{id:template.id,label:template.label,draft:{...draft,items:draft.items.map(item=>({...item,adjustmentEligible:false}))}}).expect(201);
  const record=(await user.post('/api/recurring/prepare',{}).expect(200)).body.drafts[0];assert.deepEqual(record.draft.items,draft.items);
  const path='/api/recurring/drafts/'+record.id+'/issue',issued=(await user.post(path,{draft:record.draft},'fictional-line-recurring-issue').expect(201)).body;
  assert.equal(issued.invoice.total,270000);assert.deepEqual(issued.invoice.items,draft.items);
  assert.deepEqual((await user.post(path,{draft:record.draft},'fictional-line-recurring-repeat').expect(201)).body,issued);
  await user.post(path,{draft:{...record.draft,items:record.draft.items.map((item:object)=>({...item,adjustmentEligible:false}))}},'fictional-line-recurring-changed').expect(409);
 }finally{app.locals.close();}
});

test('API rejects malformed eligibility without creating invoices',async()=>{
 const app=fixture();try{
  for(const flags of [{kind:'reimbursement'},{kind:null},{adjustmentEligible:'false'},{adjustmentEligible:null}])await request(app).post('/api/v1/invoices').set('Authorization','Bearer '+apiToken).set('Idempotency-Key',randomUUID()).send({...draft,items:[{description:'Fictional invalid flags',quantity:1,unitAmount:100,...flags}]}).expect(400);
  assert.deepEqual((await request(app).get('/api/v1/invoices').set('Authorization','Bearer '+apiToken).expect(200)).body.invoices,[]);
 }finally{app.locals.close();}
});
