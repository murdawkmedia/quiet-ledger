import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import type {ReceivingAdapter,ReceivingObservation} from '../shared/receiving.js';
const ownerToken='synthetic-live-receiving-owner';
const input={customerName:'Fictional local customer',title:'Synthetic receiving invoice',currency:'CAD',items:[{description:'Synthetic service',quantity:1,unitAmount:125}]};
async function owner(app:any){const agent=request.agent(app);const login=await agent.post('/api/session/owner').send({token:ownerToken});return {agent,post:(path:string,body:object={},key=randomUUID())=>agent.post(path).set('X-CSRF-Token',login.body.csrfToken).set('Idempotency-Key',key).send(body)};}

test('live receiving commits the exact provider receipt once and excludes it from simulated payouts',async()=>{
  let creates=0;let status:ReceivingObservation['status']='pending';let reference='';
  const adapter:ReceivingAdapter={id:'synthetic-core',mode:'live',methods:['bitcoin'],create:async c=>{creates++;reference=c.requestId;return {providerId:c.requestId,request:'bitcoin:synthetic-only',network:'mainnet',asset:'BTC',allocationKey:'synthetic-unique-allocation',opaque:{privateInternal:'must-not-be-public'}};},check:async c=>status==='paid'?{status:'paid',paymentId:'synthetic-payment-1',amount:c.amount,currency:c.currency,reference}: {status:'pending'}};
  const app=createApp({dbPath:':memory:',ownerToken,receivingAdapters:[adapter],receivingQuote:async()=>({expectedAtomic:'1000',cadEquivalent:125,source:'synthetic-only',observedAt:new Date().toISOString()})} as any);
  try{
    const user=await owner(app);const invoice=(await user.post('/api/invoices',input)).body;const key=randomUUID();
    const created=await user.post('/api/receiving',{invoiceId:invoice.id,method:'bitcoin',adapterId:adapter.id},key);assert.equal(created.status,201);
    const intent=created.body.request;assert.equal(intent.mode,'live');
    assert.equal((await user.post('/api/receiving',{invoiceId:invoice.id,method:'bitcoin',adapterId:adapter.id},key)).body.request.id,intent.id);assert.equal(creates,1);
    const publicPage=await request(app).get(`/api/receive/${intent.token}`);assert.equal(publicPage.status,200);assert.ok(!JSON.stringify(publicPage.body).includes('privateInternal'));
    const pending=await user.post(`/api/receiving/${intent.id}/check`);assert.equal(pending.body.request.status,'awaiting_payment');
    status='paid';const verified=await user.post(`/api/receiving/${intent.id}/check`);assert.equal(verified.status,200);assert.equal(verified.body.request.status,'paid');assert.equal(verified.body.request.receipt.mode,'live');
    const again=await user.post(`/api/receiving/${intent.id}/check`);assert.deepEqual(again.body.request.receipt,verified.body.request.receipt);
    const saved=(await user.agent.get(`/api/invoices/${invoice.id}`)).body;assert.equal(saved.status,'paid');assert.equal(saved.settlementMode,'live');
    assert.equal((await user.agent.get('/api/dashboard')).body.totals.availableCad,0);
    assert.equal((await user.post('/api/payouts/quote',{invoiceId:invoice.id,provider:'bullbitcoin',destinationType:'bank',recipientLabel:'Synthetic',amount:10})).status,409);
    assert.equal((await request(app).get(`/api/receipts/${saved.receiptToken}`)).body.receipt.mode,'live');
    const exported=(await user.agent.get('/api/evidence/export')).body;
    assert.equal(exported.payments.find((payment:any)=>payment.invoiceNumber===invoice.number).mode,'live');
  }finally{app.locals.close();}
});

test('owner manual receiving confirmation is atomic, retry-safe and records manual verification',async()=>{
  const {manualReceiving}=await import('../server/receiving-config.js');
  const app=createApp({dbPath:':memory:',ownerToken,receivingAdapters:[manualReceiving],receivingQuote:async()=>({expectedAtomic:'125',cadEquivalent:125,source:'synthetic-only',observedAt:new Date().toISOString()})});
  try{
    const user=await owner(app),invoice=(await user.post('/api/invoices',input)).body;
    const created=await user.post('/api/receiving',{invoiceId:invoice.id,method:'interac',adapterId:manualReceiving.id});
    assert.equal(created.status,201);
    const path=`/api/receiving/${created.body.request.id}/confirm`,key=randomUUID(),body={note:'Independently reviewed fictional bank receipt',transactionId:'synthetic-bank-transfer-001'};
    const confirmed=await user.post(path,body,key);assert.equal(confirmed.status,200);assert.equal(confirmed.body.request.status,'paid');
    assert.deepEqual((await user.post(path,body,key)).body,confirmed.body);
    const saved=(await user.agent.get(`/api/invoices/${invoice.id}`)).body;assert.equal(saved.nativePayment.verification,'manual');
    assert.equal((await user.agent.get('/api/dashboard')).body.activity.filter((event:any)=>event.action==='payment.manual_review').length,1);
  }finally{app.locals.close();}
});

test('receiving rejects wrong paid binding and does not retry an uncertain non-idempotent creation blindly',async()=>{
  let creates=0;const adapter:ReceivingAdapter={id:'uncertain-fixture',mode:'live',methods:['card'],create:async()=>{creates++;throw Object.assign(new Error('secret-upstream-value'),{code:'FIAT_CREATION_UNCERTAIN'});},check:async()=>({status:'pending'})};
  const app=createApp({dbPath:':memory:',ownerToken,receivingAdapters:[adapter],receivingQuote:async()=>({expectedAtomic:'125',cadEquivalent:125,source:'synthetic-only',observedAt:new Date().toISOString()})} as any);
  try{
    const user=await owner(app);const invoice=(await user.post('/api/invoices',input)).body;const key=randomUUID();
    assert.equal((await user.post('/api/receiving',{invoiceId:invoice.id,method:'card',adapterId:adapter.id},key)).status,502);
    const again=await user.post('/api/receiving',{invoiceId:invoice.id,method:'card',adapterId:adapter.id},key);assert.equal(again.status,409);assert.equal(creates,1);assert.ok(!JSON.stringify(again.body).includes('secret-upstream-value'));
    const demo=request.agent(app);await demo.post('/api/session/demo').send({});assert.equal((await demo.get('/api/receiving')).status,403);
    assert.equal((await user.agent.get('/api/collateral')).status,503);
  }finally{app.locals.close();}
});

test('public Lightning handoff preserves exact payload and provider-only receipt provenance',async()=>{
  let paid=false,creates=0;
  const payload='lightning:lnbc10u1fixtureonly';
  const adapter:ReceivingAdapter={id:'synthetic-lightning',mode:'live',methods:['lightning'],create:async c=>{
    creates++;return {providerId:c.requestId,request:payload,expiresAt:new Date(Date.now()+30000).toISOString(),network:'mainnet',asset:'BTC',cashuWalletHandoff:true,opaque:{secret:'synthetic-hidden-marker'}};
  },check:async c=>paid?{status:'paid',paymentId:'synthetic-lightning-payment',amount:c.amount,currency:c.currency,reference:c.requestId}:{status:'pending'}};
  const app=createApp({dbPath:':memory:',ownerToken,receivingAdapters:[adapter],receivingQuote:async()=>({expectedAtomic:'1000',cadEquivalent:125,source:'synthetic-only',observedAt:new Date().toISOString()})});
  try{
    const user=await owner(app),invoice=(await user.post('/api/invoices',input)).body,key=randomUUID();
    const created=await user.post('/api/receiving',{invoiceId:invoice.id,method:'lightning',adapterId:adapter.id},key);
    assert.equal(created.status,201);const record=created.body.request;
    const path=`/api/receive/${record.token}`;
    const publicRecord=(await request(app).get(path)).body.request;
    assert.equal(publicRecord.intent.cashuWalletHandoff,true);assert.equal(publicRecord.intent.request,payload);assert.equal(publicRecord.intent.expiresAt,record.intent.expiresAt);assert(Number.isFinite(Date.parse(publicRecord.intent.expiresAt)));
    assert(!JSON.stringify(publicRecord).includes('synthetic-hidden-marker'));assert.equal(publicRecord.receipt,undefined);
    assert.equal((await user.post(`/api/receiving/${record.id}/check`)).body.request.status,'awaiting_payment');
    assert.equal((await user.post('/api/receiving',{invoiceId:invoice.id,method:'lightning',adapterId:adapter.id},key)).body.request.id,record.id);
    paid=true;const settled=(await user.post(`/api/receiving/${record.id}/check`)).body.request;
    assert.equal(settled.receipt.method,'lightning');assert.equal(settled.receipt.mode,'live');
    assert.deepEqual((await user.post(`/api/receiving/${record.id}/check`)).body.request.receipt,settled.receipt);
    assert.equal(creates,1);const saved=(await user.agent.get(`/api/invoices/${invoice.id}`)).body;
    assert.equal(saved.nativePayment.verification,'provider');assert.equal(saved.paymentMethod,'lightning');
  }finally{app.locals.close();}
});
