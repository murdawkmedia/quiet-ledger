import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {randomBytes} from 'node:crypto';
import WebSocket,{type ClientOptions,type RawData} from 'ws';
import type {NostrEvent} from 'nostr-tools';
import {isPublicConnectionAddress,validateConnectionUrl} from './connection-transport.js';

/** Routing only: the protocol layer must authenticate and decrypt the returned event. */
export interface NwcTransport {
  (relayUrl:string,event:NostrEvent,peers:{walletPubkey:string;clientPubkey:string}):Promise<NostrEvent>;
  info?(relayUrl:string,walletPubkey:string):Promise<NostrEvent>;
}
export interface NwcTransportOptions {
  /** Trusted tests only. These options never come from saved connection fields. */
  lookup?:typeof dnsLookup;
  connect?:(url:string,options:ClientOptions)=>WebSocket;
  timeoutMs?:number;
  signal?:AbortSignal;
}
const MAX_FRAME=64*1024,MAX_TOTAL=256*1024,MAX_FRAMES=64;
const unavailable=()=>new Error('NWC relay unavailable or response invalid.');
const key=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
function relayUrl(raw:string){
  if(typeof raw!=='string'||raw.length>2048||/[\u0000-\u0020\u007f\\]/.test(raw))throw unavailable();
  const url=new URL(raw);
  if(url.protocol!=='wss:')throw unavailable();
  const https=new URL(url);https.protocol='https:';validateConnectionUrl(https.toString());
  return url;
}
function envelope(value:unknown):value is NostrEvent {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const e=value as NostrEvent;
  return key(e.id)&&key(e.pubkey)&&typeof e.sig==='string'&&/^[0-9a-f]{128}$/.test(e.sig)
    &&Number.isSafeInteger(e.created_at)&&e.created_at>=0&&Number.isSafeInteger(e.kind)
    &&typeof e.content==='string'&&Buffer.byteLength(e.content)<=MAX_FRAME
    &&Array.isArray(e.tags)&&e.tags.length<=128&&e.tags.every(t=>Array.isArray(t)&&t.length<=16&&t.every(v=>typeof v==='string'&&v.length<=2048));
}
function hasOneTag(event:NostrEvent,name:string,target:string){const tags=event.tags.filter(t=>t[0]===name);return tags.length===1&&tags[0][1]===target;}

/** One socket, one bounded subscription, no authentication/failover/redirect or ambient cookies. */
export function createNwcTransport(options:NwcTransportOptions={}):NwcTransport {
  const lookup=options.lookup??dnsLookup;
  const connect=options.connect??((url,config)=>new WebSocket(url,config));
  const timeout=options.timeoutMs??10_000;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>10_000)throw unavailable();
  const exchange=(raw:string,wallet:string,request?:NostrEvent,client?:string):Promise<NostrEvent>=>new Promise((resolve,reject)=>{
    let socket:WebSocket|undefined,done=false,subscribed=false,frames=0,totalBytes=0,infoCount=0,latest:NostrEvent|undefined;
    const subscription='ql-nwc-'+randomBytes(12).toString('hex');
    const started=Date.now();
    const swallow=()=>{};
    const finish=(error?:Error,result?:NostrEvent)=>{
      if(done)return;done=true;clearTimeout(timer);options.signal?.removeEventListener('abort',aborted);
      if(socket){
        socket.off('open',opened);socket.off('message',message);socket.off('error',failed);socket.off('close',failed);socket.off('unexpected-response',unexpected);
        // ws emits an asynchronous error/close when terminating a connecting socket.
        // Keep only these inert guards until close; closed sockets retain no listeners.
        const owned=socket;
        const removeGuards=()=>{owned.off('error',swallow);owned.off('close',removeGuards);};
        owned.on('error',swallow);owned.once('close',removeGuards);
        if(subscribed&&owned.readyState===WebSocket.OPEN){try{owned.send(JSON.stringify(['CLOSE',subscription]),()=>{});}catch{/* Best effort only; terminate still owns cleanup. */}}
        try{owned.terminate();}catch{/* A closed owned socket has no remaining work. */}
        if(owned.readyState===WebSocket.CLOSED)removeGuards();
      }
      if(error||!result)reject(unavailable());else resolve(structuredClone(result));
    };
    const failed=()=>finish(unavailable());
    const aborted=()=>finish(unavailable());
    const timer=setTimeout(aborted,timeout);
    const send=(frame:unknown,after?:()=>void)=>{
      if(done||!socket)return;
      try{socket.send(JSON.stringify(frame),error=>{if(error)failed();else if(!done)after?.();});}catch{failed();}
    };
    function opened(){
      if(done)return;subscribed=true;
      const filter=request?{kinds:[23195],authors:[wallet],'#e':[request.id],'#p':[client!],limit:1}:{kinds:[13194],authors:[wallet],limit:8};
      send(['REQ',subscription,filter],request?()=>send(['EVENT',request]):undefined);
    }
    function unexpected(_request:unknown,response:{resume?:()=>void;destroy?:()=>void}){try{response?.resume?.();response?.destroy?.();}finally{failed();}}
    function message(rawData:RawData,isBinary:boolean){
      if(done)return;
      try{
        if(isBinary||++frames>MAX_FRAMES)throw unavailable();
        const bytes=Array.isArray(rawData)?rawData.reduce((n,b)=>n+b.length,0):rawData.byteLength;
        totalBytes+=bytes;
        if(bytes>MAX_FRAME||totalBytes>MAX_TOTAL)throw unavailable();
        const text=Array.isArray(rawData)?Buffer.concat(rawData).toString('utf8'):Buffer.from(rawData as ArrayBuffer).toString('utf8');
        const frame:unknown=JSON.parse(text);
        if(!Array.isArray(frame)||typeof frame[0]!=='string')throw unavailable();
        if(frame[0]==='AUTH')throw unavailable();
        if(frame[0]==='CLOSED'&&frame[1]===subscription)throw unavailable();
        if(frame[0]==='OK'&&request&&frame[1]===request.id&&frame[2]===false)throw unavailable();
        if(frame[0]==='EOSE'&&frame[1]===subscription&&!request){finish(undefined,latest);return;}
        if(frame[0]!=='EVENT'||frame[1]!==subscription)return;
        const candidate=frame[2];
        if(!envelope(candidate)||candidate.pubkey!==wallet)return;
        if(request){
          if(candidate.kind===23195&&hasOneTag(candidate,'e',request.id)&&hasOneTag(candidate,'p',client!))finish(undefined,candidate);
        }else if(candidate.kind===13194){
          if(++infoCount>8)throw unavailable();
          if(!latest||candidate.created_at>latest.created_at||(candidate.created_at===latest.created_at&&candidate.id>latest.id))latest=candidate;
        }
      }catch{failed();}
    }
    if(options.signal?.aborted){aborted();return;}
    options.signal?.addEventListener('abort',aborted,{once:true});
    void (async()=>{
      if(!key(wallet)||request&&(!envelope(request)||request.kind!==23194||!key(client)||request.pubkey!==client||!hasOneTag(request,'p',wallet)||Buffer.byteLength(JSON.stringify(request))>48*1024))throw unavailable();
      const url=relayUrl(raw),host=url.hostname.replace(/^\[|\]$/g,'');
      const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true,verbatim:true});
      if(done)return;
      if(!addresses.length||addresses.length>16||addresses.some(a=>!isPublicConnectionAddress(a.address)||isIP(a.address)!==a.family))throw unavailable();
      const remaining=Math.max(1,timeout-(Date.now()-started));
      const connectionOptions={agent:false,followRedirects:false,maxRedirects:0,rejectUnauthorized:true,
        servername:isIP(host)?undefined:host,perMessageDeflate:false,maxPayload:MAX_FRAME,handshakeTimeout:remaining,
        headers:{'User-Agent':'Quiet-Ledger-NWC/0.1'},
        lookup:(_host:unknown,config:any,callback:any)=>config?.all?callback(null,addresses):callback(null,addresses[0].address,addresses[0].family),
      };
      // ws forwards these Node HTTP options, but its declarations omit lookup and agent:false.
      socket=connect(url.toString(),connectionOptions as unknown as ClientOptions);
      socket.on('open',opened);socket.on('message',message);socket.on('error',failed);socket.on('close',failed);socket.on('unexpected-response',unexpected);
      if(socket.readyState===WebSocket.OPEN)opened();
    })().catch(failed);
  });
  const transport:NwcTransport=(url,event,peers)=>{
    try{return exchange(url,peers.walletPubkey,structuredClone(event),peers.clientPubkey);}catch{return Promise.reject(unavailable());}
  };
  transport.info=(url,wallet)=>exchange(url,wallet);
  return transport;
}
export const nwcTransport=createNwcTransport();
