import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import type {ReceivingAdapter} from '../shared/receiving.js';

const ownerToken='fictional-events-integration-owner';
const feedKey='fictional-events-only-api-token-0000000000';
const invoiceKey='fictional-invoices-only-api-token-00000000';
const now=()=>new Date('2026-11-08T12:00:00.000Z');
function fixture(){
 const adapter:ReceivingAdapter={id:'fictional-events-receiver',methods:['lightning'],mode:'live',create:async context=>({providerId:context.requestId,asset:'BTC',network:'mainnet',allocationKey:'fictional-events:'+context.requestId}),check:async context=>({status:'paid',paymentId:'fictional-events-payment:'+context.requestId,reference:context.requestId,amount:context.amount,currency:context.currency})};
 return createApp({dbPath:':memory:',ownerToken,encryptionKey:Buffer.alloc(32,37),now,receivingAdapters:[adapter],receivingQuote:async invoice=>({expectedAtomic:String(invoice.total),source:'Controlled SAT fixture; no network',observedAt:now().toISOString()}),apiKeys:[{token:feedKey,scopes:['events:read']},{token:invoiceKey,scopes:['invoices:read']}]});
}
async function owner(app:ReturnType<typeof createApp>){
 const agent=request.agent(app),login=await agent.post('/api/session/owner').send({token:ownerToken}).expect(200);
 return {agent,post:(path:string,body:object={})=>agent.post(path).set('X-CSRF-Token',login.body.csrfToken).set('Idempotency-Key',randomUUID()).send(body)};
}
const input={customerName:'Fictional events client',customerEmail:'events-client@example.invalid',title:'Fictional installment workshop',currency:'SAT',items:[{description:'Workshop',quantity:1,unitAmount:21}],acceptedMethods:['lightning']};
function feed(app:ReturnType<typeof createApp>,cursor?:string,limit=100){return request(app).get('/api/v1/invoice-events').query({limit,...(cursor?{cursor}:{})}).set('Authorization','Bearer '+feedKey);}

test('actual application emits once per verified installment and retains a resume cursor after empty and terminal pages',async()=>{
 const app=fixture();try{
  const user=await owner(app),empty=await feed(app).expect(200);
  assert.deepEqual(empty.body.events,[]);assert.equal(empty.body.hasMore,false);assert.equal(typeof empty.body.nextCursor,'string');
  const invoice=(await user.post('/api/invoices',input).expect(201)).body;
  const first=(await user.post('/api/receiving',{invoiceId:invoice.id,method:'lightning',adapterId:'fictional-events-receiver',amount:7}).expect(201)).body.request;
  await user.post(`/api/receiving/${first.id}/check`).expect(200);
  const partial=(await feed(app,empty.body.nextCursor).expect(200)).body;
  assert.equal(partial.events.length,1);assert.equal(partial.events[0].type,'payment.received');assert.equal(partial.events[0].payment.amount,7);assert.equal(partial.hasMore,false);
  await user.post(`/api/receiving/${first.id}/check`).expect(200);
  const again=(await feed(app,partial.nextCursor).expect(200)).body;
  assert.deepEqual(again.events,[]);assert.equal(again.nextCursor,partial.nextCursor);
  const second=(await user.post('/api/receiving',{invoiceId:invoice.id,method:'lightning',adapterId:'fictional-events-receiver',amount:14}).expect(201)).body.request;
  await user.post(`/api/receiving/${second.id}/check`).expect(200);
  const final=(await feed(app,partial.nextCursor).expect(200)).body;
  assert.deepEqual(final.events.map((event:any)=>event.type),['payment.received','invoice.paid']);
  assert.deepEqual(final.events.map((event:any)=>event.seq),[2,3]);
  assert.equal(final.events[1].effectiveTotal,21);assert.equal(final.events[1].total,21);
  const page1=(await feed(app,empty.body.nextCursor,1).expect(200)).body;assert.equal(page1.hasMore,true);assert.equal(page1.events[0].seq,1);
  const page2=(await feed(app,page1.nextCursor,1).expect(200)).body;assert.equal(page2.hasMore,true);assert.equal(page2.events[0].seq,2);
  const page3=(await feed(app,page2.nextCursor,1).expect(200)).body;assert.equal(page3.hasMore,false);assert.equal(page3.events[0].seq,3);
  const caughtUp=(await feed(app,page3.nextCursor).expect(200)).body;assert.deepEqual(caughtUp.events,[]);assert.ok(caughtUp.nextCursor);
  for(const secret of [invoice.token,invoice.customerName,invoice.customerEmail,first.token,second.token])assert.ok(!JSON.stringify(final).includes(secret));
 }finally{app.locals.close();}
});

test('actual application feed denies anonymous, demo, unscoped keys and mutations; credits produce no payment event',async()=>{
 const app=fixture();try{
  const user=await owner(app);
  await request(app).get('/api/invoice-events').expect(401);
  await request(app).get('/api/v1/invoice-events').expect(401);
  await request(app).get('/api/v1/invoice-events').set('Authorization','Bearer '+invoiceKey).expect(403);
  await request(app).get('/api/v1/invoice-events?workspace=other').set('Authorization','Bearer '+feedKey).expect(403);
  await request(app).post('/api/v1/invoice-events').set('Authorization','Bearer '+feedKey).send({}).expect(403);
  const demo=request.agent(app);await demo.post('/api/session/demo').send({}).expect(200);await demo.get('/api/invoice-events').expect(403);
  const invoice=(await user.post('/api/invoices',input).expect(201)).body;
  await user.post(`/api/invoices/${invoice.id}/credits`,{amount:21,reason:'Fictional credit only'}).expect(200);
  const page=(await feed(app).expect(200)).body;assert.deepEqual(page.events,[]);
  assert.equal((await user.agent.get('/api/invoice-events').expect(200)).body.nextCursor,page.nextCursor);
 }finally{app.locals.close();}
});

test('actual application invoice.paid uses the confirmed method price and preserves the issued total',async()=>{
 const app=fixture();try{
  const user=await owner(app),invoice=(await user.post('/api/invoices',{...input,items:[{description:'Fictional service',quantity:1,unitAmount:100}],methodPricing:[{method:'lightning',discountBps:1000}]}).expect(201)).body;
  const checkout=(await request(app).get(`/api/checkout/${invoice.token}`).expect(200)).body;
  const offer=checkout.pricingOffers.find((row:any)=>row.method==='lightning');assert.equal(offer.effectiveTotal,90);
  await request(app).post(`/api/checkout/${invoice.token}/method-agreement`).set('Idempotency-Key',randomUUID()).send({method:'lightning',offerHash:offer.offerHash}).expect(201);
  const priced=(await user.agent.get(`/api/invoices/${invoice.id}`).expect(200)).body;
  const receive=(await user.post('/api/receiving',{invoiceId:invoice.id,method:'lightning',adapterId:'fictional-events-receiver',agreementId:priced.priceAgreement.id}).expect(201)).body.request;
  assert.equal(receive.amount,90);await user.post(`/api/receiving/${receive.id}/check`).expect(200);
  const events=(await feed(app).expect(200)).body.events;
  assert.deepEqual(events.map((event:any)=>event.type),['payment.received','invoice.paid']);
  assert.deepEqual(events.map((event:any)=>[event.total,event.effectiveTotal]),[[100,90],[100,90]]);
  assert.equal(events[0].payment.amount,90);
 }finally{app.locals.close();}
});
