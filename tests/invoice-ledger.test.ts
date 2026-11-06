import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import type {ReceivingAdapter} from '../shared/receiving.js';

const ownerToken='fictional-business-ledger-owner';
const invoiceInput={customerName:'Fictional Studio',title:'Fictional installment project',currency:'CAD',items:[{description:'Fictional service',quantity:1,unitAmount:1000}]};
async function owner(app:ReturnType<typeof createApp>){const agent=request.agent(app),login=await agent.post('/api/session/owner').send({token:ownerToken}).expect(200);return {agent,post:(path:string,body:object={},key:string=randomUUID())=>agent.post(path).set('X-CSRF-Token',login.body.csrfToken).set('Idempotency-Key',key).send(body)};}
function fixture(){let creates=0;const amounts:number[]=[];const paid=new Set<string>();const adapter:ReceivingAdapter={id:'fictional-live',mode:'live',methods:['lightning'],create:async context=>{creates++;amounts.push(context.amount);return {providerId:context.requestId,asset:'BTC',network:'mainnet'};},check:async context=>paid.has(context.requestId)?{status:'paid',paymentId:'fictional-payment-'+context.requestId,reference:context.requestId,amount:context.amount,currency:context.currency}:{status:'pending'}};const app=createApp({dbPath:':memory:',ownerToken,receivingAdapters:[adapter],receivingQuote:async invoice=>({expectedAtomic:String(invoice.total*10),cadEquivalent:invoice.total,source:'fictional exact quote',observedAt:new Date().toISOString()})});return {app,paid,amounts,get creates(){return creates;}};}

test('two verified installments retain immutable total and two distinct exact receipts',async()=>{
 const f=fixture();try{const user=await owner(f.app),invoice=(await user.post('/api/invoices',invoiceInput).expect(201)).body;
 const initial=(await user.agent.get(`/api/invoices/${invoice.id}/ledger`).expect(200)).body;assert.equal(initial.balance.due,1000);
 const body={invoiceId:invoice.id,method:'lightning',adapterId:'fictional-live',amount:300},key=randomUUID();
 const first=(await user.post('/api/receiving',body,key).expect(201)).body.request;assert.equal(first.amount,300);assert.deepEqual(f.amounts,[300]);
 f.paid.add(first.id);await user.post(`/api/receiving/${first.id}/check`).expect(200);
 const partial=(await user.agent.get(`/api/invoices/${invoice.id}/ledger`).expect(200)).body;assert.deepEqual([partial.balance.total,partial.balance.paid,partial.balance.due,partial.balance.state],[1000,300,700,'partially_paid']);assert.equal(partial.invoice.status,'open');
 assert.equal((await user.agent.get('/api/dashboard')).body.totals.receivedCad,300);
 assert.deepEqual((await user.agent.get('/api/evidence/export')).body.payments.map((payment:any)=>payment.amount),[300]);
 assert.equal((await user.post('/api/receiving',body,key).expect(201)).body.request.id,first.id);await user.post('/api/receiving',{...body,amount:301},key).expect(409);
 const checkout=(await request(f.app).get(`/api/checkout/${invoice.token}`).expect(200)).body;assert.equal(checkout.invoice.balance.due,700);
 const second=(await request(f.app).post(`/api/checkout/${invoice.token}/receiving`).set('Idempotency-Key',randomUUID()).send({method:'lightning',adapterId:'fictional-live'}).expect(201)).body.request;assert.equal(second.amount,700);
 f.paid.add(second.id);await user.post(`/api/receiving/${second.id}/check`).expect(200);await user.post(`/api/receiving/${first.id}/check`).expect(200);
 const final=(await user.agent.get(`/api/invoices/${invoice.id}/ledger`).expect(200)).body;assert.deepEqual([final.balance.paid,final.balance.due,final.balance.state,final.invoice.total],[1000,0,'paid',1000]);assert.equal(final.entries.length,2);
 assert.equal(new Set(final.entries.map((e:any)=>e.receiptToken)).size,2);for(const entry of final.entries){assert.equal((await request(f.app).get(`/api/receipts/${entry.receiptToken}`).expect(200)).body.receipt.amount,entry.amount);}
 assert.deepEqual((await user.agent.get('/api/evidence/export')).body.payments.map((payment:any)=>payment.amount),[300,700]);
 assert.deepEqual(f.amounts,[300,700]);assert.equal((await user.agent.get('/api/dashboard')).body.totals.availableCad,0);
 }finally{f.app.locals.close();}
});

test('void checkout cannot create a manual payment report',async()=>{
 const app=createApp({dbPath:':memory:',ownerToken});try{const user=await owner(app),invoice=(await user.post('/api/invoices',{...invoiceInput,acceptedMethods:['interac']}).expect(201)).body;
 await user.post(`/api/invoices/${invoice.id}/void`,{reason:'Fictional cancelled manual invoice'}).expect(200);
 await request(app).post(`/api/checkout/${invoice.token}/pay`).set('Idempotency-Key',randomUUID()).send({method:'interac'}).expect(409);assert.equal((await user.agent.get('/api/payment-reports')).body.reports.length,0);
 }finally{app.locals.close();}
});

test('credits reduce due without becoming payments and invalid requests allocate nothing',async()=>{
 const f=fixture();try{const user=await owner(f.app),invoice=(await user.post('/api/invoices',invoiceInput).expect(201)).body,path=`/api/invoices/${invoice.id}/credits`,key=randomUUID(),body={amount:250,reason:'Fictional scope correction'};
 const credit=(await user.post(path,body,key).expect(200)).body;assert.deepEqual([credit.balance.paid,credit.balance.credited,credit.balance.due,credit.invoice.status],[0,250,750,'open']);assert.equal(credit.entries[0].receiptToken,undefined);
 assert.deepEqual((await user.post(path,body,key).expect(200)).body,credit);await user.post(path,{...body,amount:251},key).expect(409);
 for(const amount of [0,-1,1.5,751])await user.post('/api/receiving',{invoiceId:invoice.id,method:'lightning',adapterId:'fictional-live',amount}).expect(amount===751?409:400);
 await user.post(path,{amount:751,reason:'Too much'}).expect(409);assert.equal(f.creates,0);
 const full=(await user.post(path,{amount:750,reason:'Fictional cancellation'}).expect(200)).body;assert.deepEqual([full.balance.state,full.balance.due,full.invoice.status],['credited',0,'open']);await user.post('/api/receiving',{invoiceId:invoice.id,method:'lightning',adapterId:'fictional-live'}).expect(409);assert.equal(f.creates,0);
 const publicView=(await request(f.app).get(`/api/checkout/${invoice.token}`).expect(200)).body;assert.equal(publicView.invoice.balance.state,'credited');assert(!JSON.stringify(publicView).includes('Fictional scope correction'));
 }finally{f.app.locals.close();}
});

test('void is unpaid only and blocks live and simulated checkout without a receipt',async()=>{
 const app=createApp({dbPath:':memory:',ownerToken});try{const user=await owner(app),invoice=(await user.post('/api/invoices',invoiceInput).expect(201)).body,path=`/api/invoices/${invoice.id}/void`,key=randomUUID(),body={reason:'Fictional invoice issued in error'};
 const result=(await user.post(path,body,key).expect(200)).body;assert.equal(result.balance.state,'void');assert.equal(result.invoice.status,'open');assert.equal(result.balance.due,0);assert.equal(result.entries[0].receiptToken,undefined);assert.deepEqual((await user.post(path,body,key).expect(200)).body,result);
 await request(app).post(`/api/checkout/${invoice.token}/pay`).set('Idempotency-Key',randomUUID()).send({method:'cashu'}).expect(409);assert.equal((await user.agent.get('/api/evidence/export')).body.payments.length,0);
 const demo=request.agent(app),login=await demo.post('/api/session/demo').send({});await demo.get(`/api/invoices/${invoice.id}/ledger`).expect(403);await demo.post(path).set('X-CSRF-Token',login.body.csrfToken).set('Idempotency-Key',randomUUID()).send(body).expect(403);
 }finally{app.locals.close();}
});

test('already allocated outstanding quotes retain actual overpayment value once',async()=>{
 const f=fixture();try{const user=await owner(f.app),invoice=(await user.post('/api/invoices',invoiceInput).expect(201)).body;
 const requests=[];for(let i=0;i<2;i++)requests.push((await user.post('/api/receiving',{invoiceId:invoice.id,method:'lightning',adapterId:'fictional-live',amount:700}).expect(201)).body.request);
 for(const record of requests){f.paid.add(record.id);await user.post(`/api/receiving/${record.id}/check`).expect(200);}
 const view=(await user.agent.get(`/api/invoices/${invoice.id}/ledger`).expect(200)).body;assert.deepEqual([view.balance.paid,view.balance.overpaid,view.balance.due,view.entries.length],[1400,400,0,2]);assert.equal(view.invoice.total,1000);await user.post(`/api/invoices/${invoice.id}/void`,{reason:'Cannot erase payment'}).expect(409);
 }finally{f.app.locals.close();}
});

test('real ledger routes retain CSRF, idempotency and distinct API financial scopes',async()=>{
 const reader='fictional-invoice-reader-token-at-least-32',writer='fictional-invoice-writer-token-at-least-32',exporter='fictional-record-export-token-at-least-32';
 const app=createApp({dbPath:':memory:',ownerToken,apiKeys:[{token:reader,scopes:['invoices:read']},{token:writer,scopes:['invoices:write']},{token:exporter,scopes:['records:read']}]});try{
  const user=await owner(app),invoice=(await user.post('/api/invoices',invoiceInput).expect(201)).body,path=`/api/invoices/${invoice.id}/credits`;
  await request(app).get(`/api/invoices/${invoice.id}/ledger`).expect(401);
  await user.agent.post(path).set('Idempotency-Key',randomUUID()).send({amount:100,reason:'Fictional missing CSRF'}).expect(403);
  await user.post(path,{amount:100,reason:'Fictional missing retry key'},'').expect(400);
  await request(app).get(`/api/v1/invoices/${invoice.id}/ledger`).set('Authorization','Bearer '+reader).expect(200);
  await request(app).post('/api/v1'+path.slice(4)).set('Authorization','Bearer '+reader).set('Idempotency-Key',randomUUID()).send({amount:100,reason:'Fictional unauthorized mutation'}).expect(403);
  await request(app).post('/api/v1'+path.slice(4)).set('Authorization','Bearer '+writer).set('Idempotency-Key',randomUUID()).send({amount:100,reason:'Fictional API correction'}).expect(200);
  await request(app).get('/api/v1/invoice-ledger/export.csv').set('Authorization','Bearer '+reader).expect(403);
  const csv=await request(app).get('/api/v1/invoice-ledger/export.csv').set('Authorization','Bearer '+exporter).expect(200);assert.match(csv.headers['content-type'],/text\/csv/);assert.match(csv.headers['content-disposition'],/attachment/);assert.match(csv.text,/"Credited"/);assert(!csv.text.includes(invoice.token));
  const demo=request.agent(app);await demo.post('/api/session/demo').send({});await demo.get('/api/invoice-ledger/export.csv').expect(403);assert.equal((await user.agent.get(`/api/invoices/${invoice.id}/ledger`)).body.entries.length,1);
 }finally{app.locals.close();}
});


test('invoice-filtered receiving lists include older requests and remain tenant scoped',async()=>{
 const f=fixture();try{const user=await owner(f.app),invoice=(await user.post('/api/invoices',invoiceInput).expect(201)).body;
 const own=(await user.post('/api/receiving',{invoiceId:invoice.id,method:'lightning',adapterId:'fictional-live',amount:300}).expect(201)).body.request;
 const other=(await user.post('/api/invoices',invoiceInput).expect(201)).body;
 for(let i=0;i<26;i++)await user.post('/api/receiving',{invoiceId:other.id,method:'lightning',adapterId:'fictional-live',amount:1}).expect(201);
 const page=(await user.agent.get('/api/receiving').query({invoiceId:invoice.id,limit:100}).expect(200)).body;assert.deepEqual(page.requests.map((row:any)=>row.id),[own.id]);assert.equal(page.nextCursor,null);
 const demo=request.agent(f.app);await demo.post('/api/session/demo').send({});await demo.get('/api/receiving').query({invoiceId:invoice.id}).expect(403);
 await user.agent.get('/api/receiving').query({invoiceId:'not-an-invoice'}).expect(400);
 }finally{f.app.locals.close();}
});


test('uncertain provider retries return a structured conflict without allocating a replacement',async()=>{
 let creates=0;const app=createApp({dbPath:':memory:',ownerToken,receivingAdapters:[{id:'fictional-uncertain',mode:'live',methods:['lightning'],create:async()=>{creates++;throw new Error('Fictional timeout');},check:async()=>({status:'pending'})}],receivingQuote:async invoice=>({expectedAtomic:String(invoice.total),cadEquivalent:invoice.total,source:'fictional quote',observedAt:new Date().toISOString()})});
 try{const user=await owner(app),invoice=(await user.post('/api/invoices',invoiceInput).expect(201)).body,body={invoiceId:invoice.id,method:'lightning',adapterId:'fictional-uncertain',amount:300},key=randomUUID();
  assert.equal((await user.post('/api/receiving',body,key).expect(502)).body.code,'RECEIVING_UNCERTAIN');
  assert.equal((await user.post('/api/receiving',body,key).expect(409)).body.code,'RECEIVING_UNCERTAIN');assert.equal(creates,1);
 }finally{app.locals.close();}
});
