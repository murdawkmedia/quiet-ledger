export interface ProxyEnvironment {SHC_API_ORIGIN:string;PROXY_SHARED_SECRET:string;PUBLIC_ORIGIN:string}
const REQUEST_LIMIT=48*1024;
const RESPONSE_LIMIT=2*1024*1024;
const DEADLINE_MS=15000;
const ALLOWED_METHODS=['GET','HEAD','POST','DELETE'];
const REQUEST_HEADERS=['content-type','accept','authorization','cookie','origin','sec-fetch-site','x-csrf-token','idempotency-key'];
const RESPONSE_HEADERS=['content-type','content-disposition','www-authenticate','retry-after','allow'];
const UNAVAILABLE='The API is temporarily unavailable.';
class ProxyFailure extends Error {constructor(readonly status:number,message:string){super(message);}}
function securityHeaders():Headers {
  return new Headers({'Cache-Control':'no-store, max-age=0',Pragma:'no-cache',Expires:'0','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'});
}
function failure(request:Request,status:number,message:string):Response {
  const headers=securityHeaders();headers.set('Content-Type','application/json; charset=utf-8');
  if(status===405)headers.set('Allow',ALLOWED_METHODS.join(', '));
  return new Response(request.method==='HEAD'?null:JSON.stringify({error:message}),{status,headers});
}
function origin(value:unknown):string {
  if(typeof value!=='string'||value.length>2048)throw new Error();
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.origin!==value)throw new Error();
  return url.origin;
}
export function configuration(env:ProxyEnvironment){
  const backend=origin(env.SHC_API_ORIGIN),publicOrigin=origin(env.PUBLIC_ORIGIN),secret=env.PROXY_SHARED_SECRET;
  if(backend===publicOrigin||typeof secret!=='string'||!/^[\x21-\x7e]{32,512}$/.test(secret))throw new Error();
  return {backend,publicOrigin,secret};
}
function ipv4(value:string):boolean {
  const parts=value.split('.');
  return parts.length===4&&parts.every(part=>/^(0|[1-9][0-9]{0,2})$/.test(part)&&Number(part)<=255);
}
/** Platform header only; reject ports, brackets, zone IDs, XFF chains and non-IP names. */
export function clientIp(value:string|null):string {
  if(typeof value!=='string'||value.length<2||value.length>45)throw new ProxyFailure(400,'Invalid API request.');
  if(ipv4(value))return value;
  if(!value.includes(':')||!/^[0-9A-Fa-f:.]+$/.test(value))throw new ProxyFailure(400,'Invalid API request.');
  if(value.includes('.')&&!ipv4(value.split(':').at(-1)!))throw new ProxyFailure(400,'Invalid API request.');
  try{
    const parsed=new URL('https://['+value+']/'),hostname=parsed.hostname;
    if(!hostname.startsWith('[')||!hostname.endsWith(']'))throw new Error();
    return hostname.slice(1,-1).toLowerCase();
  }catch{throw new ProxyFailure(400,'Invalid API request.');}
}
function declaredLength(value:string|null,status:number):number|undefined {
  if(value===null)return undefined;
  if(value.length>8||!/^(0|[1-9][0-9]*)$/.test(value))throw new ProxyFailure(status,status===400?'Invalid API request.':UNAVAILABLE);
  const length=Number(value);if(!Number.isSafeInteger(length))throw new ProxyFailure(status,status===400?'Invalid API request.':UNAVAILABLE);
  return length;
}
function cancel(body:ReadableStream<Uint8Array>|null){
  if(body&&!body.locked){try{void body.cancel().catch(()=>{});}catch{}}
}
function abortable<T>(task:Promise<T>,signal:AbortSignal):Promise<T> {
  return new Promise<T>((resolve,reject)=>{
    let settled=false;
    const finish=(done:(value:any)=>void,value:unknown)=>{if(settled)return;settled=true;signal.removeEventListener('abort',aborted);done(value);};
    const aborted=()=>finish(reject,new Error());
    signal.addEventListener('abort',aborted,{once:true});
    task.then(value=>finish(resolve,value),error=>finish(reject,error));
    if(signal.aborted)aborted();
  });
}
async function bounded(body:ReadableStream<Uint8Array>|null,max:number,status:number,signal:AbortSignal):Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted();if(!body)return new Uint8Array(0);
  const reader=body.getReader(),chunks:Uint8Array[]=[];let size=0,reads=0;
  try{
    for(;;){
      const {done,value}=await abortable(reader.read(),signal);if(done)break;
      if(!(value instanceof Uint8Array)||++reads>65536)throw new ProxyFailure(status,status===413?'The API request is too large.':UNAVAILABLE);
      size+=value.byteLength;if(size>max)throw new ProxyFailure(status,status===413?'The API request is too large.':UNAVAILABLE);
      if(value.byteLength)chunks.push(value.slice());
    }
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
  }finally{
    try{void reader.cancel().catch(()=>{});}catch{}
    try{reader.releaseLock();}catch{}
  }
}
function cookies(headers:Headers):string[] {
  const extended=headers as Headers&{getSetCookie?:()=>string[];getAll?:(name:string)=>string[]};
  let values:string[];
  if(typeof extended.getSetCookie==='function')values=extended.getSetCookie();
  else if(typeof extended.getAll==='function')values=extended.getAll('Set-Cookie');
  else if(!headers.has('Set-Cookie'))return [];
  else throw new Error();
  if(!Array.isArray(values)||values.length>20||values.some(value=>typeof value!=='string'||value.length>8192||/[\r\n]/.test(value)))throw new Error();
  return values;
}
function secureCookie(value:string):string {
  const parts=value.split(';'),first=parts.shift()!.trim(),equals=first.indexOf('=');if(equals<1)throw new Error();
  const name=first.slice(0,equals);if(name!=='ql_session'&&name!=='ql_auth')return value;
  const kept=parts.map(part=>part.trim()).filter(Boolean).filter(part=>!['domain','path','secure','httponly','samesite'].includes(part.split('=',1)[0].trim().toLowerCase()));
  const path=name==='ql_auth'?'/api/auth':'/';
  return [first,...kept,'Path='+path,'Secure','HttpOnly','SameSite=Strict'].join('; ');
}
function responseHeaders(upstream:Headers):Headers {
  const headers=securityHeaders();for(const name of RESPONSE_HEADERS){const value=upstream.get(name);if(value!==null)headers.set(name,value);}
  for(const value of cookies(upstream))headers.append('Set-Cookie',secureCookie(value));return headers;
}
const jsonType=(value:string|null)=>Boolean(value&&/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i.test(value));

/** Same-origin Pages gateway. Neither the upstream host nor its secret is supplied by the caller. */
export async function proxyApi(request:Request,env:ProxyEnvironment,fetcher:typeof fetch=fetch):Promise<Response> {
  let config:ReturnType<typeof configuration>;
  try{config=configuration(env);}catch{cancel(request.body);return failure(request,503,UNAVAILABLE);}
  let url:URL;
  try{url=new URL(request.url);}catch{cancel(request.body);return failure(request,400,'Invalid API request.');}
  if(url.origin!==config.publicOrigin||request.headers.get('Origin')!==null&&request.headers.get('Origin')!==config.publicOrigin||request.headers.get('Sec-Fetch-Site')==='cross-site'){
    cancel(request.body);return failure(request,403,'This API request is not permitted.');
  }
  if(!/^\/api\/[A-Za-z0-9/_-]+$/.test(url.pathname)){cancel(request.body);return failure(request,404,'This API request is not permitted.');}
  if(!ALLOWED_METHODS.includes(request.method)){cancel(request.body);return failure(request,405,'This API request is not permitted.');}
  const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,DEADLINE_MS);request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();
  let upstream:Response|undefined;
  try{
    const ip=clientIp(request.headers.get('CF-Connecting-IP')),length=declaredLength(request.headers.get('Content-Length'),400);
    if(length!==undefined&&length>REQUEST_LIMIT)throw new ProxyFailure(413,'The API request is too large.');
    const body=await bounded(request.body,REQUEST_LIMIT,413,controller.signal);
    if(length!==undefined&&length!==body.byteLength)throw new ProxyFailure(400,'Invalid API request.');
    const headers=new Headers();for(const name of REQUEST_HEADERS){const value=request.headers.get(name);if(value!==null)headers.set(name,value);}
    headers.set('x-quiet-ledger-proxy',config.secret);headers.set('x-quiet-ledger-client-ip',ip);
    const target=config.backend+url.pathname+url.search;controller.signal.throwIfAborted();
    upstream=await abortable(fetcher(target,{method:request.method,headers,body:body.byteLength?body.buffer:undefined,redirect:'manual',cache:'no-store',signal:controller.signal}),controller.signal);
    if(upstream.status<200||upstream.status>599||upstream.status>=300&&upstream.status<400&&upstream.status!==304||upstream.redirected||upstream.url&&new URL(upstream.url).href!==target)throw new ProxyFailure(502,UNAVAILABLE);
    const noBody=request.method==='HEAD'||upstream.status===204||upstream.status===304;
    if(upstream.status>=400&&!jsonType(upstream.headers.get('Content-Type')))throw new ProxyFailure(502,UNAVAILABLE);
    const headersOut=responseHeaders(upstream.headers);
    if(noBody){cancel(upstream.body);return new Response(null,{status:upstream.status,headers:headersOut});}
    const responseLength=declaredLength(upstream.headers.get('Content-Length'),502);if(responseLength!==undefined&&responseLength>RESPONSE_LIMIT)throw new ProxyFailure(502,UNAVAILABLE);
    const bytes=await bounded(upstream.body,RESPONSE_LIMIT,502,controller.signal);
    if(upstream.status>=400){
      try{JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new ProxyFailure(502,UNAVAILABLE);}
    }
    return new Response(bytes.buffer,{status:upstream.status,headers:headersOut});
  }catch(error){
    cancel(request.body);if(upstream)cancel(upstream.body);
    return failure(request,error instanceof ProxyFailure?error.status:502,error instanceof ProxyFailure?error.message:UNAVAILABLE);
  }finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);}
}

export function onRequest(context:{request:Request;env:ProxyEnvironment}):Promise<Response> {return proxyApi(context.request,context.env);}
