import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {createApp} from '../server/app.js';
import type {ReceivingAdapter} from '../shared/receiving.js';

test('offers and confirmation reject a live method unsupported in the invoice currency before any provider work',async()=>{
 let creates=0;
 const adapter:ReceivingAdapter={id:'fictional-currency-limited',mode:'live',methods:['lightning','card'],supportedCurrencies:['CAD','USD'],supportedCurrenciesByMethod:{lightning:['CAD'],card:['USD']},create:async()=>{creates++;throw new Error('must not create during pricing');},check:async()=>({status:'pending'})};
 const app=createApp({dbPath:':memory:',ownerToken:'fictional-currency-owner',receivingAdapters:[adapter]});
 try {
  const agent=request.agent(app),session=await agent.post('/api/session/owner').send({token:'fictional-currency-owner'}).expect(200);
  const invoice=(await agent.post('/api/invoices').set('X-CSRF-Token',session.body.csrfToken).set('Idempotency-Key',randomUUID()).send({customerName:'Fictional currency client',title:'Fictional USD work',currency:'USD',items:[{description:'Fictional service',quantity:1,unitAmount:10000}],acceptedMethods:['lightning','card'],methodPricing:[{method:'lightning',discountBps:500}]}).expect(201)).body;
  const checkout=(await request(app).get(`/api/checkout/${invoice.token}`).expect(200)).body;
  assert.deepEqual(checkout.pricingOffers.map((row:{method:string})=>row.method),['card']);
  const rejected=await request(app).post(`/api/checkout/${invoice.token}/method-agreement`).set('Idempotency-Key',randomUUID()).send({method:'lightning',offerHash:'a'.repeat(64)});
  assert.equal(rejected.status,409);assert.match(rejected.body.error,/not currently payable/);
  const unchanged=(await request(app).get(`/api/checkout/${invoice.token}`)).body;assert.equal(unchanged.invoice.priceAgreement,undefined);assert.equal(creates,0);
 } finally {app.locals.close();}
});
