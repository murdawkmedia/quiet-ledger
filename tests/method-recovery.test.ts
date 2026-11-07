import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import request from 'supertest';
import {createApp} from '../server/app.js';

const ownerToken='method-recovery-owner-secret';
const pricedInput={customerName:'Fictional pricing customer',title:'Fictional method-priced project',currency:'CAD',
  items:[{description:'Fictional labour',quantity:1,unitAmount:200000},{description:'Fictional flights',quantity:1,unitAmount:80000,kind:'expense'}],
  discountBps:500,taxBps:500,methodPricing:[{method:'lightning',discountBps:1000}]};

function open(dbPath:string){return createApp({dbPath,ownerToken});}
function dir(){return mkdtempSync(join(tmpdir(),'ql-method-recovery-'));}
async function ownerLogin(app:ReturnType<typeof createApp>){
  const agent=request.agent(app);
  const result=await agent.post('/api/session/owner').send({token:ownerToken}).expect(200);
  return {agent,csrf:result.body.csrfToken as string};
}
async function createPricedInvoice(app:ReturnType<typeof createApp>,user:Awaited<ReturnType<typeof ownerLogin>>){
  return (await user.agent.post('/api/invoices').set('X-CSRF-Token',user.csrf).set('Idempotency-Key',randomUUID()).send(pricedInput).expect(201)).body;
}
async function confirmAndPay(app:ReturnType<typeof createApp>,invoice:{token:string}){
  const checkout=(await request(app).get(`/api/checkout/${invoice.token}`).expect(200)).body;
  const offer=checkout.pricingOffers.find((row:{method:string})=>row.method==='lightning');
  const agreement=(await request(app).post(`/api/checkout/${invoice.token}/method-agreement`).set('Idempotency-Key',randomUUID()).send({method:'lightning',offerHash:offer.offerHash}).expect(201)).body.agreement;
  const payKey=randomUUID();
  const paid=await request(app).post(`/api/checkout/${invoice.token}/pay`).set('Idempotency-Key',payKey).send({method:'lightning',agreementId:agreement.id}).expect(200);
  return {agreement,paid:paid.body,payKey};
}

test('confirmed agreements and effective balances survive a restart',async()=>{
  const directory=dir(),dbPath=join(directory,'ledger.sqlite');
  const app=open(dbPath);
  let invoice:{id:string;token:string;number:string},agreementId:string,receiptToken:string,offerHash:string;
  try{
    const user=await ownerLogin(app);
    invoice=await createPricedInvoice(app,user);
    const result=await confirmAndPay(app,invoice);
    agreementId=result.agreement.id;receiptToken=result.paid.receiptToken;offerHash=result.agreement.offerHash;
  }finally{app.locals.close();}
  const reopened=open(dbPath);
  try{
    // The public checkout still resolves the invoice at its agreed satoshi reference.
    const checkout=(await request(reopened).get(`/api/checkout/${invoice.token}`).expect(200)).body;
    assert.deepEqual([checkout.payment.mode,checkout.payment.amountSats],['simulation',2625000]);
    assert.equal(checkout.invoice.priceAgreement.id,agreementId);
    assert.equal(checkout.invoice.priceAgreement.referenceTotalCad,undefined);
    assert.equal(checkout.receiptToken,receiptToken);
    // The owner workspace reads the full agreement and the settled effective balance.
    const user=await ownerLogin(reopened);
    const saved=(await user.agent.get(`/api/invoices/${invoice.id}`).expect(200)).body;
    assert.equal(saved.status,'paid');
    assert.deepEqual([saved.balance.effectiveTotal,saved.balance.paid,saved.balance.due],[262500,262500,0]);
    assert.equal(saved.priceAgreement.referenceTotalCad,262500);
    const receipt=(await request(reopened).get(`/api/receipts/${receiptToken}`).expect(200)).body.receipt;
    assert.deepEqual([receipt.method,receipt.amount],['lightning',262500]);
    // The append-only agreement row blocks any second confirmation after restart.
    const second=await request(reopened).post(`/api/checkout/${invoice.token}/method-agreement`).set('Idempotency-Key',randomUUID()).send({method:'lightning',offerHash});
    assert.equal(second.status,409);assert.equal(second.body.code,'METHOD_AGREEMENT_LOCKED');
  }finally{reopened.locals.close();rmSync(directory,{recursive:true,force:true});}
});

test('revoked links hide the priced checkout, agreement confirmation and receipt',async()=>{
  const directory=dir(),dbPath=join(directory,'ledger.sqlite');
  const app=open(dbPath);
  try{
    const user=await ownerLogin(app);
    const invoice=await createPricedInvoice(app,user);
    const {paid,agreement,payKey}=await confirmAndPay(app,invoice);
    const receiptToken=paid.receiptToken as string;
    await user.agent.post(`/api/invoices/${invoice.id}/revoke-links`).set('X-CSRF-Token',user.csrf).set('Idempotency-Key',randomUUID()).send({}).expect(200);
    assert.equal((await request(app).get(`/api/checkout/${invoice.token}`)).status,404);
    assert.equal((await request(app).post(`/api/checkout/${invoice.token}/method-agreement`).set('Idempotency-Key',randomUUID()).send({method:'lightning',offerHash:'0'.repeat(64)})).status,404);
    assert.equal((await request(app).post(`/api/checkout/${invoice.token}/pay`).set('Idempotency-Key',randomUUID()).send({method:'lightning',agreementId:randomUUID()})).status,404);
    assert.equal((await request(app).get(`/api/receipts/${receiptToken}`)).status,404);
    // Revocation also denies a replay of the previously successful payment key.
    assert.equal((await request(app).post(`/api/checkout/${invoice.token}/pay`).set('Idempotency-Key',payKey).send({method:'lightning',agreementId:agreement.id})).status,404);
    // The owner keeps full workspace access after revocation.
    const saved=(await user.agent.get(`/api/invoices/${invoice.id}`).expect(200)).body;
    assert.equal(saved.balance.paid,262500);
  }finally{app.locals.close();rmSync(directory,{recursive:true,force:true});}
});

test('workspace isolation keeps owner pricing away from demo sessions',async()=>{
  const directory=dir(),dbPath=join(directory,'ledger.sqlite');
  const app=open(dbPath);
  try{
    const user=await ownerLogin(app);
    const invoice=await createPricedInvoice(app,user);
    await confirmAndPay(app,invoice);
    const demo=request.agent(app);
    const session=await demo.post('/api/session/demo').send({}).expect(200);
    const csrf=session.body.csrfToken as string;
    assert.equal((await demo.get(`/api/invoices/${invoice.id}`)).status,404);
    assert.equal((await demo.get(`/api/invoices/${invoice.id}/ledger`)).status,403);
    // Demo sessions cannot reach owner live receiving for the priced invoice.
    const receiving=await demo.post('/api/receiving').set('X-CSRF-Token',csrf).set('Idempotency-Key',randomUUID()).send({invoiceId:invoice.id,method:'lightning',adapterId:'any'});
    assert.equal(receiving.status,403);
    // The demo evidence export stays demo-only and business records stay owner-only.
    const evidence=(await demo.get('/api/evidence/export').expect(200)).body;
    assert.equal(evidence.invoices.some((entry:{id:string})=>entry.id===invoice.id),false);
    assert.equal(JSON.stringify(evidence).includes('283500'),false);
    assert.equal((await demo.post('/api/business-records/statement').set('X-CSRF-Token',csrf).set('Idempotency-Key',randomUUID()).send({invoiceIds:[invoice.id]})).status,403);
  }finally{app.locals.close();rmSync(directory,{recursive:true,force:true});}
});

test('concurrent confirmations and payments keep one agreement and one receipt',async()=>{
  const directory=dir(),dbPath=join(directory,'ledger.sqlite');
  const app=open(dbPath);
  try{
    const user=await ownerLogin(app);
    const invoice=await createPricedInvoice(app,user);
    const checkout=(await request(app).get(`/api/checkout/${invoice.token}`).expect(200)).body;
    const offer=checkout.pricingOffers.find((row:{method:string})=>row.method==='lightning');
    // Two racing confirmations: exactly one locks the price.
    const confirmations=await Promise.all([1,2].map(index=>request(app).post(`/api/checkout/${invoice.token}/method-agreement`).set('Idempotency-Key',`race-confirm-${index}`).send({method:'lightning',offerHash:offer.offerHash})));
    const succeeded=confirmations.filter(response=>response.status===201);
    const locked=confirmations.filter(response=>response.status===409&&response.body.code==='METHOD_AGREEMENT_LOCKED');
    assert.equal(succeeded.length+locked.length,2);
    assert.notEqual(succeeded.length,0);
    const agreement=succeeded[0].body.agreement;
    // Concurrent payments under one key replay one receipt; a different key is idempotent on the settled invoice.
    const key=randomUUID();
    const payments=await Promise.all([1,2].map(()=>request(app).post(`/api/checkout/${invoice.token}/pay`).set('Idempotency-Key',key).send({method:'lightning',agreementId:agreement.id})));
    for(const payment of payments){assert.equal(payment.status,200);assert.equal(payment.body.receiptToken,payments[0].body.receiptToken);}
    const later=await request(app).post(`/api/checkout/${invoice.token}/pay`).set('Idempotency-Key',randomUUID()).send({method:'lightning',agreementId:agreement.id}).expect(200);
    assert.equal(later.body.receiptToken,payments[0].body.receiptToken);
    assert.equal(later.body.alreadyPaid,true);
    const saved=(await user.agent.get(`/api/invoices/${invoice.id}`).expect(200)).body;
    assert.deepEqual([saved.balance.paid,saved.balance.overpaid],[262500,0]);
  }finally{app.locals.close();rmSync(directory,{recursive:true,force:true});}
});
