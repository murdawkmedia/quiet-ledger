import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {METHOD_DEFINITIONS,methodInfo} from '../shared/payment-methods.js';

const token='synthetic-parity-owner-token';
const input={customerName:'Fictional customer',title:'Synthetic method parity',currency:'CAD',items:[{description:'Synthetic service',quantity:1,unitAmount:10000}]};
async function owner(app:ReturnType<typeof createApp>){const agent=request.agent(app);const login=await agent.post('/api/session/owner').send({token});return {agent,post:(path:string,body:object={},key=randomUUID())=>agent.post(path).set('X-CSRF-Token',login.body.csrfToken).set('Idempotency-Key',key).send(body)};}

test('method inventory covers every documented Zaprite reporting method except UNKNOWN and extra dynamic rails',()=>{
  const expected=['BITCOIN','LIQUID','LIGHTNING','BANK','CARD','CASH','CHECK','GIFTCARD','COUPON','APPLEPAY','GOOGLEPAY','CASHAPP_PAY','INTERAC','ACH','SEPA','WIRE_TRANSFER','VENMO','PAYPAL','REVOLUT_PAY','NO_CHARGE','TETHER','USDCIRCLE'];
  assert.deepEqual(METHOD_DEFINITIONS.map(row=>row.zaprite).filter(Boolean).sort(),expected.sort());
  assert.equal(new Set(METHOD_DEFINITIONS.map(row=>row.id)).size,METHOD_DEFINITIONS.length);
  for(const id of ['ideal','pay_by_bank','stripe_dynamic','ark','cashu'])assert.ok(METHOD_DEFINITIONS.some(row=>row.id===id));
});

test('every payment path settles once; manual and noncash reports need workspace confirmation and cannot mint cash',async(t)=>{
  for(const method of METHOD_DEFINITIONS)await t.test(method.id,async()=>{
    const app=createApp({dbPath:':memory:',ownerToken:token});
    try{
      const user=await owner(app);const invoice=(await user.post('/api/invoices',input)).body;
      const paid=await request(app).post(`/api/checkout/${invoice.token}/pay`).set('Idempotency-Key',randomUUID()).send({method:method.id});
      assert.equal(paid.status,200);
      let receiptToken=paid.body.receiptToken;
      if(method.family==='manual'||method.family==='adjustment'){
        assert.equal(paid.body.invoice.status,'open');assert.equal(receiptToken,undefined);assert.ok(paid.body.report?.id);
        assert.equal((await request(app).post(`/api/payment-reports/${paid.body.report.id}/confirm`).send({})).status,401);
        const confirmation=await user.post(`/api/payment-reports/${paid.body.report.id}/confirm`);assert.equal(confirmation.status,200);receiptToken=confirmation.body.receiptToken;
      }
      assert.ok(receiptToken);
      const receipt=await request(app).get(`/api/receipts/${receiptToken}`);assert.equal(receipt.status,200);assert.equal(receipt.body.receipt.method,method.id);
      const dashboard=(await user.agent.get('/api/dashboard')).body;
      assert.equal(dashboard.totals.receivedCad,method.settlement==='noncash'?0:10000);
      assert.equal(dashboard.totals.availableCad,['stablecoin','noncash'].includes(method.settlement)?0:10000);
      if(['bitcoin','stablecoin','noncash'].includes(method.settlement)){
        const quote=await user.post('/api/payouts/quote',{invoiceId:invoice.id,provider:'wise',destinationType:'bank',recipientLabel:'Fictional own bank',amount:100});
        assert.ok(quote.status>=400&&quote.status<500);
      }
    }finally{app.locals.close();}
  });
});

test('manual report confirmation is workspace-scoped and pending reports never fund a payout',async()=>{
  const app=createApp({dbPath:':memory:',ownerToken:token});
  try{
    const user=await owner(app);const invoice=(await user.post('/api/invoices',input)).body;
    const result=await request(app).post(`/api/checkout/${invoice.token}/pay`).set('Idempotency-Key',randomUUID()).send({method:'interac'});assert.equal(result.status,200);
    const demo=request.agent(app);const login=await demo.post('/api/session/demo').send({});
    assert.equal((await demo.post(`/api/payment-reports/${result.body.report.id}/confirm`).set('X-CSRF-Token',login.body.csrfToken).set('Idempotency-Key',randomUUID()).send({})).status,404);
    assert.equal((await user.agent.get('/api/dashboard')).body.totals.receivedCad,0);
    const key=randomUUID();const one=await user.post(`/api/payment-reports/${result.body.report.id}/confirm`,{},key),two=await user.post(`/api/payment-reports/${result.body.report.id}/confirm`,{},key);
    assert.equal(one.status,200);assert.deepEqual(one.body,two.body);
    assert.equal((await user.agent.get('/api/dashboard')).body.totals.receivedCad,10000);
  }finally{app.locals.close();}
});
