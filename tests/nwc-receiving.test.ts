import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {finalizeEvent,getPublicKey,verifyEvent,type NostrEvent,nip04,nip44} from 'nostr-tools';
import * as bolt11 from 'bolt11';
import {parseNwcConnection,verifyNwcReceiving,createNwcReceivingAdapter} from '../integrations/nwc-receiving.js';
import type {NwcTransport} from '../server/nwc-transport.js';
import type {ReceivingContext,ReceivingIntent} from '../shared/receiving.js';
const walletKey=Uint8Array.from(Buffer.from('0'.repeat(63)+'7','hex'));
const secret='0'.repeat(63)+'9',walletPubkey=getPublicKey(walletKey),clientPubkey=getPublicKey(Buffer.from(secret,'hex'));
const uri=`nostr+walletconnect://${walletPubkey}?relay=${encodeURIComponent('wss://relay.example.com')}&secret=${secret}`;
const sec=Math.floor(Date.now()/1000),preimage='31'.repeat(32),hash=createHash('sha256').update(Buffer.from(preimage,'hex')).digest('hex');
const context=(extra:Partial<ReceivingContext>={}):ReceivingContext=>({requestId:'fictional-request',idempotencyKey:'fictional-key',method:'lightning',amount:21,currency:'SAT',expectedAtomic:'21',createdAt:new Date((sec-1)*1000).toISOString(),expiresAt:new Date((sec+900)*1000).toISOString(),mode:'live',...extra});
function invoice(msat='21000',network='bc',timestamp=sec,expiry=600){return bolt11.sign(bolt11.encode({network:{bech32:network,pubKeyHash:network==='bc'?0:111,scriptHash:network==='bc'?5:196,validWitnessVersions:[0,1]},timestamp,millisatoshis:msat,tags:[{tagName:'payment_hash',data:hash},{tagName:'description',data:'Fictional invoice'},{tagName:'expire_time',data:expiry}]}),'0'.repeat(63)+'1').paymentRequest!;}
interface FixtureOptions{legacy?:boolean;info?:Record<string,unknown>;result?:Record<string,unknown>;paid?:boolean;mutateEvent?:(e:NostrEvent,request:NostrEvent)=>NostrEvent;makeFail?:boolean;noInfo?:boolean;badInfo?:boolean}
function fixture(options:FixtureOptions={}){
 const calls:{method:string;params:any;event:NostrEvent}[]=[];let paid=options.paid??false;
 const mode=options.legacy?'nip04':'nip44_v2';
 const transport:NwcTransport=async(_relay,event)=>{
  assert.equal(event.kind,23194);assert.equal(event.pubkey,clientPubkey);assert.ok(verifyEvent(JSON.parse(JSON.stringify(event))));
  const enc=event.tags.find(t=>t[0]==='encryption')?.[1]??'nip04';assert.equal(enc,mode);
  const plaintext=enc==='nip04'?nip04.decrypt(walletKey,event.pubkey,event.content):nip44.v2.decrypt(event.content,nip44.v2.utils.getConversationKey(walletKey,event.pubkey));
  const input=JSON.parse(plaintext);calls.push({...input,event});
  assert.ok(['get_info','make_invoice','lookup_invoice'].includes(input.method),'no spending/history/balance operation');
  if(input.method==='make_invoice'&&options.makeFail)throw new Error('FICTIONAL_SECRET_SHOULD_NOT_LEAK');
  const info={network:'mainnet',pubkey:bolt11.decode(invoice()).payeeNodeKey,methods:['get_info','make_invoice','lookup_invoice','pay_invoice'],...options.info};
  const isPaid=paid&&input.method==='lookup_invoice';
  const tx={type:'incoming',invoice:invoice(),payment_hash:hash,amount:21000,created_at:sec,expires_at:sec+600,settled_at:isPaid?sec:null,preimage:isPaid?preimage:null,...options.result};
  const body=JSON.stringify({result_type:input.method,result:input.method==='get_info'?info:tx});
  const content=mode==='nip04'?nip04.encrypt(walletKey,event.pubkey,body):nip44.v2.encrypt(body,nip44.v2.utils.getConversationKey(walletKey,event.pubkey));
  const reply=finalizeEvent({kind:23195,created_at:sec,tags:[['e',event.id],['p',event.pubkey],...(mode==='nip04'?[]:[['encryption',mode]])],content},walletKey);
  return options.mutateEvent?options.mutateEvent(reply,event):reply;
 };
 if(!options.noInfo)transport.info=async()=>{const e=finalizeEvent({kind:13194,created_at:sec,tags:options.legacy?[]:[['encryption','nip44_v2 nip04']],content:'get_info make_invoice lookup_invoice pay_invoice'},walletKey);return options.badInfo?{...e,sig:'0'.repeat(128)}:e;};
 return {transport,calls,setPaid:()=>{paid=true;}};
}
const make=(f:ReturnType<typeof fixture>,now=()=>sec*1000)=>createNwcReceivingAdapter({id:'fictional-nwc',connectionUri:uri,transport:f.transport,now});

test('NWC URI parses only public wss and valid connection identity',()=>{
 const p=parseNwcConnection(uri);assert.equal(p.walletPubkey,walletPubkey);assert.equal(p.clientPubkey,clientPubkey);assert.equal(p.relayUrl,'wss://relay.example.com/');
 for(const bad of [uri+'&secret='+secret,uri+'&unknown=x',uri.replace('wss%3A%2F%2Frelay.example.com','ws%3A%2F%2Frelay.example.com'),uri.replace('relay.example.com','127.0.0.1'),uri.replace(secret,'0'.repeat(64)),uri.replace(walletPubkey,'f'.repeat(64)),uri+'#fragment'])assert.throws(()=>parseNwcConnection(bad));
});
test('signed info negotiates NIP44, legacy NIP04 remains supported; verification creates no invoices',async()=>{
 for(const legacy of [false,true]){const f=fixture({legacy});assert.equal((await verifyNwcReceiving({connectionUri:uri,transport:f.transport})).network,'mainnet');assert.deepEqual(f.calls.map(c=>c.method),['get_info']);}
});
test('verification fails closed without signed info, on bad signature or unsupported capabilities/network',async()=>{
 for(const options of [{noInfo:true},{badInfo:true},{info:{network:'testnet'}},{info:{methods:['get_info','make_invoice']}}]){const f=fixture(options);await assert.rejects(verifyNwcReceiving({connectionUri:uri,transport:f.transport}));assert.ok(!f.calls.some(c=>c.method==='make_invoice'));}
});
test('responses need valid signer, signature, request correlation and receiver tag',async()=>{
 for(const mutateEvent of [
  (e:NostrEvent)=>({...e,sig:'0'.repeat(128)}),
  (e:NostrEvent)=>finalizeEvent({...e,tags:e.tags.map(t=>t[0]==='e'?['e','ab'.repeat(32)]:t)},walletKey),
  (e:NostrEvent)=>finalizeEvent({...e,tags:e.tags.map(t=>t[0]==='p'?['p','cd'.repeat(32)]:t)},walletKey),
  (e:NostrEvent)=>finalizeEvent({...e,created_at:sec-999},walletKey),
  (e:NostrEvent)=>finalizeEvent({...e,kind:23194},walletKey),
 ])await assert.rejects(verifyNwcReceiving({connectionUri:uri,transport:fixture({mutateEvent}).transport}));
});
test('creates exact mainnet Lightning request once under concurrency and caller mutations',async()=>{
 const f=fixture(),adapter=make(f),input=context();const pending=adapter.create(input);input.amount=99;
 const [one,two]=await Promise.all([pending,adapter.create(context())]);assert.deepEqual(one,two);assert.equal(one.request,'lightning:'+invoice());assert.equal(one.cashuWalletHandoff,true);assert.equal(f.calls.filter(c=>c.method==='make_invoice').length,1);
 assert.equal(f.calls.find(c=>c.method==='make_invoice')!.params.amount,21000);
 one.request='modified';assert.equal((await adapter.create(context())).request,'lightning:'+invoice());
 await assert.rejects(adapter.create(context({amount:22,expectedAtomic:'22'})));
});
test('fiat quote preserves invoice currency while receiving exact sats',async()=>{
 const f=fixture(),adapter=make(f);const intent=await adapter.create(context({currency:'CAD',amount:100}));f.setPaid();const observation=await adapter.check(context({currency:'CAD',amount:100}),intent);assert.equal(observation.status,'paid');if(observation.status==='paid'){assert.equal(observation.currency,'CAD');assert.equal(observation.amount,100);}
});
test('lost create response and cold restart never create another invoice',async()=>{
 const f=fixture({makeFail:true}),adapter=make(f);await assert.rejects(adapter.create(context()),e=>e instanceof Error&&!e.message.includes('FICTIONAL_SECRET'));await assert.rejects(adapter.create(context()));assert.equal(f.calls.filter(c=>c.method==='make_invoice').length,1);
 const good=fixture(),original=make(good);await original.create(context());assert.equal((await original.recover!(context())).providerId,hash);const cold=make(good);await assert.rejects(cold.recover!(context()));assert.equal(good.calls.filter(c=>c.method==='make_invoice').length,1);
});
test('pending status never credits and exact signed paid lookup returns original identity',async()=>{
 const f=fixture(),adapter=make(f),intent=await adapter.create(context());assert.equal((await adapter.check(context(),intent)).status,'pending');f.setPaid();assert.deepEqual(await adapter.check(context(),intent),{status:'paid',paymentId:`lightning:mainnet:${hash}`,reference:'fictional-request',amount:21,currency:'SAT'});
});
test('saved intent mutation is review before any provider call',async()=>{
 for(const change of [(v:ReceivingIntent)=>{v.request='lightning:broken';},(v:ReceivingIntent)=>{v.network='testnet';},(v:ReceivingIntent)=>{v.asset='CAD';},(v:ReceivingIntent)=>{v.providerId='bad';},(v:ReceivingIntent)=>{v.opaque!.walletPubkey='ff'.repeat(32);},(v:ReceivingIntent)=>{v.expiresAt=new Date((sec+901)*1000).toISOString();}]){
  const f=fixture(),adapter=make(f),intent=await adapter.create(context());change(intent);const count=f.calls.length;assert.equal((await adapter.check(context(),intent)).status,'review');assert.equal(f.calls.length,count);
 }
});
test('foreign amount, hash, direction, invoice, preimage or times fail closed',async()=>{
 for(const result of [{amount:22000},{payment_hash:'ab'.repeat(32)},{type:'outgoing'},{invoice:invoice('22000')},{preimage:'ff'.repeat(32)},{settled_at:sec+999},{settled_at:sec-999},{expires_at:sec+999}]){
  const f=fixture({paid:true}),adapter=make(f),intent=await adapter.create(context());
  // Mutate lookup only after a valid make response.
  const hostile=fixture({paid:true,result}),checker=make(hostile);
  assert.equal((await checker.check(context(),intent)).status,'review',JSON.stringify(result));
 }
});
test('creation rejects non-mainnet, wrong amount and malformed context before exposure',async()=>{
 for(const result of [{invoice:invoice('22000')},{invoice:invoice('21000','tb')},{payment_hash:'ab'.repeat(32)},{amount:22000},{type:'outgoing'}])await assert.rejects(make(fixture({result})).create(context()));
 for(const input of [context({mode:'test'}),context({expectedAtomic:'21.1'}),context({expectedAtomic:'9007199254740991'}),context({amount:0})])await assert.rejects(make(fixture()).create(input));
});
test('expired checks do not trust misleading Minibits-style created_at settlement times',async()=>{
 const f=fixture({paid:true}),adapter=make(f),intent=await adapter.create(context()),count=f.calls.length;
 const late=make(f,()=>((sec+601)*1000));assert.equal((await late.check(context(),intent)).status,'review');assert.equal(f.calls.length,count);
});

test('nostr-tools cached verification cannot authorize mutated responses',async()=>{
 const f=fixture({mutateEvent:event=>{event.content='tampered after finalizeEvent';return event;}});
 await assert.rejects(verifyNwcReceiving({connectionUri:uri,transport:f.transport}));
});
test('signed info encryption modes and wallet identity are validated before financial commands',async()=>{
 for(const change of [
  (e:NostrEvent)=>finalizeEvent({...e,tags:[['encryption','unknown']]},walletKey),
  (e:NostrEvent)=>finalizeEvent({...e,tags:[['encryption','nip44_v2'],['encryption','nip04']]},walletKey),
  (e:NostrEvent)=>finalizeEvent({...e,content:'get_info lookup_invoice'},walletKey),
  (e:NostrEvent)=>({...e,content:'mutated cached info'}),
 ]){
  const f=fixture(),original=f.transport.info!;f.transport.info=async(...args)=>change(await original(...args));
  await assert.rejects(verifyNwcReceiving({connectionUri:uri,transport:f.transport}));assert.equal(f.calls.length,0);
 }
});
test('pending preimage does not create a paid observation and legacy checks settle normally',async()=>{
 const f=fixture({legacy:true}),adapter=make(f),intent=await adapter.create(context());
 const pending=fixture({legacy:true,result:{preimage}});assert.equal((await make(pending).check(context(),intent)).status,'pending');
 f.setPaid();assert.equal((await adapter.check(context(),intent)).status,'paid');
});
test('provider errors and unsupported response method are redacted',async()=>{
 for(const result of [{error:{code:'FORBIDDEN',message:'FICTIONAL_SECRET_SHOULD_NOT_LEAK'}},{result_type:'pay_invoice',result:{}}]){
  const f=fixture();f.transport=Object.assign(async(_relay:string,event:NostrEvent)=>{
   const content=nip44.v2.encrypt(JSON.stringify(result),nip44.v2.utils.getConversationKey(walletKey,clientPubkey));
   return finalizeEvent({kind:23195,created_at:sec,tags:[['p',clientPubkey],['e',event.id]],content},walletKey);
  },{info:f.transport.info});
  await assert.rejects(verifyNwcReceiving({connectionUri:uri,transport:f.transport}),error=>error instanceof Error&&!error.message.includes('FICTIONAL_SECRET'));
 }
});


test('Minibits multi-relay URIs use one deterministic validated relay without fallback',()=>{
 const multi=uri+'&relay='+encodeURIComponent('wss://second.example.com')+'&relay='+encodeURIComponent('wss://third.example.com');
 assert.equal(parseNwcConnection(multi).relayUrl,'wss://relay.example.com/');
 for(const bad of [multi+'&relay='+encodeURIComponent('wss://fourth.example.com'),uri+'&relay='+encodeURIComponent('wss://relay.example.com/'),uri+'&relay='+encodeURIComponent('wss://127.0.0.1'),uri+'&relay='+encodeURIComponent('wss://receiver.local')])assert.throws(()=>parseNwcConnection(bad));
});

test('state and settlement time must agree; failed or unknown states never credit',async()=>{
 const initial=fixture(),intent=await make(initial).create(context());
 for(const result of [{state:'pending',settled_at:sec,preimage},{state:'accepted',settled_at:sec,preimage},{state:'failed',settled_at:sec,preimage},{state:'expired',settled_at:sec,preimage},{state:'settled',settled_at:null},{state:'unexpected',settled_at:null}]){
  const f=fixture({result});assert.equal((await make(f).check(context(),intent)).status,'review',JSON.stringify(result));
 }
 const pending=fixture({result:{state:'accepted',settled_at:null}});assert.equal((await make(pending).check(context(),intent)).status,'pending');
 const paid=fixture({paid:true,result:{state:'settled'}});assert.equal((await make(paid).check(context(),intent)).status,'paid');
});
test('lookup may omit invoice text when exact original hash and amount remain authenticated',async()=>{
 const initial=fixture(),intent=await make(initial).create(context());
 const f=fixture({paid:true,result:{invoice:undefined}});assert.equal((await make(f).check(context(),intent)).status,'paid');
});

test('a lookup crossing expiry during transport is review even with a claimed old settlement',async()=>{
 let clock=sec*1000;const f=fixture(),adapter=make(f,()=>clock),intent=await adapter.create(context());f.setPaid();const original=f.transport;
 f.transport=Object.assign(async(...args:Parameters<NwcTransport>)=>{const reply=await original(...args);if(f.calls.at(-1)?.method==='lookup_invoice')clock=(sec+601)*1000;return reply;},{info:original.info});
 const checker=make(f,()=>clock);assert.equal((await checker.check(context(),intent)).status,'review');
});

test('invoice creation finishing outside the requested window stays uncertain',async()=>{
 let clock=sec*1000;const f=fixture(),original=f.transport;
 f.transport=Object.assign(async(...args:Parameters<NwcTransport>)=>{const reply=await original(...args);if(f.calls.at(-1)?.method==='make_invoice')clock=(sec+31)*1000;return reply;},{info:original.info});
 const adapter=make(f,()=>clock),input=context({expiresAt:new Date((sec+30)*1000).toISOString()});
 await assert.rejects(adapter.create(input));await assert.rejects(adapter.recover!(input));assert.equal(f.calls.filter(c=>c.method==='make_invoice').length,1);
});

test('expired metadata preflight never publishes make_invoice',async()=>{
 let clock=sec*1000;const f=fixture(),original=f.transport;
 f.transport=Object.assign(async(...args:Parameters<NwcTransport>)=>{const reply=await original(...args);if(f.calls.at(-1)?.method==='get_info')clock=(sec+31)*1000;return reply;},{info:original.info});
 await assert.rejects(make(f,()=>clock).create(context({expiresAt:new Date((sec+30)*1000).toISOString()})));
 assert.equal(f.calls.filter(c=>c.method==='make_invoice').length,0);
});

test('older wallet metadata can accompany a proven on-time settlement',async()=>{
 const intent=await make(fixture()).create(context());
 const tx={created_at:sec-604800,state:'settled',preimage,settled_at:sec};
 for(const [result,expected] of [[tx,'paid'],[{...tx,preimage:null},'review'],[{...tx,invoice:null},'review'],[{...tx,settled_at:sec-1},'review']] as const){
  assert.equal((await make(fixture({paid:true,result})).check(context(),intent)).status,expected);
 }
});
