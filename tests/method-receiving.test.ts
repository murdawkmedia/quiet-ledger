import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {createApp} from '../server/app.js';
import type {ReceivingAdapter} from '../shared/receiving.js';

const ownerToken='method-receiving-owner-secret';
const pricedInput={customerName:'Fictional pricing customer',title:'Fictional method-priced project',currency:'CAD',
  items:[{description:'Fictional labour',quantity:1,unitAmount:200000},{description:'Fictional flights',quantity:1,unitAmount:80000,kind:'expense'}],
  discountBps:500,taxBps:500,methodPricing:[{method:'lightning',discountBps:1000}]};

interface QuoteCapture {total:number;totalCad?:number;amountSats?:number;method:string;mode:string}
function setup(){
  const quotes:QuoteCapture[]=[];let creates=0;let paid=false;
  const adapter:ReceivingAdapter={id:'fictional-priced-live',mode:'live',methods:['lightning','card'],
    create:async context=>{creates++;return {providerId:context.requestId,request:'lightning:fictional-priced-request',network:'mainnet',asset:'BTC'};},
    check:async context=>paid?{status:'paid',paymentId:'fictional-payment-'+context.requestId,reference:context.requestId,amount:context.amount,currency:context.currency}:{status:'pending'}};
  const app=createApp({dbPath:':memory:',ownerToken,receivingAdapters:[adapter],
    receivingQuote:async(invoice,method,mode)=>{quotes.push({total:invoice.total,totalCad:invoice.totalCad,amountSats:invoice.amountSats,method,mode});
      return {expectedAtomic:String(invoice.total*10),cadEquivalent:invoice.totalCad,source:'fictional priced quote',observedAt:new Date().toISOString()};}});
  return {app,quotes,get creates(){return creates;},markPaid(){paid=true;},isPaid(){return paid;},cleanup(){app.locals.close();}};
}
async function ownerLogin(app:ReturnType<typeof createApp>){
  const agent=request.agent(app);
  const result=await agent.post('/api/session/owner').send({token:ownerToken}).expect(200);
  return {agent,csrf:result.body.csrfToken as string};
}
async function createInvoice(app:ReturnType<typeof createApp>,user:Awaited<ReturnType<typeof ownerLogin>>,input:Record<string,unknown>=pricedInput){
  return (await user.agent.post('/api/invoices').set('X-CSRF-Token',user.csrf).set('Idempotency-Key',randomUUID()).send(input).expect(201)).body;
}
async function confirmLightning(app:ReturnType<typeof createApp>,invoice:{token:string}){
  const checkout=(await request(app).get(`/api/checkout/${invoice.token}`).expect(200)).body;
  const offer=checkout.pricingOffers.find((row:{method:string})=>row.method==='lightning');
  const confirmed=(await request(app).post(`/api/checkout/${invoice.token}/method-agreement`).set('Idempotency-Key',randomUUID()).send({method:'lightning',offerHash:offer.offerHash}).expect(201)).body.agreement;
  return confirmed as {id:string;effectiveTotal:number;referenceTotalCad?:number;referenceAmountSats?:number};
}

test('receiving requires the exact saved agreement before any quote or provider work',async()=>{
  const s=setup();
  try{
    const user=await ownerLogin(s.app),invoice=await createInvoice(s.app,user);
    const post=(body:object)=>user.agent.post('/api/receiving').set('X-CSRF-Token',user.csrf).set('Idempotency-Key',randomUUID()).send(body);
    // No agreement yet: fail closed with zero quote and zero adapter calls.
    const blocked=await post({invoiceId:invoice.id,method:'lightning',adapterId:'fictional-priced-live'});
    assert.equal(blocked.status,409);assert.equal(blocked.body.code,'METHOD_AGREEMENT_REQUIRED');
    assert.deepEqual([s.quotes.length,s.creates],[0,0]);
    const agreement=await confirmLightning(s.app,invoice);
    // Wrong agreement id and mismatching canonical method never reach the provider.
    assert.equal((await post({invoiceId:invoice.id,method:'lightning',adapterId:'fictional-priced-live',agreementId:randomUUID()})).status,409);
    const mismatched=await post({invoiceId:invoice.id,method:'card',adapterId:'fictional-priced-live',agreementId:agreement.id});
    assert.equal(mismatched.status,409);assert.equal(mismatched.body.code,'METHOD_AGREEMENT_MISMATCH');
    assert.deepEqual([s.quotes.length,s.creates],[0,0]);
    // A no-rule invoice rejects a supplied agreementId outright.
    const plain=await createInvoice(s.app,user,{customerName:'Fictional legacy customer',title:'Legacy invoice',currency:'CAD',items:[{description:'Legacy work',quantity:1,unitAmount:10000}]});
    assert.equal((await post({invoiceId:plain.id,method:'lightning',adapterId:'fictional-priced-live',agreementId:agreement.id})).status,400);
    // The public checkout receiving route binds the same agreement through its token.
    const created=await post({invoiceId:invoice.id,method:'lightning',adapterId:'fictional-priced-live',agreementId:agreement.id}).expect(201);
    assert.equal(created.body.request.agreementId,agreement.id);
    assert.equal(created.body.request.amount,262500);
    const publicWrong=request(s.app).post(`/api/checkout/${invoice.token}/receiving`).set('Idempotency-Key',randomUUID()).send({method:'lightning',adapterId:'fictional-priced-live',agreementId:randomUUID()});
    assert.equal((await publicWrong).status,409);
    const publicCreated=await request(s.app).post(`/api/checkout/${invoice.token}/receiving`).set('Idempotency-Key',randomUUID()).send({method:'lightning',adapterId:'fictional-priced-live',agreementId:agreement.id}).expect(201);
    assert.equal(publicCreated.body.request.agreementId,agreement.id);
    // The whole effective total was quoted against the agreement's references.
    assert.deepEqual(s.quotes.map(({total,totalCad,amountSats})=>({total,totalCad,amountSats})),[{total:262500,totalCad:262500,amountSats:2625000},{total:262500,totalCad:262500,amountSats:2625000}]);
    assert.equal(s.creates,2);
  }finally{s.cleanup();}
});

test('installments prorate the agreed references and settle at the effective price',async()=>{
  const s=setup();
  try{
    const user=await ownerLogin(s.app),invoice=await createInvoice(s.app,user);
    const agreement=await confirmLightning(s.app,invoice);
    const post=(body:object)=>user.agent.post('/api/receiving').set('X-CSRF-Token',user.csrf).set('Idempotency-Key',randomUUID()).send(body);
    // A 100000 minor-unit installment quotes its exact prorated CAD and satoshi references.
    const first=await post({invoiceId:invoice.id,method:'lightning',adapterId:'fictional-priced-live',amount:100000,agreementId:agreement.id}).expect(201);
    const firstRequest=first.body.request;
    assert.deepEqual([firstRequest.amount,firstRequest.agreementId],[100000,agreement.id]);
    assert.deepEqual(s.quotes.at(-1),{total:100000,totalCad:100000,amountSats:1000000,method:'lightning',mode:'live'});
    // Settlement of the installment credits the paid amount only.
    assert.equal((await user.agent.post(`/api/receiving/${firstRequest.id}/check`).set('X-CSRF-Token',user.csrf).set('Idempotency-Key',randomUUID()).send({})).body.request.status,'awaiting_payment');
    s.markPaid();
    const settled=(await user.agent.post(`/api/receiving/${firstRequest.id}/check`).set('X-CSRF-Token',user.csrf).set('Idempotency-Key',randomUUID()).send({}).expect(200)).body.request;
    assert.equal(settled.status,'paid');assert.equal(settled.receipt.amount,100000);
    const partial=(await user.agent.get(`/api/invoices/${invoice.id}`).expect(200)).body;
    assert.equal(partial.status,'open');assert.equal(partial.settlementMode,'live');
    assert.deepEqual([partial.balance.effectiveTotal,partial.balance.paid,partial.balance.due],[262500,100000,162500]);
    // The remaining balance is quoted at the prorated effective remainder.
    const second=await post({invoiceId:invoice.id,method:'lightning',adapterId:'fictional-priced-live',agreementId:agreement.id}).expect(201);
    assert.equal(second.body.request.amount,162500);
    assert.deepEqual(s.quotes.at(-1),{total:162500,totalCad:162500,amountSats:1625000,method:'lightning',mode:'live'});
    const closed=(await user.agent.post(`/api/receiving/${second.body.request.id}/check`).set('X-CSRF-Token',user.csrf).set('Idempotency-Key',randomUUID()).send({}).expect(200)).body.request;
    assert.equal(closed.status,'paid');
    const saved=(await user.agent.get(`/api/invoices/${invoice.id}`).expect(200)).body;
    assert.equal(saved.status,'paid');assert.deepEqual([saved.balance.paid,saved.balance.due],[262500,0]);
    // Live receipts never fund simulated payouts and the CAD reference is the agreed one.
    const dashboard=(await user.agent.get('/api/dashboard').expect(200)).body;
    assert.equal(dashboard.totals.receivedCad,262500);assert.equal(dashboard.totals.availableCad,0);
  }finally{s.cleanup();}
});

test('recovery keeps the stored agreement binding on the saved request identity',async()=>{
  const s=setup();
  try{
    const user=await ownerLogin(s.app),invoice=await createInvoice(s.app,user);
    const agreement=await confirmLightning(s.app,invoice);
    const created=await user.agent.post('/api/receiving').set('X-CSRF-Token',user.csrf).set('Idempotency-Key',randomUUID()).send({invoiceId:invoice.id,method:'lightning',adapterId:'fictional-priced-live',agreementId:agreement.id}).expect(201);
    const request_=created.body.request;
    const recovered=(await user.agent.post(`/api/receiving/${request_.id}/recover`).set('X-CSRF-Token',user.csrf).set('Idempotency-Key',randomUUID()).send({}).expect(200)).body.request;
    assert.equal(recovered.id,request_.id);
    assert.equal(recovered.agreementId,agreement.id);
    assert.equal(recovered.amount,262500);
    assert.equal(s.creates,1);
  }finally{s.cleanup();}
});
