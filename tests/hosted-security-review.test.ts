import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {Store} from '../server/store.js';

const key=Buffer.alloc(32,13),proxy='synthetic-independent-review-proxy-value',origin='http://localhost:4332';
const input={customerName:'Fictional review customer',title:'Synthetic quota review',currency:'CAD',items:[{description:'Synthetic service',quantity:1,unitAmount:125}]};
function fixture(limits:Record<string,number>){
  const directory=mkdtempSync(join(tmpdir(),'ql-security-review-')),path=join(directory,'synthetic.sqlite');
  const app=createApp({dbPath:path,encryptionKey:key,hosted:{publicOrigin:origin,proxySecret:proxy,allowInsecureLoopback:true,limits}} as any);
  const store=new Store(path,{encryptionKey:key}),workspace=randomUUID(),accountId=randomUUID(),value=randomBytes(32).toString('base64url'),csrf=randomUUID();
  store.saveSession(value,{role:'owner',accountId,workspace,csrf,expires:new Date(Date.now()+3600000).toISOString()});
  const headers={'x-quiet-ledger-proxy':proxy,'x-quiet-ledger-client-ip':'203.0.113.13',Origin:origin,Cookie:'ql_session='+value,'X-CSRF-Token':csrf};
  return {app,store,workspace,
    post:(path:string,body:object={},retry=randomUUID())=>request(app).post(path).set(headers).set('Idempotency-Key',retry).send(body),
    publicPost:(path:string,body:object={},retry=randomUUID())=>request(app).post(path).set({'x-quiet-ledger-proxy':proxy,'x-quiet-ledger-client-ip':'203.0.113.13',Origin:origin,'Idempotency-Key':retry}).send(body),
    close(){store.close();app.locals.close();rmSync(directory,{recursive:true,force:true});},
  };
}
test('security review: hosted account record quota stops new invoices and preserves existing retries',async()=>{
  const f=fixture({invoicesPerWorkspace:2});try{
    const retry=randomUUID();assert.equal((await f.post('/api/invoices',input,retry)).status,201);
    assert.equal((await f.post('/api/invoices',input)).status,201);
    assert.ok([409,429].includes((await f.post('/api/invoices',input)).status),'a tenant cannot grow invoice rows without a server-side quota');
    assert.equal((await f.post('/api/invoices',input,retry)).status,201,'quota cannot discard a valid saved retry');
    assert.equal(Number(f.store.db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE workspace=?').get(f.workspace)!.n),2);
  }finally{f.close();}
});
test('security review: holder of one checkout link cannot create unlimited receiving requests',async()=>{
  const f=fixture({receiveRequestsPerInvoice:2});try{
    const invoice=(await f.post('/api/invoices',input)).body;
    const path=`/api/checkout/${invoice.token}/receiving`,body={method:'interac',adapterId:'owner-confirmed-manual'},retry=randomUUID();
    assert.equal((await f.publicPost(path,body,retry)).status,201);assert.equal((await f.publicPost(path,body)).status,201);
    assert.ok([409,429].includes((await f.publicPost(path,body)).status),'a public invoice bearer cannot grow receiving rows indefinitely');
    assert.equal((await f.publicPost(path,body,retry)).status,201);
    assert.equal(Number(f.store.db.prepare('SELECT COUNT(*) AS n FROM receiving_requests WHERE invoice_id=?').get(invoice.id)!.n),2);
  }finally{f.close();}
});
test('security review: retained retry responses are bounded without deleting prior outcomes',async()=>{
  const f=fixture({invoicesPerWorkspace:20,idempotencyPerScope:2});try{
    const retry=randomUUID();assert.equal((await f.post('/api/invoices',input,retry)).status,201);assert.equal((await f.post('/api/invoices',input)).status,201);
    assert.ok([409,429].includes((await f.post('/api/invoices',input)).status),'saved retry responses need an account/scope bound');
    assert.equal((await f.post('/api/invoices',input,retry)).status,201);
    assert.equal(Number(f.store.db.prepare('SELECT COUNT(*) AS n FROM idempotency WHERE scope=?').get('invoice:'+f.workspace)!.n),2);
  }finally{f.close();}
});
test('security review: encrypted request fingerprints cannot be enumerated from an unkeyed private-body hash',()=>{
  const store=new Store(':memory:',{encryptionKey:key});try{
    store.idempotent('fictional-private-scope','fictional-key',{amount:125},201,()=>({accepted:true}));
    const fingerprint=String(store.db.prepare('SELECT fingerprint FROM idempotency').get()!.fingerprint);
    const publicGuess=createHash('sha256').update('{"amount":125}').digest('hex');
    assert.notEqual(fingerprint,publicGuess,'encrypted storage must blind the low-entropy request-body fingerprint');
  }finally{store.close();}
});
test('security review: independent accounts may confirm their separate banks using the same local reference',async()=>{
  const f=fixture({});try{
    const bToken=randomBytes(32).toString('base64url'),bCsrf=randomUUID(),bWorkspace=randomUUID();
    f.store.saveSession(bToken,{role:'owner',accountId:randomUUID(),workspace:bWorkspace,csrf:bCsrf,expires:new Date(Date.now()+3600000).toISOString()});
    const bPost=(path:string,body:object)=>request(f.app).post(path).set({'x-quiet-ledger-proxy':proxy,'x-quiet-ledger-client-ip':'203.0.113.14',Origin:origin,Cookie:'ql_session='+bToken,'X-CSRF-Token':bCsrf,'Idempotency-Key':randomUUID()}).send(body);
    const aInvoice=(await f.post('/api/invoices',input)).body,bInvoice=(await bPost('/api/invoices',input)).body;
    const aRequest=(await f.post('/api/receiving',{invoiceId:aInvoice.id,method:'interac',adapterId:'owner-confirmed-manual'})).body.request;
    const bRequest=(await bPost('/api/receiving',{invoiceId:bInvoice.id,method:'interac',adapterId:'owner-confirmed-manual'})).body.request;
    const review={note:'Independent fictional bank record for this account only',transactionId:'SYNTHETIC-BANK-LOCAL-REFERENCE-001'};
    assert.equal((await f.post(`/api/receiving/${aRequest.id}/confirm`,review)).status,200);
    assert.equal((await bPost(`/api/receiving/${bRequest.id}/confirm`,review)).status,200,'manual bank references are not a global cross-account payment identity');
  }finally{f.close();}
});
test('security review: the same account still cannot credit two invoices from one manual payment identity',async()=>{
  const f=fixture({});try{
    const first=(await f.post('/api/invoices',input)).body,second=(await f.post('/api/invoices',input)).body;
    const a=(await f.post('/api/receiving',{invoiceId:first.id,method:'interac',adapterId:'owner-confirmed-manual'})).body.request;
    const b=(await f.post('/api/receiving',{invoiceId:second.id,method:'interac',adapterId:'owner-confirmed-manual'})).body.request;
    const review={note:'Fictional independently verified receipt',transactionId:'SYNTHETIC-SAME-ACCOUNT-PAYMENT'};
    assert.equal((await f.post(`/api/receiving/${a.id}/confirm`,review)).status,200);
    assert.equal((await f.post(`/api/receiving/${b.id}/confirm`,review)).status,409);
    assert.equal(f.store.getInvoice(second.id,f.workspace)?.status,'open');
  }finally{f.close();}
});
