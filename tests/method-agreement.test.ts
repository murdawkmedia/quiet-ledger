import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import request from 'supertest';
import {createApp} from '../server/app.js';

const ownerToken='method-agreement-owner-secret';
// Worked example: 200000 eligible labour + 80000 expense, 5% discount, 5% tax.
// Issued total 283500. Lightning -10%: effective 262500, sats reference 2625000.
// Card +2%: effective 287700.
const pricedInput={customerName:'Fictional pricing customer',title:'Fictional method-priced project',currency:'CAD',
  items:[{description:'Fictional labour',quantity:1,unitAmount:200000},{description:'Fictional flights',quantity:1,unitAmount:80000,kind:'expense'}],
  discountBps:500,taxBps:500,methodPricing:[{method:'lightning',discountBps:1000},{method:'card',premiumBps:200}]};
// Fictional monthly-pilot basis case: 200000 eligible services + 80000 excluded
// flights, no tax or global adjustments. Bitcoin 15% eligible -> 250000; the
// all-fiat 5% whole-invoice premium -> 294000 on every settlement-fiat method.
const groupInput={customerName:'Fictional fiat studio',title:'Fictional monthly pilot',currency:'CAD',
  items:[{description:'Fictional monthly services',quantity:1,unitAmount:200000},{description:'Fictional excluded flights',quantity:1,unitAmount:80000,kind:'expense'}],
  taxBps:0,methodPricing:[{method:'lightning',discountBps:1500},{method:'fiat',basis:'subtotal',premiumBps:500}]};

function setup(){
  const dir=mkdtempSync(join(tmpdir(),'ql-method-agreement-')),dbPath=join(dir,'ledger.sqlite');
  const app=createApp({dbPath,ownerToken});
  return {app,dbPath,cleanup(){app.locals.close();rmSync(dir,{recursive:true,force:true});}};
}
async function ownerLogin(app:ReturnType<typeof createApp>){
  const agent=request.agent(app);
  const result=await agent.post('/api/session/owner').send({token:ownerToken}).expect(200);
  return {agent,csrf:result.body.csrfToken as string};
}
async function createPricedInvoice(app:ReturnType<typeof createApp>,user:Awaited<ReturnType<typeof ownerLogin>>,input:Record<string,unknown>=pricedInput){
  return (await user.agent.post('/api/invoices').set('X-CSRF-Token',user.csrf).set('Idempotency-Key',randomUUID()).send(input).expect(201)).body;
}
function confirm(app:ReturnType<typeof createApp>,token:string,method:string,offerHash:string,key=randomUUID()){
  return request(app).post(`/api/checkout/${token}/method-agreement`).set('Idempotency-Key',key).send({method,offerHash});
}
function pay(app:ReturnType<typeof createApp>,token:string,body:object,key=randomUUID()){
  return request(app).post(`/api/checkout/${token}/pay`).set('Idempotency-Key',key).send(body);
}

test('checkout hides the simulation payment until the payer confirms one method price',async()=>{
  const s=setup();
  try{
    const user=await ownerLogin(s.app),invoice=await createPricedInvoice(s.app,user);
    const checkout=(await request(s.app).get(`/api/checkout/${invoice.token}`).expect(200)).body;
    // A required method-price lock hides the base-price simulation QR until confirmed.
    assert.equal(checkout.payment,null);
    assert.equal(checkout.invoice.methodPricing.length,2);
    assert.equal(checkout.invoice.priceAgreement,undefined);
    const offers=Object.fromEntries(checkout.pricingOffers.map((offer:{method:string})=>[offer.method,offer]));
    const lightning=offers.lightning;
    assert.match(lightning.offerHash,/^[0-9a-f]{64}$/);
    assert.deepEqual([lightning.issuedTotal,lightning.discountAmount,lightning.effectiveTax,lightning.effectiveTotal,lightning.taxAdjustment,lightning.totalAdjustment,lightning.referenceTotalCad,lightning.referenceAmountSats],[283500,20000,12500,262500,-1000,-21000,262500,2625000]);
    assert.deepEqual([offers.card.premiumAmount,offers.card.effectiveTotal,offers.card.totalAdjustment],[4000,287700,4200]);
    // A method without a rule keeps its exact base-price offer.
    assert.deepEqual([offers.bitcoin.effectiveTotal,offers.bitcoin.totalAdjustment],[283500,0]);
    // A stale or forged hash never locks a price.
    assert.equal((await confirm(s.app,invoice.token,'lightning','0'.repeat(64))).status,400);
    // Aliased and unknown methods are rejected before any lock.
    assert.equal((await confirm(s.app,invoice.token,'square',lightning.offerHash)).status,400);
    // Happy path: the public checkout token is the only confirmation authority.
    const key=randomUUID();
    const confirmed=await confirm(s.app,invoice.token,'lightning',lightning.offerHash,key).expect(201);
    const agreement=confirmed.body.agreement;
    assert.deepEqual([agreement.method,agreement.effectiveTotal,agreement.referenceAmountSats,agreement.confirmation],['lightning',262500,2625000,'public_checkout_token']);
    assert.equal('invoiceId' in agreement,false);assert.equal('referenceTotalCad' in agreement,false);
    // Same key and body replay byte-identically; an altered body under the saved key conflicts.
    const replay=await confirm(s.app,invoice.token,'lightning',lightning.offerHash,key).expect(201);
    assert.equal(JSON.stringify(replay.body),JSON.stringify(confirmed.body));
    assert.equal((await confirm(s.app,invoice.token,'card',offers.card.offerHash,key)).status,409);
    // A second key racing the one-agreement lock fails closed.
    const second=await confirm(s.app,invoice.token,'card',offers.card.offerHash);
    assert.equal(second.status,409);assert.equal(second.body.code,'METHOD_AGREEMENT_LOCKED');
    // After the lock the checkout serves the agreed simulation payment and no offers.
    const locked=(await request(s.app).get(`/api/checkout/${invoice.token}`).expect(200)).body;
    assert.deepEqual([locked.payment.mode,locked.payment.amountSats],['simulation',2625000]);
    assert.match(locked.payment.qrDataUrl,/^data:image\/png;base64,/);
    assert.deepEqual(locked.pricingOffers,[]);
    assert.equal(locked.invoice.priceAgreement.effectiveTotal,262500);
    assert.equal(locked.invoice.priceAgreement.invoiceId,undefined);
    assert.equal(locked.invoice.priceAgreement.referenceTotalCad,undefined);
  }finally{s.cleanup();}
});

test('the pay route settles only the explicitly confirmed effective price',async()=>{
  const s=setup();
  try{
    const user=await ownerLogin(s.app),invoice=await createPricedInvoice(s.app,user);
    const checkout=(await request(s.app).get(`/api/checkout/${invoice.token}`).expect(200)).body;
    const offer=checkout.pricingOffers.find((row:{method:string})=>row.method==='lightning');
    const confirmed=(await confirm(s.app,invoice.token,'lightning',offer.offerHash).expect(201)).body.agreement;
    // The payment must reference the exact agreement.
    assert.equal((await pay(s.app,invoice.token,{method:'lightning'})).status,409);
    assert.equal((await pay(s.app,invoice.token,{method:'lightning',agreementId:randomUUID()})).status,409);
    const mismatched=await pay(s.app,invoice.token,{method:'card',agreementId:confirmed.id});
    assert.equal(mismatched.status,409);assert.equal(mismatched.body.code,'METHOD_AGREEMENT_MISMATCH');
    const paid=await pay(s.app,invoice.token,{method:'lightning',agreementId:confirmed.id}).expect(200);
    assert.equal(paid.body.alreadyPaid,false);
    const receipt=(await request(s.app).get(`/api/receipts/${paid.body.receiptToken}`).expect(200)).body;
    assert.deepEqual([receipt.receipt.mode,receipt.receipt.method,receipt.receipt.amount],['simulation','lightning',262500]);
    assert.equal(receipt.invoice.priceAgreement.effectiveTotal,262500);
    assert.equal(receipt.invoice.priceAgreement.referenceTotalCad,undefined);
    // The owner dashboard reports the effective settlement target, not the issued total.
    const dashboard=(await user.agent.get('/api/dashboard').expect(200)).body;
    const row=dashboard.invoices.find((entry:{id:string})=>entry.id===invoice.id);
    assert.equal(row.status,'paid');
    assert.deepEqual([row.balance.effectiveTotal,row.balance.paid,row.balance.due],[262500,262500,0]);
    assert.equal(row.priceAgreement.referenceTotalCad,262500);
    assert.equal(dashboard.totals.receivedCad,262500);
  }finally{s.cleanup();}
});

test('a revoked checkout link can never confirm or replay a saved agreement',async()=>{
  const s=setup();
  try{
    const user=await ownerLogin(s.app),invoice=await createPricedInvoice(s.app,user);
    const checkout=(await request(s.app).get(`/api/checkout/${invoice.token}`).expect(200)).body;
    const offer=checkout.pricingOffers.find((row:{method:string})=>row.method==='lightning');
    const key=randomUUID();
    await confirm(s.app,invoice.token,'lightning',offer.offerHash,key).expect(201);
    await user.agent.post(`/api/invoices/${invoice.id}/revoke-links`).set('X-CSRF-Token',user.csrf).set('Idempotency-Key',randomUUID()).send({}).expect(200);
    // The link is resolved and authorized before any saved idempotent response is read.
    assert.equal((await request(s.app).get(`/api/checkout/${invoice.token}`)).status,404);
    assert.equal((await confirm(s.app,invoice.token,'lightning',offer.offerHash,key)).status,404);
    assert.equal((await pay(s.app,invoice.token,{method:'lightning',agreementId:randomUUID()})).status,404);
  }finally{s.cleanup();}
});

test('local demo sessions cannot create method-priced invoices or read owner pricing',async()=>{
  const s=setup();
  try{
    const user=await ownerLogin(s.app),invoice=await createPricedInvoice(s.app,user);
    const demo=request.agent(s.app);
    const result=await demo.post('/api/session/demo').send({}).expect(200);
    const csrf=result.body.csrfToken as string;
    // Demo creation of a priced invoice fails closed before any row is written.
    const rejected=await demo.post('/api/invoices').set('X-CSRF-Token',csrf).set('Idempotency-Key',randomUUID()).send(pricedInput);
    assert.equal(rejected.status,403);
    // Unpriced demo creation still works and stays in its own workspace.
    await demo.post('/api/invoices').set('X-CSRF-Token',csrf).set('Idempotency-Key',randomUUID()).send({customerName:'Fictional demo customer',title:'Demo work',currency:'CAD',items:[{description:'Demo',quantity:1,unitAmount:5000}]}).expect(201);
    // The owner's priced invoice and its agreement stay invisible to the demo workspace.
    assert.equal((await demo.get(`/api/invoices/${invoice.id}`)).status,404);
    const demoDashboard=(await demo.get('/api/dashboard').expect(200)).body;
    assert.equal(demoDashboard.invoices.some((entry:{id:string})=>entry.id===invoice.id),false);
  }finally{s.cleanup();}
});

test('priced invoices without a confirmed agreement block payment at the checkout',async()=>{
  const s=setup();
  try{
    const user=await ownerLogin(s.app),invoice=await createPricedInvoice(s.app,user);
    const blocked=await pay(s.app,invoice.token,{method:'lightning'});
    assert.equal(blocked.status,409);assert.equal(blocked.body.code,'METHOD_AGREEMENT_REQUIRED');
    // Owner-side receiving is gated the same way (see method-receiving tests) and the
    // invoice stays exactly as issued.
    const saved=(await user.agent.get(`/api/invoices/${invoice.id}`).expect(200)).body;
    assert.equal(saved.status,'open');
    assert.deepEqual([saved.balance.effectiveTotal,saved.balance.due],[283500,283500]);
  }finally{s.cleanup();}
});

test('the all-fiat fallback prices every payable fiat method and one concrete confirmation locks it',async()=>{
  const s=setup();
  try{
    const user=await ownerLogin(s.app),invoice=await createPricedInvoice(s.app,user,groupInput);
    assert.deepEqual(invoice.methodPricing,[{method:'lightning',discountBps:1500},{method:'fiat',basis:'subtotal',premiumBps:500}]);
    const checkout=(await request(s.app).get(`/api/checkout/${invoice.token}`).expect(200)).body;
    const offers=Object.fromEntries(checkout.pricingOffers.map((offer:{method:string})=>[offer.method,offer]));
    // The group target is never itself an actual payment method.
    assert.equal(offers.fiat,undefined);
    // Bitcoin keeps its eligible-basis discount.
    assert.deepEqual([offers.lightning.discountAmount,offers.lightning.effectiveTotal,offers.lightning.basis],[30000,250000,undefined]);
    // Every settlement-fiat method, including manual bank/cash/check, gets the same whole-subtotal premium.
    for(const method of ['bank','card','cash','check','interac','ach','sepa','wire','paypal','stripe_dynamic'])
      assert.deepEqual([offers[method].premiumAmount,offers[method].effectiveTotal,offers[method].basis],[14000,294000,'subtotal'],method);
    // Concrete fiat offers are distinct server offers even with equal amounts.
    assert.notEqual(offers.bank.offerHash,offers.card.offerHash);
    // Stablecoin, Bitcoin-native methods without a rule and noncash get no fiat fallback.
    for(const method of ['usdt','usdc','bitcoin','gift_card'])
      assert.deepEqual([offers[method].premiumAmount,offers[method].effectiveTotal,offers[method].basis,offers[method].totalAdjustment],[0,280000,undefined,0],method);
    // The group target itself can never be confirmed as a payment rail.
    assert.equal((await confirm(s.app,invoice.token,'fiat',offers.card.offerHash)).status,400);
    // A concrete fiat confirmation locks the group price with its basis metadata.
    const key=randomUUID();
    const confirmed=await confirm(s.app,invoice.token,'bank',offers.bank.offerHash,key).expect(201);
    assert.deepEqual([confirmed.body.agreement.method,confirmed.body.agreement.basis,confirmed.body.agreement.effectiveTotal,confirmed.body.agreement.premiumAmount],['bank','subtotal',294000,14000]);
    assert.equal('invoiceId' in confirmed.body.agreement,false);
    // Same key and body replay byte-identically; a different body under the saved key conflicts.
    const replay=await confirm(s.app,invoice.token,'bank',offers.bank.offerHash,key).expect(201);
    assert.equal(JSON.stringify(replay.body),JSON.stringify(confirmed.body));
    assert.equal((await confirm(s.app,invoice.token,'card',offers.card.offerHash,key)).status,409);
    // The locked checkout exposes the basis on the public agreement and no further offers.
    const locked=(await request(s.app).get(`/api/checkout/${invoice.token}`).expect(200)).body;
    assert.deepEqual(locked.pricingOffers,[]);
    assert.deepEqual([locked.invoice.priceAgreement.method,locked.invoice.priceAgreement.basis,locked.invoice.priceAgreement.effectiveTotal],['bank','subtotal',294000]);
  }finally{s.cleanup();}
});

test('a concrete fiat rule overrides the all-fiat group for that method only',async()=>{
  const s=setup();
  try{
    const user=await ownerLogin(s.app),invoice=await createPricedInvoice(s.app,user,{...groupInput,methodPricing:[{method:'fiat',basis:'subtotal',premiumBps:500},{method:'card',premiumBps:200}]});
    const checkout=(await request(s.app).get(`/api/checkout/${invoice.token}`).expect(200)).body;
    const offers=Object.fromEntries(checkout.pricingOffers.map((offer:{method:string})=>[offer.method,offer]));
    // Card uses its own eligible-basis rule; bank keeps the whole-subtotal group premium.
    assert.deepEqual([offers.card.premiumAmount,offers.card.effectiveTotal,offers.card.basis],[4000,284000,undefined]);
    assert.deepEqual([offers.bank.premiumAmount,offers.bank.effectiveTotal,offers.bank.basis],[14000,294000,'subtotal']);
  }finally{s.cleanup();}
});

test('SAT invoices reject the all-fiat group rule before anything is stored',async()=>{
  const s=setup();
  try{
    const user=await ownerLogin(s.app);
    const rejected=await user.agent.post('/api/invoices').set('X-CSRF-Token',user.csrf).set('Idempotency-Key',randomUUID())
      .send({...groupInput,currency:'SAT',items:[{description:'Fictional satoshi work',quantity:1,unitAmount:100000}],methodPricing:[{method:'lightning',discountBps:1500},{method:'fiat',basis:'subtotal',premiumBps:500}]});
    assert.equal(rejected.status,400);
    assert.match(rejected.body.error,/SAT/);
    assert.equal((await user.agent.get('/api/invoices').expect(200)).body.invoices.length,0);
  }finally{s.cleanup();}
});
