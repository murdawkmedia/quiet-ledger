import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import type {NostrEvent} from 'nostr-tools';
import {createNwcTransport} from '../server/nwc-transport.js';

const wallet='11'.repeat(32),client='22'.repeat(32),requestId='33'.repeat(32);
const request:NostrEvent={id:requestId,pubkey:client,created_at:1700000000,kind:23194,tags:[['p',wallet]],content:'fictional encrypted request',sig:'44'.repeat(64)};
const reply=(extra:Partial<NostrEvent>={}):NostrEvent=>({id:'55'.repeat(32),pubkey:wallet,created_at:1700000001,kind:23195,tags:[['e',requestId],['p',client]],content:'fictional encrypted reply',sig:'66'.repeat(64),...extra});
class Socket extends EventEmitter {
  readyState=0;sent:any[]=[];terminations=0;onSend?:(frame:any)=>void;
  send(raw:string,callback?:(error?:Error)=>void){const frame=JSON.parse(raw);this.sent.push(frame);callback?.();this.onSend?.(frame);}
  terminate(){this.terminations++;this.readyState=3;}
  close(){this.readyState=3;}
  message(frame:any,binary=false){this.emit('message',Buffer.from(JSON.stringify(frame)),binary);}
}
function fixture(config:{addresses?:{address:string;family:number}[];hangDns?:boolean;timeout?:number;hangOpen?:boolean;signal?:AbortSignal}={}){
 const socket=new Socket(),calls:{url:string;options:any}[]=[];let lookups=0;
 const transport=createNwcTransport({timeoutMs:config.timeout??100,signal:config.signal,
  lookup:(async()=>{lookups++;if(config.hangDns)return new Promise(()=>{});return config.addresses??[{address:'8.8.8.8',family:4},{address:'2606:4700:4700::1111',family:6}];}) as any,
  connect:((url:string,options:any)=>{calls.push({url,options});if(!config.hangOpen)queueMicrotask(()=>{socket.readyState=1;socket.emit('open');});return socket;}) as any});
 return {socket,calls,transport,lookups:()=>lookups};
}
const sendReply=(f:ReturnType<typeof fixture>)=>{f.socket.onSend=frame=>{if(frame[0]==='EVENT')queueMicrotask(()=>f.socket.message(['EVENT',f.socket.sent[0][1],reply()]));};};
const clean=(f:ReturnType<typeof fixture>)=>{assert.equal(f.socket.terminations,1);for(const event of ['open','message','error','close','unexpected-response'])assert.equal(f.socket.listenerCount(event),0,event);};

test('NWC transport rejects unsafe relay destinations without DNS or sockets',async()=>{
 const f=fixture();for(const url of ['ws://relay.example','wss://127.0.0.1','wss://localhost','wss://10.1.2.3','wss://[::1]','wss://[::ffff:8.8.8.8]','wss://[2001:db8::1]','wss://relay.example:8443','wss://u:secret@relay.example','wss://relay.example/#secret','wss://host.internal','https://relay.example','wss://relay.example./'])await assert.rejects(()=>f.transport(url,request,{walletPubkey:wallet,clientPubkey:client}),{message:'NWC relay unavailable or response invalid.'});
 assert.equal(f.calls.length,0);assert.equal(f.lookups(),0);
});
test('request bytes and peer identities are checked before resolving a relay',async()=>{
 const f=fixture();
 for(const event of [reply(),{...request,content:'a'.repeat(48*1024)},{...request,tags:[['p',wallet],['p',wallet]]}])await assert.rejects(()=>f.transport('wss://relay.example',event,{walletPubkey:wallet,clientPubkey:client}));
 await assert.rejects(()=>f.transport('wss://relay.example',request,{walletPubkey:wallet,clientPubkey:'not-a-key'}));
 await assert.rejects(()=>f.transport.info!('wss://relay.example','not-a-key'));assert.equal(f.lookups(),0);assert.equal(f.calls.length,0);
});
test('all DNS answers must be public and socket lookup stays pinned to the original answers',async()=>{
 for(const addresses of [[],[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],[{address:'fd00::1',family:6}],[{address:'8.8.8.8',family:6}]]){const f=fixture({addresses});await assert.rejects(()=>f.transport('wss://relay.example',request,{walletPubkey:wallet,clientPubkey:client}));assert.equal(f.calls.length,0);}
 const f=fixture();sendReply(f);await f.transport('wss://relay.example/path',request,{walletPubkey:wallet,clientPubkey:client});
 const {url,options}=f.calls[0];assert.equal(url,'wss://relay.example/path');assert.equal(options.rejectUnauthorized,true);assert.equal(options.followRedirects,false);assert.equal(options.maxPayload,65536);assert.equal(options.perMessageDeflate,false);assert.equal(options.agent,false);assert.equal(options.servername,'relay.example');
 const addresses=await new Promise((resolve,reject)=>options.lookup('relay.example',{all:true},(error:any,value:any)=>error?reject(error):resolve(value)));assert.deepEqual(addresses,[{address:'8.8.8.8',family:4},{address:'2606:4700:4700::1111',family:6}]);assert.equal(f.lookups(),1);assert.equal('Cookie' in (options.headers??{}),false);clean(f);
});
test('response query precedes publish and all peer/request/subscription bindings are required',async()=>{
 const f=fixture();f.socket.onSend=frame=>{if(frame[0]==='EVENT')queueMicrotask(()=>{
  const sub=f.socket.sent[0][1];f.socket.message(['EVENT','other',reply()]);f.socket.message(['EVENT',sub,reply({pubkey:'77'.repeat(32)})]);f.socket.message(['EVENT',sub,reply({kind:1})]);f.socket.message(['EVENT',sub,reply({tags:[['e','99'.repeat(32)],['p',client]]})]);f.socket.message(['EVENT',sub,reply({tags:[['e',requestId],['p',wallet]]})]);f.socket.message(['EVENT',sub,reply()]);
 });};
 const actual=await f.transport('wss://relay.example',request,{walletPubkey:wallet,clientPubkey:client});assert.deepEqual(actual,reply());assert.deepEqual(f.socket.sent.map(v=>v[0]),['REQ','EVENT','CLOSE']);
 const filter=f.socket.sent[0][2];assert.deepEqual(filter,{kinds:[23195],authors:[wallet],'#e':[requestId],'#p':[client],limit:1});assert.deepEqual(f.socket.sent[1],['EVENT',request]);clean(f);
});
test('mutable callers cannot change the request snapshot while DNS resolves',async()=>{
 const event=structuredClone(request),peers={walletPubkey:wallet,clientPubkey:client};const f=fixture();sendReply(f);const pending=f.transport('wss://relay.example',event,peers);event.id='88'.repeat(32);event.content='changed';peers.walletPubkey='99'.repeat(32);await pending;assert.deepEqual(f.socket.sent[1],['EVENT',request]);clean(f);
});
test('deadline covers stalled DNS and handshake; explicit abort cleans the owned socket',async()=>{
 for(const config of [{hangDns:true},{hangOpen:true}]){const f=fixture({...config,timeout:10});await assert.rejects(()=>f.transport('wss://relay.example',request,{walletPubkey:wallet,clientPubkey:client}));if(f.calls.length)clean(f);}
 const controller=new AbortController(),f=fixture({signal:controller.signal});const pending=f.transport('wss://relay.example',request,{walletPubkey:wallet,clientPubkey:client});await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(pending);clean(f);
 const c=new AbortController();c.abort();const never=fixture({signal:c.signal});await assert.rejects(()=>never.transport('wss://relay.example',request,{walletPubkey:wallet,clientPubkey:client}));assert.equal(never.calls.length,0);
});
test('socket errors and relay refusal expose only a fixed error and clear listeners',async()=>{
 for(const mode of ['error','close','auth','refusal','redirect','send-error']){
  const f=fixture();f.socket.onSend=frame=>{if(frame[0]==='EVENT')queueMicrotask(()=>{
   const sub=f.socket.sent[0][1];if(mode==='error')f.socket.emit('error',new Error('private URL/token'));else if(mode==='close')f.socket.emit('close',1006,Buffer.from('private'));else if(mode==='auth')f.socket.message(['AUTH','secret challenge']);else if(mode==='refusal')f.socket.message(['CLOSED',sub,'private refusal']);else if(mode==='redirect')f.socket.emit('unexpected-response',{}, {resume(){},destroy(){}});else f.socket.emit('error',new Error('private send failure'));
  });};
  await assert.rejects(()=>f.transport('wss://relay.example/path?access=fictional-private',request,{walletPubkey:wallet,clientPubkey:client}),{message:'NWC relay unavailable or response invalid.'});clean(f);
 }
});
test('frame bytes, frame count, malformed JSON and binary frames are bounded',async()=>{
 for(const mode of ['large','flood','malformed','binary']){const f=fixture();f.socket.onSend=frame=>{if(frame[0]==='EVENT')queueMicrotask(()=>{if(mode==='large')f.socket.emit('message',Buffer.alloc(65537),false);if(mode==='flood')for(let i=0;i<65;i++)f.socket.message(['NOTICE','unrelated']);if(mode==='malformed')f.socket.emit('message',Buffer.from('not-json'),false);if(mode==='binary')f.socket.message(['NOTICE'],true);});};await assert.rejects(()=>f.transport('wss://relay.example',request,{walletPubkey:wallet,clientPubkey:client}));clean(f);}
});
test('relay rejection of the published event fails before the ordinary deadline',async()=>{
 const f=fixture();f.socket.onSend=frame=>{if(frame[0]==='EVENT')queueMicrotask(()=>f.socket.message(['OK',requestId,false,'private denial']));};await assert.rejects(()=>f.transport('wss://relay.example',request,{walletPubkey:wallet,clientPubkey:client}));clean(f);
});
test('info queries select the newest matching wallet announcement at EOSE without publishing',async()=>{
 const f=fixture();f.socket.onSend=frame=>{if(frame[0]==='REQ')queueMicrotask(()=>{const sub=frame[1];f.socket.message(['EVENT',sub,reply({kind:13194,created_at:2,content:'older'})]);f.socket.message(['EVENT',sub,reply({kind:13194,created_at:3,content:'latest'})]);f.socket.message(['EVENT',sub,reply({pubkey:client,kind:13194,created_at:4,content:'wrong wallet'})]);f.socket.message(['EOSE',sub]);});};
 const result=await f.transport.info!('wss://relay.example',wallet);assert.equal(result.content,'latest');assert.deepEqual(f.socket.sent.map(v=>v[0]),['REQ','CLOSE']);assert.deepEqual(f.socket.sent[0][2],{kinds:[13194],authors:[wallet],limit:8});clean(f);
});
test('missing info or stopped listener never returns another wallet or synthetic announcement',async()=>{
 const f=fixture();f.socket.onSend=frame=>{if(frame[0]==='REQ')queueMicrotask(()=>f.socket.message(['EOSE',frame[1]]));};await assert.rejects(()=>f.transport.info!('wss://relay.example',wallet));clean(f);
});
test('real loopback WebSocket exchange closes its own socket without error/listener leaks',async()=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 let owned:WebSocket|undefined;const messages:string[]=[];
 server.on('connection',socket=>{let sub='';socket.on('message',raw=>{const f=JSON.parse(raw.toString());messages.push(f[0]);if(f[0]==='REQ')sub=f[1];if(f[0]==='EVENT')socket.send(JSON.stringify(['EVENT',sub,reply()]));});});
 const transport=createNwcTransport({timeoutMs:1000,lookup:(async()=>[{address:'8.8.8.8',family:4}]) as any,connect:()=>owned=new WebSocket(`ws://127.0.0.1:${address.port}`)});
 try{assert.deepEqual(await transport('wss://relay.example',request,{walletPubkey:wallet,clientPubkey:client}),reply());if(owned!.readyState!==WebSocket.CLOSED)await once(owned!,'close');assert.equal(owned!.readyState,WebSocket.CLOSED);assert.equal(owned!.listenerCount('error'),0);assert.equal(owned!.listenerCount('message'),0);assert.deepEqual(messages.slice(0,2),['REQ','EVENT']);}
 finally{for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
