import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import type {ReceivingAdapter} from '../shared/receiving.js';
const ownerToken='fictional-currency-report-owner';
test('dashboard and scoped evidence agree on exact currency balances without a provider quote or mutation',async()=>{
 let providerCalls=0;const adapter:ReceivingAdapter={id:'fictional-currency-reader',mode:'live',methods:['lightning'],create:async c=>{providerCalls++;return {providerId:c.requestId,asset:'BTC',network:'mainnet'};},check:async c=>({status:'paid',paymentId:'fictional:'+c.requestId,reference:c.requestId,amount:c.amount,currency:c.currency})};
 const exporter='fictional-report-export-token-at-least-32',reader='fictional-report-reader-token-at-least-32';
 const app=createApp({dbPath:':memory:',ownerToken,receivingAdapters:[adapter],receivingQuote:async invoice=>({expectedAtomic:String(invoice.total*10),cadEquivalent:321,source:'Fictional saved quote',observedAt:new Date().toISOString()}),apiKeys:[{token:exporter,scopes:['records:read']},{token:reader,scopes:['invoices:read']}]});
 try{
  const owner=request.agent(app),login=await owner.post('/api/session/owner').send({token:ownerToken}).expect(200);
  const post=(path:string,data:object)=>owner.post(path).set('X-CSRF-Token',login.body.csrfToken).set('Idempotency-Key',randomUUID()).send(data);
  async function create(currency:string,amount:number){return (await post('/api/invoices',{customerName:'Fictional report client',title:'Fictional reporting fixture',currency,items:[{description:'Fictional service',quantity:1,unitAmount:amount}]}).expect(201)).body;}
  const usd=await create('USD',10000),won=await create('KRW',150001);
  await post(`/api/invoices/${won.id}/credits`,{amount:1,reason:'Fictional whole-won correction'}).expect(200);
  const receive=(await post('/api/receiving',{invoiceId:usd.id,method:'lightning',adapterId:adapter.id,amount:2500}).expect(201)).body.request;
  await post(`/api/receiving/${receive.id}/check`,{}).expect(200);
  const before=(await owner.get('/api/evidence/export').expect(200)).body;
  const dashboard=(await owner.get('/api/dashboard').expect(200)).body;
  assert.deepEqual(dashboard.currencyBalances,[
   {currency:'USD',mode:'live',invoiceCount:1,issued:10000,effective:10000,paid:2500,credited:0,voided:0,due:7500,overpaid:0,methodDiscount:0,methodPremium:0,methodTaxAdjustment:0},
   {currency:'KRW',mode:'live',invoiceCount:1,issued:150001,effective:150001,paid:0,credited:1,voided:0,due:150000,overpaid:0,methodDiscount:0,methodPremium:0,methodTaxAdjustment:0},
  ]);
  assert.equal(dashboard.valuation.invoicedCad,'reference_only');assert.equal(dashboard.totals.receivedCad,321);
  const evidence=(await request(app).get('/api/v1/evidence/export').set('Authorization','Bearer '+exporter).expect(200)).body;assert.deepEqual(evidence.currencyBalances,dashboard.currencyBalances);assert.deepEqual(evidence.valuation,dashboard.valuation);
  await request(app).get('/api/v1/evidence/export').set('Authorization','Bearer '+reader).expect(403);await request(app).get('/api/evidence/export').expect(401);
  const demo=request.agent(app);await demo.post('/api/session/demo').send({}).expect(200);const other=(await demo.get('/api/dashboard').expect(200)).body;assert(other.currencyBalances.every((row:any)=>row.mode==='simulation'));assert(!JSON.stringify(other).includes('Fictional report client'));
  const after=(await owner.get('/api/evidence/export').expect(200)).body;for(const key of ['invoices','payments','payouts','activity'])assert.deepEqual(after[key],before[key]);assert.equal(providerCalls,1);
 }finally{app.locals.close();}
});
