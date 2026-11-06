import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,linkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createLedgerMcpServer,LedgerApiClient,loadMcpConfig} from '../server/mcp.js';

const token='synthetic-hosted-account-scoped-mcp-key-at-least32';
const origin='https://fictional-ledger.example';
type WithRemote=ConstructorParameters<typeof LedgerApiClient>[0]&{allowRemote?:boolean};
const client=(options:WithRemote)=>new LedgerApiClient(options);
async function protocol(api:LedgerApiClient){
  const server=createLedgerMcpServer(api),sdk=new Client({name:'synthetic-hosted-client',version:'1.0.0'});
  const [left,right]=InMemoryTransport.createLinkedPair();await server.connect(right);await sdk.connect(left);
  return {sdk,close:async()=>{await sdk.close();await server.close();}};
}

test('hosted MCP requires explicit remote permission and keeps loopback as the default',()=>{
  assert.throws(()=>client({token,baseUrl:origin}),/loopback/);
  assert.throws(()=>client({token,baseUrl:origin,allowRemote:false}),/loopback/);
  assert.doesNotThrow(()=>client({token,baseUrl:origin,allowRemote:true}));
  for(const baseUrl of ['http://127.0.0.1:4317','https://localhost:4317','http://[::1]:4317']){
    assert.doesNotThrow(()=>client({token,baseUrl}));assert.doesNotThrow(()=>client({token,baseUrl,allowRemote:true}));
  }
});

test('hosted MCP rejects HTTP remote origins, userinfo and any path, query or fragment',()=>{
  for(const baseUrl of [
    'http://fictional-ledger.example','ftp://fictional-ledger.example','ws://fictional-ledger.example','file:///tmp/fictional',
    'https://user:secret@fictional-ledger.example','https://user@fictional-ledger.example','https://@fictional-ledger.example',
    'https://fictional-ledger.example/api','https://fictional-ledger.example/api/..','https://fictional-ledger.example//',
    'https://fictional-ledger.example?token=synthetic','https://fictional-ledger.example/?','https://fictional-ledger.example/#',
    'https://fictional-ledger.example#fragment','https:fictional-ledger.example',' https://fictional-ledger.example',
    'https://fictional-ledger.example\n','https://fictional-ledger.example\\',
  ])assert.throws(()=>client({token,baseUrl,allowRemote:true}),error=>error instanceof Error&&error.message.startsWith('QUIET_LEDGER_URL')&&!error.message.includes('secret')&&!error.message.includes('synthetic'),baseUrl);
});

test('MCP env enables remote HTTPS only with the exact true flag and propagates that decision',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'quiet-hosted-mcp-')),path=join(directory,'synthetic-api-token');
  try{
    writeFileSync(path,token+'\n',{mode:0o600});
    const local=loadMcpConfig({QUIET_LEDGER_API_TOKEN_FILE:path});assert.equal((local as any).allowRemote,false);assert.equal(local.baseUrl,'http://127.0.0.1:4317');
    for(const flag of [undefined,'false','TRUE','1','yes',' true '])assert.throws(()=>loadMcpConfig({QUIET_LEDGER_API_TOKEN_FILE:path,QUIET_LEDGER_URL:origin,...(flag===undefined?{}:{QUIET_LEDGER_ALLOW_REMOTE:flag})}),/loopback/);
    const remote=loadMcpConfig({QUIET_LEDGER_API_TOKEN_FILE:path,QUIET_LEDGER_URL:origin+'/',QUIET_LEDGER_ALLOW_REMOTE:'true'});assert.equal((remote as any).allowRemote,true);assert.equal(remote.baseUrl,origin);
    let destination='';const api=new LedgerApiClient({...remote,fetcher:async input=>{destination=String(input);return Response.json({invoices:[],nextCursor:null});}});
    await api.invoices({});assert.equal(destination,origin+'/api/v1/invoices?limit=25');
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('hosted MCP sends its scoped token only to the fixed configured HTTPS API and preserves denials',async()=>{
  const requests:{url:string;init:RequestInit}[]=[];
  const p=await protocol(client({token,baseUrl:origin,allowRemote:true,fetcher:async(input,init)=>{
    const url=String(input);requests.push({url,init:init??{}});
    assert.equal(new URL(url).origin,origin);assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer '+token);assert.equal(init?.redirect,'error');
    if(init?.method==='POST')return Response.json({error:'Synthetic account key has read scope only.'},{status:403});
    return Response.json({invoices:[{id:'fictional-owned-invoice',number:'FICTIONAL-0001',customerName:'Synthetic account',title:'Fictional own-account record',currency:'CAD',total:125,status:'open',token:'synthetic-private-bearer-must-stay-hidden'}],nextCursor:null});
  }}));
  try{
    const tools=await p.sdk.listTools();assert.equal(tools.tools.length,12);assert.equal(tools.tools.some(tool=>/send|capture|confirm|sign|withdraw|seed|config/.test(tool.name)),false);
    const read=await p.sdk.callTool({name:'list_invoices',arguments:{limit:2}});assert.notEqual(read.isError,true);assert.equal(JSON.stringify(read).includes('fictional-owned-invoice'),true);assert.equal(JSON.stringify(read).includes('synthetic-private-bearer'),false);assert.equal(JSON.stringify(read).includes(token),false);
    const write=await p.sdk.callTool({name:'create_invoice',arguments:{idempotencyKey:'synthetic_stable_invoice_key',customerName:'Synthetic account',title:'No write scope',currency:'CAD',items:[{description:'Fictional',quantity:1,unitAmount:125}]}});assert.equal(write.isError,true);assert.match(JSON.stringify(write),/forbidden/);assert.equal(JSON.stringify(write).includes(token),false);
    assert.equal(requests.length,2);assert.equal(requests[0].url,origin+'/api/v1/invoices?limit=2');assert.equal(requests[1].url,origin+'/api/v1/invoices');assert.equal(new Headers(requests[1].init.headers).get('Idempotency-Key'),'synthetic_stable_invoice_key');
    const injected=await p.sdk.callTool({name:'list_invoices',arguments:{baseUrl:'https://wrong.example'}});assert.equal(injected.isError,true);assert.equal(requests.length,2);
  }finally{await p.close();}
});

test('hosted MCP does not follow redirects or trust an already-redirected response',async()=>{
  for(const successRedirect of [false,true]){
    let calls=0;
    const p=await protocol(client({token,baseUrl:origin,allowRemote:true,fetcher:async(_input,init)=>{
      calls++;assert.equal(init?.redirect,'error');
      if(!successRedirect)return new Response(null,{status:302,headers:{Location:'https://wrong.example/collect'}});
      const response=Response.json({methods:[],adapters:[]});Object.defineProperty(response,'redirected',{value:true});Object.defineProperty(response,'url',{value:'https://wrong.example/collect'});return response;
    }}));
    try{const output=await p.sdk.callTool({name:'list_payment_methods',arguments:{}});assert.equal(output.isError,true);assert.equal(calls,1);assert.equal(JSON.stringify(output).includes(token),false);}finally{await p.close();}
  }
});

test('MCP credential files reject hardlinks without modifying the source token',()=>{
  const directory=mkdtempSync(join(tmpdir(),'quiet-hosted-mcp-links-')),path=join(directory,'synthetic-api-token');
  try{
    writeFileSync(path,token+'\n',{mode:0o600});linkSync(path,join(directory,'hardlink'));
    for(const candidate of [path,join(directory,'hardlink')])assert.throws(()=>loadMcpConfig({QUIET_LEDGER_API_TOKEN_FILE:candidate}),error=>error instanceof Error&&error.message.includes('0600')&&!error.message.includes(token)&&!error.message.includes(directory));
  }finally{rmSync(directory,{recursive:true,force:true});}
});
