import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {Store} from '../server/store.js';
import {createInvoice} from '../server/domain.js';
import {PaymentReports} from '../server/payment-reports.js';
import {InvoiceTemplates} from '../server/invoice-templates.js';
import type {ReceivingAdapter} from '../shared/receiving.js';
const draft={customerName:'Fictional private client',title:'Workshop capture',currency:'CAD',items:[{description:'Capture',quantity:1,unitAmount:10000}],acceptedMethods:['bitcoin']};
test('public simulation and public/private receiving reject unaccepted methods before provider calls',async()=>{
 let creates=0,quotes=0;const adapter:ReceivingAdapter={id:'test-card',mode:'test',methods:['card'],create:async()=>{creates++;throw new Error('must not call provider');},check:async()=>({status:'pending'})};
 const app=createApp({dbPath:':memory:',ownerToken:'fixture-invoice-owner',receivingAdapters:[adapter],receivingQuote:async()=>{quotes++;throw new Error('must not quote');}});
 try{const user=request.agent(app),login=await user.post('/api/session/owner').send({token:'fixture-invoice-owner'});const headers={'X-CSRF-Token':login.body.csrfToken,'Idempotency-Key':randomUUID()};const created=await user.post('/api/invoices').set(headers).send(draft);assert.equal(created.status,201);const invoice=created.body;
  for(const method of ['cash','card']){const denied=await request(app).post(`/api/checkout/${invoice.token}/pay`).set('Idempotency-Key',randomUUID()).send({method});assert.equal(denied.status,400);assert.match(denied.body.error,/not accepted/);}
  const body={method:'card',adapterId:adapter.id};assert.equal((await request(app).post(`/api/checkout/${invoice.token}/receiving`).set('Idempotency-Key',randomUUID()).send(body)).status,400);
  assert.equal((await user.post('/api/receiving').set({...headers,'Idempotency-Key':randomUUID()}).send({invoiceId:invoice.id,...body})).status,400);
  assert.equal(creates,0);assert.equal(quotes,0);assert.equal((await user.get('/api/payment-reports')).body.reports.length,0);assert.equal((await user.get(`/api/invoices/${invoice.id}`)).body.status,'open');
  assert.equal((await request(app).post(`/api/checkout/${invoice.token}/pay`).set('Idempotency-Key',randomUUID()).send({method:'bitcoin'})).status,200);
 }finally{app.locals.close();}
});
test('saved manual reports remain isolated even when another workspace supplies the exact invoice ID',()=>{
 const store=new Store(':memory:');try{const reports=new PaymentReports(store),invoice=createInvoice(store,'alpha',{...draft,acceptedMethods:['cash']},new Date());reports.report('alpha',invoice.id,'cash',new Date());assert.throws(()=>reports.report('beta',invoice.id,'cash',new Date()),/not found/);assert.throws(()=>reports.report('alpha',invoice.id,'card',new Date()),/not accepted/);}finally{store.close();}
});
test('template customer details and labels are encrypted and authenticated to their workspace',()=>{
 const store=new Store(':memory:',{encryptionKey:Buffer.alloc(32,36)});try{const templates=new InvoiceTemplates(store),template=templates.save('alpha',{label:'Fictional private repeat client',draft});const row=store.db.prepare('SELECT data FROM invoice_templates WHERE id=?').get(template.id)!;assert.match(String(row.data),/^qlr:v1:/);assert.equal(String(row.data).includes(draft.customerName),false);assert.equal(String(row.data).includes(template.label),false);assert.deepEqual(templates.list('alpha'),[template]);assert.deepEqual(templates.list('beta'),[]);assert.throws(()=>store.decode(row.data,'invoice_templates',template.id,'beta'));assert.throws(()=>templates.save('beta',{id:template.id,label:'Override',draft}),/not found/);}finally{store.close();}
});

test('KRW is explicitly refused by unsupported fiat providers before quotes, transport or saved uncertain requests',async()=>{
 const {createFiatAdapter}=await import('../integrations/fiat-receiving.js');let reads=0,quotes=0;const adapter=createFiatAdapter({provider:'stripe',secretKey:'sk_live_fictional_fixture',accountId:'acct_fixture',merchantCountry:'US',returnUrl:'https://merchant.example/return',fetcher:async()=>{reads++;throw new Error('must not contact provider');}});
 const app=createApp({dbPath:':memory:',ownerToken:'fixture-krw-owner',receivingAdapters:[adapter],receivingQuote:async()=>{quotes++;return {expectedAtomic:'150000',cadEquivalent:15000,source:'fictional',observedAt:new Date().toISOString()};}});
 try{const user=request.agent(app),login=await user.post('/api/session/owner').send({token:'fixture-krw-owner'}),headers={'X-CSRF-Token':login.body.csrfToken,'Idempotency-Key':randomUUID()};const created=await user.post('/api/invoices').set(headers).send({...draft,currency:'KRW',acceptedMethods:['card'],items:[{description:'Recording',quantity:1,unitAmount:150000}]});assert.equal(created.status,201);const result=await user.post('/api/receiving').set({...headers,'Idempotency-Key':randomUUID()}).send({invoiceId:created.body.id,method:'card',adapterId:adapter.id});assert.equal(result.status,409);assert.match(result.body.error,/does not support KRW/);assert.equal(reads,0);assert.equal(quotes,0);assert.equal((await user.get('/api/receiving')).body.requests.length,0);}finally{app.locals.close();}
});
