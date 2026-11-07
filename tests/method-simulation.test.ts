import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import request from 'supertest';
import {createApp} from '../server/app.js';
import {Store} from '../server/store.js';

const ownerToken='method-simulation-owner-secret';
const pricedInput={customerName:'Fictional pricing customer',title:'Fictional method-priced project',currency:'CAD',
  items:[{description:'Fictional labour',quantity:1,unitAmount:200000},{description:'Fictional flights',quantity:1,unitAmount:80000,kind:'expense'}],
  discountBps:500,taxBps:500};

function setup(options:Record<string,unknown>={}){
  const dir=mkdtempSync(join(tmpdir(),'ql-method-simulation-')),dbPath=join(dir,'ledger.sqlite');
  const app=createApp({dbPath,ownerToken,...options});
  return {app,dbPath,dir,cleanup(){app.locals.close();rmSync(dir,{recursive:true,force:true});}};
}
async function ownerLogin(app:ReturnType<typeof createApp>){
  const agent=request.agent(app);
  const result=await agent.post('/api/session/owner').send({token:ownerToken}).expect(200);
  return {agent,csrf:result.body.csrfToken as string};
}
async function createInvoice(app:ReturnType<typeof createApp>,user:Awaited<ReturnType<typeof ownerLogin>>,methodPricing:object[]|undefined){
  const body=methodPricing?{...pricedInput,methodPricing}:pricedInput;
  return (await user.agent.post('/api/invoices').set('X-CSRF-Token',user.csrf).set('Idempotency-Key',randomUUID()).send(body).expect(201)).body;
}
async function confirmMethod(app:ReturnType<typeof createApp>,token:string,method:string){
  const checkout=(await request(app).get(`/api/checkout/${token}`).expect(200)).body;
  const offer=checkout.pricingOffers.find((row:{method:string})=>row.method===method);
  const confirmed=(await request(app).post(`/api/checkout/${token}/method-agreement`).set('Idempotency-Key',randomUUID()).send({method,offerHash:offer.offerHash}).expect(201)).body.agreement;
  return confirmed as {id:string;effectiveTotal:number};
}

test('a simulated cashu payment settles the effective total and its satoshi reference',async()=>{
  const s=setup();
  try{
    const user=await ownerLogin(s.app),invoice=await createInvoice(s.app,user,[{method:'cashu',discountBps:1000}]);
    const agreement=await confirmMethod(s.app,invoice.token,'cashu');
    // The checkout payment surface already serves the agreed satoshi reference.
    const checkout=(await request(s.app).get(`/api/checkout/${invoice.token}`).expect(200)).body;
    assert.deepEqual([checkout.payment.mode,checkout.payment.amountSats],['simulation',2625000]);
    const paid=await request(s.app).post(`/api/checkout/${invoice.token}/pay`).set('Idempotency-Key',randomUUID()).send({method:'cashu',agreementId:agreement.id}).expect(200);
    const receipt=(await request(s.app).get(`/api/receipts/${paid.body.receiptToken}`).expect(200)).body.receipt;
    assert.deepEqual([receipt.mode,receipt.method,receipt.amount,receipt.amountSats],['simulation','cashu',262500,2625000]);
    // Dashboard availability follows the effective CAD reference, never the issued total.
    const dashboard=(await user.agent.get('/api/dashboard').expect(200)).body;
    assert.deepEqual([dashboard.totals.invoicedCad,dashboard.totals.receivedCad,dashboard.totals.availableCad],[283500,262500,262500]);
    const balance=dashboard.currencyBalances.find((row:{currency:string;mode:string})=>row.currency==='CAD'&&row.mode==='simulation');
    assert.deepEqual([balance.issued,balance.effective,balance.paid,balance.due],[283500,262500,262500,0]);
    assert.deepEqual([balance.methodDiscount,balance.methodTaxAdjustment],[20000,-1000]);
  }finally{s.cleanup();}
});

test('square sandbox fails closed without a card agreement and charges the effective total',async()=>{
  const calls:{url:string;body:any}[]=[];
  const fetcher=async(url:string,init?:RequestInit)=>{
    const body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({url,body});
    if(url.endsWith('/locations'))return Response.json({locations:[{id:'loc-1',status:'ACTIVE',currency:'CAD'}]});
    if(url.endsWith('/payment-links'))return Response.json({payment_link:{id:'link-1',order_id:'order-1',url:'https://sandbox.square.link/u/fixture'}});
    throw new Error('Unexpected fixture request');
  };
  const s=setup({squareSandbox:{token:'synthetic-sandbox-secret',fetcher}});
  try{
    const user=await ownerLogin(s.app),invoice=await createInvoice(s.app,user,[{method:'card',premiumBps:200}]);
    const post=(body:object)=>user.agent.post('/api/square-sandbox/checkouts').set('X-CSRF-Token',user.csrf).set('Idempotency-Key',randomUUID()).send(body);
    // Missing agreement fails closed before any sandbox connection work.
    const blocked=await post({invoiceId:invoice.id});
    assert.equal(blocked.status,409);assert.equal(blocked.body.code,'METHOD_AGREEMENT_REQUIRED');
    assert.equal(calls.length,0);
    const agreement=await confirmMethod(s.app,invoice.token,'card');
    assert.equal(agreement.effectiveTotal,287700);
    const created=await post({invoiceId:invoice.id}).expect(201);
    // The public sandbox projection exposes the charged amount only; the stored
    // record keeps the private agreement binding (covered by the store tests).
    assert.equal(created.body.checkout.amount,287700);
    assert.equal('agreementId' in created.body.checkout,false);
    // The provider order itself is priced at the whole effective total.
    const link=calls.find(call=>call.url.endsWith('/payment-links'))!;
    assert.equal(link.body.quick_pay.price_money.amount,287700);
  }finally{s.cleanup();}
});

test('the hackathon demo rejects priced creation and gates its payment action on an agreement',async()=>{
  const origin='https://demo.example',secret='fictional-private-proxy-value-at-least-32-bytes',key=Buffer.alloc(32,51);
  const dir=mkdtempSync(join(tmpdir(),'ql-method-demo-')),dbPath=join(dir,'demo.sqlite');
  const app=createApp({dbPath,encryptionKey:key,hosted:{publicOrigin:origin,proxySecret:secret,hackathonDemo:true,limits:{requestsPerMinute:1000}}});
  const headers={'x-quiet-ledger-proxy':secret,'x-quiet-ledger-client-ip':'203.0.113.11',Origin:origin};
  try{
    const session=await request(app).post('/api/session/hackathon-demo').set(headers).send({password:'marmot'}).expect(200);
    const auth={...headers,Cookie:String(session.headers['set-cookie'][0]).split(';')[0],'X-CSRF-Token':session.body.csrfToken};
    // Priced fictional demo creation is rejected before any invoice row is written.
    const rejected=await request(app).post('/api/hackathon-demo/invoices').set(auth).send({...pricedInput,methodPricing:[{method:'cashu',discountBps:1000}]});
    assert.equal(rejected.status,400);
    const view=(await request(app).get('/api/hackathon-demo').set(auth).expect(200)).body;
    // A directly seeded priced demo invoice (fictional) cannot use the shortcut payment
    // action without a public agreement: the acceptedMethods[0] path stays gated.
    const store=new Store(dbPath,{encryptionKey:key});
    const workspace=String((store.db.prepare('SELECT workspace FROM invoices WHERE id=?').get(view.invoice.id) as {workspace:string}).workspace);
    const seeded=store.getInvoice(view.invoice.id,workspace)!;
    store.saveInvoice({...seeded,methodPricing:[{method:'cashu',discountBps:1000}]});
    const blocked=await request(app).post('/api/hackathon-demo/simulate-payment').set(auth).send({});
    assert.equal(blocked.status,409);assert.equal(blocked.body.code,'METHOD_AGREEMENT_REQUIRED');
    store.close();
  }finally{app.locals.close();rmSync(dir,{recursive:true,force:true});}
});
