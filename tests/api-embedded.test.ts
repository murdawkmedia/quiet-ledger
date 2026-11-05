import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createApp, type AppOptions} from '../server/app.js';
import {createLedgerMcpServer,LedgerApiClient} from '../server/mcp.js';
import type {ApiScope} from '../server/api-access.js';
import type {ReceivingAdapter} from '../shared/receiving.js';

const ownerToken='embedded-fixture-owner-token';
const readToken='embedded-synthetic-read-token-at-least-32';
const writeToken='embedded-synthetic-write-token-at-least-32';
const confirmToken='embedded-synthetic-confirm-token-at-least-32';
const readScopes:ApiScope[]=['invoices:read','receiving:read','collateral:read'];
const writeScopes:ApiScope[]=[...readScopes,'invoices:write','receiving:write'];
const invoiceInput={customerName:'Synthetic workshop',title:'Embedded API fixture',currency:'CAD',items:[{description:'Fictional service',quantity:1,unitAmount:1200}]};
const apiKeys=[{token:readToken,scopes:readScopes},{token:writeToken,scopes:writeScopes},{token:confirmToken,scopes:['payments:confirm'] as ApiScope[]}];
const syntheticQuote=async()=>({expectedAtomic:'1000',cadEquivalent:1200,source:'synthetic fixture; no live quote',observedAt:new Date().toISOString()});
function fixture(options:Partial<AppOptions>={}){return createApp({dbPath:':memory:',ownerToken,apiKeys,receivingQuote:syntheticQuote,...options});}
function get(app:ReturnType<typeof createApp>,path:string,token=readToken){return request(app).get(`/api/v1${path}`).set('Authorization',`Bearer ${token}`);}
function post(app:ReturnType<typeof createApp>,path:string,body:object,key:string=randomUUID(),token=writeToken){return request(app).post(`/api/v1${path}`).set('Authorization',`Bearer ${token}`).set('Idempotency-Key',key).send(body);}
const adapter:ReceivingAdapter={id:'synthetic-watch',mode:'live',methods:['bitcoin'],walletOptionIds:['bitcoin-core','watch-only'],
  create:async context=>({providerId:context.requestId,request:'bitcoin:synthetic-not-an-address',network:'mainnet',asset:'BTC',allocationKey:`fixture:${context.requestId}`,opaque:{providerSecret:'synthetic-opaque-private-marker'}}),
  check:async context=>({status:'paid',paymentId:`synthetic-payment:${context.requestId}`,amount:context.amount,currency:context.currency,reference:context.requestId}),
};

test('embedded API authenticates owner without creating a browser session and keeps cookie CSRF intact',async()=>{
  const app=fixture();
  try{
    const created=await post(app,'/invoices',invoiceInput).expect(201);
    assert.equal(created.headers['set-cookie'],undefined);
    assert.equal((await request(app).get('/api/session')).body.authenticated,false);
    await request(app).get('/api/invoices').expect(401);
    await request(app).post('/api/invoices').send(invoiceInput).expect(401);
    await post(app,'/invoices',invoiceInput,randomUUID(),readToken).expect(403);
    await post(app,'/invoices',invoiceInput,'').expect(400);
    const owner=request.agent(app);await owner.post('/api/session/owner').send({token:ownerToken}).expect(200);
    await owner.post('/api/invoices').set('Idempotency-Key',randomUUID()).send(invoiceInput).expect(403);
    await owner.get('/api/v1/invoices').expect(401);
    await owner.get('/api/invoices').set('Authorization','Bearer invalid-key-with-at-least-32-characters').expect(401);
    const listed=await get(app,'/invoices').expect(200);assert.deepEqual(listed.body.invoices.map((row:any)=>row.id),[created.body.id]);
  }finally{app.locals.close();}
});

test('embedded bearer routes cannot reach scenario sessions provider configuration payouts or public tokens',async()=>{
  const app=fixture({receivingAdapters:[adapter]});
  try{
    for(const resource of ['/scenario','/session','/integrations','/square-sandbox','/payouts','/config','/health','/receive/public-token','/checkout/public-token']){
      await get(app,resource,writeToken).expect(403);
      await request(app).get(`/api${resource}`).set('Authorization',`Bearer ${writeToken}`).expect(403);
    }
    await get(app,'/evidence/export',writeToken).expect(403);
    await post(app,'/receiving/unknown/confirm',{note:'Fixture',transactionId:'fixture-transfer'},randomUUID()).expect(403);
    await post(app,'/payment-reports/unknown/confirm',{},randomUUID()).expect(403);
    await get(app,'/collateral').expect(503);
    await get(app,'/ark').expect(503);
    assert.equal((await request(app).get('/api/session')).body.authenticated,false);
  }finally{app.locals.close();}
});

test('embedded bearer reads are scoped to owner even with demo cookies and never expose demo invoices',async()=>{
  const app=fixture();
  try{
    const invoice=(await post(app,'/invoices',invoiceInput).expect(201)).body;
    const demo=request.agent(app);await demo.post('/api/session/demo').send({}).expect(200);
    const demoInvoices=(await demo.get('/api/invoices').expect(200)).body.invoices;
    assert.ok(demoInvoices.length>0);
    assert.ok(!demoInvoices.some((row:any)=>row.id===invoice.id));
    const apiList=await demo.get('/api/v1/invoices').set('Authorization',`Bearer ${readToken}`).expect(200);
    assert.deepEqual(apiList.body.invoices.map((row:any)=>row.id),[invoice.id]);
    await get(app,`/invoices/${demoInvoices[0].id}`).expect(404);
    await demo.get(`/api/invoices/${invoice.id}`).expect(404);
  }finally{app.locals.close();}
});

test('embedded invoice paging is bounded canonical and stable when later records are inserted',async()=>{
  const app=fixture();
  try{
    const original:string[]=[];
    for(let index=0;index<28;index++)original.push((await post(app,'/invoices',{...invoiceInput,title:`Synthetic invoice ${index}`}).expect(201)).body.id);
    const first=(await get(app,'/invoices').expect(200)).body;assert.equal(first.invoices.length,25);assert.equal(typeof first.nextCursor,'string');
    const inserted=(await post(app,'/invoices',{...invoiceInput,title:'Newer synthetic invoice'}).expect(201)).body.id;
    const second=(await get(app,`/invoices?limit=25&cursor=${first.nextCursor}`).expect(200)).body;
    assert.equal(second.invoices.length,3);assert.equal(second.nextCursor,null);
    const combined=[...first.invoices,...second.invoices].map((row:any)=>row.id);
    assert.deepEqual(combined,[...original].reverse());assert.ok(!combined.includes(inserted));assert.equal(new Set(combined).size,28);
    await get(app,'/invoices?limit=101').expect(403);
    await get(app,'/invoices?limit=1&limit=2').expect(403);
    await get(app,'/invoices?cursor=not_a_numeric_cursor').expect(400);
    const one=(await get(app,'/invoices?limit=1').expect(200)).body;assert.equal(one.invoices.length,1);assert.ok(one.nextCursor);
  }finally{app.locals.close();}
});

test('embedded receiving API strips provider internals retains original request and isolates public permissions',async()=>{
  const app=fixture({receivingAdapters:[adapter]});
  try{
    const invoice=(await post(app,'/invoices',invoiceInput).expect(201)).body,key=randomUUID();
    const first=(await post(app,'/receiving',{invoiceId:invoice.id,method:'bitcoin',adapterId:adapter.id},key).expect(201)).body.request;
    const again=(await post(app,'/receiving',{invoiceId:invoice.id,method:'bitcoin',adapterId:adapter.id},key).expect(201)).body.request;
    assert.equal(first.id,again.id);
    const listed=(await get(app,'/receiving').expect(200)).body,read=(await get(app,`/receiving/${first.id}`).expect(200)).body;
    const publicRead=(await request(app).get(`/api/receive/${first.token}`).expect(200)).body;
    for(const result of [first,listed,read,publicRead]){
      const serialized=JSON.stringify(result);assert.equal(serialized.includes('synthetic-opaque-private-marker'),false);assert.equal(serialized.includes('idempotencyKey'),false);assert.equal(serialized.includes(key),false);assert.equal(serialized.includes('allocationKey'),false);
    }
    assert.equal(publicRead.request.invoiceId,undefined);
    await post(app,`/receiving/${first.id}/check`,{},randomUUID(),readToken).expect(403);
    const checked=(await post(app,`/receiving/${first.id}/check`,{}).expect(200)).body.request;
    assert.equal(checked.status,'paid');assert.equal(checked.receipt.mode,'live');
    assert.equal((await get(app,`/invoices/${invoice.id}`).expect(200)).body.settlementMode,'live');
    await post(app,'/receiving',{invoiceId:invoice.id,method:'bitcoin',adapterId:adapter.id},key).expect(201);
  }finally{app.locals.close();}
});

test('embedded receiving recovery uses retained provider identity and never needs caller retry-key disclosure',async()=>{
  let creates=0,recoveries=0,originalProviderKey='';
  const uncertain:ReceivingAdapter={...adapter,id:'uncertain-synthetic',create:async context=>{creates++;originalProviderKey=context.idempotencyKey;throw Object.assign(new Error('synthetic-private-upstream-error'),{code:'FIAT_CREATION_UNCERTAIN'});},recover:async context=>{recoveries++;assert.equal(context.idempotencyKey,originalProviderKey);return {providerId:context.requestId,network:'mainnet',asset:'BTC',allocationKey:`recovered:${context.requestId}`};}};
  const app=fixture({receivingAdapters:[uncertain]});
  try{
    const invoice=(await post(app,'/invoices',invoiceInput).expect(201)).body;
    const failed=await post(app,'/receiving',{invoiceId:invoice.id,method:'bitcoin',adapterId:uncertain.id}).expect(502);
    assert.equal(JSON.stringify(failed.body).includes('synthetic-private-upstream-error'),false);
    const pending=(await get(app,'/receiving').expect(200)).body.requests[0];assert.equal(pending.creationUncertain,true);
    await post(app,`/receiving/${pending.id}/recover`,{},randomUUID(),readToken).expect(403);
    const recovered=(await post(app,`/receiving/${pending.id}/recover`,{}).expect(200)).body.request;
    assert.equal(recovered.id,pending.id);assert.equal(recovered.status,'awaiting_payment');
    await post(app,`/receiving/${pending.id}/recover`,{}).expect(200);
    assert.equal(creates,1);assert.equal(recoveries,1);
    assert.equal(JSON.stringify(recovered).includes(originalProviderKey),false);
  }finally{app.locals.close();}
});

test('embedded receiving pagination retains original batch across concurrent inserts',async()=>{
  const app=fixture({receivingAdapters:[adapter]});
  try{
    const invoice=(await post(app,'/invoices',invoiceInput).expect(201)).body;
    const original:string[]=[];
    for(let index=0;index<4;index++)original.push((await post(app,'/receiving',{invoiceId:invoice.id,method:'bitcoin',adapterId:adapter.id}).expect(201)).body.request.id);
    const first=(await get(app,'/receiving?limit=2').expect(200)).body;assert.equal(first.requests.length,2);assert.equal(typeof first.nextCursor,'string');
    const inserted=(await post(app,'/receiving',{invoiceId:invoice.id,method:'bitcoin',adapterId:adapter.id}).expect(201)).body.request.id;
    const second=(await get(app,`/receiving?limit=2&cursor=${first.nextCursor}`).expect(200)).body;
    assert.equal(second.requests.length,2);assert.equal(second.nextCursor,null);
    const combined=[...first.requests,...second.requests].map((row:any)=>row.id);assert.deepEqual(combined,[...original].reverse());assert.ok(!combined.includes(inserted));
    await get(app,'/receiving?cursor=bad_cursor').expect(400);
  }finally{app.locals.close();}
});

test('MCP against the real HTTP app creates retries reads and verifies while excluding bearer tokens',async()=>{
  const app=fixture({receivingAdapters:[adapter]});
  const listener=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>listener.once('listening',resolve));
  const port=(listener.address() as AddressInfo).port;
  const server=createLedgerMcpServer(new LedgerApiClient({baseUrl:`http://127.0.0.1:${port}`,token:writeToken}));
  const client=new Client({name:'embedded-synthetic-consumer',version:'1.0.0'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);
  try{
    const created=await client.callTool({name:'create_invoice',arguments:{...invoiceInput,idempotencyKey:'embedded_mcp_invoice'}});assert.notEqual(created.isError,true);
    const invoice=(created.structuredContent as any).invoice;assert.equal(invoice.token,undefined);assert.equal(invoice.receiptToken,undefined);
    const retried=await client.callTool({name:'create_invoice',arguments:{...invoiceInput,idempotencyKey:'embedded_mcp_invoice'}});assert.equal((retried.structuredContent as any).invoice.id,invoice.id);
    const received=await client.callTool({name:'create_receive_request',arguments:{invoiceId:invoice.id,method:'bitcoin',adapterId:adapter.id,idempotencyKey:'embedded_mcp_receive'}});assert.notEqual(received.isError,true);
    const receive=(received.structuredContent as any).request;assert.equal(receive.token,undefined);assert.equal(receive.context,undefined);assert.equal(receive.intent.opaque,undefined);
    const checked=await client.callTool({name:'check_receive_request',arguments:{requestId:receive.id}});assert.notEqual(checked.isError,true);assert.equal((checked.structuredContent as any).request.receipt.mode,'live');
    const read=await client.callTool({name:'get_invoice',arguments:{invoiceId:invoice.id}});assert.equal((read.structuredContent as any).invoice.settlementMode,'live');assert.equal((read.structuredContent as any).invoice.receiptToken,undefined);
    for(const output of [created,retried,received,checked,read]){assert.equal(JSON.stringify(output).includes(writeToken),false);assert.equal(JSON.stringify(output).includes('synthetic-opaque-private-marker'),false);}
  }finally{await client.close();await server.close();await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));app.locals.close();}
});

test('MCP exposes the same complete wallet choices and requirements as the integrated app',async()=>{
  const app=fixture({receivingAdapters:[adapter]});
  const listener=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>listener.once('listening',resolve));
  const port=(listener.address() as AddressInfo).port;
  const server=createLedgerMcpServer(new LedgerApiClient({baseUrl:`http://127.0.0.1:${port}`,token:readToken}));
  const client=new Client({name:'embedded-wallet-consumer',version:'1.0.0'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);
  try{
    const api=(await get(app,'/payment-methods').expect(200)).body;
    const listed=await client.callTool({name:'list_payment_methods',arguments:{}});assert.notEqual(listed.isError,true);
    const result=listed.structuredContent as any;assert.ok(Array.isArray(result.walletOptions),'MCP drops all wallet options returned by the app');
    assert.deepEqual(result.walletOptions,api.walletOptions);
    assert.deepEqual(result.adapters[0].walletOptionIds,api.adapters[0].walletOptionIds);
  }finally{await client.close();await server.close();await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));app.locals.close();}
});
