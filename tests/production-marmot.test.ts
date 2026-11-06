import test from 'node:test';
import assert from 'node:assert/strict';
import {InMemoryKeyValueStore} from '@internet-privacy/marmot-ts/extra';
import {finalizeEvent,generateSecretKey,getPublicKey,matchFilters,verifyEvent,type Event,type Filter} from 'nostr-tools';
import {v2 as nip44} from 'nostr-tools/nip44';
import {MarmotClient,type NostrNetworkInterface} from '@internet-privacy/marmot-ts';
import {proposeRemoveUser} from '../node_modules/@internet-privacy/marmot-ts/dist/client/group/proposals/remove-member.js';
import {openMarmotKeyring,restoreMarmotKeyring} from '../client/marmot-keyring.js';
import * as module from '../integrations/marmot-client.js';
const relays=['wss://relay.us.whitenoise.chat/','wss://relay.eu.whitenoise.chat/'];
function network(){
 const events:Event[]=[],additional:Event[]=[],attempts:Event[]=[];let offline=false,dropWelcomes=false;
 const api:NostrNetworkInterface={
  async publish(routes,event){attempts.push(structuredClone(event));if(offline||dropWelcomes&&event.kind===1059)return Object.fromEntries(routes.map(from=>[from,{from,ok:false,uncertain:true}]));assert.ok(verifyEvent(event));if(!events.some(item=>item.id===event.id))events.push(structuredClone(event));return Object.fromEntries(routes.map(from=>[from,{from,ok:true}]));},
  async request(_routes,filters){if(offline)throw new Error('Fictional relay offline');const list=Array.isArray(filters)?filters:[filters];return list.flatMap(filter=>[...events,...additional].filter(event=>matchFilters([filter as Filter],event)).sort((a,b)=>b.created_at-a.created_at||b.id.localeCompare(a.id)).slice(0,filter.limit??500)).map(event=>structuredClone(event));},
  subscription(){return{subscribe(){return{unsubscribe(){}};}};},async getUserInboxRelays(){return relays;},
 };
 return{api,events,additional,attempts,setOffline(value:boolean){offline=value;},setDropWelcomes(value:boolean){dropWelcomes=value;}};
}
async function pair(namespace:string){
 assert.equal(typeof module.createProductionMarmot,'function','Production Marmot engine is missing.');
 const relay=network(),storage=new InMemoryKeyValueStore<unknown>(),aSecret=generateSecretKey(),bSecret=generateSecretKey();
 const aOptions={namespace:namespace+'-a',network:relay.api,storage,secretKey:aSecret,relays},bOptions={namespace:namespace+'-b',network:relay.api,storage,secretKey:bSecret,relays};
 const a=await module.createProductionMarmot(aOptions),b=await module.createProductionMarmot(bOptions);return{a,b,relay,storage,aOptions,bOptions};
}
for(const reverse of [false,true])test(`independent SDK peers invite ${reverse?'B to A':'A to B'} and exchange real Unicode free text`,async()=>{
 const {a,b,relay}=await pair('bidirectional-'+reverse);try{
  const [sender,receiver]=reverse?[b,a]:[a,b];await receiver.ensurePublished();const group=await sender.invite(receiver.pubkey);
  assert.equal(group.peerPubkey,receiver.pubkey);assert.equal(group.state,'pending');const invites=await receiver.invitations();assert.equal(invites.length,1);assert.equal(invites[0].peerPubkey,sender.pubkey);
  await assert.rejects(receiver.accept(invites[0].id,receiver.pubkey),/peer|distinct|match/i);assert.equal(receiver.groups().length,0);
  const joined=await receiver.accept(invites[0].id,sender.pubkey);assert.equal(joined.id,group.id);assert.equal(joined.state,'joined');
  const sent=await sender.send(group.id,'Hello — 안녕하세요. 🦫\nInvoice discussion only.');assert.equal(sent.state,'sent');await receiver.sync();
  assert.equal(receiver.messages(group.id).at(-1)?.text,sent.text);assert.equal(receiver.messages(group.id).at(-1)?.sender,sender.pubkey);
  await receiver.send(group.id,'Thanks, I can reply from my own participant.');await sender.sync();assert.equal(sender.groups()[0].state,'joined');assert.equal(sender.messages(group.id).length,2);
  assert.equal(JSON.stringify(relay.events).includes('Invoice discussion only'),false);assert.equal(JSON.stringify(relay.events).includes('bidirectional'),false);
  assert.deepEqual((await receiver.invitations()),[]);assert.ok(relay.events.some(event=>event.kind===1059));
 }finally{await a.dispose();await b.dispose();}
});
test('contexts isolate rooms with the same peer and single-writer reservation survives disposal',async()=>{
 const {a,b,aOptions}=await pair('context');try{
  await b.ensurePublished();const first=await a.invite(b.pubkey,{context:'private-invoice-a'}),second=await a.invite(b.pubkey,{context:'private-invoice-b'});assert.notEqual(first.id,second.id);assert.deepEqual(await a.invite(b.pubkey,{context:'private-invoice-a'}),first);
  await assert.rejects(module.createProductionMarmot(aOptions),/already|writer|open/i);await assert.rejects(a.send('0'.repeat(64),'Wrong room'),/group|conversation/i);
  for(const text of ['', ' '.repeat(5),'x'.repeat(8001),'bad\0control'])await assert.rejects(a.send(first.id,text),/text|message/i);
  await assert.rejects(a.invite('nsec1secret'),/public|peer|hex/i);
 }finally{await a.dispose();await b.dispose();}
 const reopened=await module.createProductionMarmot(aOptions);assert.equal(reopened.groups().length,2);await reopened.dispose();
});
test('history exceeds old 128-event limits, paginates, deduplicates and survives participant restart',async()=>{
 let {a,b,relay,aOptions,bOptions}=await pair('history');try{
  await b.ensurePublished();const group=await a.invite(b.pubkey),invite=(await b.invitations())[0];await b.accept(invite.id,a.pubkey);
  for(let i=0;i<140;i++)await a.send(group.id,`Fictional history ${i}`);
  await b.sync();const all=b.messages(group.id,{limit:100}),older=b.messages(group.id,{limit:100,before:all[0].id});assert.equal(all.length+older.length,140);
  const last=relay.events.findLast(event=>event.kind===445)!;relay.additional.push(last,last,{...last,sig:'0'.repeat(128)});await b.sync();assert.equal(b.messages(group.id,{limit:100}).length,100);
  const originalDevice=b.deviceId,originalKey=b.pubkey;await a.dispose();await b.dispose();a=await module.createProductionMarmot(aOptions);b=await module.createProductionMarmot(bOptions);assert.equal(b.deviceId,originalDevice);assert.equal(b.pubkey,originalKey);
  await b.sync();assert.equal(b.messages(group.id,{limit:100}).length,100);await b.send(group.id,'Still usable after restart');await a.sync();assert.equal(a.messages(group.id).at(-1)?.text,'Still usable after restart');
 }finally{await a.dispose();await b.dispose();}
});
test('unknown relay publication retries exact ciphertext after reconnect without duplicate application messages',async()=>{
 let {a,b,relay,aOptions}=await pair('reconnect');try{
  await b.ensurePublished();const group=await a.invite(b.pubkey),invite=(await b.invitations())[0];await b.accept(invite.id,a.pubkey);
  relay.setOffline(true);const result=await a.send(group.id,'A fictional offline message');assert.equal(result.state,'unknown');await a.dispose();a=await module.createProductionMarmot(aOptions);relay.setOffline(false);await a.sync();await b.sync();await a.sync();
  assert.equal(b.messages(group.id).filter(item=>item.text===result.text).length,1);assert.equal(a.messages(group.id).find(item=>item.id===result.id)?.state,'sent');
  await a.send(group.id,'A new generation after retry and restart');await b.sync();assert.equal(b.messages(group.id).length,2);
 }finally{await a.dispose();await b.dispose();}
});

test('actual SDK group, key-package and message state stay encrypted through keyring close and reopen',async()=>{
 const relay=network(),raw=new InMemoryKeyValueStore<unknown>(),passphrase='fictional encrypted messaging password';
 let aRing=await openMarmotKeyring({namespace:'encrypted-a',passphrase,storage:raw}),bRing=await openMarmotKeyring({namespace:'encrypted-b',passphrase,storage:raw});
 let a=await module.createProductionMarmot({namespace:'encrypted-a',network:relay.api,storage:aRing.storage,secretKey:aRing.secretKey,relays}),b=await module.createProductionMarmot({namespace:'encrypted-b',network:relay.api,storage:bRing.storage,secretKey:bRing.secretKey,relays});
 try{
  await b.ensurePublished();const group=await a.invite(b.pubkey),invite=(await b.invitations())[0];await b.accept(invite.id,a.pubkey);await a.send(group.id,'Private encrypted fixture body');await b.sync();
  assert.equal(JSON.stringify(await Promise.all((await raw.keys()).map(key=>raw.getItem(key)))).includes('Private encrypted fixture body'),false);
  await a.dispose();await b.dispose();await aRing.dispose();await bRing.dispose();aRing=await openMarmotKeyring({namespace:'encrypted-a',passphrase,storage:raw});bRing=await openMarmotKeyring({namespace:'encrypted-b',passphrase,storage:raw});
  a=await module.createProductionMarmot({namespace:'encrypted-a',network:relay.api,storage:aRing.storage,secretKey:aRing.secretKey,relays});b=await module.createProductionMarmot({namespace:'encrypted-b',network:relay.api,storage:bRing.storage,secretKey:bRing.secretKey,relays});
  await b.send(group.id,'Usable encrypted SDK restart');await a.sync();assert.equal(a.messages(group.id).at(-1)?.text,'Usable encrypted SDK restart');
 }finally{await a.dispose();await b.dispose();await aRing.dispose();await bRing.dispose();}
});

test('current authenticated membership is available independently of historical messages',async()=>{
 const {a,b}=await pair('members');try{
  await b.ensurePublished();const group=await a.invite(b.pubkey);assert.equal(typeof a.members,'function','Current membership authority is missing.');assert.deepEqual(new Set(a.members(group.id)),new Set([a.pubkey,b.pubkey]));
  assert.throws(()=>a.members('0'.repeat(64)),/group|conversation/i);await a.dispose();assert.throws(()=>a.members(group.id),/disposed|closed/i);
 }finally{await a.dispose();await b.dispose();}
});

test('a three-member Welcome is refused without consuming the live key package, then a direct invite still works',async()=>{
 const{a,b,relay}=await pair('rejected-group'),secret=generateSecretKey(),pubkey=getPublicKey(secret);
 const stranger=new MarmotClient({clientId:pubkey,network:relay.api,signer:{getPublicKey:()=>pubkey,signEvent:draft=>finalizeEvent(draft,secret),nip44:{encrypt:(peer,text)=>nip44.encrypt(text,nip44.utils.getConversationKey(secret,peer)),decrypt:(peer,text)=>nip44.decrypt(text,nip44.utils.getConversationKey(secret,peer))}},groupStateStore:new InMemoryKeyValueStore(),keyPackageStore:new InMemoryKeyValueStore()});
 try{
  await a.ensurePublished();await b.ensurePublished();const packages=relay.events.filter(event=>event.kind===30443&&[a.pubkey,b.pubkey].includes(event.pubkey));await stranger.groups.create('Unexpected group',{relays,adminPubkeys:[pubkey],invitees:packages});
  const invite=(await b.invitations()).find(invite=>invite.peerPubkey===pubkey)!;await assert.rejects(b.accept(invite.id,pubkey),/two.member|direct/i);assert.equal(b.groups().length,0);
  const direct=await a.invite(b.pubkey),good=(await b.invitations()).find(invite=>invite.peerPubkey===a.pubkey)!;await b.accept(good.id,a.pubkey);assert.equal(b.groups()[0].id,direct.id);
 }finally{await a.dispose();await b.dispose();for(const group of stranger.groups.loaded)group.dispose();secret.fill(0);}
});

test('incompatible signed and expired MLS key packages cannot create a conversation',async()=>{
 const{a,b,relay,bOptions}=await pair('invalid-package');try{
  await b.ensurePublished();const original=relay.events.find(event=>event.kind===30443)!;
  const incompatible=finalizeEvent({kind:30443,created_at:original.created_at,tags:original.tags.map(tag=>tag[0]==='mls_protocol_version'?['mls_protocol_version','invalid']:tag),content:original.content},bOptions.secretKey);
  relay.events.splice(relay.events.indexOf(original),1,incompatible);await assert.rejects(a.invite(b.pubkey),/compatible|current|key package/i);assert.equal(a.groups().length,0);
  relay.events.splice(relay.events.indexOf(incompatible),1,original);const originalNow=Date.now;try{Date.now=()=>originalNow()+370*86400000;await assert.rejects(a.invite(b.pubkey),/compatible|current|key package/i);}finally{Date.now=originalNow;}
  assert.equal(a.groups().length,0);
 }finally{await a.dispose();await b.dispose();}
});

test('catch-up preserves messages sharing the oldest second at a relay page boundary',async()=>{
 const{a,b,relay}=await pair('boundary');try{
  await b.ensurePublished();const group=await a.invite(b.pubkey),invite=(await b.invitations())[0];await b.accept(invite.id,a.pubkey);
  await a.send(group.id,'Boundary message one');await a.send(group.id,'Boundary message two');const encrypted=relay.events.filter(event=>event.kind===445).slice(-2),timestamp=Math.floor(Date.now()/1000)-20;
  for(let index=relay.events.length-1;index>=0;index--)if(relay.events[index].kind===445)relay.events.splice(index,1);
  for(const event of encrypted)relay.events.push(finalizeEvent({kind:445,created_at:timestamp,tags:event.tags,content:event.content},generateSecretKey()));
  const noiseKey=generateSecretKey();for(let index=0;index<499;index++)relay.events.push(finalizeEvent({kind:445,created_at:timestamp+1,tags:encrypted[0].tags,content:'invalid ciphertext '+index},noiseKey));
  await b.sync();assert.deepEqual(new Set(b.messages(group.id).map(message=>message.text)),new Set(['Boundary message one','Boundary message two']));
 }finally{await a.dispose();await b.dispose();}
});

test('an interrupted invitation binding resumes the existing SDK group and private context after restart',async()=>{
 let{a,b,aOptions,storage}=await pair('interrupted');await a.dispose();let fail=true;
 const wrapped={getItem:(key:string)=>storage.getItem(key),async setItem(key:string,value:unknown){if(fail&&key.endsWith(':metadata:bindings')){fail=false;throw new Error('Fictional binding persistence failure');}return storage.setItem(key,value);},removeItem:(key:string)=>storage.removeItem(key),keys:()=>storage.keys(),clear:()=>storage.clear()};
 aOptions={...aOptions,storage:wrapped as any};a=await module.createProductionMarmot(aOptions);try{
  await b.ensurePublished();await assert.rejects(a.invite(b.pubkey,{context:'private recovery context'}),/binding persistence failure/);await a.dispose();a=await module.createProductionMarmot(aOptions);
  assert.equal(a.groups().length,1);const group=await a.invite(b.pubkey,{context:'private recovery context'});assert.equal(group.id,a.groups()[0].id);
  const invite=(await b.invitations())[0];await b.accept(invite.id,a.pubkey);await a.send(group.id,'Recovered same encrypted conversation');await b.sync();assert.equal(b.messages(group.id).at(-1)?.text,'Recovered same encrypted conversation');
 }finally{await a.dispose();await b.dispose();}
});

test('disposing an actual engine preserves the keyring identity for encrypted backup and fresh membership restore',async()=>{
 const relay=network(),passphrase='fictional export after SDK dispose',raw=new InMemoryKeyValueStore<unknown>();
 const ring=await openMarmotKeyring({namespace:'export-engine',passphrase,storage:raw}),engine=await module.createProductionMarmot({namespace:'export-engine',network:relay.api,storage:ring.storage,secretKey:ring.secretKey,relays});
 try{
  await engine.ensurePublished();const publicKey=engine.pubkey,device=engine.deviceId;await engine.dispose();assert.equal(getPublicKey(ring.secretKey),publicKey);const backup=await ring.exportBackup();
  const restored=await restoreMarmotKeyring({namespace:'restored-engine',passphrase,backup,storage:new InMemoryKeyValueStore(),confirmSourceStopped:true,mode:'identity-only-rejoin'});
  const newEngine=await module.createProductionMarmot({namespace:'restored-engine',network:relay.api,storage:restored.storage,secretKey:restored.secretKey,relays});try{assert.equal(newEngine.pubkey,publicKey);assert.notEqual(newEngine.deviceId,device);assert.deepEqual(newEngine.groups(),[]);}finally{await newEngine.dispose();await restored.dispose();}
 }finally{await engine.dispose();await ring.dispose();}
});

test('an interrupted accepted invitation restores the adopted group without forking its MLS ratchet',async()=>{
 let{a,b,bOptions,storage}=await pair('interrupted-accept');await b.dispose();let fail=true;
 const wrapped={getItem:(key:string)=>storage.getItem(key),async setItem(key:string,value:unknown){if(fail&&key.endsWith(':metadata:bindings')){fail=false;throw new Error('Fictional acceptance binding failure');}return storage.setItem(key,value);},removeItem:(key:string)=>storage.removeItem(key),keys:()=>storage.keys(),clear:()=>storage.clear()};
 bOptions={...bOptions,storage:wrapped as any};b=await module.createProductionMarmot(bOptions);try{
  await b.ensurePublished();const group=await a.invite(b.pubkey),invite=(await b.invitations())[0];await assert.rejects(b.accept(invite.id,a.pubkey),/acceptance binding failure/);await b.dispose();b=await module.createProductionMarmot(bOptions);
  assert.equal(b.groups()[0]?.id,group.id);assert.equal(b.groups()[0]?.state,'joined');await b.send(group.id,'Recovered accepted group');await a.sync();assert.equal(a.messages(group.id).at(-1)?.text,'Recovered accepted group');
 }finally{await a.dispose();await b.dispose();}
});

test('removed membership retires one room, preserves its history and leaves unrelated rooms usable across restart',async()=>{
 let{a,b,relay,aOptions}=await pair('retirement');const secret=generateSecretKey(),pubkey=getPublicKey(secret);
 const admin=new MarmotClient({clientId:pubkey,network:relay.api,signer:{getPublicKey:()=>pubkey,signEvent:draft=>finalizeEvent(draft,secret),nip44:{encrypt:(peer,text)=>nip44.encrypt(text,nip44.utils.getConversationKey(secret,peer)),decrypt:(peer,text)=>nip44.decrypt(text,nip44.utils.getConversationKey(secret,peer))}},groupStateStore:new InMemoryKeyValueStore(),keyPackageStore:new InMemoryKeyValueStore()});
 try{
  await b.ensurePublished();const healthy=await a.invite(b.pubkey),healthyInvite=(await b.invitations())[0];await b.accept(healthyInvite.id,a.pubkey);
  await a.ensurePublished();const keyPackage=relay.events.findLast(event=>event.kind===30443&&event.pubkey===a.pubkey)!;
  const changed=await admin.groups.create('Fictional removable room',{relays,adminPubkeys:[pubkey],invitees:[keyPackage]}),invite=(await a.invitations()).find(invite=>invite.peerPubkey===pubkey)!;
  await a.accept(invite.id,pubkey);await a.send(changed.idStr,'History before removal');relay.setOffline(true);const pending=await a.send(changed.idStr,'Queued before removal'),prepared=relay.attempts.findLast(event=>event.kind===445)!;relay.setOffline(false);await admin.groups.commit(changed.id,{extraProposals:[proposeRemoveUser(a.pubkey)]});
  await a.sync();assert.equal(a.groups().find(group=>group.id===changed.idStr)?.state,'retired');assert.ok(a.messages(changed.idStr).some(message=>message.text==='History before removal'));assert.equal(a.messages(changed.idStr).find(message=>message.id===pending.id)?.state,'failed');assert.equal(relay.attempts.filter(event=>event.id===prepared.id).length,1);assert.throws(()=>a.members(changed.idStr),/retired|membership|inactive/i);await assert.rejects(a.send(changed.idStr,'Forbidden after removal'),/retired|membership|inactive/i);
  await a.send(healthy.id,'Healthy room survives removal');await b.sync();assert.equal(b.messages(healthy.id).at(-1)?.text,'Healthy room survives removal');
  await a.dispose();a=await module.createProductionMarmot(aOptions);assert.equal(a.groups().find(group=>group.id===changed.idStr)?.state,'retired');assert.ok(a.messages(changed.idStr).some(message=>message.text==='History before removal'));await a.send(healthy.id,'Healthy room survives reopen');await b.sync();assert.equal(b.messages(healthy.id).at(-1)?.text,'Healthy room survives reopen');
  await admin.keyPackages.ensurePublished({relays,client:'Fictional admin'});const replacement=await a.invite(pubkey,{context:'invite:'+invite.id});assert.notEqual(replacement.id,changed.idStr);assert.equal(replacement.state,'pending');
 }finally{await a.dispose();await b.dispose();for(const group of admin.groups.loaded)group.dispose();secret.fill(0);}
});

test('an unacknowledged Welcome fails explicitly and retries exact prepared ciphertext after restart',async()=>{
 let{a,b,relay,aOptions}=await pair('welcome-retry');try{
  await b.ensurePublished();relay.setDropWelcomes(true);await assert.rejects(a.invite(b.pubkey),/welcome|invitation|acknowledge/i);
  assert.equal(relay.events.filter(event=>event.kind===1059).length,0);assert.equal(a.groups().length,1);const groupId=a.groups()[0].id,original=relay.attempts.filter(event=>event.kind===1059);assert.equal(original.length,1);
  await a.dispose();a=await module.createProductionMarmot(aOptions);relay.setDropWelcomes(false);const retried=await a.invite(b.pubkey);assert.equal(retried.id,groupId);
  assert.deepEqual(relay.attempts.filter(event=>event.kind===1059).map(event=>JSON.stringify(event)),[JSON.stringify(original[0]),JSON.stringify(original[0])]);
  const invite=(await b.invitations())[0];assert.ok(invite);await b.accept(invite.id,a.pubkey);await a.send(groupId,'Delivered through durable Welcome retry');await b.sync();assert.equal(b.messages(groupId).at(-1)?.text,'Delivered through durable Welcome retry');
 }finally{await a.dispose();await b.dispose();}
});

test('failed durable ciphertext preparation rejects before publication and preserves a failed local draft',async()=>{
 let{a,b,aOptions,storage,relay}=await pair('failed-prepare');await a.dispose();let fail=false;
 const wrapped={getItem:(key:string)=>storage.getItem(key),async setItem(key:string,value:unknown){if(fail&&key.includes(':outbox:')){fail=false;throw new Error('Fictional ciphertext preparation failure');}return storage.setItem(key,value);},removeItem:(key:string)=>storage.removeItem(key),keys:()=>storage.keys(),clear:()=>storage.clear()};
 aOptions={...aOptions,storage:wrapped as any};a=await module.createProductionMarmot(aOptions);try{
  await b.ensurePublished();const group=await a.invite(b.pubkey),invite=(await b.invitations())[0];await b.accept(invite.id,a.pubkey);const before=relay.attempts.length;fail=true;
  await assert.rejects(a.send(group.id,'Keep this fictional draft'),/persist|prepar|publish|draft/i);assert.equal(relay.attempts.length,before);assert.equal(a.messages(group.id).at(-1)?.state,'failed');assert.equal(a.messages(group.id).at(-1)?.text,'Keep this fictional draft');
  await a.dispose();a=await module.createProductionMarmot(aOptions);await a.sync();await b.sync();assert.equal(b.messages(group.id).length,0);await a.send(group.id,'A new explicit action');await b.sync();assert.equal(b.messages(group.id).at(-1)?.text,'A new explicit action');
 }finally{await a.dispose();await b.dispose();}
});

test('a Welcome accepted before acknowledgement persistence fails retries the identical signed gift wrap',async()=>{
 let{a,b,aOptions,storage,relay}=await pair('welcome-ack-write');await a.dispose();let fail=true;
 const wrapped={getItem:(key:string)=>storage.getItem(key),async setItem(key:string,value:unknown){if(fail&&key.includes(':welcomes:')&&(value as {state?:string}).state==='acknowledged'){fail=false;throw new Error('Fictional acknowledgement persistence failure');}return storage.setItem(key,value);},removeItem:(key:string)=>storage.removeItem(key),keys:()=>storage.keys(),clear:()=>storage.clear()};
 aOptions={...aOptions,storage:wrapped as any};a=await module.createProductionMarmot(aOptions);try{
  await b.ensurePublished();await assert.rejects(a.invite(b.pubkey),/welcome|invitation|acknowledge/i);const first=relay.events.find(event=>event.kind===1059)!;assert.ok(first);const id=a.groups()[0].id;
  await a.dispose();a=await module.createProductionMarmot(aOptions);assert.equal((await a.invite(b.pubkey)).id,id);assert.deepEqual(relay.attempts.filter(event=>event.kind===1059).map(event=>event.id),[first.id,first.id]);assert.equal((await b.invitations()).length,1);
 }finally{await a.dispose();await b.dispose();}
});

test('legacy pending bindings without prepared Welcome evidence retire explicitly and allow a fresh invitation',async()=>{
 let{a,b,aOptions,storage,relay}=await pair('legacy-pending');try{
  await b.ensurePublished();const original=await a.invite(b.pubkey);await a.dispose();
  const bindingKey=(await storage.keys()).find(key=>key.endsWith(':metadata:bindings'))!,bindings=await storage.getItem(bindingKey) as {deliveryId?:string}[];for(const binding of bindings)delete binding.deliveryId;await storage.setItem(bindingKey,bindings);
  for(const key of await storage.keys())if(key.includes(':welcomes:'))await storage.removeItem(key);
  a=await module.createProductionMarmot(aOptions);await assert.rejects(a.invite(b.pubkey),/retired|recoverable|fresh/i);assert.equal(a.groups()[0].state,'retired');const next=await a.invite(b.pubkey);assert.notEqual(next.id,original.id);assert.equal(next.state,'pending');assert.equal(relay.events.filter(event=>event.kind===1059).length,2);
 }finally{await a.dispose();await b.dispose();}
});

test('legacy joined bindings remain usable without newly added Welcome delivery metadata',async()=>{
 let{a,b,aOptions,storage,relay}=await pair('legacy-joined');try{
  await b.ensurePublished();const original=await a.invite(b.pubkey),invite=(await b.invitations())[0];await b.accept(invite.id,a.pubkey);await b.send(original.id,'Legacy peer membership evidence');await a.sync();await a.dispose();
  for(const key of await storage.keys())if(key.endsWith(':metadata:bindings')){const bindings=await storage.getItem(key) as {deliveryId?:string}[];for(const binding of bindings)delete binding.deliveryId;await storage.setItem(key,bindings);}else if(key.includes(':welcomes:'))await storage.removeItem(key);
  a=await module.createProductionMarmot(aOptions);assert.equal((await a.invite(b.pubkey)).id,original.id);assert.equal(relay.events.filter(event=>event.kind===1059).length,1);await a.send(original.id,'Existing joined ratchet remains usable');await b.sync();assert.equal(b.messages(original.id).at(-1)?.text,'Existing joined ratchet remains usable');
 }finally{await a.dispose();await b.dispose();}
});

test('a Welcome cannot reach the network before its exact ciphertext is stored durably',async()=>{
 let{a,b,aOptions,storage,relay}=await pair('welcome-prepare');await a.dispose();let fail=true;
 const wrapped={getItem:(key:string)=>storage.getItem(key),async setItem(key:string,value:unknown){if(fail&&key.includes(':welcomes:')){fail=false;throw new Error('Fictional Welcome preparation failure');}return storage.setItem(key,value);},removeItem:(key:string)=>storage.removeItem(key),keys:()=>storage.keys(),clear:()=>storage.clear()};
 aOptions={...aOptions,storage:wrapped as any};a=await module.createProductionMarmot(aOptions);try{
  await b.ensurePublished();await assert.rejects(a.invite(b.pubkey),/welcome|prepared|durab/i);assert.equal(relay.attempts.filter(event=>event.kind===1059).length,0);assert.equal((await b.invitations()).length,0);
  const group=await a.invite(b.pubkey);assert.equal(group.id,a.groups()[0].id);assert.equal(relay.attempts.filter(event=>event.kind===1059).length,1);assert.equal((await b.invitations()).length,1);
 }finally{await a.dispose();await b.dispose();}
});

test('failure to save a send intent cannot leave a false Sent message after restart',async()=>{
 let{a,b,aOptions,storage,relay}=await pair('send-intent-failure');await a.dispose();let fail=false;
 const wrapped={getItem:(key:string)=>storage.getItem(key),async setItem(key:string,value:unknown){if(fail&&key.includes(':metadata:send:')){fail=false;throw new Error('Fictional send-intent persistence failure');}return storage.setItem(key,value);},removeItem:(key:string)=>storage.removeItem(key),keys:()=>storage.keys(),clear:()=>storage.clear()};
 aOptions={...aOptions,storage:wrapped as any};a=await module.createProductionMarmot(aOptions);try{
  await b.ensurePublished();const group=await a.invite(b.pubkey),invite=(await b.invitations())[0];await b.accept(invite.id,a.pubkey);const before=relay.attempts.length;fail=true;await assert.rejects(a.send(group.id,'An unsaved draft remains in the caller'),/send.intent persistence failure/);assert.equal(relay.attempts.length,before);
  await a.dispose();a=await module.createProductionMarmot(aOptions);assert.equal(a.messages(group.id).length,0);await a.sync();await b.sync();assert.equal(b.messages(group.id).length,0);
 }finally{await a.dispose();await b.dispose();}
});
