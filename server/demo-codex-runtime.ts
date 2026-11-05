import {statSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
import {request as httpRequest} from 'node:http';
import type {DemoCase,DemoConversationMessage,DemoInference,DemoRole} from '../shared/demo-agents.js';
import {validateDemoInference} from './demo-agent-replies.js';
import {readDemoWorkerToken} from './demo-worker-auth.js';

const model='gpt-6-luna';
const failure='The Codex subscription demo service is unavailable. No other provider was used.';

/** Optional accountant-only subscription backend. Its sign-in stays on its host. */
export function loadCodexDemoRuntime(env:NodeJS.ProcessEnv) {
 const socketPath=env.CODEX_DEMO_SOCKET_FILE,url=env.CODEX_DEMO_URL,tokenPath=env.CODEX_DEMO_TOKEN_FILE;
 if(!env.DEMO_ACCOUNTANT_RUNTIME&&!socketPath&&!url&&!tokenPath)return undefined;
 if(env.DEMO_ACCOUNTANT_RUNTIME!=='codex'||env.DEMO_TEAM_ENABLED!=='true'||env.HACKATHON_DEMO_ENABLED!=='true'||env.HOSTED_ACCOUNTS!=='true')throw new Error('Codex requires explicit fictional account demo mode.');
 if(Boolean(socketPath)===Boolean(url)||!tokenPath)throw new Error('Choose one private Codex socket or loopback endpoint and a service token.');
 const token=readDemoWorkerToken(tokenPath);
 let endpoint:URL|undefined;
 if(socketPath) {
  if(!isAbsolute(socketPath)||realpathSync(socketPath)!==socketPath)throw new Error('The Codex demo socket path must be absolute and contain no links.');
  const info=statSync(socketPath),parent=statSync(dirname(socketPath));
  if(!info.isSocket()||(info.mode&0o777)!==0o600||(parent.mode&0o777)!==0o700||(process.getuid&&(info.uid!==process.getuid()||parent.uid!==process.getuid())))throw new Error('The Codex demo socket must be private and owned by the runtime.');
 }else {
  endpoint=new URL(url!);
  if(endpoint.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(endpoint.hostname)||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash)throw new Error('Codex HTTP must use an explicit literal loopback origin.');
 }
 return {model,reasoningEffort:'max' as const,async infer(role:DemoRole,text:string,caseDTO:DemoCase,requestId:string,signal:AbortSignal,history?:DemoConversationMessage[]):Promise<DemoInference> {
  if(role!=='accountant')throw new Error('The Codex demo backend is only configured for Jordan.');
  const body=JSON.stringify({role,text,case:caseDTO,requestId,...(history?{history}:{})});
  if(Buffer.byteLength(body)>16384)throw new Error('The Codex request exceeds its limit.');
  const inference=await new Promise<DemoInference>((resolve,reject)=>{
   const request=httpRequest({...(socketPath?{socketPath}:{hostname:endpoint!.hostname.replace(/^\[|\]$/g,''),port:endpoint!.port||80}),path:'/infer',method:'POST',signal:AbortSignal.any([signal,AbortSignal.timeout(32000)]),headers:{authorization:`Bearer ${token}`,'content-type':'application/json','content-length':Buffer.byteLength(body)},maxHeaderSize:8192},response=>{
    const fail=()=>{response.destroy();reject(new Error(failure));};
    if(response.statusCode!==200||!/^application\/json(?:;|$)/i.test(String(response.headers['content-type']??''))||Number(response.headers['content-length']??0)>4096){fail();return;}
    let bytes=0;const chunks:Buffer[]=[];
    response.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>4096){fail();return;}chunks.push(chunk);});
    response.on('error',()=>reject(new Error(failure)));
    response.on('aborted',()=>reject(new Error(failure)));
    response.on('end',()=>{try{const result=validateDemoInference(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));if(result.runtime!=='codex'||result.model!==model||!result.reply)throw new Error(failure);resolve(result);}catch{reject(new Error(failure));}});
   });
   request.on('error',()=>reject(new Error(failure)));
   request.end(body);
  });
  return inference;
 }};
}
