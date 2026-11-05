import test from 'node:test';import assert from 'node:assert/strict';import request from 'supertest';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes,randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';import {Store} from '../server/store.js';
const secret='synthetic-proxy-value-at-least32-bytes',key=Buffer.alloc(32,7),origin='http://localhost:4332';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'ql-hosted-isolation-')),dbPath=join(dir,'synthetic.sqlite');const app=createApp({dbPath,ownerToken:'synthetic-unused-owner-token',encryptionKey:key,hosted:{publicOrigin:origin,proxySecret:secret,allowInsecureLoopback:true}});
  const store=new Store(dbPath,{encryptionKey:key});
  const actor=()=>{const accountId=randomUUID(),workspace=randomUUID(),token=randomBytes(32).toString('base64url'),csrf=randomUUID();store.saveSession(token,{role:'owner',workspace,accountId,csrf,expires:new Date(Date.now()+3600000).toISOString()});const headers={'x-quiet-ledger-proxy':secret,Cookie:'ql_session='+token,'X-CSRF-Token':csrf,Origin:origin};return {accountId,workspace,get:(path:string)=>request(app).get(path).set(headers),post:(path:string,body:object={},id=randomUUID())=>request(app).post(path).set(headers).set('Idempotency-Key',id).send(body)};};
  return {app,actor,store,close(){store.close();app.locals.close();rmSync(dir,{recursive:true,force:true});}};
}
const invoiceInput={customerName:'Fictional tenant customer',title:'Fictional hosted service',currency:'CAD',items:[{description:'Synthetic service',quantity:1,unitAmount:125}],note:'FICTIONAL_PRIVATE_TENANT_NOTE'};
test('hosted mode requires encryption and fixed trusted transport and disables local owner/demo auth',async()=>{
  assert.throws(()=>createApp({dbPath:':memory:',ownerToken:'synthetic-unused-owner',hosted:{publicOrigin:'https://example.test',proxySecret:secret}}));
  const f=fixture();try{
    assert.equal((await request(f.app).get('/api/health')).status,403);
    for(const path of ['/api/session/owner','/api/session/demo'])assert.equal((await request(f.app).post(path).set('x-quiet-ledger-proxy',secret).send({token:'synthetic-unused-owner-token'})).status,404);
    const configured=await request(f.app).get('/api/auth/config').set('x-quiet-ledger-proxy',secret);assert.equal(configured.status,200);assert.deepEqual(configured.body.methods,['passkey','nostr']);
    const a=f.actor();assert.equal((await a.get('/api/scenario')).status,404);assert.equal((await a.get('/api/square-sandbox')).status,404);
    assert.equal((await a.get('/api/session')).body.authMode,'hosted');
  }finally{f.close();}
});
test('two hosted accounts isolate invoice receiving confirmation recovery and export',async()=>{
  const f=fixture();try{const a=f.actor(),b=f.actor();const created=await a.post('/api/invoices',invoiceInput);assert.equal(created.status,201);const invoice=created.body;
    assert.equal((await b.get(`/api/invoices/${invoice.id}`)).status,404);assert.equal((await b.get('/api/invoices')).body.invoices.length,0);
    const received=await a.post('/api/receiving',{invoiceId:invoice.id,method:'interac',adapterId:'owner-confirmed-manual'});assert.equal(received.status,201);const id=received.body.request.id;
    assert.equal((await b.get(`/api/receiving/${id}`)).status,404);assert.equal((await b.post(`/api/receiving/${id}/check`)).status,404);assert.equal((await b.post(`/api/receiving/${id}/recover`)).status,404);
    assert.equal((await b.post(`/api/receiving/${id}/confirm`,{note:'Fictional proof',transactionId:'synthetic-b-reference'})).status,404);
    assert.equal((await a.post(`/api/receiving/${id}/confirm`,{note:'Independently verified fictional bank receipt',transactionId:'synthetic-a-reference'})).status,200);
    assert.equal((await a.get(`/api/invoices/${invoice.id}`)).body.status,'paid');assert.ok(!JSON.stringify((await b.get('/api/evidence/export')).body).includes(invoice.id));
    assert.equal((await a.get('/api/collateral')).status,503);assert.equal((await a.get('/api/ark')).status,503);
  }finally{f.close();}
});
test('hosted payment pages omit private notes/proof identifiers and invoice links can be revoked',async()=>{
  const f=fixture();try{const a=f.actor(),b=f.actor(),invoice=(await a.post('/api/invoices',invoiceInput)).body;
    const page=await request(f.app).get(`/api/checkout/${invoice.token}`).set('x-quiet-ledger-proxy',secret);assert.equal(page.status,200);assert.ok(!JSON.stringify(page.body).includes(invoiceInput.note));
    assert.equal((await b.post(`/api/invoices/${invoice.id}/revoke-links`)).status,404);assert.equal((await a.post(`/api/invoices/${invoice.id}/revoke-links`)).status,200);
    assert.equal((await request(f.app).get(`/api/checkout/${invoice.token}`).set('x-quiet-ledger-proxy',secret)).status,404);assert.equal((await a.get(`/api/invoices/${invoice.id}`)).status,200);
  }finally{f.close();}
});
