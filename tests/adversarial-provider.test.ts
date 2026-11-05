import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {createSquareSandboxClient} from '../integrations/square.js';

test('Square refuses malformed provider identifiers instead of persisting unusable order bindings',async()=>{
  for(const patch of [{id:123},{order_id:{untrusted:'object'}},{id:' '},{order_id:'x'.repeat(201)}]){
    const client=createSquareSandboxClient({token:'synthetic-only',locationId:'loc',fetcher:async()=>Response.json({payment_link:{id:'link',order_id:'order',url:'https://sandbox.square.link/u/fixture',...patch}})});
    await assert.rejects(()=>client.createPaymentLink({amount:125,currency:'CAD',title:'Synthetic',idempotencyKey:'stable-fixture'}));
  }
});

test('a malformed Square tender produces a controlled review error and no receipt',async()=>{
  let paymentCalls=0;
  const app=createApp({dbPath:':memory:',ownerToken:'synthetic-only-owner-token',squareSandbox:{token:'synthetic-only-provider-token',fetcher:async(url)=>{
    if(url.endsWith('/locations'))return Response.json({locations:[{id:'loc',status:'ACTIVE',currency:'CAD'}]});
    if(url.endsWith('/payment-links'))return Response.json({payment_link:{id:'link',order_id:'order',url:'https://sandbox.square.link/u/fixture'}});
    if(url.endsWith('/orders/order'))return Response.json({order:{id:'order',location_id:'loc',total_money:{amount:125,currency:'CAD'},tenders:[null]}});
    paymentCalls++;throw new Error('No payment request should be made for a malformed tender');
  }}});
  try{
    const agent=request.agent(app);const login=await agent.post('/api/session/owner').send({token:'synthetic-only-owner-token'});
    const post=(path:string,body:object={})=>agent.post(path).set('X-CSRF-Token',login.body.csrfToken).set('Idempotency-Key',randomUUID()).send(body);
    const invoice=(await post('/api/invoices',{customerName:'Fictional',title:'Synthetic test',currency:'CAD',items:[{description:'Service',quantity:1,unitAmount:125}]})).body;
    const creation=await post('/api/square-sandbox/checkouts',{invoiceId:invoice.id});assert.equal(creation.status,201);
    const result=await post(`/api/square-sandbox/checkouts/${creation.body.checkout.id}/reconcile`);
    assert.equal(result.status,409);assert.equal(paymentCalls,0);
    const publicView=await request(app).get(`/api/square-test/${creation.body.checkout.token}`);
    assert.equal(publicView.body.checkout.status,'awaiting_payment');assert.equal(publicView.body.checkout.receipt,undefined);
  }finally{app.locals.close();}
});
