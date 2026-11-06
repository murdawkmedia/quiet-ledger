import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,generateSecretKey} from 'nostr-tools';
import * as module from '../client/marmot-relay.js';
test('relay URLs require reviewed public WSS endpoints and reject local or credential-bearing destinations',()=>{
 assert.equal(typeof module.validateMarmotRelays,'function','Production relay adapter is missing.');
 assert.deepEqual(module.validateMarmotRelays(['wss://relay.us.whitenoise.chat']),['wss://relay.us.whitenoise.chat/']);
 for(const relay of ['ws://relay.us.whitenoise.chat','wss://127.0.0.1','wss://[::1]','wss://192.168.1.2','wss://169.254.169.254','wss://localhost','wss://printer.local','wss://user:pass@relay.us.whitenoise.chat','wss://relay.us.whitenoise.chat/?token=secret','wss://unreviewed.example.org'])assert.throws(()=>module.validateMarmotRelays([relay]),/relay|WSS|public|reviewed/i);
});
test('redundant relay publication requires actual OK and queries verify signatures and filters',async()=>{
 assert.equal(typeof module.createMarmotRelayNetwork,'function','Production relay adapter is missing.');
 const event=finalizeEvent({kind:10050,created_at:Math.floor(Date.now()/1000),tags:[['relay','wss://relay.us.whitenoise.chat/']],content:''},generateSecretKey());const opened:string[]=[];
 class Socket {
  readyState=1;onopen:(()=>void)|null=null;onmessage:((event:{data:string})=>void)|null=null;onerror:(()=>void)|null=null;onclose:(()=>void)|null=null;
  constructor(public url:string){opened.push(url);queueMicrotask(()=>this.onopen?.());}
  send(data:string){const frame=JSON.parse(data);queueMicrotask(()=>{
   if(frame[0]==='EVENT')this.onmessage?.({data:JSON.stringify(['OK',frame[1].id,this.url.includes('.us.'),'fictional result'])});
   if(frame[0]==='REQ'){this.onmessage?.({data:JSON.stringify(['EVENT',frame[1],{...event,sig:'0'.repeat(128)}])});this.onmessage?.({data:JSON.stringify(['EVENT',frame[1],event])});this.onmessage?.({data:JSON.stringify(['EOSE',frame[1]])});}
  });}
  close(){this.readyState=3;}
 }
 const relays=['wss://relay.us.whitenoise.chat/','wss://relay.eu.whitenoise.chat/'],network=module.createMarmotRelayNetwork({relays,WebSocket:Socket as any,timeoutMs:100});try{
  const result=await network.publish(relays,event);assert.equal(Object.values(result).filter((item:any)=>item.ok).length,1);assert.equal(opened.length,2);
  assert.deepEqual(await network.request(relays,[{kinds:[10050],authors:[event.pubkey],limit:2}]),[JSON.parse(JSON.stringify(event))]);
  assert.deepEqual(await network.request(relays,[{kinds:[30443],authors:[event.pubkey],limit:2}]),[]);
  await assert.rejects(network.request(['wss://127.0.0.1/'],[{kinds:[10050],limit:1}]),/relay|public|reviewed/i);
  await assert.rejects(network.request(relays,[{kinds:[10050],limit:10001}]),/filter|bound|limit/i);
 }finally{network.dispose();}
});

test('cached nostr verification flags cannot admit a subsequently modified signature',async()=>{
 const event=finalizeEvent({kind:10050,created_at:Math.floor(Date.now()/1000),tags:[],content:''},generateSecretKey());event.sig='0'.repeat(128);
 let opened=0;class Socket{constructor(){opened++;throw new Error('No socket should open for an invalid event.');}}
 const relays=['wss://relay.us.whitenoise.chat/'],network=module.createMarmotRelayNetwork({relays,WebSocket:Socket as any,timeoutMs:20});try{await assert.rejects(network.publish(relays,event),/signed|event|bounds/i);assert.equal(opened,0);}finally{network.dispose();}
});
