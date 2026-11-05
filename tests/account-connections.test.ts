import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {Store} from '../server/store.js';
import type {HttpFetch} from '../integrations/http.js';

const origin='https://fixture.example',proxy='synthetic-connection-proxy-value-at-least32',key=Buffer.alloc(32,29);
const bank={provider:'bank-instructions',label:'TEST bank',mode:'live',fields:{method:'interac',recipient:'TEST receiver',instructions:'FICTIONAL_BANK_DETAILS_PRIVATE_68421'}};
const invoice={customerName:'TEST connection customer',title:'TEST saved bank connection',currency:'CAD',items:[{description:'TEST service',quantity:1,unitAmount:125}],note:'PRIVATE_INTERNAL_NOTE_FOR_TEST_ONLY'};
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'ql-connection-fixture-')),dbPath=join(directory,'ledger.sqlite');
  let fail=false,calls=0;
  const fetcher:HttpFetch=async(url)=>{calls++;if(fail)throw new Error('DO_NOT_ECHO_CREDENTIAL_OR_PROVIDER_ERROR');assert.equal(url,'https://api.stripe.com/v1/account');return Response.json({id:'acct_FICTIONAL',country:'CA',charges_enabled:true});};
  const options={dbPath,encryptionKey:key,hosted:{publicOrigin:origin,proxySecret:proxy},connectionFetcher:fetcher,receivingQuote:async()=>({expectedAtomic:'125',cadEquivalent:125,source:'test fixture',observedAt:new Date().toISOString()})};
  let app=createApp(options),store=new Store(dbPath,{encryptionKey:key});
  function actor(){const accountId=randomUUID(),workspace=randomUUID(),token=randomBytes(32).toString('base64url'),csrf=randomUUID();store.saveSession(token,{role:'owner',accountId,workspace,csrf,expires:new Date(Date.now()+86400000).toISOString()});const headers={'x-quiet-ledger-proxy':proxy,Origin:origin,Cookie:'ql_session='+token,'X-CSRF-Token':csrf};return{workspace,headers,get:(path:string)=>request(app).get(path).set(headers),post:(path:string,body:object={},retry=randomUUID())=>request(app).post(path).set(headers).set('Idempotency-Key',retry).send(body),remove:(path:string)=>request(app).delete(path).set(headers)};}
  return {actor,get app(){return app;},get store(){return store;},dbPath,get calls(){return calls;},setFail(value:boolean){fail=value;},restart(){app.locals.close();store.close();app=createApp(options);store=new Store(dbPath,{encryptionKey:key});},close(){app.locals.close();store.close();rmSync(directory,{recursive:true,force:true});}};
}
test('saved bank connection survives restart and stays private to its account',async()=>{
 const f=fixture();try{const a=f.actor(),b=f.actor();const save=await a.post('/api/account/connections',bank);assert.equal(save.status,201);assert.equal(save.body.connection.status,'manual');assert.equal(save.body.connection.mode,'live');const id=save.body.connection.id;
 assert.ok(!JSON.stringify(save.body).includes(bank.fields.instructions));assert.equal((await b.get('/api/account/connections')).body.connections.length,0);
 assert.equal((await b.post(`/api/account/connections/${id}/check`)).status,404);assert.equal((await b.remove(`/api/account/connections/${id}`)).status,404);
 f.restart();const list=await a.get('/api/account/connections');assert.equal(list.status,200);assert.equal(list.body.connections[0].id,id);assert.ok(list.body.providers.some((p:any)=>p.id==='lightning-address'));
 const created=(await a.post('/api/invoices',invoice)).body;const received=await a.post('/api/receiving',{invoiceId:created.id,method:'interac',adapterId:id});assert.equal(received.status,201);assert.ok(JSON.stringify(received.body.request.intent).includes(bank.fields.instructions));
 const page=await request(f.app).get(`/api/checkout/${created.token}`).set('x-quiet-ledger-proxy',proxy);assert.equal(page.status,200);assert.ok(JSON.stringify(page.body).includes(id));assert.ok(!JSON.stringify(page.body).includes(invoice.note));
 assert.equal(page.body.adapters[0].id,id,'configured provider precedes the generic placeholder');assert.equal(page.body.adapters[0].label,'Bank / Interac / Wise instructions');assert.ok(!JSON.stringify(page.body).includes(bank.label),'private connection label stays off customer pages');
 const publicRequest=await request(f.app).get(`/api/receive/${received.body.request.token}`).set('x-quiet-ledger-proxy',proxy);assert.equal(publicRequest.status,200);assert.ok(JSON.stringify(publicRequest.body).includes(bank.fields.instructions));
 }finally{f.close();}
});
test('provider credentials and keyed retry bodies stay encrypted, with summary-only readback',async()=>{
 const f=fixture();try{const a=f.actor(),secret='sk_live_FICTIONAL_PRIVATE_PROVIDER_KEY_93652';const input={provider:'stripe',mode:'live',fields:{secretKey:secret,accountId:'acct_FICTIONAL',merchantCountry:'CA'}};const retry=randomUUID();const save=await a.post('/api/account/connections',input,retry);assert.equal(save.status,201);assert.equal(save.body.connection.status,'connected');
 assert.equal((await a.post('/api/account/connections',input,retry)).body.connection.id,save.body.connection.id);assert.equal(Number(f.store.db.prepare('SELECT COUNT(*) AS n FROM account_connections').get()!.n),1);
 assert.ok(!JSON.stringify((await a.get('/api/account/connections')).body).includes(secret));assert.ok(!JSON.stringify(save.body).includes(secret));
 for(const suffix of ['','-wal'])if(existsSync(f.dbPath+suffix))assert.ok(!readFileSync(f.dbPath+suffix).includes(Buffer.from(secret)));
 assert.ok(String(f.store.db.prepare('SELECT data FROM account_connections').get()!.data).startsWith('qlr:v1:'));
 assert.equal((await a.post('/api/account/connections',{...input,label:'different'},retry)).status,409);
 }finally{f.close();}
});
test('connection management rejects anonymous, bearer, CSRF and workspace-injection requests',async()=>{
 const f=fixture();try{const a=f.actor();assert.equal((await request(f.app).get('/api/account/connections').set('x-quiet-ledger-proxy',proxy)).status,401);
 assert.equal((await request(f.app).post('/api/account/connections').set({...a.headers,'X-CSRF-Token':'wrong','Idempotency-Key':randomUUID()}).send(bank)).status,403);
 const minted=await request(f.app).post('/api/account/api-keys').set(a.headers).send({scopes:['invoices:read','receiving:write']});assert.equal(minted.status,201);
 assert.equal((await request(f.app).get('/api/account/connections').set({...a.headers,Authorization:'Bearer '+minted.body.key.token})).status,403);
 assert.equal((await a.post('/api/account/connections',{...bank,workspace:'other'})).status,400);
 assert.equal((await a.post('/api/account/connections',{...bank,fields:{...bank.fields,fetcher:'https://attacker.example'}})).status,400);
 }finally{f.close();}
});
test('failed read-only verification saves no credentials and disconnect stops future adapter use',async()=>{
 const f=fixture();try{const a=f.actor();f.setFail(true);const failed=await a.post('/api/account/connections',{provider:'stripe',mode:'live',fields:{secretKey:'sk_live_FICTIONAL_PRIVATE_KEY_93652',accountId:'acct_FICTIONAL',merchantCountry:'CA'}});assert.equal(failed.status,502);assert.ok(!JSON.stringify(failed.body).includes('DO_NOT_ECHO'));assert.equal((await a.get('/api/account/connections')).body.connections.length,0);
 const retry=randomUUID(),saved=await a.post('/api/account/connections',bank,retry);assert.equal(saved.status,201);const id=saved.body.connection.id;const created=(await a.post('/api/invoices',invoice)).body;
 assert.equal((await a.remove(`/api/account/connections/${id}`)).status,200);assert.equal((await a.get('/api/account/connections')).body.connections.length,0);assert.equal((await a.post('/api/receiving',{invoiceId:created.id,method:'interac',adapterId:id})).status,503);
 assert.equal((await a.post('/api/account/connections',bank,retry)).status,409,'a saved retry cannot claim that disconnected credentials are active');
 assert.equal(Number(f.store.db.prepare('SELECT COUNT(*) AS n FROM account_connections').get()!.n),0);
 }finally{f.close();}
});
test('connection quota keeps prior retries available and never makes an outbound payment',async()=>{
 const f=fixture();try{const a=f.actor(),retry=randomUUID();assert.equal((await a.post('/api/account/connections',bank,retry)).status,201);
 for(let i=1;i<20;i++)assert.equal((await a.post('/api/account/connections',{...bank,label:'TEST bank '+i})).status,201);
 assert.equal((await a.post('/api/account/connections',{...bank,label:'over quota'})).status,429);assert.equal((await a.post('/api/account/connections',bank,retry)).status,201);assert.equal(f.calls,0);
 }finally{f.close();}
});
