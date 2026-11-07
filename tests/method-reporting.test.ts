import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {createApp} from '../server/app.js';

const ownerToken='method-reporting-owner-secret';
const pricedInput={customerName:'Fictional pricing customer',title:'Fictional method-priced project',currency:'CAD',
  items:[{description:'Fictional labour',quantity:1,unitAmount:200000},{description:'Fictional flights',quantity:1,unitAmount:80000,kind:'expense'}],
  discountBps:500,taxBps:500,methodPricing:[{method:'lightning',discountBps:1000}]};

function setup(){
  const app=createApp({dbPath:':memory:',ownerToken});
  return {app,cleanup(){app.locals.close();}};
}
async function ownerLogin(app:ReturnType<typeof createApp>){
  const agent=request.agent(app);
  const result=await agent.post('/api/session/owner').send({token:ownerToken}).expect(200);
  return {agent,csrf:result.body.csrfToken as string};
}
async function createInvoice(app:ReturnType<typeof createApp>,user:Awaited<ReturnType<typeof ownerLogin>>,input:Record<string,unknown>=pricedInput){
  return (await user.agent.post('/api/invoices').set('X-CSRF-Token',user.csrf).set('Idempotency-Key',randomUUID()).send(input).expect(201)).body;
}
async function confirmMethod(app:ReturnType<typeof createApp>,token:string,method:string){
  const checkout=(await request(app).get(`/api/checkout/${token}`).expect(200)).body;
  const offer=checkout.pricingOffers.find((row:{method:string})=>row.method===method);
  return (await request(app).post(`/api/checkout/${token}/method-agreement`).set('Idempotency-Key',randomUUID()).send({method,offerHash:offer.offerHash}).expect(201)).body.agreement;
}

test('statements, evidence and CSV exports report one consistent effective price',async()=>{
  const s=setup();
  try{
    const user=await ownerLogin(s.app),invoice=await createInvoice(s.app,user);
    const agreement=await confirmMethod(s.app,invoice.token,'lightning');
    const paid=await request(s.app).post(`/api/checkout/${invoice.token}/pay`).set('Idempotency-Key',randomUUID()).send({method:'lightning',agreementId:agreement.id}).expect(200);
    // Business-records statement keeps the rules, the full owner agreement and the effective balance.
    const statement=(await user.agent.post('/api/business-records/statement').set('X-CSRF-Token',user.csrf).set('Idempotency-Key',randomUUID()).send({invoiceIds:[invoice.id]}).expect(200)).body;
    const row=statement.invoices[0];
    assert.equal(row.invoice.methodPricing.length,1);
    assert.equal(row.invoice.priceAgreement.id,agreement.id);
    assert.equal(row.invoice.priceAgreement.referenceTotalCad,262500);
    assert.deepEqual([row.balance.effectiveTotal,row.balance.paid,row.balance.due],[262500,262500,0]);
    assert.equal(row.entries.at(-1).amount,262500);
    assert.deepEqual([statement.summary[0].issued,statement.summary[0].effective,statement.summary[0].paid,statement.summary[0].methodDiscount,statement.summary[0].methodTaxAdjustment],[283500,262500,262500,20000,-1000]);
    // Evidence export is schemaVersion 2 and never exposes checkout capabilities.
    const evidence=(await user.agent.get('/api/evidence/export').expect(200)).body;
    assert.equal(evidence.schemaVersion,2);
    const exported=evidence.invoices.find((entry:{id:string})=>entry.id===invoice.id);
    assert.equal(exported.priceAgreement.effectiveTotal,262500);
    assert.equal(exported.priceAgreement.referenceTotalCad,262500);
    assert.equal(exported.token,undefined);assert.equal(exported.receiptToken,undefined);
    assert.equal(evidence.payments.at(-1).amount,262500);
    assert.deepEqual([evidence.currencyBalances[0].issued,evidence.currencyBalances[0].effective],[283500,262500]);
    // The 21-column CSV export carries the same effective, adjustment and agreement cells.
    const csv=(await user.agent.get('/api/invoice-ledger/export.csv').expect(200)).text;
    const [header,data]=csv.split('\r\n');
    assert.equal(header,'"Invoice","Customer","Title","Currency","Total","Effective total","Pricing method","Original tax","Effective tax","Method discount","Method premium","Method tax adjustment","Paid","Credited","Due","Overpaid","State","Mode","Issue date","Due date","Agreement"');
    assert.ok(data.includes('"2835.00","2625.00","lightning","135.00","125.00","200.00","0.00","-10.00","2625.00","0.00","0.00","0.00","paid","simulation"'));
    assert.ok(data.endsWith(`"${agreement.id}"`));
    // The exported CSV round-trips through the preview validator.
    const preview=(await user.agent.post('/api/business-records/csv-preview').set('X-CSRF-Token',user.csrf).set('Idempotency-Key',randomUUID()).send({csv}).expect(200)).body;
    assert.equal(preview.counts.existing,1);
    assert.equal(preview.rows[0].record.balance.effectiveTotal,262500);
    assert.equal(preview.rows[0].record.agreementId,agreement.id);
    assert.equal(preview.rows[0].record.pricingMethod,'lightning');
  }finally{s.cleanup();}
});

test('manual payment reports on a priced invoice snapshot and settle the effective total',async()=>{
  const s=setup();
  try{
    const user=await ownerLogin(s.app);
    const invoice=await createInvoice(s.app,user,{...pricedInput,acceptedMethods:['bank'],methodPricing:[{method:'bank',discountBps:1000}]});
    const pay=(body:object)=>request(s.app).post(`/api/checkout/${invoice.token}/pay`).set('Idempotency-Key',randomUUID()).send(body);
    // A manual bank report before any agreement is rejected outright.
    const blocked=await pay({method:'bank_transfer'});
    assert.equal(blocked.status,409);assert.equal(blocked.body.code,'METHOD_AGREEMENT_REQUIRED');
    const agreement=await confirmMethod(s.app,invoice.token,'bank');
    assert.equal(agreement.effectiveTotal,262500);
    // The report snapshots the agreed method, amount and agreement id.
    const reported=await pay({method:'bank_transfer',agreementId:agreement.id}).expect(200);
    assert.equal(reported.body.alreadyPaid,false);
    const report=reported.body.report;
    // The report keeps the client-facing method label; its agreement binding is canonical.
    assert.deepEqual([report.method,report.amount,report.agreementId,report.status],['bank_transfer',262500,agreement.id,'reported']);
    assert.equal((await user.agent.get(`/api/invoices/${invoice.id}`).expect(200)).body.status,'open');
    // Owner confirmation settles exactly the agreed effective total, once.
    const confirm=(await user.agent.post(`/api/payment-reports/${report.id}/confirm`).set('X-CSRF-Token',user.csrf).set('Idempotency-Key',randomUUID()).send({}).expect(200)).body;
    assert.equal(confirm.invoice.status,'paid');
    assert.equal(confirm.invoice.receiptToken,undefined);
    const receipt=(await request(s.app).get(`/api/receipts/${confirm.receiptToken}`).expect(200)).body.receipt;
    assert.deepEqual([receipt.method,receipt.amount],['bank_transfer',262500]);
    const listed=(await user.agent.get('/api/payment-reports').expect(200)).body.reports;
    assert.equal(listed.find((entry:{id:string})=>entry.id===report.id).status,'confirmed');
  }finally{s.cleanup();}
});
