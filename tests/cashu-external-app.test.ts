import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {Store} from '../server/store.js';
import type {HttpFetch} from '../integrations/http.js';

// Hosted vertical slice for external-wallet Cashu receiving. Every value here
// is fictional: no wallet, mint, network or funded payment is ever contacted,
// and no funded acceptance is claimed or tested. The fetcher proves zero
// outbound transport across saving, checking, receiving and confirming.
const origin='https://fixture.example',proxy='synthetic-cashu-proxy-value-at-least32',key=Buffer.alloc(32,31);
const connection={provider:'cashu-external',label:'TEST external Cashu wallet',mode:'live',fields:{hosting:'Third-party wallet',walletLabel:'Minibits',mint:'https://mint.minibits.cash/Bitcoin',instructions:'FICTIONAL channel: send ecash inside the shared fictional Minibits group.'}};
const satInvoice={customerName:'TEST cashu customer',title:'TEST external Cashu SAT invoice',currency:'SAT',items:[{description:'TEST fictional service',quantity:1,unitAmount:21}],taxBps:0,note:'PRIVATE_INTERNAL_NOTE_FOR_TEST_ONLY'};
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'ql-cashu-external-')),dbPath=join(directory,'ledger.sqlite');
  let calls=0;
  const fetcher:HttpFetch=async()=>{calls++;throw new Error('FIXTURE: external Cashu wallet receiving must never use the network');};
  const options={dbPath,encryptionKey:key,hosted:{publicOrigin:origin,proxySecret:proxy},connectionFetcher:fetcher};
  let app=createApp(options),store=new Store(dbPath,{encryptionKey:key});
  function actor(){const accountId=randomUUID(),workspace=randomUUID(),token=randomBytes(32).toString('base64url'),csrf=randomUUID();store.saveSession(token,{role:'owner',accountId,workspace,csrf,expires:new Date(Date.now()+86400000).toISOString()});const headers={'x-quiet-ledger-proxy':proxy,Origin:origin,Cookie:'ql_session='+token,'X-CSRF-Token':csrf};return{workspace,headers,get:(path:string)=>request(app).get(path).set(headers),post:(path:string,body:object={},retry=randomUUID())=>request(app).post(path).set(headers).set('Idempotency-Key',retry).send(body)};}
  return {actor,get app(){return app;},get store(){return store;},get calls(){return calls;},restart(){app.locals.close();store.close();app=createApp(options);store=new Store(dbPath,{encryptionKey:key});},close(){app.locals.close();store.close();rmSync(directory,{recursive:true,force:true});}};
}

test('external Cashu wallet connection settles a SAT invoice through owner confirmation only',async()=>{
  const f=fixture();try{
  const a=f.actor(),b=f.actor();
  // Saving performs zero transport and never claims a connected or funded state.
  const saved=await a.post('/api/account/connections',connection);
  assert.equal(saved.status,201);assert.equal(saved.body.connection.status,'manual');assert.equal(saved.body.connection.mode,'live');
  const id=saved.body.connection.id;
  const checked=await a.post(`/api/account/connections/${id}/check`,{});
  assert.equal(checked.status,200);assert.equal(checked.body.connection.status,'manual','checking stays manual and never becomes connected');
  assert.match(checked.body.connection.detail,/no funded readiness is claimed/i);
  assert.ok(!/funded-ready|funded and ready|ready to be paid/i.test(JSON.stringify(checked.body)));
  assert.equal((await b.get('/api/account/connections')).body.connections.length,0,'the saved connection stays private to its account');
  // A 21-sat whole-satoshi SAT invoice with the cashu method available.
  const invoice=(await a.post('/api/invoices',satInvoice)).body;
  assert.equal(invoice.currency,'SAT');assert.equal(invoice.total,21);
  const checkout=await request(f.app).get(`/api/checkout/${invoice.token}`).set('x-quiet-ledger-proxy',proxy);
  assert.equal(checkout.status,200);
  assert.equal(checkout.body.adapters[0].id,id,'the saved external Cashu wallet is the configured receiving adapter');
  assert.equal(checkout.body.adapters[0].label,'Cashu external wallet');
  assert.ok(!JSON.stringify(checkout.body).includes(connection.label),'the private connection label stays off customer pages');
  assert.ok(!JSON.stringify(checkout.body).includes(satInvoice.note));
  // The payer starts receiving and gets the full manual instruction sheet.
  const payerKey=randomUUID();
  const received=await request(f.app).post(`/api/checkout/${invoice.token}/receiving`).set('x-quiet-ledger-proxy',proxy).set('Origin',origin).set('Idempotency-Key',payerKey).send({method:'cashu',adapterId:id});
  assert.equal(received.status,201);
  const record=received.body.request;
  assert.equal(record.method,'cashu');assert.equal(record.mode,'live');assert.equal(record.status,'awaiting_payment');
  assert.equal(record.amount,21);assert.equal(record.currency,'SAT');
  const sheet=JSON.stringify(record.intent.instructions);
  assert.ok(sheet.includes(connection.fields.mint));
  assert.ok(sheet.includes('Third-party wallet'));
  assert.ok(sheet.includes('Wallet hosting'));
  assert.ok(/21 sats net of fees/.test(sheet));
  assert.ok(sheet.includes(`cashu-external:${record.id}`),'unique invoice-bound payment reference');
  assert.ok(!sheet.includes(satInvoice.note));
  // The public receive page shows the same instructions with no private note.
  const publicRead=await request(f.app).get(`/api/receive/${record.token}`).set('x-quiet-ledger-proxy',proxy);
  assert.equal(publicRead.status,200);assert.ok(JSON.stringify(publicRead.body).includes(connection.fields.instructions));
  assert.ok(!JSON.stringify(publicRead.body).includes(satInvoice.note));
  // Owner check always stays unpaid: payer action never credits.
  const unpaid=await a.post(`/api/receiving/${record.id}/check`,{});
  assert.equal(unpaid.status,200);assert.equal(unpaid.body.request.status,'awaiting_payment');
  assert.match(unpaid.body.request.reviewReason,/owner review/i);
  const publicCheck=await request(f.app).post(`/api/receive/${record.token}/check`).set('x-quiet-ledger-proxy',proxy).set('Origin',origin).set('Idempotency-Key',randomUUID()).send({});
  assert.equal(publicCheck.status,200);assert.equal(publicCheck.body.request.status,'awaiting_payment');
  // Neither the wrong tenant nor a key without the confirm scope can confirm.
  const review={note:'FICTIONAL owner review: imported the ecash into my own wallet and verified it spendable there. No mint was contacted.',transactionId:'fictional-owner-wallet-reference-1'};
  assert.equal((await b.post(`/api/receiving/${record.id}/confirm`,review)).status,404);
  const noScopeKey=await request(f.app).post('/api/account/api-keys').set(a.headers).send({scopes:['receiving:read','receiving:write']});
  assert.equal(noScopeKey.status,201);
  assert.equal((await request(f.app).post(`/api/receiving/${record.id}/confirm`).set({...a.headers,Authorization:'Bearer '+noScopeKey.body.key.token}).set('Idempotency-Key',randomUUID()).send(review)).status,403,'a key without payments:confirm cannot confirm');
  const foreignKey=await request(f.app).post('/api/account/api-keys').set(b.headers).send({scopes:['payments:confirm']});
  assert.equal(foreignKey.status,201);
  assert.equal((await request(f.app).post(`/api/receiving/${record.id}/confirm`).set({...b.headers,Authorization:'Bearer '+foreignKey.body.key.token}).set('Idempotency-Key',randomUUID()).send(review)).status,404,'a confirm-scoped key from another workspace cannot confirm');
  // The owner's explicit manual confirmation settles exactly once.
  const confirmed=await a.post(`/api/receiving/${record.id}/confirm`,review);
  assert.equal(confirmed.status,200);assert.equal(confirmed.body.request.status,'paid');
  assert.equal(confirmed.body.request.receipt.method,'cashu');assert.equal(confirmed.body.request.receipt.mode,'live');
  // Receipt provenance: manual verification in an explicitly hosted external wallet.
  const savedInvoice=(await a.get(`/api/invoices/${invoice.id}`)).body;
  assert.equal(savedInvoice.status,'paid');assert.equal(savedInvoice.settlementMode,'live');assert.equal(savedInvoice.paymentMethod,'cashu');
  assert.equal(savedInvoice.nativePayment.asset,'BTC');assert.equal(savedInvoice.nativePayment.atomicAmount,'21');
  assert.equal(savedInvoice.nativePayment.network,'cashu-external (Third-party wallet)');
  assert.equal(savedInvoice.nativePayment.verification,'manual');
  const receipt=(await request(f.app).get(`/api/receipts/${savedInvoice.receiptToken}`).set('x-quiet-ledger-proxy',proxy)).body.receipt;
  assert.equal(receipt.method,'cashu');assert.equal(receipt.amount,21);assert.equal(receipt.currency,'SAT');assert.equal(receipt.mode,'live');
  assert.equal(receipt.nativePayment.network,'cashu-external (Third-party wallet)');assert.equal(receipt.nativePayment.verification,'manual');
  // Restart and idempotent retries never double-credit the single receipt.
  f.restart();
  const retryConfirm=await a.post(`/api/receiving/${record.id}/confirm`,{...review,transactionId:'fictional-owner-wallet-reference-1-again'});
  assert.equal(retryConfirm.status,200);assert.equal(retryConfirm.body.request.status,'paid');
  const retryReceive=await request(f.app).post(`/api/checkout/${invoice.token}/receiving`).set('x-quiet-ledger-proxy',proxy).set('Origin',origin).set('Idempotency-Key',payerKey).send({method:'cashu',adapterId:id});
  assert.equal(retryReceive.status,201);assert.equal(retryReceive.body.request.id,record.id,'the idempotent payer retry replays the same request');
  const after=(await a.get(`/api/invoices/${invoice.id}`)).body;
  assert.equal(after.status,'paid');assert.deepEqual([after.balance.paid,after.balance.due],[21,0]);
  const receiving=(await a.get('/api/receiving?invoiceId='+invoice.id)).body;
  assert.equal(receiving.requests.filter((row:{status:string})=>row.status==='paid').length,1,'exactly one paid receiving request');
  const dashboard=(await a.get('/api/dashboard')).body;
  assert.equal(dashboard.currencyBalances.find((row:{currency:string;mode:string})=>row.currency==='SAT'&&row.mode==='live').paid,21);
  assert.equal(dashboard.totals.receivedCad,0,'SAT receipts never fund CAD payouts');
  // The whole journey performed zero outbound transport.
  assert.equal(f.calls,0);
  }finally{f.close();}
});

test('partial installments settle prorated sats and one reference never credits twice',async()=>{
  const f=fixture();try{
  const a=f.actor();
  const saved=await a.post('/api/account/connections',{...connection,fields:{...connection.fields,hosting:'Self-hosted wallet (user-run)'}});
  assert.equal(saved.status,201);const id=saved.body.connection.id;
  const invoice=(await a.post('/api/invoices',satInvoice)).body;
  // A 10-sat installment binds its own unique reference on the same connection.
  const referenceOf=(row:{intent:{instructions:{label:string;value:string}[]}})=>row.intent.instructions.find(step=>step.label==='Payment reference')!.value;
  const first=await a.post('/api/receiving',{invoiceId:invoice.id,method:'cashu',adapterId:id,amount:10});
  assert.equal(first.status,201);assert.equal(first.body.request.amount,10);
  assert.equal(referenceOf(first.body.request),`cashu-external:${first.body.request.id}`);
  assert.equal(first.body.request.intent.network,'cashu-external (Self-hosted wallet (user-run))');
  const review={note:'FICTIONAL owner review: verified spendable ecash in my own self-hosted wallet. No mint was contacted.',transactionId:'fictional-owner-wallet-reference-partial'};
  const settled=await a.post(`/api/receiving/${first.body.request.id}/confirm`,review);
  assert.equal(settled.status,200);assert.equal(settled.body.request.status,'paid');
  // The remaining balance quotes the exact due remainder on a fresh reference.
  const second=await a.post('/api/receiving',{invoiceId:invoice.id,method:'cashu',adapterId:id});
  assert.equal(second.status,201);assert.equal(second.body.request.amount,11,'the remainder quotes the exact due balance');
  assert.notEqual(referenceOf(second.body.request),referenceOf(first.body.request));
  const partial=(await a.get(`/api/invoices/${invoice.id}`)).body;
  assert.equal(partial.status,'open');assert.deepEqual([partial.balance.paid,partial.balance.due],[10,11]);
  // The same owner reference cannot be confirmed against a second request.
  const duplicate=await a.post(`/api/receiving/${second.body.request.id}/confirm`,review);
  assert.equal(duplicate.status,409,'one received ecash transfer never credits two requests');
  const closed=await a.post(`/api/receiving/${second.body.request.id}/confirm`,{...review,transactionId:'fictional-owner-wallet-reference-remainder'});
  assert.equal(closed.status,200);assert.equal(closed.body.request.status,'paid');
  const done=(await a.get(`/api/invoices/${invoice.id}`)).body;
  assert.equal(done.status,'paid');assert.deepEqual([done.balance.paid,done.balance.due],[21,0]);
  assert.equal(f.calls,0);
  }finally{f.close();}
});

test('token-shaped saved fields and payer evidence are refused without transport',async()=>{
  const f=fixture();try{
  const a=f.actor();
  for(const bad of ['cashuAeyJ0aXRsZSI6ImZpeHR1cmUifQ','nsec1fictionalsecretvalue123456','-----BEGIN RSA PRIVATE KEY-----'])
    assert.equal((await a.post('/api/account/connections',{...connection,fields:{...connection.fields,instructions:bad}})).status,400,bad.slice(0,16));
  assert.equal((await a.post('/api/account/connections',{...connection,fields:{...connection.fields,hosting:'Automatic receiver'}})).status,400);
  assert.equal((await a.post('/api/account/connections',{...connection,fields:{...connection.fields,mint:'https://mint.attacker.example/Bitcoin'}})).status,400);
  assert.equal((await a.post('/api/account/connections',{...connection,fields:{...connection.fields,walletLabel:'Fake wallet'}})).status,400);
  assert.equal((await a.get('/api/account/connections')).body.connections.length,0,'nothing was saved');
  const saved=await a.post('/api/account/connections',connection);
  assert.equal(saved.status,201);const id=saved.body.connection.id;
  const invoice=(await a.post('/api/invoices',satInvoice)).body;
  const received=await a.post('/api/receiving',{invoiceId:invoice.id,method:'cashu',adapterId:id});
  assert.equal(received.status,201);const record=received.body.request;
  // A token-shaped payer claim never reaches the ledger; it fails closed.
  const tokenClaim=await a.post(`/api/receiving/${record.id}/check`,{transactionId:'cashuAeyJ0aXRsZSI6ImZpeHR1cmUifQ'});
  assert.equal(tokenClaim.status,502);assert.equal(tokenClaim.body.request,undefined);
  const stillOpen=(await a.get(`/api/invoices/${invoice.id}`)).body;
  assert.equal(stillOpen.status,'open');assert.equal(stillOpen.balance.paid,0);
  // Confirmation still requires an owner note and a unique reference.
  assert.equal((await a.post(`/api/receiving/${record.id}/confirm`,{note:'',transactionId:'x'})).status,400);
  assert.equal(f.calls,0);
  }finally{f.close();}
});

test('external Cashu confirmation refuses bearer secrets before any payment or retry record is saved',async()=>{
  const f=fixture();try{
    const a=f.actor();
    const saved=await a.post('/api/account/connections',connection);
    assert.equal(saved.status,201);
    const invoice=(await a.post('/api/invoices',satInvoice)).body;
    const received=await a.post('/api/receiving',{invoiceId:invoice.id,method:'cashu',adapterId:saved.body.connection.id});
    assert.equal(received.status,201);
    const path=`/api/receiving/${received.body.request.id}/confirm`;
    const before=f.store.db.prepare('SELECT count(*) AS n FROM idempotency').get();
    const secrets=['cashuAeyJmaWN0aW9uYWwiOnRydWV9','cashuBeyJmaWN0aW9uYWwiOnRydWV9','nsec1fictionalsecretvalue123456','a'.repeat(64)];
    for(const [index,secret] of secrets.entries())for(const field of ['note','transactionId']){
      const body={note:'FICTIONAL imported and spendable in my external wallet',transactionId:'fictional-safe-wallet-ref',[field]:`Do not store ${secret}`};
      const response=await a.post(path,body);
      assert.equal(response.status,400,`secret class ${index} in ${field} must be refused`);
      assert.ok(!JSON.stringify(response.body).includes(secret),'refusal must not echo the secret');
    }
    assert.deepEqual(f.store.db.prepare('SELECT count(*) AS n FROM idempotency').get(),before,'failed confirmation has no saved retry response');
    const unchanged=(await a.get(`/api/invoices/${invoice.id}`)).body;
    assert.equal(unchanged.balance.paid,0);
    assert.equal(unchanged.status,'open');
    assert.equal((await a.get('/api/receiving?invoiceId='+invoice.id)).body.requests[0].status,'awaiting_payment');
    assert.equal(f.calls,0);
  }finally{f.close();}
});

test('changing Cashu wallet hosting cannot allocate the same received transfer twice',async()=>{
  const f=fixture();try{
    const a=f.actor(),review={note:'FICTIONAL imported and spendable in my external wallet',transactionId:'fictional-one-received-cashu-transfer'};
    for(const [index,hosting] of ['Third-party wallet','Self-hosted wallet (user-run)'].entries()){
      const saved=await a.post('/api/account/connections',{...connection,label:'TEST wallet '+index,fields:{...connection.fields,hosting}});
      assert.equal(saved.status,201);
      const invoice=(await a.post('/api/invoices',satInvoice)).body;
      const received=await a.post('/api/receiving',{invoiceId:invoice.id,method:'cashu',adapterId:saved.body.connection.id});
      assert.equal(received.status,201);
      assert.equal((await a.post(`/api/receiving/${received.body.request.id}/confirm`,review)).status,index===0?200:409);
      assert.equal((await a.get(`/api/invoices/${invoice.id}`)).body.balance.paid,index===0?21:0);
    }
  }finally{f.close();}
});

test('external Cashu connection labels refuse bearer-shaped content too',async()=>{
  const f=fixture();try{
    const a=f.actor();
    assert.equal((await a.post('/api/account/connections',{...connection,label:'cashuAeyJmaWN0aW9uYWwiOnRydWV9'})).status,400);
    assert.equal((await a.get('/api/account/connections')).body.connections.length,0);
  }finally{f.close();}
});
