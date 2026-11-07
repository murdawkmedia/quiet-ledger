import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {mkdtempSync,writeFileSync,chmodSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createApiAccess,type ApiScope} from '../server/api-access.js';
import {createLedgerMcpServer,LedgerApiClient,loadMcpConfig} from '../server/mcp.js';

const token='fictional-api-key-with-at-least-32-characters';
const scopes:ApiScope[]=['invoices:read','invoices:write','receiving:read','receiving:write','collateral:read'];
function authApp(allowed:ApiScope[]=scopes){
  const app=express();app.use(createApiAccess({keys:[{token,scopes:allowed}]}));
  app.use((req,res)=>res.json({url:req.url,originalUrl:req.originalUrl,access:res.locals.apiAccess??null}));
  return app;
}

test('API version alias requires a bearer; legacy cookie auth remains available',async()=>{
  const app=authApp();
  await request(app).get('/api/v1/invoices').expect(401);
  await request(app).get('/api/v1/invoices').set('Authorization','Basic fictional').expect(401);
  const legacy=await request(app).get('/api/invoices').set('Authorization','Basic fictional').expect(200);
  assert.equal(legacy.body.access,null);
  assert.equal((await request(app).get('/api/invoices?browser_filter=open').set('Authorization','Basic fictional').expect(200)).body.access,null);
  const result=await request(app).get('/api/v1/invoices?limit=25').set('Authorization',`bEaReR ${token}`).expect(200);
  assert.equal(result.body.url,'/api/invoices?limit=25');
  assert.equal(result.body.originalUrl,'/api/v1/invoices?limit=25');
  assert.deepEqual(result.body.access,{keyId:'key-1',scopes,version:'v1'});
  assert.equal(JSON.stringify(result.body).includes(token),false);
  await request(app).get('/api/invoices').set('Authorization',`Bearer ${token}wrong`).expect(401);
});

test('API denies every non-allowlisted method/resource before normal owner routes',async()=>{
  const app=authApp([...scopes,'payments:confirm','records:read']);
  for(const path of ['scenario','session','config','credentials','payouts','wallet/send','rpc','invoices/a/receipt','receiving/a/pay','receiving-test/token']){
    for(const auth of [`Bearer ${token}`,'Basic fictional'])await request(app).get(`/api/v1/${path}`).set('Authorization',auth).expect(403);
  }
  await request(app).delete('/api/v1/invoices/a').set('Authorization',`Bearer ${token}`).expect(403);
  await request(app).head('/api/v1/invoices').set('Authorization',`Bearer ${token}`).expect(403);
  await request(app).post('/api/v1/collateral').set('Authorization',`Bearer ${token}`).expect(403);
  await request(app).get('/API/SCENARIO').set('Authorization',`Bearer ${token}`).expect(403);
  await request(app).get('/API/V1/invoices').set('Authorization',`Bearer ${token}`).expect(403);
  await request(app).get('/API/V1/invoices').expect(401);
});

test('API enforces individual scopes and explicit confirmation authority',async()=>{
  const app=authApp(['invoices:read']);
  await request(app).get('/api/v1/invoices/a').set('Authorization',`Bearer ${token}`).expect(200);
  for(const path of ['invoices','receiving','receiving/a/check','receiving/a/recover','receiving/a/confirm','payment-reports/a/confirm'])await request(app).post(`/api/v1/${path}`).set('Authorization',`Bearer ${token}`).expect(403);
  await request(app).get('/api/v1/receiving').set('Authorization',`Bearer ${token}`).expect(403);
  await request(authApp(['payments:confirm'])).post('/api/v1/receiving/a/confirm').set('Authorization',`Bearer ${token}`).expect(200);
  await request(authApp(['records:read'])).get('/api/v1/evidence/export').set('Authorization',`Bearer ${token}`).expect(200);
  await request(authApp(['receiving:write'])).post('/api/v1/receiving/a/recover').set('Authorization',`Bearer ${token}`).expect(200);
  await request(authApp(['receiving:write'])).get('/api/v1/receiving/a/recover').set('Authorization',`Bearer ${token}`).expect(403);
  await request(authApp(['receiving:write'])).post('/api/v1/receiving/a/recover/').set('Authorization',`Bearer ${token}`).expect(403);
});

test('API rejects ambiguous paths, query overrides and malformed credentials',async()=>{
  const app=authApp();
  for(const path of ['/api/v1/invoices/','/api/v1//invoices','/api/v1/invoices/%2e%2e','/api/v1/invoices/a%2fb','/api/v1/invoices/a%00','/api/v1/invoices?limit=101','/api/v1/invoices?limit=1&limit=2','/api/v1/invoices?_method=DELETE','/api/v1/invoices/a?cursor=x']){
    await request(app).get(path).set('Authorization',`Bearer ${token}`).expect(403);
  }
  await request(app).get('/api/v1/invoices').set('Authorization','Bearer').expect(401);
  await request(app).get('/api/v1/invoices').set('Authorization',`Bearer ${token} another`).expect(401);
  await request(authApp([])).get('/api/v1/invoices').set('Authorization',`Bearer ${token}`).expect(403);
  assert.throws(()=>createApiAccess({keys:[{token:'short',scopes}]}),/API key configuration/);
  const disabled=express();disabled.use(createApiAccess({keys:[]}));disabled.use((_req,res)=>res.sendStatus(200));
  await request(disabled).get('/api/v1/invoices').set('Authorization',`Bearer ${token}`).expect(401);
});

test('API key rotation preserves separate scopes and snapshots configuration',async()=>{
  const readScopes:ApiScope[]=['invoices:read'];const second=token+'-second';
  const app=express();app.use(createApiAccess({keys:[{token,scopes:readScopes},{token:second,scopes:['receiving:write']}]}));
  readScopes.push('payments:confirm');
  app.use((_req,res)=>res.json(res.locals.apiAccess));
  assert.equal((await request(app).post('/api/v1/receiving').set('Authorization',`Bearer ${second}`).expect(200)).body.keyId,'key-2');
  await request(app).get('/api/v1/invoices').set('Authorization',`Bearer ${second}`).expect(403);
  await request(app).post('/api/v1/receiving/a/confirm').set('Authorization',`Bearer ${token}`).expect(403);
  assert.throws(()=>createApiAccess({keys:[{token,scopes},{token,scopes}]}),/API key configuration/);
});

const invoice={id:'inv_1',number:'QL-0001',title:'Fictional service',customerName:'Example workshop',currency:'CAD',total:1200,status:'open',createdAt:'2026-11-04T00:00:00Z',token:'private-checkout-token',receiptToken:'private-receipt-token',items:[{description:'Work',quantity:1,unitAmount:1200}]};
const receive={id:'receive_1',invoiceId:'inv_1',invoiceNumber:'QL-0001',method:'bitcoin',adapterId:'watch',mode:'live',status:'awaiting_payment',amount:1200,currency:'CAD',createdAt:invoice.createdAt,expiresAt:'2026-11-05T00:00:00Z',token:'private-receive-token',intent:{providerId:'p_1',request:'bitcoin:fictional-address',network:'mainnet',asset:'BTC',opaque:{credential:'private-provider-internal'}}};
const fixture=(path:string)=>path==='/payment-methods'?{methods:[{id:'bitcoin',label:'Bitcoin',family:'bitcoin',settlement:'bitcoin'}],adapters:[{id:'watch',methods:['bitcoin'],mode:'live'}],defaultMode:'live'}:path==='/invoices'?{invoices:[invoice],nextCursor:'opaque_next'}:path.startsWith('/invoices/')?invoice:path==='/receiving'?{requests:[receive],adapters:[],nextCursor:null}:path.startsWith('/receiving/')?{request:receive}:path==='/collateral'?{collateral:{asset:'BTC',network:'mainnet',totalSats:1000,control:'unverified',unencumbered:'unknown',lenderAcceptance:'unknown'}}:{ark:[{network:'mainnet',kind:'virtual-vtxo-balance',spendableSats:500,onchainCollateral:false}]};
async function protocol(api:LedgerApiClient){
  const server=createLedgerMcpServer(api),client=new Client({name:'fixture-client',version:'1.0.0'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await client.connect(clientTransport);
  return {client,close:async()=>{await client.close();await server.close();}};
}

test('real MCP SDK lists twelve annotated tools and executes every fixed API operation',async()=>{
  const calls:{path:string;init:RequestInit}[]=[];
  const api=new LedgerApiClient({token,baseUrl:'http://127.0.0.1:49123',fetcher:async(input,init)=>{
    const url=new URL(String(input));calls.push({path:url.pathname+url.search,init:init??{}});
    const route=url.pathname.replace('/api/v1','');
    return Response.json(init?.method==='POST'&&route==='/invoices'?invoice:init?.method==='POST'&&route==='/receiving'?{request:receive}:fixture(route));
  }});
  const p=await protocol(api);
  try{
    const tools=(await p.client.listTools()).tools;assert.equal(tools.length,12);
    assert.equal(tools.some(t=>/confirm|send|withdraw|sign|seed|config/.test(t.name)),false);
    assert.equal(tools.find(t=>t.name==='check_receive_request')?.annotations?.readOnlyHint,false);
    assert.equal(tools.find(t=>t.name==='get_collateral')?.annotations?.readOnlyHint,true);
    const operations:[string,Record<string,unknown>][]=[
      ['list_payment_methods',{}],['list_invoices',{limit:2,cursor:'opaque_before'}],
      ['create_invoice',{idempotencyKey:'fictional_invoice_key',customerName:'Example workshop',title:'Fictional service',currency:'CAD',items:[{description:'Work',quantity:1,unitAmount:1200}]}],
      ['get_invoice',{invoiceId:'inv_1'}],['list_receive_requests',{}],
      ['create_receive_request',{idempotencyKey:'fictional_receiving_key',invoiceId:'inv_1',method:'bitcoin',adapterId:'watch'}],
      ['check_receive_request',{requestId:'receive_1',transactionId:'fictional_txid'}],['get_collateral',{}],['get_ark_status',{}],
    ];
    for(const [name,args] of operations){
      const output=await p.client.callTool({name,arguments:args});assert.notEqual(output.isError,true,name);assert.ok(output.structuredContent,name);
      assert.equal(/private-(?:checkout|receipt|receive|provider)/.test(JSON.stringify(output)),false,name);
    }
    assert.equal(calls[1].path,'/api/v1/invoices?limit=2&cursor=opaque_before');
    assert.equal(new Headers(calls[2].init.headers).get('Idempotency-Key'),'fictional_invoice_key');
    assert.equal(new Headers(calls[5].init.headers).get('Idempotency-Key'),'fictional_receiving_key');
    assert.equal(new Headers(calls[0].init.headers).get('Authorization'),`Bearer ${token}`);
    assert.equal(calls.every(c=>c.init.redirect==='error'),true);
  }finally{await p.close();}
});

test('MCP create schemas require stable retry keys and reject unexpected fields before HTTP',async()=>{
  let count=0;const p=await protocol(new LedgerApiClient({token,fetcher:async()=>{count++;return Response.json({});}}));
  try{
    for(const args of [{invoiceId:'inv_1',method:'bitcoin',adapterId:'watch'},{invoiceId:'../scenario',method:'bitcoin',adapterId:'watch',idempotencyKey:'stable_retry_key'},{invoiceId:'inv_1',method:'bitcoin',adapterId:'watch',idempotencyKey:'stable_retry_key',seed:'forbidden'}]){
      const result=await p.client.callTool({name:'create_receive_request',arguments:args});assert.equal(result.isError,true);
    }
    assert.equal(count,0);
  }finally{await p.close();}
});

test('MCP follows opaque continuation cursors and preserves retry identity after uncertain writes',async()=>{
  const creates:{key:string|null;body:BodyInit|null|undefined}[]=[];let createCalls=0;
  const api=new LedgerApiClient({token,fetcher:async(input,init)=>{
    const url=new URL(String(input));
    if(init?.method==='POST'){
      creates.push({key:new Headers(init.headers).get('Idempotency-Key'),body:init.body});
      if(createCalls++===0)return new Response('private provider failure',{status:502});
      return Response.json({request:receive});
    }
    return Response.json(url.searchParams.get('cursor')==='next_batch'?{invoices:[{...invoice,id:'inv_2'}],nextCursor:null}:{invoices:[invoice],nextCursor:'next_batch'});
  }});
  const p=await protocol(api);
  try{
    const first=await p.client.callTool({name:'list_invoices',arguments:{limit:1}});
    const next=(first.structuredContent as Record<string,unknown>|undefined)?.nextCursor;assert.equal(next,'next_batch');
    const second=await p.client.callTool({name:'list_invoices',arguments:{limit:1,cursor:next}});
    assert.equal((second.structuredContent as Record<string,unknown>|undefined)?.nextCursor,null);assert.match(JSON.stringify(second),/inv_2/);
    const args={invoiceId:'inv_1',method:'bitcoin',adapterId:'watch',idempotencyKey:'retained_uncertain_key'};
    assert.equal((await p.client.callTool({name:'create_receive_request',arguments:args})).isError,true);
    assert.equal(creates.length,1);
    assert.notEqual((await p.client.callTool({name:'create_receive_request',arguments:args})).isError,true);
    assert.equal(creates.length,2);assert.deepEqual(creates[0],creates[1]);
  }finally{await p.close();}
});

test('MCP errors are actionable, sanitized and never automatically retry a write',async()=>{
  for(const status of [400,401,403,404,409,429,500,502,503]){
    let count=0;const p=await protocol(new LedgerApiClient({token,fetcher:async()=>{count++;return new Response(`secret=${token}; /private/credential/path`,{status});}}));
    try{
      const output=await p.client.callTool({name:'create_receive_request',arguments:{invoiceId:'inv_1',method:'bitcoin',adapterId:'watch',idempotencyKey:'stable_retry_key'}});
      assert.equal(output.isError,true);assert.equal(count,1);assert.equal(JSON.stringify(output).includes(token),false);assert.equal(JSON.stringify(output).includes('/private/'),false);
    }finally{await p.close();}
  }
  const p=await protocol(new LedgerApiClient({token,fetcher:async()=>{throw new Error(`network failure ${token}`);}}));
  try{const output=await p.client.callTool({name:'get_collateral',arguments:{}});assert.equal(output.isError,true);assert.match(JSON.stringify(output),/unavailable|reach/i);assert.equal(JSON.stringify(output).includes(token),false);}finally{await p.close();}
});

test('MCP rejects redirects, malformed/oversized bodies and unsupported origins',async()=>{
  for(const url of ['https://example.com','http://127.0.0.1:4317/api','http://user:secret@localhost:4317','http://localhost:4317/?token=x'])assert.throws(()=>new LedgerApiClient({token,baseUrl:url}),/loopback/);
  for(const response of [new Response('<html>secret</html>',{status:200}),Response.json([]),new Response('x'.repeat(2_097_153),{status:200}),new Response(null,{status:302,headers:{Location:'https://example.com'}})]){
    const p=await protocol(new LedgerApiClient({token,fetcher:async()=>response}));
    try{assert.equal((await p.client.callTool({name:'list_payment_methods',arguments:{}})).isError,true);}finally{await p.close();}
  }
});

test('MCP credentials fail closed, require external 0600 regular files and never enter errors',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ledger-mcp-'));const path=join(dir,'fixture-token');
  try{
    assert.throws(()=>loadMcpConfig({}),/QUIET_LEDGER_API_TOKEN_FILE/);
    writeFileSync(path,token+'\n',{mode:0o600});
    const result=loadMcpConfig({QUIET_LEDGER_API_TOKEN_FILE:path});assert.equal(result.token,token);assert.equal(result.baseUrl,'http://127.0.0.1:4317');
    chmodSync(path,0o644);assert.throws(()=>loadMcpConfig({QUIET_LEDGER_API_TOKEN_FILE:path}),/0600/);
    chmodSync(path,0o600);symlinkSync(path,join(dir,'alias'));assert.throws(()=>loadMcpConfig({QUIET_LEDGER_API_TOKEN_FILE:join(dir,'alias')}),/0600/);
    writeFileSync(path,'short');assert.throws(()=>loadMcpConfig({QUIET_LEDGER_API_TOKEN_FILE:path}),/0600/);
    const missing=spawnSync(process.execPath,['--import','tsx','server/mcp.ts'],{cwd:resolve('.'),env:{PATH:process.env.PATH??''},encoding:'utf8',timeout:10000});
    assert.notEqual(missing.status,0);assert.equal(missing.stdout,'');assert.match(missing.stderr,/QUIET_LEDGER_API_TOKEN_FILE/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('MCP stdio process communicates with SDK Client against a synthetic authenticated loopback API',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ledger-stdio-'));const path=join(dir,'fixture-token');writeFileSync(path,token,{mode:0o600});
  const app=express();app.use(createApiAccess({keys:[{token,scopes}]}));app.get('/api/invoices',(_req,res)=>res.json({invoices:[invoice],nextCursor:null}));
  const http=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>http.once('listening',resolve));
  const address=http.address();assert.ok(address&&typeof address!=='string');
  const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','server/mcp.ts'],cwd:resolve('.'),env:{PATH:process.env.PATH??'',QUIET_LEDGER_URL:`http://127.0.0.1:${address.port}`,QUIET_LEDGER_API_TOKEN_FILE:path},stderr:'pipe'});
  let stderr='';transport.stderr?.on('data',chunk=>{stderr+=String(chunk);});
  const client=new Client({name:'stdio-fixture-client',version:'1.0.0'});
  try{
    await client.connect(transport);assert.equal((await client.listTools()).tools.length,12);
    const output=await client.callTool({name:'list_invoices',arguments:{limit:10}});assert.notEqual(output.isError,true);assert.match(JSON.stringify(output),/QL-0001/);assert.equal(stderr.includes(token),false);
  }finally{await client.close();await new Promise<void>(resolve=>http.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});

test('MCP invoice tools preserve KRW dates adjustments and allowed methods without leaking checkout tokens',async()=>{
 let sent:Record<string,unknown>|undefined;
 const args={customerName:'Fictional marmot client',title:'Workshop',currency:'KRW',items:[{description:'Capture',quantity:1,unitAmount:150000}],issueDate:'2026-11-05',dueDate:'2026-12-05',paymentTermDays:30,paymentTerms:'Fictional custom payment terms.',discountBps:500,premiumBps:100,acceptedMethods:['bitcoin','lightning']};
 const api=new LedgerApiClient({token,fetcher:async(_input,init)=>{sent=JSON.parse(String(init?.body));return Response.json({...invoice,...sent,discountAmount:7500,premiumAmount:1500,total:144000});}}),p=await protocol(api);
 try{const result=await p.client.callTool({name:'create_invoice',arguments:{...args,idempotencyKey:'fictional_marmot_krw'}});assert.notEqual(result.isError,true);assert.deepEqual(sent,args);const saved=(result.structuredContent as any).invoice;for(const field of ['issueDate','dueDate','paymentTermDays','paymentTerms','discountBps','premiumBps','acceptedMethods'])assert.deepEqual(saved[field],(args as any)[field]);assert.equal(saved.discountAmount,7500);assert.equal(saved.premiumAmount,1500);assert.equal(saved.token,undefined);}finally{await p.close();}
});

test('MCP create_invoice preserves SAT whole-satoshi denomination without a fiat reference',async()=>{
 let sent:Record<string,unknown>|undefined;
 const args={customerName:'Fictional satoshi client',title:'Whole-satoshi workshop',currency:'SAT',items:[{description:'Recording',quantity:2,unitAmount:10500}]};
 const api=new LedgerApiClient({token,fetcher:async(_input,init)=>{sent=JSON.parse(String(init?.body));return Response.json({...invoice,...sent,total:21000,amountSats:21000});}}),p=await protocol(api);
 try{const result=await p.client.callTool({name:'create_invoice',arguments:{...args,idempotencyKey:'fictional_sats_whole'}});assert.notEqual(result.isError,true);assert.deepEqual(sent,args);const saved=(result.structuredContent as any).invoice;assert.equal(saved.currency,'SAT');assert.equal(saved.total,21000);assert.equal(saved.totalCad,undefined);assert.equal(saved.token,undefined);assert.equal(saved.receiptToken,undefined);}finally{await p.close();}
});

test('business ledger API requires explicit read, invoice-write and bulk-record scopes',async()=>{
 const auth=`Bearer ${token}`;
 await request(authApp(['invoices:read'])).get('/api/v1/invoices/inv_1/ledger').set('Authorization',auth).expect(200);
 await request(authApp(['invoices:write'])).post('/api/v1/invoices/inv_1/credits').set('Authorization',auth).expect(200);
 await request(authApp(['invoices:write'])).post('/api/v1/invoices/inv_1/void').set('Authorization',auth).expect(200);
 await request(authApp(['records:read'])).get('/api/v1/invoice-ledger/export.csv').set('Authorization',auth).expect(200);
 for(const path of ['credits','void'])await request(authApp(['invoices:read'])).post('/api/v1/invoices/inv_1/'+path).set('Authorization',auth).expect(403);
 await request(authApp(['invoices:read'])).get('/api/v1/invoice-ledger/export.csv').set('Authorization',auth).expect(403);
});

test('MCP business tools preserve exact credit idempotency and omit receipt capabilities',async()=>{
 const calls:{path:string;init?:RequestInit}[]=[];
 const balance={total:1200,paid:300,credited:0,due:900,overpaid:0,currency:'CAD',state:'partially_paid',mode:'live'};
 const api=new LedgerApiClient({token,fetcher:async(url,init)=>{calls.push({path:new URL(String(url)).pathname,init});return Response.json({invoice:{...invoice,balance},balance,entries:[{id:'entry_1',kind:'payment',amount:300,currency:'CAD',createdAt:'2026-11-06T00:00:00Z',method:'lightning',verification:'provider',receiptToken:'private-receipt-capability',receiptNumber:'PAY-fixture'}]});}}),p=await protocol(api);
 try{
  const result=await p.client.callTool({name:'get_invoice_ledger',arguments:{invoiceId:'inv_1'}});assert.notEqual(result.isError,true);
  assert.equal(JSON.stringify(result).includes('private-receipt-capability'),false);assert.deepEqual((result.structuredContent as any).balance,balance);
  const body={invoiceId:'inv_1',amount:100,reason:'Fictional scope reduction',idempotencyKey:'fictional_credit_1'};
  assert.notEqual((await p.client.callTool({name:'create_credit_note',arguments:body})).isError,true);
  assert.notEqual((await p.client.callTool({name:'void_invoice',arguments:{invoiceId:'inv_1',reason:'Fictional cancellation',idempotencyKey:'fictional_void_1'}})).isError,true);
  assert.equal(calls[1].path,'/api/v1/invoices/inv_1/credits');assert.equal(new Headers(calls[1].init?.headers).get('Idempotency-Key'),body.idempotencyKey);
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)),{amount:100,reason:body.reason});
  const before=calls.length;assert.equal((await p.client.callTool({name:'create_credit_note',arguments:{...body,amount:0}})).isError,true);assert.equal(calls.length,before);
 }finally{await p.close();}
});

test('MCP partial receiving passes the exact minor-unit amount and rejects fractions',async()=>{
 let body:any,count=0;const p=await protocol(new LedgerApiClient({token,fetcher:async(_url,init)=>{count++;body=JSON.parse(String(init?.body));return Response.json({request:receive});}}));
 try{
  const args={invoiceId:'inv_1',method:'lightning',adapterId:'lnd',amount:300,idempotencyKey:'fictional_deposit_key'};
  assert.notEqual((await p.client.callTool({name:'create_receive_request',arguments:args})).isError,true);assert.equal(body.amount,300);
  assert.equal((await p.client.callTool({name:'create_receive_request',arguments:{...args,amount:1.5}})).isError,true);assert.equal(count,1);
 }finally{await p.close();}
});

test('MCP preserves explicit line kinds and adjustment eligibility',async()=>{
 let sent:Record<string,unknown>|undefined;
 const args={customerName:'Fictional travel client',title:'Labour and fixed flights',currency:'CAD',items:[{description:'Fictional labour',quantity:1,unitAmount:200000,kind:'service',adjustmentEligible:true},{description:'Fictional fixed flights',quantity:1,unitAmount:80000,kind:'expense',adjustmentEligible:false}],discountBps:500,acceptedMethods:['bitcoin','lightning']};
 const p=await protocol(new LedgerApiClient({token,fetcher:async(_input,init)=>{sent=JSON.parse(String(init?.body));return Response.json({...invoice,...sent,total:270000});}}));
 try{const result=await p.client.callTool({name:'create_invoice',arguments:{...args,idempotencyKey:'fictional-line-eligibility'}});assert.notEqual(result.isError,true);assert.deepEqual(sent,args);assert.deepEqual((result.structuredContent as any).invoice.items,args.items);assert.equal((result.structuredContent as any).invoice.token,undefined);}finally{await p.close();}
});

test('MCP create_invoice forwards method pricing and rejects invalid rules before HTTP',async()=>{
  let count=0,sent:Record<string,unknown>|undefined;
  const p=await protocol(new LedgerApiClient({token,fetcher:async(_input,init)=>{count++;sent=JSON.parse(String(init?.body));return Response.json({...invoice,...sent});}}));
  try{
    const args={customerName:'Fictional pricing client',title:'Method-priced workshop',currency:'CAD',items:[{description:'Fictional labour',quantity:1,unitAmount:200000},{description:'Fictional flights',quantity:1,unitAmount:80000,kind:'expense'}],discountBps:500,taxBps:500,methodPricing:[{method:'lightning',discountBps:1000},{method:'card',premiumBps:200}]};
    const result=await p.client.callTool({name:'create_invoice',arguments:{...args,idempotencyKey:'fictional_method_pricing'}});
    assert.notEqual(result.isError,true);assert.deepEqual(sent,args);
    // Client-facing aliases, unknown methods, zero-rate, duplicate and excess rules are rejected before HTTP.
    const canonical=['bitcoin','liquid','lightning','bank','card','cash','check','gift_card','coupon','apple_pay','google_pay','cash_app_pay','interac','ach','sepa','wire','venmo','paypal','revolut_pay','no_charge','cashu','onchain','ark','bolt12','lnurl','xpub','taproot'];
    const invalid:[string,unknown][]=[['square',[{method:'square',discountBps:500}]],['bank_transfer',[{method:'bank_transfer',discountBps:500}]],['ecash',[{method:'ecash',discountBps:500}]],['zero-rate',[{method:'lightning'}]],['duplicate-method',[{method:'lightning',discountBps:500},{method:'lightning',premiumBps:500}]],['too-many-rules',canonical.map(method=>({method,discountBps:100}))]];
    for(const [name,rules] of invalid){
      const rejected=await p.client.callTool({name:'create_invoice',arguments:{...args,idempotencyKey:`rejected-${name}`,methodPricing:rules}});
      assert.equal(rejected.isError,true,name);
    }
    assert.equal(count,1);
  }finally{await p.close();}
});

test('MCP create_receive_request forwards the exact agreement id and rejects malformed ones',async()=>{
  let body:any,count=0;const agreementId='0d9a5b4e-1111-4222-8333-444455556666';
  const p=await protocol(new LedgerApiClient({token,fetcher:async(_url,init)=>{count++;body=JSON.parse(String(init?.body));return Response.json({request:{...receive,agreementId}});}}));
  try{
    const args={invoiceId:'inv_1',method:'lightning',adapterId:'watch',agreementId,idempotencyKey:'fictional_priced_receiving'};
    const result=await p.client.callTool({name:'create_receive_request',arguments:args});
    assert.notEqual(result.isError,true);assert.deepEqual(body,{invoiceId:'inv_1',method:'lightning',adapterId:'watch',agreementId});
    assert.equal((result.structuredContent as any).request.agreementId,agreementId);
    // A malformed agreement id never reaches HTTP.
    assert.equal((await p.client.callTool({name:'create_receive_request',arguments:{...args,agreementId:'not-a-uuid'}})).isError,true);
    assert.equal(count,1);
  }finally{await p.close();}
});

test('MCP invoice tools pass the confirmed price agreement and effective balance through',async()=>{
  const methodPricing=[{method:'lightning',discountBps:1000}];
  const priceAgreement={id:'0d9a5b4e-1111-4222-8333-444455556666',invoiceId:'inv_1',method:'lightning',offerHash:'a'.repeat(64),confirmedAt:'2026-11-06T12:00:00Z',confirmation:'public_checkout_token',currency:'CAD',eligibleSubtotal:200000,issuedSubtotal:280000,issuedDiscountAmount:10000,issuedPremiumAmount:0,issuedTax:13500,issuedTotal:283500,discountBps:1000,premiumBps:0,discountAmount:20000,premiumAmount:0,adjustedSubtotal:260000,effectiveTax:12500,taxAdjustment:-1000,effectiveTotal:262500,totalAdjustment:-21000,referenceTotalCad:262500,referenceAmountSats:2625000};
  const balance={total:283500,effectiveTotal:262500,paid:0,credited:0,due:262500,overpaid:0,currency:'CAD',state:'unpaid',mode:'simulation'};
  const priced={...invoice,methodPricing,priceAgreement,balance};
  const p=await protocol(new LedgerApiClient({token,fetcher:async input=>{
    const route=new URL(String(input)).pathname.replace('/api/v1','');
    return Response.json(route==='/invoices/inv_1/ledger'?{invoice:priced,balance,entries:[{id:'entry_1',kind:'payment',amount:300,currency:'CAD',createdAt:'2026-11-06T00:00:00Z',method:'lightning',verification:'provider'}]}:priced);
  }}));
  try{
    const single=await p.client.callTool({name:'get_invoice',arguments:{invoiceId:'inv_1'}});
    assert.notEqual(single.isError,true);
    const saved=(single.structuredContent as any).invoice;
    assert.deepEqual(saved.methodPricing,methodPricing);
    assert.deepEqual(saved.priceAgreement,priceAgreement);
    assert.equal(saved.priceAgreement.effectiveTotal,262500);
    assert.equal(saved.token,undefined);assert.equal(saved.receiptToken,undefined);
    const ledger=await p.client.callTool({name:'get_invoice_ledger',arguments:{invoiceId:'inv_1'}});
    assert.notEqual(ledger.isError,true);
    assert.deepEqual((ledger.structuredContent as any).balance,balance);
    assert.deepEqual((ledger.structuredContent as any).invoice.priceAgreement,priceAgreement);
  }finally{await p.close();}
});
