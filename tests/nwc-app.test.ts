import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {Store} from '../server/store.js';
import {fictionalNwcWallet} from './fixtures/nwc-wallet.js';

const origin='https://nwc-fixture.example',proxy='fictional-nwc-proxy-with-at-least32characters';
function fixture(){
 const wallet=fictionalNwcWallet(),directory=mkdtempSync(join(tmpdir(),'ql-nwc-account-')),dbPath=join(directory,'ledger.sqlite');
 const encryptionKey=Buffer.alloc(32,49);
 const options={dbPath,encryptionKey,hosted:{publicOrigin:origin,proxySecret:proxy},nwcTransport:wallet.transport,receivingQuote:async()=>({expectedAtomic:'2100',source:'fictional exact quote',observedAt:new Date().toISOString()})};
 let app=createApp(options),store=new Store(dbPath,{encryptionKey});
 function actor(){
  const workspace=randomUUID(),token=randomBytes(32).toString('base64url'),csrf=randomUUID();
  store.saveSession(token,{role:'owner',accountId:randomUUID(),workspace,csrf,expires:new Date(Date.now()+3600000).toISOString()});
  const headers={'x-quiet-ledger-proxy':proxy,Origin:origin,Cookie:'ql_session='+token,'X-CSRF-Token':csrf};
  return {workspace,headers,get:(p:string)=>request(app).get(p).set(headers),post:(p:string,body:object={},key=randomUUID())=>request(app).post(p).set(headers).set('Idempotency-Key',key).send(body)};
 }
 return {wallet,dbPath,actor,get app(){return app;},get store(){return store;},async restart(){await app.locals.closeAsync();store.close();app=createApp(options);store=new Store(dbPath,{encryptionKey});},async close(){await app.locals.closeAsync();store.close();rmSync(directory,{recursive:true,force:true});}};
}
const input=(wallet:ReturnType<typeof fictionalNwcWallet>,label='Minibits')=>({provider:'nwc',mode:'live',fields:{walletLabel:label,connectionUri:wallet.uri}});
const invoiceInput=(currency:string)=>({customerName:'Fictional NWC client',title:'Fictional service',currency,items:[{description:'Fictional recording',quantity:1,unitAmount:currency==='SAT'?2100:1500}],taxBps:0});

test('encrypted NWC connection survives restart and settles one original Lightning receipt through actual checkout',async()=>{
 const f=fixture();try{
  const owner=f.actor(),stranger=f.actor(),saved=await owner.post('/api/account/connections',input(f.wallet));assert.equal(saved.status,201);
  const adapterId=saved.body.connection.id;assert.deepEqual(f.wallet.calls,['get_info']);
  assert.equal((await stranger.get('/api/account/connections')).body.connections.length,0);
  assert.equal((await stranger.post(`/api/account/connections/${adapterId}/check`)).status,404);
  for(const suffix of ['','-wal'])if(existsSync(f.dbPath+suffix))assert.ok(!readFileSync(f.dbPath+suffix).includes(Buffer.from(f.wallet.uri)));
  await f.restart();assert.equal((await owner.get('/api/account/connections')).body.connections[0].id,adapterId);
  const issued=await owner.post('/api/invoices',invoiceInput('SAT'));assert.equal(issued.status,201);
  const publicPost=(path:string,body:object,key=randomUUID())=>request(f.app).post(path).set({'x-quiet-ledger-proxy':proxy,Origin:origin,'Idempotency-Key':key}).send(body);
  const retry=randomUUID(),endpoint=`/api/checkout/${issued.body.token}/receiving`;
  const received=await publicPost(endpoint,{method:'lightning',adapterId,amount:2100},retry);assert.equal(received.status,201);
  assert.equal((await publicPost(endpoint,{method:'lightning',adapterId,amount:2100},retry)).body.request.id,received.body.request.id);
  assert.equal(f.wallet.calls.filter(x=>x==='make_invoice').length,1);
  assert.ok(!JSON.stringify(received.body).includes(f.wallet.clientSecret));
  const check=`/api/receive/${received.body.request.token}/check`;
  assert.equal((await publicPost(check,{})).body.request.status,'awaiting_payment');
  await f.restart();f.wallet.setPaid(true);
  await f.app.locals.detectPayments();await f.app.locals.detectPayments();
  const paid=await owner.get('/api/receiving/'+received.body.request.id);assert.equal(paid.status,200);assert.equal(paid.body.request.status,'paid');
  assert.equal(paid.body.request.receipt.method,'lightning');assert.equal(paid.body.request.receipt.mode,'live');assert.equal(paid.body.request.receipt.amount,2100);
  assert.equal((await publicPost(check,{})).body.request.id,received.body.request.id);
  assert.equal(Number(f.store.db.prepare('SELECT COUNT(*) AS n FROM invoice_ledger_entries').get()!.n),1);
  assert.ok(!f.wallet.calls.some(x=>['pay_invoice','get_balance','list_transactions','sign_message'].includes(x)));
 }finally{await f.close();}
});

test('fiat invoice keeps its issued currency while wallet receives its exact quoted sats',async()=>{
 const f=fixture();try{
  const owner=f.actor(),saved=await owner.post('/api/account/connections',input(f.wallet,'Zeus'));assert.equal(saved.status,201);
  const issued=await owner.post('/api/invoices',invoiceInput('CAD'));assert.equal(issued.status,201);
  const received=await owner.post('/api/receiving',{invoiceId:issued.body.id,method:'lightning',adapterId:saved.body.connection.id});assert.equal(received.status,201);
  assert.equal(received.body.request.expectedAtomic,'2100');assert.equal([...f.wallet.records.values()][0].amount,2100000);
  f.wallet.setPaid(true);const paid=await owner.post(`/api/receiving/${received.body.request.id}/check`,{});assert.equal(paid.status,200);
  assert.equal(paid.body.request.receipt.currency,'CAD');assert.equal(paid.body.request.receipt.amount,1500);assert.equal(paid.body.request.receipt.method,'lightning');
 }finally{await f.close();}
});

test('lost invoice response stays uncertain across restart without creating a second wallet invoice',async()=>{
 const f=fixture();try{
  const owner=f.actor(),saved=await owner.post('/api/account/connections',input(f.wallet));assert.equal(saved.status,201);
  const issued=await owner.post('/api/invoices',invoiceInput('SAT'));assert.equal(issued.status,201);
  f.wallet.setLoseCreate(true);const body={invoiceId:issued.body.id,method:'lightning',adapterId:saved.body.connection.id},key=randomUUID();
  const lost=await owner.post('/api/receiving',body,key);assert.ok([409,502].includes(lost.status));
  await f.restart();f.wallet.setLoseCreate(false);
  const retry=await owner.post('/api/receiving',body,key);assert.equal(retry.status,409);
  assert.equal(f.wallet.calls.filter(x=>x==='make_invoice').length,1);assert.equal(f.wallet.records.size,1);
  assert.equal(Number(f.store.db.prepare('SELECT COUNT(*) AS n FROM invoice_ledger_entries').get()!.n),0);
 }finally{await f.close();}
});
