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

const origin='https://review.example',proxy='fictional-review-proxy-value-at-least32',key=Buffer.alloc(32,47);
const invoice={customerName:'TEST security review',title:'TEST ONLY no funds',currency:'CAD',items:[{description:'Fictional service',quantity:1,unitAmount:125}]};
const staticCrypto={provider:'static-crypto',mode:'live',fields:{method:'usdc',address:'0x'+'12'.repeat(20),network:'ethereum-mainnet'}};
const stripe={provider:'stripe',mode:'live',fields:{secretKey:'sk_live_FICTIONAL_REVIEW_PRIVATE_KEY',accountId:'acct_FICTIONAL',merchantCountry:'CA'}};
function fixture(fetcher:HttpFetch=async()=>{throw new Error('Unexpected external request');}){
  const directory=mkdtempSync(join(tmpdir(),'ql-connections-security-')),dbPath=join(directory,'review.sqlite');
  const app=createApp({dbPath,encryptionKey:key,hosted:{publicOrigin:origin,proxySecret:proxy,limits:{requestsPerMinute:1000}},connectionFetcher:fetcher,receivingQuote:async()=>({expectedAtomic:'1250000',cadEquivalent:125,source:'fictional review fixture',observedAt:new Date().toISOString()})});
  const store=new Store(dbPath,{encryptionKey:key});
  function actor(){
    const workspace=randomUUID(),token=randomBytes(32).toString('base64url'),csrf=randomUUID();
    store.saveSession(token,{role:'owner',accountId:workspace,workspace,csrf,expires:new Date(Date.now()+86400000).toISOString()});
    const headers={'x-quiet-ledger-proxy':proxy,Origin:origin,Cookie:'ql_session='+token,'X-CSRF-Token':csrf};
    return {workspace,headers,get:(path:string)=>request(app).get(path).set(headers),post:(path:string,body:object={},retry=randomUUID())=>request(app).post(path).set(headers).set('Idempotency-Key',retry).send(body),remove:(path:string)=>request(app).delete(path).set(headers)};
  }
  return {app,store,actor,close(){app.locals.close();store.close();rmSync(directory,{recursive:true,force:true});}};
}

test('an unrelated account cannot reserve another account’s static receiving destination',async()=>{
  const f=fixture();try{
    const attacker=f.actor(),merchant=f.actor();
    const attackerConnection=await attacker.post('/api/account/connections',staticCrypto),merchantConnection=await merchant.post('/api/account/connections',staticCrypto);
    assert.equal(attackerConnection.status,201);assert.equal(merchantConnection.status,201);
    const attackerInvoice=await attacker.post('/api/invoices',invoice),merchantInvoice=await merchant.post('/api/invoices',invoice);
    assert.equal(attackerInvoice.status,201);assert.equal(merchantInvoice.status,201);
    assert.equal((await attacker.post('/api/receiving',{invoiceId:attackerInvoice.body.id,method:'usdc',adapterId:attackerConnection.body.connection.id})).status,201);
    const legitimate=await merchant.post('/api/receiving',{invoiceId:merchantInvoice.body.id,method:'usdc',adapterId:merchantConnection.body.connection.id});
    assert.equal(legitimate.status,201,'allocation reuse protection must remain inside the owning workspace; an unrelated account cannot claim its public address');
  }finally{f.close();}
});

test('duplicate destinations inside one account remain unavailable across saved connection IDs',async()=>{
  const f=fixture();try{
    const merchant=f.actor(),one=await merchant.post('/api/account/connections',staticCrypto),two=await merchant.post('/api/account/connections',staticCrypto);
    const first=await merchant.post('/api/invoices',invoice),second=await merchant.post('/api/invoices',invoice);
    assert.equal((await merchant.post('/api/receiving',{invoiceId:first.body.id,method:'usdc',adapterId:one.body.connection.id})).status,201);
    assert.equal((await merchant.post('/api/receiving',{invoiceId:second.body.id,method:'usdc',adapterId:two.body.connection.id})).status,409);
  }finally{f.close();}
});

test('disconnect racing a provider recheck cannot restore saved credentials',async()=>{
  let enter:()=>void=()=>{},release:()=>void=()=>{},calls=0;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
  const f=fixture(async()=>{if(++calls>1){enter();await blocked;}return Response.json({id:'acct_FICTIONAL',country:'CA',charges_enabled:true});});
  try{
    const merchant=f.actor(),saved=await merchant.post('/api/account/connections',stripe);assert.equal(saved.status,201);
    const id=saved.body.connection.id,pending=merchant.post(`/api/account/connections/${id}/check`).then(value=>value);
    await entered;
    assert.equal((await merchant.remove(`/api/account/connections/${id}`)).status,200);
    release();assert.equal((await pending).status,404);
    assert.equal((await merchant.get('/api/account/connections')).body.connections.length,0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM account_connections').get()!.n,0);
  }finally{release();f.close();}
});

test('connection retries cannot cross workspaces and never export saved provider secrets',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return Response.json({id:'acct_FICTIONAL',country:'CA',charges_enabled:true});});
  try{
    const a=f.actor(),b=f.actor(),retry=randomUUID();
    const one=await a.post('/api/account/connections',stripe,retry),two=await b.post('/api/account/connections',stripe,retry);
    assert.equal(one.status,201);assert.equal(two.status,201);assert.notEqual(one.body.connection.id,two.body.connection.id);assert.equal(calls,2);
    assert.equal((await a.post('/api/account/connections',stripe,retry)).body.connection.id,one.body.connection.id);assert.equal(calls,2);
    for(const actor of [a,b]){
      const exported=await actor.get('/api/evidence/export');assert.equal(exported.status,200);
      assert.equal(JSON.stringify(exported.body).includes(stripe.fields.secretKey),false);
      assert.equal(JSON.stringify(exported.body).includes(stripe.fields.accountId),false);
    }
    assert.equal((await a.post(`/api/account/connections/${two.body.connection.id}/check`)).status,404);
    assert.equal((await b.remove(`/api/account/connections/${one.body.connection.id}`)).status,404);
  }finally{f.close();}
});
