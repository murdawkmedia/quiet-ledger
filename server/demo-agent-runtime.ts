import {constants,openSync,closeSync,fstatSync,readFileSync,realpathSync} from 'node:fs';
import {isAbsolute,dirname} from 'node:path';
import {DEMO_REPLY_INTENTS,type DemoCase,type DemoInference,type DemoRole} from '../shared/demo-agents.js';

/** Operator configuration only; never resolve a provider URL from a visitor. */
export function loadDemoAgentRuntime(env:NodeJS.ProcessEnv){
  if(env.DEMO_TEAM_ENABLED!=='true')return undefined;
  if(env.HACKATHON_DEMO_ENABLED!=='true'||env.HOSTED_ACCOUNTS!=='true')throw new Error('The team requires explicit hosted-account hackathon demo mode.');
  const runtimeRoot=env.DEMO_TEAM_STATE_DIR,binaryPath=env.MARMOT_AGENT_BINARY,tokenPath=env.HERMES_DEMO_TOKEN_FILE;
  if(!runtimeRoot||!binaryPath||!tokenPath||![runtimeRoot,binaryPath,tokenPath].every(isAbsolute))throw new Error('Demo team requires explicit private runtime, binary and token paths.');
  const fd=openSync(tokenPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let token:string;
  try{const info=fstatSync(fd);if(!info.isFile()||(info.mode&0o777)!==0o600||info.nlink!==1||info.size<32||info.size>512||realpathSync(dirname(tokenPath))!==dirname(tokenPath)||(process.getuid&&info.uid!==process.getuid()))throw new Error('The demo worker token file must be private.');token=readFileSync(fd,'utf8').trim();}finally{closeSync(fd);}
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(token))throw new Error('Invalid demo worker token configuration.');
  const endpoint=new URL(env.HERMES_DEMO_URL??'http://127.0.0.1:4420');
  if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash)throw new Error('Invalid private demo worker endpoint.');
  // HTTP is limited to a literal loopback or the isolated compose service name.
  if(endpoint.protocol==='http:'&&!['127.0.0.1','[::1]','hermes-demo'].includes(endpoint.hostname))throw new Error('The demo worker requires a private loopback or compose endpoint.');
  const origin=env.PUBLIC_ORIGIN;if(!origin)throw new Error('The demo team requires a public origin.');const relay=new URL('/marmot',origin);relay.protocol=relay.protocol==='https:'?'wss:':'ws:';
  return {runtimeRoot,binaryPath,publicRelayUrl:relay.href,allowLoopbackRelays:env.SELF_HOSTED==='true'&&relay.protocol==='ws:',async infer(role:DemoRole,text:string,caseDTO:DemoCase,requestId:string,signal:AbortSignal):Promise<DemoInference>{
    const response=await fetch(new URL('/infer',endpoint),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({role,text,case:caseDTO,requestId}),signal:AbortSignal.any([signal,AbortSignal.timeout(32000)]),redirect:'error'});
    if(!response.ok)throw new Error('The isolated Hermes inference service is unavailable.');
    if(Number(response.headers.get('content-length')??0)>4096)throw new Error('The Hermes response exceeded its limit.');
    const reader=response.body?.getReader();if(!reader)throw new Error('Missing Hermes response.');let size=0;const chunks:Uint8Array[]=[];for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();throw new Error('The Hermes response exceeded its limit.');}chunks.push(value);}const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(result.runtime!=='hermes'||!DEMO_REPLY_INTENTS.includes(result.intent)||typeof result.model!=='string'||result.model.length<1||result.model.length>128||Object.keys(result).some(key=>!['intent','runtime','model'].includes(key)))throw new Error('The Hermes service returned an invalid intent.');
    return {runtime:'hermes',intent:result.intent,model:result.model};
  }};
}
