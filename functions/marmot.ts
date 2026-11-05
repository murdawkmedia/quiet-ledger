import {configuration,clientIp,type ProxyEnvironment} from './api/[[path]].js';
const headers=()=>new Headers({'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'});
function fail(status:number){return new Response(JSON.stringify({error:'The demo messaging connection is unavailable.'}),{status,headers:headers()});}
/** Standard NIP01 WebSocket tunnel; never forwards browser credentials or destinations. */
export async function proxyMarmot(request:Request,env:ProxyEnvironment,fetcher:typeof fetch=fetch):Promise<Response>{
  let config:ReturnType<typeof configuration>;try{config=configuration(env);}catch{return fail(503);}
  const url=new URL(request.url);
  if(url.origin!==config.publicOrigin)return fail(403);
  if(!/^\/marmot\/[A-Za-z0-9_-]{43}$/.test(url.pathname)||url.search)return fail(404);
  if(request.method!=='GET')return fail(405);
  if(request.headers.get('upgrade')?.toLowerCase()!=='websocket')return fail(426);
  const origin=request.headers.get('origin');
  if((origin!==null&&origin!==config.publicOrigin)||request.headers.get('sec-fetch-site')==='cross-site')return fail(403);
  let ip:string;try{ip=clientIp(request.headers.get('CF-Connecting-IP'));}catch{return fail(400);}
  const h=new Headers({'Upgrade':'websocket','X-Quiet-Ledger-Proxy':config.secret,'X-Quiet-Ledger-Client-IP':ip});
  if(origin)h.set('Origin',origin);
  for(const key of ['Sec-WebSocket-Key','Sec-WebSocket-Version','Sec-WebSocket-Protocol']){const value=request.headers.get(key);if(value!==null){if(value.length>256||/[\r\n]/.test(value))return fail(400);h.set(key,value);}}
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
  try{
    const response=await fetcher(config.backend+url.pathname,{method:'GET',headers:h,redirect:'manual',signal:controller.signal});
    if(response.status!==101||!(response as Response&{webSocket?:unknown}).webSocket){try{await response.body?.cancel();}catch{}return fail(502);}
    return response;
  }catch{return fail(502);}finally{clearTimeout(timer);}
}
