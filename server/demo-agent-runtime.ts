import {isAbsolute} from 'node:path';
import {type DemoCase,type DemoConversationMessage,type DemoInference,type DemoRole} from '../shared/demo-agents.js';

import {validateDemoInference} from './demo-agent-replies.js';
import {readDemoWorkerToken} from './demo-worker-auth.js';
import {loadCodexDemoRuntime} from './demo-codex-runtime.js';

/** Operator configuration only; never resolve a provider URL from a visitor. */
export function loadDemoAgentRuntime(env:NodeJS.ProcessEnv){
  if(env.DEMO_TEAM_ENABLED!=='true')return undefined;
  if(env.HACKATHON_DEMO_ENABLED!=='true'||env.HOSTED_ACCOUNTS!=='true')throw new Error('The team requires explicit hosted-account hackathon demo mode.');
  const runtimeRoot=env.DEMO_TEAM_STATE_DIR,binaryPath=env.MARMOT_AGENT_BINARY,tokenPath=env.HERMES_DEMO_TOKEN_FILE;
  if(!runtimeRoot||!binaryPath||!tokenPath||![runtimeRoot,binaryPath,tokenPath].every(isAbsolute))throw new Error('Demo team requires explicit private runtime, binary and token paths.');
  const token=readDemoWorkerToken(tokenPath),codex=loadCodexDemoRuntime(env);
  const endpoint=new URL(env.HERMES_DEMO_URL??'http://127.0.0.1:4420');
  if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash)throw new Error('Invalid private demo worker endpoint.');
  // HTTP is limited to a literal loopback or the isolated compose service name.
  if(endpoint.protocol==='http:'&&!['127.0.0.1','[::1]','hermes-demo'].includes(endpoint.hostname))throw new Error('The demo worker requires a private loopback or compose endpoint.');
  const origin=env.PUBLIC_ORIGIN;if(!origin)throw new Error('The demo team requires a public origin.');const relay=new URL('/marmot',origin);relay.protocol=relay.protocol==='https:'?'wss:':'ws:';
  const codexProvider=codex?{runtime:'codex' as const,model:codex.model,reasoningEffort:codex.reasoningEffort}:undefined;
  return {runtimeRoot,binaryPath,publicRelayUrl:relay.href,allowLoopbackRelays:env.SELF_HOSTED==='true'&&relay.protocol==='ws:',...(codex?{providers:{client:codex.roles.includes('client')?codexProvider!:{runtime:'hermes' as const},accountant:codexProvider!}}:{}),async infer(role:DemoRole,text:string,caseDTO:DemoCase,requestId:string,signal:AbortSignal,history?:DemoConversationMessage[]):Promise<DemoInference>{
    if(codex&&codex.roles.includes(role))return codex.infer(role,text,caseDTO,requestId,signal,history);
    const response=await fetch(new URL('/infer',endpoint),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({role,text,case:caseDTO,requestId,...(history?{history}:{})}),signal:AbortSignal.any([signal,AbortSignal.timeout(32000)]),redirect:'error'});
    if(!response.ok)throw new Error('The isolated Hermes inference service is unavailable.');
    if(Number(response.headers.get('content-length')??0)>4096)throw new Error('The Hermes response exceeded its limit.');
    const reader=response.body?.getReader();if(!reader)throw new Error('Missing Hermes response.');let size=0;const chunks:Uint8Array[]=[];for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();throw new Error('The Hermes response exceeded its limit.');}chunks.push(value);}const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const inference=validateDemoInference(result);
    if(inference.runtime!=='hermes'||!inference.reply)throw new Error('The Hermes service returned no composed reply from its selected runtime.');
    return inference;
  }};
}
