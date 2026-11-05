import {lookup as dnsLookup} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';
import {isIP} from 'node:net';
import type {HttpFetch} from '../integrations/http.js';

const unavailable=()=>new Error('Provider connection unavailable or endpoint is not permitted.');
/** Conservative global-unicast allowlist: special-purpose ranges never reach a socket. */
export function isPublicConnectionAddress(address:string):boolean {
  if(isIP(address)===4){
    const [a,b,c]=address.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||(b===88&&c===99)))||(a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
  }
  if(isIP(address)===6){
    // A URL canonicalizes expanded/compressed IPv6 forms before prefix checks.
    const ip=new URL(`https://[${address}]/`).hostname.slice(1,-1).toLowerCase();
    const [first,second]=ip.split(':').map(part=>parseInt(part||'0',16));
    return first>=0x2000&&first<=0x3fff&&!(first===0x2001&&(second<=0x1ff||second===0xdb8))&&first!==0x2002&&!(first>=0x3ff0);
  }
  return false;
}
export function validateConnectionUrl(raw:unknown):URL {
  if(typeof raw!=='string'||raw.length>2048||/[\u0000-\u0020\u007f\\]/.test(raw))throw unavailable();
  let url:URL;try{url=new URL(raw);}catch{throw unavailable();}
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(url.protocol!=='https:'||url.username||url.password||url.hash||(url.port&&url.port!=='443')||!host||host.endsWith('.')||(!isIP(host)&&(!host.includes('.')||!/^[a-z0-9.-]+$/.test(host)||/\.(local|localhost|localdomain|internal|onion|home|lan|test|invalid)$/.test(host)))||(isIP(host)&&!isPublicConnectionAddress(host)))throw unavailable();
  return url;
}
export interface ConnectionTransportOptions {
  /** Internal fixture injection only; tenant configuration is never spread here. */
  lookup?:typeof dnsLookup;
  request?:typeof httpsRequest;
  timeoutMs?:number;
}
const abortable=<T>(work:Promise<T>,signal:AbortSignal):Promise<T>=>new Promise((resolve,reject)=>{
  const abort=()=>reject(unavailable());
  if(signal.aborted){reject(unavailable());return;}
  signal.addEventListener('abort',abort,{once:true});
  work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
});

/** Fully buffers a bounded response while its deadline still covers DNS, TLS and body. */
export function createConnectionTransport(options:ConnectionTransportOptions={}):HttpFetch {
  const lookup=options.lookup??dnsLookup,request=options.request??httpsRequest;
  return async(raw,init={})=>{
    const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),options.timeoutMs??10_000);
    const signal=init.signal?AbortSignal.any([deadline.signal,init.signal]):deadline.signal;
    try{
      const url=validateConnectionUrl(raw),hostname=url.hostname.replace(/^\[|\]$/g,'');
      const method=(init.method??'GET').toUpperCase();
      if(!['GET','POST'].includes(method)||signal.aborted)throw unavailable();
      let body:Buffer|undefined;
      if(init.body!==undefined&&init.body!==null){
        if(typeof init.body==='string'||init.body instanceof URLSearchParams)body=Buffer.from(init.body.toString());
        else if(init.body instanceof Uint8Array)body=Buffer.from(init.body);
        else throw unavailable();
        if(body.length>48*1024||method==='GET')throw unavailable();
      }
      const headers=new Headers(init.headers);
      for(const [name] of headers)if(['cookie','cookie2','host','connection','content-length','transfer-encoding','expect','upgrade','te','trailer','accept-encoding'].includes(name)||name.startsWith('proxy-'))throw unavailable();
      headers.set('Accept-Encoding','identity');
      if(body)headers.set('Content-Length',String(body.length));
      const requestBytes=Buffer.byteLength(`${method} ${url.toString()} HTTP/1.1\r\n`)+[...headers].reduce((size,[name,value])=>size+Buffer.byteLength(`${name}: ${value}\r\n`),2)+(body?.length??0);
      if(requestBytes>48*1024)throw unavailable();
      const addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await abortable(lookup(hostname,{all:true,verbatim:true}),signal);
      if(signal.aborted||!addresses.length||addresses.some(value=>!isPublicConnectionAddress(value.address)||(value.family!==4&&value.family!==6)))throw unavailable();
      return await new Promise<Response>((resolve,reject)=>{
        let complete=false;
        const fail=()=>{if(!complete){complete=true;reject(unavailable());}};
        const req=request(url,{method,headers:Object.fromEntries(headers),agent:false,signal,maxHeaderSize:16*1024,
          // The TLS hostname remains the configured hostname; only socket DNS is pinned.
          lookup:((_name:any,config:any,done:any)=>config?.all?done(null,addresses):done(null,addresses[0].address,addresses[0].family)) as any,
        },res=>{
          const status=res.statusCode??502;
          if(status>=300&&status<400){res.destroy();req.destroy();fail();return;}
          const length=res.headers['content-length'];
          if(length!==undefined&&(!/^\d+$/.test(String(length))||Number(length)>1024*1024)){res.destroy();req.destroy();fail();return;}
          const chunks:Buffer[]=[];let bytes=0;
          res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>1024*1024){res.destroy();req.destroy();fail();}else chunks.push(chunk);});
          res.on('error',fail);res.on('aborted',fail);
          res.on('end',()=>{
            if(complete)return;
            try{
              const responseHeaders=new Headers();
              for(const [name,value] of Object.entries(res.headers))if(value!==undefined&&!['set-cookie','set-cookie2','content-encoding','transfer-encoding'].includes(name))responseHeaders.set(name,Array.isArray(value)?value.join(', '):value);
              const response=new Response([204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers:responseHeaders});
              complete=true;resolve(response);
            }catch{fail();}
          });
        });
        req.on('error',fail);req.setTimeout(options.timeoutMs??10_000,()=>{req.destroy();fail();});req.end(body);
      });
    }catch{throw unavailable();}finally{clearTimeout(timer);}
  };
}
export const connectionFetch:HttpFetch=createConnectionTransport();
