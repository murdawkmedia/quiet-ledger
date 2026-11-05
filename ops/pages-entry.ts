import {onRequest,configuration} from '../functions/api/[[path]].js';
import {proxyMarmot} from '../functions/marmot.js';
function secureAssets(response:Response,env:Env){const origin=configuration(env).publicOrigin;const headers=new Headers(response.headers);headers.set('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${origin.replace(/^http/,'ws')}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`);return new Response(response.body,{status:response.status,statusText:response.statusText,headers});}
interface AssetBinding {fetch(request:Request):Promise<Response>}
interface Env {SHC_API_ORIGIN:string;PROXY_SHARED_SECRET:string;PUBLIC_ORIGIN:string;ASSETS:AssetBinding}
export default {async fetch(request:Request,env:Env){
  const url=new URL(request.url);
  if((url.pathname==='/marmot'||url.pathname.startsWith('/marmot/')))return proxyMarmot(request,env);
  if(url.pathname.startsWith('/api/'))return onRequest({request,env});
  const response=await env.ASSETS.fetch(request);
  if(response.status===404&&request.method==='GET'&&request.headers.get('accept')?.includes('text/html')&&!url.pathname.split('/').at(-1)?.includes('.')){
    const index=new URL('/index.html',url);return secureAssets(await env.ASSETS.fetch(new Request(index,request)),env);
  }
  return secureAssets(response,env);
}};
