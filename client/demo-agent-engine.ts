import {MarmotClient,createApplicationMessageIntent,createChatRumor,deserializeApplicationData,getGroupMemberPubkeys,type GenericKeyValueStore,type MarmotGroup,type NostrNetworkInterface} from '@internet-privacy/marmot-ts';
import {generateSecretKey,getPublicKey,finalizeEvent,type Event,type Filter} from 'nostr-tools';
import {v2 as nip44} from 'nostr-tools/nip44';
import {createMarmotBrowserStore} from './marmot-engine';
import type {DemoChannel} from '../shared/demo-agents';

export type DemoAgentRole='client'|'accountant';
export interface DemoTeamMember {role:DemoAgentRole;name:string;pubkey:string}
export interface DemoTeamMessage {id:string;sender:string;role:DemoAgentRole|'human';text:string;createdAt:number;replyTo?:string}
export interface DemoTeamNetwork {publish(event:Event):Promise<void>;query(filters:Filter[]):Promise<Event[]>;watch?(filters:Filter[],notify:()=>void):()=>void;close?():void}
export interface DemoPendingMessage {id:string;text:string;queuedAt:number}
export interface DemoHumanParticipant {
  readonly pubkey:string;
  readonly issue?:string;
  prepare():Promise<void>;
  connect(members:DemoTeamMember[]):Promise<{groupId:string;nostrGroupId:string}>;
  send(target:DemoAgentRole|'both',text:string):Promise<void>;
  sync():Promise<void>;
  messages():DemoTeamMessage[];
  pendingMessage():DemoPendingMessage|undefined;
  onMessages?(listener:()=>void):()=>void;
  onIssue?(listener:(message:string)=>void):()=>void;
  dispose():Promise<void>;
}
const hex=(bytes:Uint8Array)=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const pubkeyPattern=/^[0-9a-f]{64}$/;
const leases=new Set<string>();
const kindSet=new Set([30443,1059,445,5,10050,10002]);
function scope<T>(store:GenericKeyValueStore<unknown>,prefix:string):GenericKeyValueStore<T>{return {async getItem(k){return await store.getItem(prefix+k) as T|null;},async setItem(k,v){await store.setItem(prefix+k,v);return v;},removeItem:k=>store.removeItem(prefix+k),async clear(){for(const k of await store.keys())if(k.startsWith(prefix))await store.removeItem(k);},async keys(){return (await store.keys()).filter(k=>k.startsWith(prefix)).map(k=>k.slice(prefix.length));}};}
/** Standard NIP01 delivery to this application's one relay endpoint. Keys stay local. */
export function createDemoWebSocketNetwork(relayUrl:string):DemoTeamNetwork{
  const url=new URL(relayUrl);
  if(!/^\/marmot(?:\/[A-Za-z0-9_-]{43})?$/.test(url.pathname)||url.search||url.hash||url.username||url.password||!['ws:','wss:'].includes(url.protocol))throw new Error('Invalid demo relay address.');
  if(url.protocol==='ws:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Demo messages require encrypted relay transport.');
  if(typeof location!=='undefined'&&url.host!==location.host)throw new Error('Demo messages use the same application origin.');
  let closed=false,socket:WebSocket|undefined,opening:Promise<WebSocket>|undefined;
  type Pending={frame:unknown[];kind:'publish'|'query';rows:Event[];bytes:number;finish:(error?:Error)=>void};
  const pending=new Map<string,Pending>(),watches=new Map<string,{filters:Filter[];notify:()=>void;seen:Set<string>}>();
  const failure=()=>new Error('The demo relay connection closed. Refresh messages to retry.');
  function disconnect(){socket=undefined;opening=undefined;for(const item of [...pending.values()])item.finish(failure());}
  function connect():Promise<WebSocket>{
    if(closed)return Promise.reject(new Error('Demo transport is closed.'));
    if(socket?.readyState===WebSocket.OPEN)return Promise.resolve(socket);
    if(opening)return opening;
    opening=new Promise((resolve,reject)=>{const current=new WebSocket(url);socket=current;const timer=setTimeout(()=>{current.close();reject(failure());},10000);
      current.onopen=()=>{clearTimeout(timer);for(const[id,watch]of watches)current.send(JSON.stringify(['REQ',id,...watch.filters]));resolve(current);};
      current.onerror=()=>{clearTimeout(timer);reject(failure());};
      current.onclose=()=>{clearTimeout(timer);reject(failure());if(socket===current)disconnect();};
      current.onmessage=message=>{if(typeof message.data!=='string'||message.data.length>2*1024*1024){current.close();return;}try{const value=JSON.parse(message.data);if(!Array.isArray(value)||typeof value[1]!=='string')return;const watch=watches.get(value[1]);if(watch&&value[0]==='EVENT'){const event=value[2];if(typeof event?.id!=='string'||watch.seen.has(event.id))return;if(watch.seen.size>=128)watch.seen.delete(watch.seen.values().next().value!);watch.seen.add(event.id);watch.notify();return;}
        const id=value[0]==='OK'?'event:'+value[1]:'query:'+value[1],item=pending.get(id);if(!item)return;item.bytes+=message.data.length;if(item.bytes>2*1024*1024)return item.finish(new Error('The demo relay response exceeded its limit.'));
        if(item.kind==='publish'&&value[0]==='OK')item.finish(value[2]===true?undefined:new Error('The demo relay declined this event.'));
        if(item.kind==='query'){if(value[0]==='EVENT'){if(item.rows.length>=128)return item.finish(new Error('The demo relay response exceeded its limit.'));item.rows.push(value[2]);}else if(value[0]==='EOSE')item.finish();else if(value[0]==='CLOSED')item.finish(new Error('The demo relay declined this query.'));}
      }catch{current.close();}};
    });return opening;
  }
  async function exchange(frame:unknown[],kind:'publish'|'query'):Promise<Event[]>{const connection=await connect();if(pending.size>=8)throw new Error('The demo relay is busy. Try again shortly.');const id=kind==='publish'?'event:'+(frame[1] as Event).id:'query:'+frame[1];if(pending.has(id))throw new Error('This demo event is already being delivered.');return new Promise((resolve,reject)=>{const rows:Event[]=[];const timer=setTimeout(()=>finish(new Error('The demo relay did not respond. Refresh messages to retry.')),12000);function finish(error?:Error){if(!pending.delete(id))return;clearTimeout(timer);if(kind==='query'&&connection.readyState===WebSocket.OPEN)connection.send(JSON.stringify(['CLOSE',frame[1]]));error?reject(error):resolve(rows);}pending.set(id,{frame,kind,rows,bytes:0,finish});try{connection.send(JSON.stringify(frame));}catch{finish(failure());}});}
  return {async publish(event){await exchange(['EVENT',event],'publish');},query:filters=>exchange(['REQ',crypto.randomUUID(),...filters],'query'),watch(filters,notify){if(watches.size>=2)throw new Error('Demo subscription limit reached.');const id=crypto.randomUUID();watches.set(id,{filters,notify,seen:new Set()});if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(['REQ',id,...filters]));else void connect().catch(()=>{});return()=>{watches.delete(id);if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(['CLOSE',id]));};},close(){closed=true;watches.clear();const current=socket;disconnect();current?.close();}};

}

export async function createDemoHumanParticipant(options:{namespace:string;channel?:DemoChannel;relayUrl:string;network?:DemoTeamNetwork;storage?:GenericKeyValueStore<unknown>}):Promise<DemoHumanParticipant>{
  const channel=options.channel??'group';
  if(!['client','accountant','group'].includes(channel))throw new Error('Invalid demo conversation channel.');
  if(!options.namespace||options.namespace.length>512)throw new Error('A demo identity namespace is required.');
  const hash=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('quiet-ledger-team:'+options.namespace))));
  if(leases.has(hash))throw new Error('This demo conversation is already open.');leases.add(hash);
  let unlock:(()=>void)|undefined,ownStore:Awaited<ReturnType<typeof createMarmotBrowserStore>>|undefined,secret:Uint8Array|undefined,group:MarmotGroup|undefined,sdk:MarmotClient|undefined;
  const network=options.network??createDemoWebSocketNetwork(options.relayUrl);
  let disposed=false,queue:Promise<unknown>=Promise.resolve();const listeners=new Set<()=>void>(),issueListeners=new Set<(message:string)=>void>();let membershipIssue:string|undefined;let unwatch:(()=>void)|undefined;
  try{
    if(typeof navigator!=='undefined'&&navigator.locks)unlock=await new Promise<()=>void>((resolve,reject)=>{void navigator.locks.request('quiet-ledger-team:'+hash,{ifAvailable:true},async lock=>{if(!lock){reject(new Error('This demo is already open in another tab.'));return;}await new Promise<void>(release=>resolve(release));}).catch(reject);});
    const storage=options.storage??(ownStore=await createMarmotBrowserStore());const base='demo-team:'+hash+':';const identity=scope<unknown>(storage,base+'meta:');const roomBase=channel==='group'?base:base+'room:'+channel+':';const meta=scope<unknown>(storage,roomBase+'meta:');
    const previous=await identity.getItem('identity');secret=previous instanceof Uint8Array&&previous.length===32?new Uint8Array(previous):generateSecretKey();if(!previous)await identity.setItem('identity',new Uint8Array(secret));const signingSecret=secret,pubkey=getPublicKey(secret);
    let members:DemoTeamMember[]=[];const savedHistory=await meta.getItem('history');let history:DemoTeamMessage[]=Array.isArray(savedHistory)?savedHistory.slice(-128) as DemoTeamMessage[]:[];
    function assertRoster(){if(membershipIssue)throw new Error(membershipIssue);if(!group)return;const expected=[pubkey,...members.map(member=>member.pubkey)].sort();if(JSON.stringify(getGroupMemberPubkeys(group.state).sort())===JSON.stringify(expected))return;membershipIssue='The conversation membership changed. This room is disconnected. Reset the team to start a new room.';unwatch?.();network.close?.();for(const listener of issueListeners)listener(membershipIssue);throw new Error(membershipIssue);}
    function remember(rumor:ReturnType<typeof createChatRumor>){assertRoster();if(!group||rumor.kind!==9||typeof rumor.content!=='string'||rumor.content.length>3000||history.some(m=>m.id===rumor.id))return;const member=members.find(m=>m.pubkey===rumor.pubkey);if(rumor.pubkey!==pubkey&&!member)return;if(!getGroupMemberPubkeys(group.state).includes(rumor.pubkey))return;const references=new Set(rumor.tags.filter(tag=>['e','q'].includes(tag[0])&&pubkeyPattern.test(tag[1]??'')).map(tag=>tag[1]));const replyTo=references.size===1?[...references][0]:undefined;history=[...history,{...(replyTo?{replyTo}:{}),id:rumor.id,sender:rumor.pubkey,role:(rumor.pubkey===pubkey?'human':member!.role) as DemoTeamMessage['role'],text:rumor.content,createdAt:rumor.created_at}].slice(-128);}
    const outbox=scope<{event:Event;application?:ReturnType<typeof createChatRumor>;queuedAt?:number}>(storage,roomBase+'outbox:');let activeApplication:ReturnType<typeof createChatRumor>|undefined,pendingMessage:DemoPendingMessage|undefined;
    for(const key of await outbox.keys()){const entry=await outbox.getItem(key);if(entry?.application)pendingMessage={id:entry.application.id,text:entry.application.content,queuedAt:entry.queuedAt??entry.application.created_at*1000};}
    async function deliver(event:Event){if(event.kind===445)assertRoster();await network.publish(event);const entry=await outbox.getItem(event.id);if(entry?.application){remember(entry.application);await meta.setItem('history',history);}await outbox.removeItem(event.id);if(entry?.application?.id===pendingMessage?.id)pendingMessage=undefined;}
    const route=(relays:string[])=>{if(!relays.length||relays.some(r=>r!==options.relayUrl))throw new Error('Unexpected demo delivery route.');};
    const native:NostrNetworkInterface={async publish(relays,event){route(relays);if(event.kind===445)assertRoster();if(!kindSet.has(event.kind)||new TextEncoder().encode(JSON.stringify(event)).length>24576)throw new Error('Demo event exceeds transport bounds.');const old=await outbox.getItem(event.id);const entry=old??{event,...(event.kind===445&&activeApplication?{application:activeApplication,queuedAt:Date.now()}:{})};await outbox.setItem(event.id,entry);if(entry.application)pendingMessage={id:entry.application.id,text:entry.application.content,queuedAt:entry.queuedAt??entry.application.created_at*1000};await deliver(event);return {[options.relayUrl]:{from:options.relayUrl,ok:true}};},async request(relays,filters){route(relays);return network.query(Array.isArray(filters)?filters:[filters]);},subscription(){return {subscribe(){return {unsubscribe(){}};}};},async getUserInboxRelays(){return [options.relayUrl];}};
    sdk=new MarmotClient({clientId:hash,signer:{getPublicKey:()=>pubkey,signEvent:e=>finalizeEvent(e,signingSecret),nip44:{encrypt:(peer,text)=>nip44.encrypt(text,nip44.utils.getConversationKey(signingSecret,peer)),decrypt:(peer,text)=>nip44.decrypt(text,nip44.utils.getConversationKey(signingSecret,peer))}},network:native,groupStateStore:scope(storage,base+'groups:'),keyPackageStore:scope(storage,base+'packages:'),inviteStore:scope(storage,base+'invites:'),ingestStateStore:scope(storage,base+'ingest:'),rewindStore:scope(storage,base+'rewind:'),removedMarkerStore:scope(storage,base+'removed:')});const client=sdk;
    function listen(g:MarmotGroup){g.on('stateChanged',()=>{try{assertRoster();}catch{/* The issue callback disconnects the UI without throwing into MLS state updates. */}});g.on('applicationMessage',data=>{try{remember(deserializeApplicationData(data));}catch{/* Only authenticated kind9 chat becomes UI text. */}});}
    const saved=await meta.getItem('group') as {id:string;members:DemoTeamMember[]}|null;if(saved){members=saved.members;group=await client.groups.get(saved.id);listen(group);}
    const serial=<T>(operation:()=>Promise<T>)=>{const result=queue.then(()=>{if(disposed)throw new Error('Demo identity is closed.');return operation();});queue=result.catch(()=>{});return result;};
    async function flush(){for(const key of await outbox.keys()){const pending=await outbox.getItem(key);if(pending)await deliver(pending.event);}}
    async function sync(){assertRoster();await flush();if(!group?.groupData?.nostrGroupId)return;const tag=hex(group.groupData.nostrGroupId);const rows=await network.query([{kinds:[445],'#h':[tag],limit:40}]);for await(const _item of group.ingest(rows.filter(e=>e.kind===445&&e.tags.filter(t=>t[0]==='h').length===1&&e.tags.some(t=>t[0]==='h'&&t[1]===tag)))){assertRoster();}assertRoster();await meta.setItem('history',history);for(const listener of listeners)listener();}
    function watchGroup(){if(unwatch||!group?.groupData?.nostrGroupId||!network.watch)return;const tag=hex(group.groupData.nostrGroupId);unwatch=network.watch([{kinds:[445],'#h':[tag],limit:40}],()=>{void serial(sync).catch(()=>{});});}
    const descriptor=()=>{if(!group?.groupData?.nostrGroupId)throw new Error('Demo group is unavailable.');return {groupId:hex(group.id),nostrGroupId:hex(group.groupData.nostrGroupId)};};
    return {pubkey,get issue(){return membershipIssue;},prepare:()=>serial(async()=>{await client.keyPackages.ensurePublished({relays:[options.relayUrl],client:'Quiet Ledger fictional demo'});}),connect:requested=>serial(async()=>{
      const roles=channel==='group'?['client','accountant']:[channel];if(requested.length!==roles.length||new Set(requested.map(m=>m.role)).size!==roles.length||requested.some(m=>!roles.includes(m.role)||!pubkeyPattern.test(m.pubkey))||new Set([pubkey,...requested.map(m=>m.pubkey)]).size!==roles.length+1)throw new Error('Distinct participant identities and the expected room roles are required.');
      const expected=[pubkey,...requested.map(m=>m.pubkey)].sort();if(group){if(JSON.stringify(getGroupMemberPubkeys(group.state).sort())!==JSON.stringify(expected))throw new Error('The saved participant roster does not match this demo.');await flush();watchGroup();return descriptor();}
      const used=new Set(await identity.getItem('used-packages') as string[]??[]);const packages:Event[]=[];for(const member of requested){const rows=await network.query([{kinds:[30443,5],authors:[member.pubkey],limit:40}]);const deleted=new Set(rows.filter(e=>e.kind===5&&e.pubkey===member.pubkey).flatMap(e=>e.tags.filter(t=>t[0]==='e').map(t=>t[1])));const deletedSlots=new Set(rows.filter(e=>e.kind===5&&e.pubkey===member.pubkey).flatMap(e=>e.tags.filter(t=>t[0]==='a').map(t=>t[1])));const candidate=rows.filter(e=>e.kind===30443&&e.pubkey===member.pubkey&&!used.has(e.id)&&!deleted.has(e.id)&&!e.tags.some(t=>t[0]==='d'&&deletedSlots.has('30443:'+e.pubkey+':'+t[1]))).sort((a,b)=>b.created_at-a.created_at||a.id.localeCompare(b.id))[0];if(!candidate)throw new Error('A demo participant has not published a fresh key package. Try connecting again.');packages.push(candidate);}
      members=requested.map(m=>({...m}));group=await client.groups.create(channel==='group'?'Quiet Ledger fictional demo group':'Quiet Ledger fictional demo '+channel,{description:'Fictional business conversation. No real funds.',relays:[options.relayUrl],adminPubkeys:[pubkey],invitees:packages});if(JSON.stringify(getGroupMemberPubkeys(group.state).sort())!==JSON.stringify(expected))throw new Error('Unexpected demo group membership.');listen(group);await identity.setItem('used-packages',[...used,...packages.map(event=>event.id)]);await meta.setItem('group',{id:group.idStr,members});if(group.pendingWelcomes.length)throw new Error('The encrypted demo invitation needs another delivery attempt.');watchGroup();return descriptor();
    }),send:(target,text)=>serial(async()=>{if(!['client','accountant','both'].includes(target)||(channel!=='group'&&target!==channel))throw new Error('Invalid target role for this room.');const value=text.trim();if(!value||value.length>1492)throw new Error('Use a message of 1 to 1492 characters.');if(!group)throw new Error('Prepare the demo conversation first.');await sync();assertRoster();const rumor=createChatRumor({pubkey,content:value,tags:[['nonce',hex(crypto.getRandomValues(new Uint8Array(16)))]]});activeApplication=rumor;try{await client.groups.send(group.id,createApplicationMessageIntent(rumor));}finally{activeApplication=undefined;}remember(rumor);await meta.setItem('history',history);}),sync:()=>serial(sync),onMessages(listener){listeners.add(listener);return()=>{listeners.delete(listener);};},onIssue(listener){issueListeners.add(listener);if(membershipIssue)listener(membershipIssue);return()=>{issueListeners.delete(listener);};},pendingMessage(){return pendingMessage?{...pendingMessage}:undefined;},messages(){if(disposed)throw new Error('Demo identity is closed.');return history.map(m=>({...m}));},async dispose(){if(disposed)return;disposed=true;unwatch?.();listeners.clear();issueListeners.clear();network.close?.();for(const g of client.groups.loaded)g.dispose();await queue.catch(()=>{});client.groups.removeAllListeners();client.invites.removeAllListeners();ownStore?.close();secret?.fill(0);unlock?.();leases.delete(hash);}};
  }catch(error){network.close?.();group?.dispose();ownStore?.close();secret?.fill(0);unlock?.();leases.delete(hash);throw error;}
}
