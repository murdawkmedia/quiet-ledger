import {PUBLIC_MARMOT_RELAY_ORIGINS} from '../shared/marmot-relays';
import type {NostrNetworkInterface,PublishResponse} from '@internet-privacy/marmot-ts';
import {matchFilters,verifyEvent,type Event,type Filter} from 'nostr-tools';

export const DEFAULT_MARMOT_RELAYS=PUBLIC_MARMOT_RELAY_ORIGINS.map(origin=>origin+'/');
const allowedKinds=new Set([30443,1059,445,5,10050]),hex=/^[0-9a-f]{64}$/;
const bytes=(text:string)=>new TextEncoder().encode(text).length;
function relayUrl(value:string):string{
 const url=new URL(value),host=url.hostname.toLowerCase();
 if(url.protocol!=='wss:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.port&&url.port!=='443'||!host.includes('.')||/[\[\]:]/.test(host)||/^[\d.]+$/.test(host)||/\.(?:local|localhost|internal|invalid|test)$/.test(host))throw new Error('Choose a reviewed public WSS relay.');return url.href;
}
export function validateMarmotRelays(relays:readonly string[],reviewed:readonly string[]=DEFAULT_MARMOT_RELAYS):string[]{
 if(!Array.isArray(relays)||relays.length<1||relays.length>4||!Array.isArray(reviewed)||reviewed.length>16)throw new Error('Choose one to four reviewed public relays.');
 try{const approved=new Set(reviewed.map(relayUrl)),values=[...new Set(relays.map(relayUrl))];if(values.some(value=>!approved.has(value)))throw new Error();return values;}catch{throw new Error('Only reviewed public WSS relays are allowed.');}
}
function filtersFor(input:Filter|Filter[]):Filter[]{
 const filters=Array.isArray(input)?input:[input];if(filters.length<1||filters.length>8)throw new Error('Relay filter bounds exceeded.');
 for(const filter of filters){
  if(!filter||typeof filter!=='object'||!Array.isArray(filter.kinds)||!filter.kinds.length||filter.kinds.some(kind=>!allowedKinds.has(kind))||!Number.isSafeInteger(filter.limit??500)||(filter.limit??500)<1||(filter.limit??500)>500)throw new Error('Relay filter limit or kind is invalid.');
  for(const [key,value]of Object.entries(filter)){
   if(['limit','since','until'].includes(key)){if(!Number.isSafeInteger(value)||Number(value)<0)throw new Error('Invalid relay filter bound.');}
   else if(['kinds','authors','ids','#p','#h'].includes(key)){if(!Array.isArray(value)||value.length>64||key!=='kinds'&&value.some(item=>typeof item!=='string'||!hex.test(item)))throw new Error('Invalid relay filter values.');}
   else throw new Error('Unsupported relay filter.');
  }
 }
 return filters.map(filter=>({...filter,limit:filter.limit??500}));
}
function verified(value:unknown):value is Event {try{const event=value as Event;return allowedKinds.has(event.kind)&&bytes(JSON.stringify(event))<=131072&&event.tags.length<=128&&event.tags.every(tag=>Array.isArray(tag)&&tag.length<=16&&tag.every(part=>typeof part==='string'&&part.length<=4096))&&verifyEvent({id:event.id,pubkey:event.pubkey,created_at:event.created_at,kind:event.kind,tags:event.tags,content:event.content,sig:event.sig});}catch{return false;}}
export interface MarmotRelayOptions {relays?:string[];reviewedRelays?:string[];timeoutMs?:number;WebSocket?:typeof WebSocket}
export function createMarmotRelayNetwork(options:MarmotRelayOptions={}):NostrNetworkInterface&{dispose():void}{
 const relays=validateMarmotRelays(options.relays??[...DEFAULT_MARMOT_RELAYS],options.reviewedRelays),Socket=options.WebSocket??globalThis.WebSocket,timeout=options.timeoutMs??8000;
 if(!Socket||!Number.isSafeInteger(timeout)||timeout<1||timeout>10000)throw new Error('A bounded browser WebSocket transport is required.');
 const sockets=new Set<WebSocket>();let disposed=false;
 const routes=(values:string[])=>{if(disposed)throw new Error('Marmot relay transport is disposed.');return validateMarmotRelays(values,relays);};
 const exchange=<T>(relay:string,opening:unknown[],receive:(frame:any[])=>T|undefined,fallback:()=>T):Promise<T>=>new Promise(resolve=>{
  let socket:WebSocket,done=false,frames=0;const finish=(result:T)=>{if(done)return;done=true;clearTimeout(timer);if(socket){sockets.delete(socket);socket.onopen=socket.onmessage=socket.onerror=socket.onclose=null;socket.close();}resolve(result);};
  const timer=setTimeout(()=>finish(fallback()),timeout);
  try{socket=new Socket(relay);sockets.add(socket);socket.onopen=()=>{try{socket.send(JSON.stringify(opening));}catch{finish(fallback());}};socket.onerror=socket.onclose=()=>finish(fallback());socket.onmessage=event=>{if(typeof event.data!=='string'||bytes(event.data)>131072||++frames>4096){finish(fallback());return;}try{const frame=JSON.parse(event.data);if(!Array.isArray(frame))return;const result=receive(frame);if(result!==undefined)finish(result);}catch{/* Malformed relay frames cannot become application events. */}};}catch{finish(fallback());}
 });
 const network:NostrNetworkInterface&{dispose():void}={
  async publish(values,event){const targets=routes(values);if(!verified(event))throw new Error('The signed Marmot event exceeds relay bounds.');return Object.fromEntries(await Promise.all(targets.map(async relay=>[relay,await exchange<PublishResponse>(relay,['EVENT',event],frame=>frame[0]==='OK'&&frame[1]===event.id&&typeof frame[2]==='boolean'?{from:relay,ok:frame[2]}:undefined,()=>({from:relay,ok:false,uncertain:true}))])));},
  async request(values,input){const targets=routes(values),filters=filtersFor(input),results=await Promise.all(targets.map(relay=>{const id=crypto.randomUUID(),found=new Map<string,Event>();return exchange<Event[]|null>(relay,['REQ',id,...filters],frame=>{if(frame[0]==='EVENT'&&frame[1]===id&&verified(frame[2])&&matchFilters(filters,frame[2])){found.set(frame[2].id,frame[2]);if(found.size>=Math.min(4000,filters.reduce((sum,filter)=>sum+filter.limit!,0)))return[...found.values()];}if(frame[0]==='EOSE'&&frame[1]===id)return[...found.values()];if(frame[0]==='CLOSED'&&frame[1]===id)return null;return undefined;},()=>null);}));if(results.every(result=>result===null))throw new Error('Marmot relays are unavailable or timed out.');const merged=new Map<string,Event>();for(const result of results)for(const event of result??[])merged.set(event.id,event);return[...merged.values()];},
  subscription(values,filters){return{subscribe(observer){let cancelled=false;void network.request(values,filters).then(events=>{if(cancelled)return;for(const event of events)observer.next?.(event);observer.complete?.();}).catch(error=>{if(!cancelled)observer.error?.(error);});return{unsubscribe(){cancelled=true;}};}};},
  async getUserInboxRelays(pubkey){if(!hex.test(pubkey))throw new Error('A peer public key is required.');const events=await network.request(relays,[{kinds:[10050],authors:[pubkey],limit:4}]),newest=events.sort((a,b)=>b.created_at-a.created_at)[0];if(!newest)return[...relays];const discovered=newest.tags.filter(tag=>tag[0]==='relay').map(tag=>tag[1]);return discovered.filter(value=>{try{return relays.includes(relayUrl(value));}catch{return false;}}).slice(0,4);},
  dispose(){if(disposed)return;disposed=true;for(const socket of sockets)socket.close();sockets.clear();},
 };
 return network;
}
