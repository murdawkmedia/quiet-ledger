import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createApp} from '../server/app.js';
import {Store} from '../server/store.js';
import {manualReceiving} from '../server/receiving-config.js';
import {createLedgerMcpServer,LedgerApiClient} from '../server/mcp.js';
import type {ApiScope} from '../server/api-access.js';
import type {Currency} from '../shared/contracts.js';

// No existing runtime, provider, account or network is used by this bounded soak.
const origin='https://fictional-soak.example';
const proxy='fictional-api-soak-proxy-at-least32-bytes';
const encryptionKey=Buffer.alloc(32,83);
const start=Date.parse('2026-11-05T16:00:00.000Z');
const readScopes:ApiScope[]=['invoices:read','receiving:read'];
const fullScopes:ApiScope[]=[...readScopes,'invoices:write','receiving:write','payments:confirm','records:read'];
const input=(currency:Currency)=>({customerName:'Fictional soak client',title:'Synthetic API lifecycle',currency,items:[{description:'Fictional service',quantity:1,unitAmount:125}],acceptedMethods:['wire']});

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'ql-mvp-api-soak-'));
  const dbPath=join(directory,'fictional.sqlite');
  let clock=start;
  const calls={quotes:0,creates:0};
  const open=()=>createApp({dbPath,encryptionKey,now:()=>new Date(clock),hosted:{publicOrigin:origin,proxySecret:proxy,limits:{requestsPerMinute:10000}},receivingAdaptersForWorkspace:()=>[{...manualReceiving,async create(context){calls.creates++;return manualReceiving.create(context);}}],receivingQuote:async invoice=>{calls.quotes++;return {expectedAtomic:String(invoice.total),cadEquivalent:invoice.total,source:'Fictional API soak quote',observedAt:new Date(clock).toISOString()};}});
  let app=open();
  const store=new Store(dbPath,{encryptionKey});
  const publicHeaders={'x-quiet-ledger-proxy':proxy,Origin:origin};
  function actor(){
    const workspace=randomUUID(),accountId=randomUUID(),cookie=randomBytes(32).toString('base64url'),csrf=randomUUID();
    store.saveSession(cookie,{role:'owner',accountId,workspace,csrf,expires:new Date(start+7*86400000).toISOString()});
    const headers={...publicHeaders,Cookie:'ql_session='+cookie,'X-CSRF-Token':csrf};
    const get=(path:string)=>request(app).get(path).set(headers);
    const post=(path:string,body:object,retry?:string)=>{const call=request(app).post(path).set(headers);return (retry?call.set('Idempotency-Key',retry):call).send(body);};
    return {workspace,headers,get,post,remove:(path:string)=>request(app).delete(path).set(headers),async key(scopes:ApiScope[]=fullScopes){const result=await post('/api/account/api-keys',{label:'Fictional soak key',scopes,expiresInDays:1}).expect(201);return result.body.key as {id:string;token:string};}};
  }
  const get=(path:string,token:string,cookieHeaders:Record<string,string>={})=>request(app).get('/api/v1'+path).set({...publicHeaders,...cookieHeaders,Authorization:'Bearer '+token});
  const post=(path:string,body:object,token:string,retry:string=randomUUID(),cookieHeaders:Record<string,string>={})=>request(app).post('/api/v1'+path).set({...publicHeaders,...cookieHeaders,Authorization:'Bearer '+token,'Idempotency-Key':retry}).send(body);
  return {store,calls,actor,get,post,publicGet:(path:string)=>request(app).get(path).set(publicHeaders),publicPost:(path:string)=>request(app).post(path).set(publicHeaders).send({}),setClock:(value:number)=>{clock=value;},async reopen(){await app.locals.closeAsync();app=open();},async close(){await app.locals.closeAsync();store.close();rmSync(directory,{recursive:true,force:true});}};
}

test('API currency boundary: manual rails reject unsupported currencies before quotes, creation or persisted request identity',async t=>{
  const f=fixture();
  try{
    const actor=f.actor(),key=await actor.key();
    const counts=()=>({quotes:f.calls.quotes,creates:f.calls.creates,receiving:Number(f.store.db.prepare('SELECT COUNT(*) AS n FROM receiving_requests').get()!.n),idempotency:Number(f.store.db.prepare('SELECT COUNT(*) AS n FROM idempotency').get()!.n)});
    for(const [currency,method] of [['USD','interac'],['CAD','ach'],['USD','sepa']] as const)await t.test(currency+' '+method,async()=>{
      const invoice=(await f.post('/invoices',{...input(currency),acceptedMethods:[method]},key.token).expect(201)).body;
      const before=counts();
      const result=await f.post('/receiving',{invoiceId:invoice.id,method,adapterId:'owner-confirmed-manual'},key.token);
      const after=counts();
      assert.deepEqual({status:result.status,quoteDelta:after.quotes-before.quotes,createDelta:after.creates-before.creates,receivingDelta:after.receiving-before.receiving,idempotencyDelta:after.idempotency-before.idempotency},{status:409,quoteDelta:0,createDelta:0,receivingDelta:0,idempotencyDelta:0});
    });
    for(const [currency,method] of [['CAD','interac'],['USD','ach'],['EUR','sepa']] as const)await t.test(currency+' '+method+' supported',async()=>{
      const invoice=(await f.post('/invoices',{...input(currency),acceptedMethods:[method]},key.token).expect(201)).body;
      const before=counts();
      const result=await f.post('/receiving',{invoiceId:invoice.id,method,adapterId:'owner-confirmed-manual'},key.token).expect(201);
      assert.equal(result.body.request.status,'awaiting_payment');
      const after=counts();
      assert.deepEqual({quoteDelta:after.quotes-before.quotes,createDelta:after.creates-before.creates,receivingDelta:after.receiving-before.receiving,idempotencyDelta:after.idempotency-before.idempotency},{quoteDelta:1,createDelta:1,receivingDelta:1,idempotencyDelta:1});
    });
  }finally{await f.close();}
});

test('MCP preserves per-method currency eligibility in both adapter registries',async()=>{
  const f=fixture();
  const client=new Client({name:'fictional-currency-boundary-consumer',version:'1.0.0'});
  let server:ReturnType<typeof createLedgerMcpServer>|undefined;
  try{
    const actor=f.actor(),key=await actor.key();
    server=createLedgerMcpServer(new LedgerApiClient({token:key.token,fetcher:async url=>{
      const destination=new URL(String(url));
      const result=await f.get(destination.pathname.replace('/api/v1','')+destination.search,key.token);
      return Response.json(result.body,{status:result.status});
    }}));
    const [left,right]=InMemoryTransport.createLinkedPair();
    await server.connect(right);await client.connect(left);
    for(const name of ['list_payment_methods','list_receive_requests']){
      const result=await client.callTool({name,arguments:{}});
      assert.notEqual(result.isError,true);
      const data=result.structuredContent as {adapters:{id:string;supportedCurrenciesByMethod?:Record<string,string[]>}[]};
      const adapter=data.adapters.find(row=>row.id==='owner-confirmed-manual');
      assert.ok(adapter);
      assert.deepEqual(adapter.supportedCurrenciesByMethod,{interac:['CAD'],ach:['USD'],sepa:['EUR']},name);
    }
  }finally{await client.close();await server?.close();await f.close();}
});

test('API soak: concurrent tenants retain separate retry identities through manual receiving, link revocation and encrypted reopen',async t=>{
  const f=fixture();
  try{
    const actors=Array.from({length:3},()=>f.actor());
    const keys=await Promise.all(actors.map(actor=>actor.key()));
    const currencies:Currency[]=['CAD','USD','KRW','EUR','GBP'];
    const owned=actors.map(()=>[] as string[]);
    for(const currency of currencies)await t.test(currency,async()=>{
      const retry='shared_fictional_'+currency;
      const created=await Promise.all(keys.map(key=>f.post('/invoices',input(currency),key.token,retry).expect(201)));
      assert.equal(new Set(created.map(result=>result.body.id)).size,actors.length);
      for(let index=0;index<actors.length;index++){
        const invoice=created[index].body,key=keys[index].token;
        owned[index].push(invoice.id);
        const retried=await Promise.all(Array.from({length:4},()=>f.post('/invoices',input(currency),key,retry).expect(201)));
        assert.equal(retried.every(result=>result.body.id===invoice.id),true);
        await f.get('/invoices/'+invoice.id,keys[(index+1)%keys.length].token).expect(404);
        const receiveInput={invoiceId:invoice.id,method:'wire',adapterId:'owner-confirmed-manual'};
        const received=await Promise.all(Array.from({length:3},()=>f.post('/receiving',receiveInput,key,retry).expect(201)));
        const receive=received[0].body.request;
        assert.equal(new Set(received.map(result=>result.body.request.id)).size,1);
        await f.publicGet('/api/receive/'+receive.token).expect(200);
        await f.post('/invoices/'+invoice.id+'/revoke-links',{},key).expect(200);
        await f.publicGet('/api/checkout/'+invoice.token).expect(404);
        await f.publicGet('/api/receive/'+receive.token).expect(404);
        await f.publicPost('/api/receive/'+receive.token+'/check').expect(404);
        const confirmation={note:'Independent fictional bank verification',transactionId:'fictional_'+currency};
        const confirmations=await Promise.all(Array.from({length:3},()=>f.post('/receiving/'+receive.id+'/confirm',confirmation,key,retry).expect(200)));
        assert.equal(confirmations.every(result=>result.body.request.status==='paid'),true);
        assert.equal((await f.get('/invoices/'+invoice.id,key).expect(200)).body.settlementMode,'live');
        await f.post('/receiving',receiveInput,key,retry).expect(201);
        const exported=(await f.get('/evidence/export',key).expect(200)).body;
        assert.equal(exported.invoices.find((row:{id:string})=>row.id===invoice.id).status,'paid');
        assert.equal(JSON.stringify(exported).includes(invoice.token),false);
      }
    });
    await f.reopen();
    for(let index=0;index<actors.length;index++){
      const listed=(await f.get('/invoices?limit=2',keys[index].token).expect(200)).body;
      const second=(await f.get('/invoices?limit=2&cursor='+listed.nextCursor,keys[index].token).expect(200)).body;
      const third=(await f.get('/invoices?limit=2&cursor='+second.nextCursor,keys[index].token).expect(200)).body;
      assert.deepEqual([...listed.invoices,...second.invoices,...third.invoices].map((row:{id:string})=>row.id),[...owned[index]].reverse());
      assert.equal(third.nextCursor,null);
      assert.equal((await f.get('/receiving?limit=100',keys[index].token).expect(200)).body.requests.length,currencies.length);
      const dashboard=(await actors[index].get('/api/dashboard').expect(200)).body;
      assert.equal(dashboard.totals.availableCad,0);
    }
    assert.equal(Number(f.store.db.prepare('SELECT COUNT(*) AS n FROM receipts').get()!.n),0);
    assert.equal(Number(f.store.db.prepare('SELECT COUNT(*) AS n FROM invoice_ledger_entries WHERE receiving_id IS NOT NULL').get()!.n),15);
  }finally{await f.close();}
});

test('API soak: revoked and expired bearers cannot fall back to a different valid browser cookie after restart',async()=>{
  const f=fixture();
  try{
    const a=f.actor(),b=f.actor(),aKey=await a.key(),readKey=await a.key(readScopes),bKey=await b.key();
    const invoice=(await f.post('/invoices',input('CAD'),aKey.token).expect(201)).body;
    await f.get('/invoices/'+invoice.id,aKey.token,b.headers).expect(200);
    await f.get('/invoices/'+invoice.id,bKey.token,a.headers).expect(404);
    await f.post('/invoices',input('CAD'),readKey.token,randomUUID(),a.headers).expect(403);
    const receive=(await f.post('/receiving',{invoiceId:invoice.id,method:'wire',adapterId:'owner-confirmed-manual'},aKey.token).expect(201)).body.request;
    await f.post('/receiving/'+receive.id+'/confirm',{note:'Fictional',transactionId:'fictional'},readKey.token,randomUUID(),a.headers).expect(403);
    await a.remove('/api/account/api-keys/'+aKey.id).expect(204);
    await f.reopen();
    await f.get('/invoices',aKey.token,b.headers).expect(401);
    await b.get('/api/invoices').expect(200);
    f.setClock(start+86400000-1);
    await f.get('/invoices',readKey.token).expect(200);
    f.setClock(start+86400000);
    await f.get('/invoices',readKey.token,a.headers).expect(401);
    await f.get('/invoices',bKey.token,b.headers).expect(401);
    assert.equal((await a.get('/api/invoices').expect(200)).body.invoices.length,1);
    assert.equal((await a.get('/api/invoices/'+invoice.id).expect(200)).body.status,'open');
  }finally{await f.close();}
});
