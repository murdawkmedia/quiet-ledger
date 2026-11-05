import assert from 'node:assert/strict';
import test from 'node:test';
import {MarmotClient,createApplicationMessageIntent,createChatRumor,deserializeApplicationData,getGroupMemberPubkeys,type GenericKeyValueStore} from '@internet-privacy/marmot-ts';
import {generateSecretKey,getPublicKey,finalizeEvent,matchFilters,type Event,type Filter} from 'nostr-tools';
import {v2 as nip44} from 'nostr-tools/nip44';
import {createDemoHumanParticipant,type DemoTeamNetwork} from '../client/demo-agent-engine.js';
class MemoryStore implements GenericKeyValueStore<unknown>{values=new Map<string,unknown>();async getItem(k:string){return structuredClone(this.values.get(k)??null);}async setItem(k:string,v:unknown){this.values.set(k,structuredClone(v));return v;}async removeItem(k:string){this.values.delete(k);}async clear(){this.values.clear();}async keys(){return [...this.values.keys()];}}
const relay='ws://localhost:4419/marmot';
function transport(){const events:Event[]=[];const network:DemoTeamNetwork={async publish(e){if(!events.some(x=>x.id===e.id))events.push(structuredClone(e));},async query(filters){return events.filter(e=>matchFilters(filters as Filter[],e));}};return {events,network};}
function bot(network:DemoTeamNetwork){const secret=generateSecretKey(),pubkey=getPublicKey(secret),storage=new MemoryStore();const n={async publish(_r:string[],event:Event){await network.publish(event);return {[relay]:{from:relay,ok:true}};},async request(_r:string[],filters:Filter[]|Filter){return network.query(Array.isArray(filters)?filters:[filters]);},subscription(){return {subscribe(){return {unsubscribe(){}};}};},async getUserInboxRelays(){return [relay];}};const sdk=new MarmotClient({clientId:pubkey,signer:{getPublicKey:()=>pubkey,signEvent:e=>finalizeEvent(e,secret),nip44:{encrypt:(p,t)=>nip44.encrypt(t,nip44.utils.getConversationKey(secret,p)),decrypt:(p,t)=>nip44.decrypt(t,nip44.utils.getConversationKey(secret,p))}},network:n,groupStateStore:storage as never,keyPackageStore:new MemoryStore() as never,inviteStore:new MemoryStore() as never,ingestStateStore:new MemoryStore() as never,rewindStore:new MemoryStore() as never,removedMarkerStore:new MemoryStore() as never});return {pubkey,sdk};}
test('human establishes three authenticated members and receives both real encrypted replies',async()=>{const t=transport(),riley=bot(t.network),jordan=bot(t.network),storage=new MemoryStore();const human=await createDemoHumanParticipant({namespace:'fictional-demo-browser/room-one',relayUrl:relay,network:t.network,storage});try{await Promise.all([riley.sdk.keyPackages.ensurePublished({relays:[relay]}),jordan.sdk.keyPackages.ensurePublished({relays:[relay]}),human.prepare()]);const room=await human.connect([{role:'client',name:'Riley',pubkey:riley.pubkey},{role:'accountant',name:'Jordan',pubkey:jordan.pubkey}]);assert.match(room.groupId,/^[a-f0-9]+$/);assert.match(room.nostrGroupId,/^[a-f0-9]{64}$/);const groups=[];for(const b of [riley,jordan]){for(const e of t.events.filter(e=>e.kind===1059&&e.tags.some(x=>x[0]==='p'&&x[1]===b.pubkey)))await b.sdk.invites.ingestEvent(e);await b.sdk.invites.decryptGiftWraps();const invite=(await b.sdk.invites.getUnread())[0];assert(invite);const joined=await b.sdk.joinGroupFromWelcome({welcomeRumor:invite});groups.push(joined.group);}await human.send('client','What did we agree to?');for(const [i,b] of [riley,jordan].entries()){const content=i?'Jordan: fictional ledger is open.':'Riley: fictional workshop agreed.';await b.sdk.groups.send(groups[i].id,createApplicationMessageIntent(createChatRumor({pubkey:b.pubkey,content})));}await human.sync();assert.deepEqual(human.messages().filter(m=>m.role!=='human').map(m=>m.role).sort(),['accountant','client']);assert(!JSON.stringify(t.events).includes('fictional ledger is open.'));assert(!JSON.stringify(t.events).includes('What did we agree to?'));}finally{await human.dispose();for(const b of [riley,jordan])for(const g of b.sdk.groups.loaded)g.dispose();}});
test('identity and group state persist, wrong peer roster and invalid message targets fail',async()=>{const t=transport(),storage=new MemoryStore(),a=bot(t.network),b=bot(t.network);let human=await createDemoHumanParticipant({namespace:'fictional-persistence',relayUrl:relay,network:t.network,storage});try{await Promise.all([a.sdk.keyPackages.ensurePublished({relays:[relay]}),b.sdk.keyPackages.ensurePublished({relays:[relay]})]);const members=[{role:'client' as const,name:'Riley',pubkey:a.pubkey},{role:'accountant' as const,name:'Jordan',pubkey:b.pubkey}],room=await human.connect(members),pubkey=human.pubkey;await human.dispose();human=await createDemoHumanParticipant({namespace:'fictional-persistence',relayUrl:relay,network:t.network,storage});assert.equal(human.pubkey,pubkey);assert.deepEqual(await human.connect(members),room);await assert.rejects(human.connect([{...members[0],pubkey:human.pubkey},members[1]]),/identity|member|participant|roster/i);await assert.rejects(human.send('owner' as never,'hello'),/role|target/i);await assert.rejects(human.send('client','x'.repeat(1501)),/length|message|1500/i);}finally{await human.dispose();for(const c of [a,b])for(const g of c.sdk.groups.loaded)g.dispose();}});

test('direct and group rooms share one identity, keep separate histories and preserve exact human text',async()=>{
 const t=transport(),storage=new MemoryStore(),riley=bot(t.network),jordan=bot(t.network),namespace='fictional-separated-rooms';
 const members=[{role:'client' as const,name:'Riley',pubkey:riley.pubkey},{role:'accountant' as const,name:'Jordan',pubkey:jordan.pubkey}];
 let human=await createDemoHumanParticipant({namespace,channel:'client',relayUrl:relay,network:t.network,storage});
 const pubkey=human.pubkey,rooms=new Map<string,{groupId:string;nostrGroupId:string}>();
 try{
  await Promise.all([riley.sdk.keyPackages.ensurePublished({relays:[relay]}),jordan.sdk.keyPackages.ensurePublished({relays:[relay]})]);
  for(const channel of ['client','accountant','group'] as const){
   if(channel==='group')await Promise.all([riley.sdk.keyPackages.create({relays:[relay]}),jordan.sdk.keyPackages.create({relays:[relay]})]);
   if(channel!=='client'){await human.dispose();human=await createDemoHumanParticipant({namespace,channel,relayUrl:relay,network:t.network,storage});}
   assert.equal(human.pubkey,pubkey);assert.deepEqual(human.messages(),[]);
   const peers=channel==='group'?members:members.filter(m=>m.role===channel);rooms.set(channel,await human.connect(peers));
   const joined=[];
   for(const peer of peers){const b=peer.role==='client'?riley:jordan;for(const event of t.events.filter(e=>e.kind===1059&&e.tags.some(tag=>tag[0]==='p'&&tag[1]===b.pubkey)))await b.sdk.invites.ingestEvent(event);await b.sdk.invites.decryptGiftWraps();const invite=(await b.sdk.invites.getUnread()).at(-1);assert(invite);const result=await b.sdk.joinGroupFromWelcome({welcomeRumor:invite});await b.sdk.invites.markAsRead(invite.id);joined.push({bot:b,group:result.group});assert.deepEqual(getGroupMemberPubkeys(result.group.state).sort(),[pubkey,...peers.map(p=>p.pubkey)].sort());}
   const text=`What does your company do? ${channel}`;await human.send(channel==='group'?'both':channel,`  ${text}  `);assert.equal(human.messages().at(-1)?.text,text);const messageId=human.messages().at(-1)!.id;
   for(const {bot:b,group} of joined){let received='';group.on('applicationMessage',data=>{const rumor=deserializeApplicationData(data);if(rumor.pubkey===pubkey)received=rumor.content;});for await(const _item of group.ingest(t.events.filter(e=>e.kind===445&&e.tags.some(tag=>tag[0]==='h'&&tag[1]===rooms.get(channel)!.nostrGroupId)))){}assert.equal(received,text);await b.sdk.groups.send(group.id,createApplicationMessageIntent(createChatRumor({pubkey:b.pubkey,content:`A reply in ${channel}.`,tags:[['e',messageId],['q',messageId]]})));}
   await human.sync();assert.equal(human.messages().length,peers.length+1);assert(human.messages().filter(m=>m.role!=='human').every(m=>m.replyTo===messageId));
   if(channel!=='group')await assert.rejects(human.send(channel==='client'?'accountant':'client','Wrong room.'),/role|target|room/i);
   await assert.rejects(createDemoHumanParticipant({namespace,channel:'group',relayUrl:relay,network:t.network,storage}),/already open/);
  }
  assert.equal(new Set([...rooms.values()].map(room=>room.groupId)).size,3);
  for(const channel of ['client','group','accountant','client'] as const){await human.dispose();human=await createDemoHumanParticipant({namespace,channel,relayUrl:relay,network:t.network,storage});assert.equal(human.pubkey,pubkey);assert.deepEqual(await human.connect(channel==='group'?members:members.filter(m=>m.role===channel)),rooms.get(channel));assert.equal(human.messages().filter(m=>m.role==='human').length,1);assert.equal(human.messages().find(m=>m.role==='human')?.text,`What does your company do? ${channel}`);assert(human.messages().filter(m=>m.role!=='human').every(m=>channel==='group'||m.role===channel));}
 }finally{await human.dispose();for(const b of [riley,jordan])for(const group of b.sdk.groups.loaded)group.dispose();}
});

test('a failed direct delivery keeps its signed outbox isolated until that room reopens',async()=>{
 const t=transport(),storage=new MemoryStore(),a=bot(t.network),b=bot(t.network),namespace='fictional-outbox-isolation';
 let blocked:Event|undefined,fail=false;
 const network:DemoTeamNetwork={...t.network,async publish(event){if(fail&&event.kind===445){blocked=event;throw new Error('Fictional relay outage.');}await t.network.publish(event);}};
 const members=[{role:'client' as const,name:'Riley',pubkey:a.pubkey},{role:'accountant' as const,name:'Jordan',pubkey:b.pubkey}];
 let human=await createDemoHumanParticipant({namespace,channel:'client',relayUrl:relay,network,storage});
 try{
  await Promise.all([a.sdk.keyPackages.ensurePublished({relays:[relay]}),b.sdk.keyPackages.ensurePublished({relays:[relay]})]);
  const room=await human.connect([members[0]]);fail=true;await assert.rejects(human.send('client','Keep this in the Riley room.'),/outage/);assert(blocked);const eventId=blocked.id;await human.dispose();fail=false;
  human=await createDemoHumanParticipant({namespace,channel:'accountant',relayUrl:relay,network,storage});await human.connect([members[1]]);await human.sync();assert.deepEqual(human.messages(),[]);assert(!t.events.some(event=>event.id===eventId));
  await human.dispose();human=await createDemoHumanParticipant({namespace,channel:'client',relayUrl:relay,network,storage});assert.deepEqual(await human.connect([members[0]]),room);assert.equal(t.events.filter(event=>event.id===eventId).length,1);assert.equal(human.messages().at(-1)?.text,'Keep this in the Riley room.');await human.sync();assert.equal(t.events.filter(event=>event.id===eventId).length,1);assert.equal(human.messages().length,1);
 }finally{await human.dispose();for(const bot of [a,b])for(const group of bot.sdk.groups.loaded)group.dispose();}
});

test('a legacy three-member room is never restored as a direct conversation',async()=>{
 const t=transport(),storage=new MemoryStore(),a=bot(t.network),b=bot(t.network),namespace='fictional-legacy-group';
 const members=[{role:'client' as const,name:'Riley',pubkey:a.pubkey},{role:'accountant' as const,name:'Jordan',pubkey:b.pubkey}];
 let human=await createDemoHumanParticipant({namespace,relayUrl:relay,network:t.network,storage});
 try{
  await Promise.all([a.sdk.keyPackages.ensurePublished({relays:[relay]}),b.sdk.keyPackages.ensurePublished({relays:[relay]})]);const group=await human.connect(members);const pubkey=human.pubkey;await human.send('client','An old group message.');await human.dispose();
  human=await createDemoHumanParticipant({namespace,channel:'client',relayUrl:relay,network:t.network,storage});assert.equal(human.pubkey,pubkey);assert.deepEqual(human.messages(),[]);await assert.rejects(human.connect(members),/room roles/);await a.sdk.keyPackages.create({relays:[relay]});const direct=await human.connect([members[0]]);assert.notEqual(direct.groupId,group.groupId);assert.deepEqual(human.messages(),[]);await human.dispose();
  human=await createDemoHumanParticipant({namespace,channel:'group',relayUrl:relay,network:t.network,storage});assert.deepEqual(await human.connect(members),group);assert.equal(human.messages().at(-1)?.text,'An old group message.');
 }finally{await human.dispose();for(const bot of [a,b])for(const group of bot.sdk.groups.loaded)group.dispose();}
});

test('an authenticated membership commit disconnects the room and denies sending to an expanded roster',async()=>{
 const {injectDemoRoomMember}=await import('./demo-conversation-roster.js');
 const t=transport(),storage=new MemoryStore(),a=bot(t.network),b=bot(t.network),human=await createDemoHumanParticipant({namespace:'fictional-roster-change',channel:'client',relayUrl:relay,network:t.network,storage});
 try{
  await Promise.all([a.sdk.keyPackages.ensurePublished({relays:[relay]}),b.sdk.keyPackages.ensurePublished({relays:[relay]})]);const room=await human.connect([{role:'client',name:'Riley',pubkey:a.pubkey}]);
  await injectDemoRoomMember({storage,network:t.network,relayUrl:relay,groupId:room.groupId,memberPubkey:b.pubkey});
  const ciphertextCount=t.events.filter(e=>e.kind===445).length;await assert.rejects(human.send('client','This must not be sent to a larger roster.'),/membership changed|roster/i);assert.equal(t.events.filter(e=>e.kind===445).length,ciphertextCount);await assert.rejects(human.sync(),/membership changed|roster/i);assert(!human.messages().some(message=>message.text==='This must not be sent to a larger roster.'));
 }finally{await human.dispose();for(const peer of [a,b])for(const group of peer.sdk.groups.loaded)group.dispose();}
});
