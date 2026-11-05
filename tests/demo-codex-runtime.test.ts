import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {loadCodexDemoRuntime} from '../server/demo-codex-runtime.js';
import {loadDemoAgentRuntime} from '../server/demo-agent-runtime.js';
import {validateDemoInference} from '../server/demo-agent-replies.js';
import type {DemoCase} from '../shared/demo-agents.js';

const context:DemoCase={fictional:true,currency:'CAD',lineAmount:12500,tax:0,total:12500,status:'open',settlementMode:'simulation',receiptRecorded:false,version:1,asOf:'2026-11-05T00:00:00.000Z'};
function fixture(){const root=mkdtempSync(join(tmpdir(),'ql-codex-runtime-'));const token=join(root,'token');writeFileSync(token,'c'.repeat(43),{mode:0o600});return {root,token,env:{DEMO_TEAM_ENABLED:'true',HOSTED_ACCOUNTS:'true',HACKATHON_DEMO_ENABLED:'true',DEMO_ACCOUNTANT_RUNTIME:'codex',CODEX_DEMO_TOKEN_FILE:token}};}
const valid={runtime:'codex',model:'gpt-6-luna',intent:'conversation',reply:'I help keep the workshop scope clear. What would you like to work through?'};

test('runtime identity is an exact supported string',()=>{
 for(const runtime of [['codex'],{runtime:'codex'},'other',null])assert.throws(()=>validateDemoInference({...valid,runtime}));
 assert.equal(validateDemoInference(valid).runtime,'codex');
});

test('Codex is explicit and requires a private local endpoint and owned token',()=>{
 const f=fixture();try{
  assert.equal(loadCodexDemoRuntime({}),undefined);
  assert.throws(()=>loadCodexDemoRuntime({CODEX_DEMO_URL:'http://127.0.0.1:4441'}));
  for(const extra of [{DEMO_ACCOUNTANT_RUNTIME:'other'}, {HOSTED_ACCOUNTS:'false'}, {CODEX_DEMO_URL:'http://example.org'}, {CODEX_DEMO_URL:'https://example.org'}, {CODEX_DEMO_URL:'http://user@127.0.0.1'}, {CODEX_DEMO_URL:'http://127.0.0.1/path'}, {CODEX_DEMO_URL:'http://127.0.0.1',CODEX_DEMO_SOCKET_FILE:join(f.root,'socket')}])assert.throws(()=>loadCodexDemoRuntime({...f.env,...extra}));
  symlinkSync(f.token,join(f.root,'linked'));assert.throws(()=>loadCodexDemoRuntime({...f.env,CODEX_DEMO_URL:'http://127.0.0.1:4441',CODEX_DEMO_TOKEN_FILE:join(f.root,'linked')}));
  chmodSync(f.token,0o644);assert.throws(()=>loadCodexDemoRuntime({...f.env,CODEX_DEMO_URL:'http://127.0.0.1:4441'}));
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('the subscription adapter uses the selected socket and rejects a different runtime/model',async()=>{
 const f=fixture();const socket=join(f.root,'codex.sock');let result:unknown=valid,requests=0,body:any;
 const server=createServer((req,res)=>{requests++;assert.equal(req.url,'/infer');assert.equal(req.headers.authorization,'Bearer '+'c'.repeat(43));let text='';req.on('data',data=>text+=data);req.on('end',()=>{body=JSON.parse(text);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));});});
 await new Promise<void>(resolve=>server.listen(socket,resolve));chmodSync(socket,0o600);
 try{
  const runtime=loadCodexDemoRuntime({...f.env,CODEX_DEMO_SOCKET_FILE:socket})!;const signal=new AbortController().signal;const history=[{speaker:'human' as const,text:'I make captioned films.'}];
  assert.deepEqual(await runtime.infer('accountant','What would help?',context,'fixture',signal,history),valid);assert.deepEqual(body,{role:'accountant',text:'What would help?',case:context,requestId:'fixture',history});
  await assert.rejects(runtime.infer('client','Hello',context,'wrong-role',signal));assert.equal(requests,1);
  for(const response of [{...valid,runtime:'hermes'},{...valid,model:'other'},{...valid,reply:undefined},{...valid,extra:'unexpected'},'x'.repeat(5000)]){result=response;await assert.rejects(runtime.infer('accountant','Hello',context,'invalid',signal));}
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(f.root,{recursive:true,force:true});}
});

test('Codex connection cancellation does not retry or change the request destination',async()=>{
 const f=fixture();let requests=0;const server=createServer((_req,res)=>{requests++;res.on('error',()=>{});});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const port=(server.address() as {port:number}).port;const runtime=loadCodexDemoRuntime({...f.env,CODEX_DEMO_URL:`http://127.0.0.1:${port}`})!;const controller=new AbortController();const promise=runtime.infer('accountant','Hello',context,'cancelled',controller.signal);setTimeout(()=>controller.abort(),30);await assert.rejects(promise);assert.equal(requests,1);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(f.root,{recursive:true,force:true});}
});

test('only Jordan uses Codex and a Codex failure never falls back to Riley’s provider',async()=>{
 const f=fixture();const seen:string[]=[];let codexStatus=200;
 function service(kind:'codex'|'hermes'){return createServer((req,res)=>{let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{const input=JSON.parse(raw);seen.push(kind+':'+input.role);res.statusCode=kind==='codex'?codexStatus:200;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...valid,runtime:kind,model:kind==='codex'?'gpt-6-luna':'fixture'}));});});}
 const codex=service('codex'),hermes=service('hermes');await new Promise<void>(resolve=>codex.listen(0,'127.0.0.1',resolve));await new Promise<void>(resolve=>hermes.listen(0,'127.0.0.1',resolve));
 try{
  const port=(server:ReturnType<typeof createServer>)=>(server.address() as {port:number}).port;
  const runtime=loadDemoAgentRuntime({...f.env,CODEX_DEMO_URL:`http://127.0.0.1:${port(codex)}`,HERMES_DEMO_URL:`http://127.0.0.1:${port(hermes)}`,HERMES_DEMO_TOKEN_FILE:f.token,DEMO_TEAM_STATE_DIR:join(f.root,'native'),MARMOT_AGENT_BINARY:join(f.root,'binary'),PUBLIC_ORIGIN:'http://localhost:4417',SELF_HOSTED:'true'})!;
  assert.equal(runtime.providers?.accountant.model,'gpt-6-luna');assert.equal(runtime.providers?.accountant.reasoningEffort,'max');
  const signal=new AbortController().signal;assert.equal((await runtime.infer('accountant','Hello',context,'jordan',signal)).runtime,'codex');assert.equal((await runtime.infer('client','Hello',context,'riley',signal)).runtime,'hermes');
  codexStatus=503;await assert.rejects(runtime.infer('accountant','Hello',context,'failed',signal));assert.deepEqual(seen,['codex:accountant','hermes:client','codex:accountant']);
 }finally{for(const server of [codex,hermes]){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}rmSync(f.root,{recursive:true,force:true});}
});
