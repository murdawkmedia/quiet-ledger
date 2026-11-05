import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { createSquareSandboxClient } from '../integrations/square.js';

const ownerToken='square-test-owner-synthetic-credential';
const invoiceInput={customerName:'PRIVATE CUSTOMER MUST STAY LOCAL',customerEmail:'private@example.invalid',title:'Private invoice title',note:'PRIVATE NOTE MUST STAY LOCAL',currency:'CAD',items:[{description:'Test service',quantity:1,unitAmount:125}]};
function fixture(){
  const calls:{url:string;body:any}[]=[];
  let failures=0;
  let payment:any={id:'payment-1',order_id:'order-1',location_id:'loc-1',status:'COMPLETED',amount_money:{amount:125,currency:'CAD'},refunded_money:{amount:0,currency:'CAD'}};
  let tenders:any[]=[];
  const fetcher=async(url:string,init?:RequestInit)=>{
    const body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({url,body});
    if(url.endsWith('/locations'))return Response.json({locations:[{id:'loc-1',status:'ACTIVE',currency:'CAD'}]});
    if(url.endsWith('/payment-links')){
      if(failures-->0)throw new Error('synthetic-secret-must-not-escape');
      return Response.json({payment_link:{id:'link-1',order_id:'order-1',url:'https://sandbox.square.link/u/fixture'}});
    }
    if(url.endsWith('/orders/order-1'))return Response.json({order:{id:'order-1',location_id:'loc-1',total_money:{amount:125,currency:'CAD'},tenders}});
    if(url.endsWith('/payments/payment-1'))return Response.json({payment});
    throw new Error('Unexpected fixture request');
  };
  return {calls,fetcher,setFailures:(value:number)=>{failures=value;},setPayment:(value:any)=>{payment={...payment,...value};},setTenders:(value:any[])=>{tenders=value;},fund:()=>{tenders=[{id:'payment-1',payment_id:'payment-1'}];}};
}
async function login(app:any,role='owner'){
  const agent=request.agent(app);
  const response=await agent.post(`/api/session/${role}`).send(role==='owner'?{token:ownerToken}:{});
  assert.equal(response.status,200);
  const csrf=response.body.csrfToken;
  return {agent,post:(path:string,body:object={},key=randomUUID())=>agent.post(path).set('X-CSRF-Token',csrf).set('Idempotency-Key',key).send(body)};
}
function appFor(provider=fixture(),dbPath=':memory:'){
  const app=createApp({dbPath,ownerToken,squareSandbox:{token:'synthetic-sandbox-secret',fetcher:provider.fetcher}} as any);
  return {app,provider};
}

test('Square sandbox connection is owner-only, CSRF-protected and explicitly unconfigured without a token',async()=>{
  const {app}=appFor();const disabled=createApp({dbPath:':memory:',ownerToken});
  try{
    assert.equal((await request(app).get('/api/square-sandbox')).status,401);
    const demo=await login(app,'demo');assert.equal((await demo.agent.get('/api/square-sandbox')).status,403);
    const owner=await login(app);
    assert.equal((await owner.agent.post('/api/square-sandbox/connection').send({})).status,403);
    const status=await owner.agent.get('/api/square-sandbox');assert.equal(status.body.configured,true);
    assert.equal(status.body.connection,null);
    assert.equal((await owner.post('/api/square-sandbox/connection')).body.connection.currency,'CAD');
    const noToken=await login(disabled);assert.equal((await noToken.post('/api/square-sandbox/connection')).status,503);
  }finally{app.locals.close();disabled.locals.close();}
});

test('Square persists an intent before a timeout and retries one provider key across a restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'quiet-square-'));const path=join(dir,'test.sqlite');const provider=fixture();provider.setFailures(1);
  let app=appFor(provider,path).app;
  try{
    let owner=await login(app);const invoice=(await owner.post('/api/invoices',invoiceInput)).body;
    const retryKey=randomUUID();
    const failed=await owner.post('/api/square-sandbox/checkouts',{invoiceId:invoice.id},retryKey);
    assert.equal(failed.status,502);assert.ok(!JSON.stringify(failed.body).includes('synthetic-secret'));
    const pending=(await owner.agent.get('/api/square-sandbox')).body.checkouts;
    assert.equal(pending.length,1);assert.equal(pending[0].status,'creation_pending');
    app.locals.close();app=appFor(provider,path).app;owner=await login(app);
    const retry=await owner.post('/api/square-sandbox/checkouts',{invoiceId:invoice.id},retryKey);
    assert.equal(retry.status,201);assert.equal(retry.body.checkout.status,'awaiting_payment');
    const duplicate=await owner.post('/api/square-sandbox/checkouts',{invoiceId:invoice.id});
    assert.equal(duplicate.body.checkout.id,retry.body.checkout.id);
    const creations=provider.calls.filter(c=>c.url.endsWith('/payment-links'));
    assert.equal(creations.length,2);assert.equal(creations[0].body.idempotency_key,creations[1].body.idempotency_key);
    assert.ok(!JSON.stringify(creations).includes('PRIVATE'));
    assert.equal((await owner.post('/api/square-sandbox/checkouts',{invoiceId:'another'},retryKey)).status,409);
  }finally{app.locals.close();rmSync(dir,{recursive:true,force:true});}
});

test('Square receipts require exact authoritative readback and never credit the simulation ledger',async()=>{
  const {app,provider}=appFor();
  try{
    const owner=await login(app);const invoice=(await owner.post('/api/invoices',invoiceInput)).body;
    const created=await owner.post('/api/square-sandbox/checkouts',{invoiceId:invoice.id});assert.equal(created.status,201);
    const checkout=created.body.checkout;
    const before=await owner.post(`/api/square-sandbox/checkouts/${checkout.id}/reconcile`);
    assert.equal(before.body.checkout.status,'awaiting_payment');
    provider.fund();provider.setPayment({order_id:'unrelated-order'});
    assert.equal((await owner.post(`/api/square-sandbox/checkouts/${checkout.id}/reconcile`)).status,409);
    provider.setPayment({order_id:'order-1',refunded_money:{amount:1,currency:'CAD'}});
    assert.equal((await owner.post(`/api/square-sandbox/checkouts/${checkout.id}/reconcile`)).status,409);
    provider.setPayment({refunded_money:{amount:0,currency:'CAD'}});
    const paid=await owner.post(`/api/square-sandbox/checkouts/${checkout.id}/reconcile`);
    assert.equal(paid.status,200);assert.equal(paid.body.checkout.receipt.mode,'square_sandbox');
    const again=await owner.post(`/api/square-sandbox/checkouts/${checkout.id}/reconcile`);
    assert.deepEqual(again.body.checkout.receipt,paid.body.checkout.receipt);
    const original=await owner.agent.get(`/api/invoices/${invoice.id}`);assert.equal(original.body.status,'open');
    const dashboard=await owner.agent.get('/api/dashboard');assert.equal(dashboard.body.totals.receivedCad,0);
    const token=checkout.token;
    const publicResult=await request(app).get(`/api/square-test/${token}`);assert.equal(publicResult.status,200);
    assert.equal(publicResult.body.checkout.receipt.mode,'square_sandbox');
    assert.ok(!JSON.stringify(publicResult.body).includes('PRIVATE'));
    assert.ok(!JSON.stringify(publicResult.body).includes('synthetic-sandbox-secret'));
    assert.equal((await request(app).post(`/api/square-test/${token}/check`).set('Origin','https://foreign.invalid').send({})).status,403);
    assert.equal((await owner.agent.get('/api/evidence/export')).body.payments.length,0);
  }finally{app.locals.close();}
});

test('Square refuses missing retry keys, other workspace invoices and mismatching location currencies',async()=>{
  const {app,provider}=appFor();
  try{
    const owner=await login(app);const demo=await login(app,'demo');const their=(await demo.post('/api/invoices',invoiceInput)).body;
    assert.equal((await owner.post('/api/square-sandbox/checkouts',{invoiceId:their.id})).status,404);
    const usd=(await owner.post('/api/invoices',{...invoiceInput,currency:'USD'})).body;
    assert.equal((await owner.post('/api/square-sandbox/checkouts',{invoiceId:usd.id})).status,409);
    const cad=(await owner.post('/api/invoices',invoiceInput)).body;
    const session=await owner.agent.get('/api/session');
    assert.equal((await owner.agent.post('/api/square-sandbox/checkouts').set('X-CSRF-Token',session.body.csrfToken).send({invoiceId:cad.id})).status,400);
    assert.equal(provider.calls.filter(c=>c.url.endsWith('/payment-links')).length,0);
  }finally{app.locals.close();}
});

test('Square sandbox client rejects production checkout links even if returned by its upstream',async()=>{
  const client=createSquareSandboxClient({token:'fixture',locationId:'loc-1',fetcher:async()=>Response.json({payment_link:{id:'l',order_id:'o',url:'https://square.link/u/production'}})});
  await assert.rejects(()=>client.createPaymentLink({amount:125,currency:'CAD',title:'Test',idempotencyKey:'stable-key'}),/sandbox checkout host/);
});

test('Square rejects ambiguous sandbox location selection before creating any provider order',async()=>{
  const app=createApp({dbPath:':memory:',ownerToken,squareSandbox:{token:'fixture',fetcher:async()=>Response.json({locations:[{id:'a',status:'ACTIVE',currency:'CAD'},{id:'b',status:'ACTIVE',currency:'CAD'}]})}});
  try{const owner=await login(app);assert.equal((await owner.post('/api/square-sandbox/connection')).status,503);}
  finally{app.locals.close();}
});

test('concurrent Square creation reuses one checkout and completed-payment mismatches never issue a receipt',async()=>{
  const {app,provider}=appFor();
  try{
    const owner=await login(app);const invoice=(await owner.post('/api/invoices',invoiceInput)).body;
    const results=await Promise.all([owner.post('/api/square-sandbox/checkouts',{invoiceId:invoice.id}),owner.post('/api/square-sandbox/checkouts',{invoiceId:invoice.id})]);
    assert.equal(results[0].status,201);assert.equal(results[1].status,201);
    assert.equal(results[0].body.checkout.id,results[1].body.checkout.id);
    assert.equal(provider.calls.filter(call=>call.url.endsWith('/payment-links')).length,1);
    const checkout=results[0].body.checkout;
    provider.fund();
    for(const patch of [{location_id:'wrong'},{amount_money:{amount:126,currency:'CAD'}},{amount_money:{amount:125,currency:'USD'}},{id:'wrong-payment'}]){
      provider.setPayment({id:'payment-1',location_id:'loc-1',amount_money:{amount:125,currency:'CAD'},...patch});
      assert.equal((await owner.post(`/api/square-sandbox/checkouts/${checkout.id}/reconcile`)).status,409);
      assert.equal((await request(app).get(`/api/square-test/${checkout.token}`)).body.checkout.receipt,undefined);
    }
    provider.setPayment({id:'payment-1',status:'PENDING'});
    assert.equal((await owner.post(`/api/square-sandbox/checkouts/${checkout.id}/reconcile`)).body.checkout.status,'awaiting_payment');
    provider.setTenders([{id:'one'},{id:'two'}]);
    assert.equal((await owner.post(`/api/square-sandbox/checkouts/${checkout.id}/reconcile`)).status,409);
    assert.equal((await request(app).post(`/api/square-test/${checkout.token}/check`).send({paymentId:'unrelated'})).status,400);
  }finally{app.locals.close();}
});
