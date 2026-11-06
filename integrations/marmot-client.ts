import {
 MarmotClient,createApplicationMessageIntent,createChatRumor,getGroupMemberPubkeys,getMemberCount,
 type GenericKeyValueStore,type NostrNetworkInterface,type MarmotGroup,type GroupRumorHistory,type StoredKeyPackage,
} from '@internet-privacy/marmot-ts';
import {InMemoryKeyValueStore,makeKeyValueRumorHistoryFactory} from '@internet-privacy/marmot-ts/extra';
import {finalizeEvent,getPublicKey,verifyEvent,matchFilters,type Event,type Filter} from 'nostr-tools';
import {v2 as nip44} from 'nostr-tools/nip44';
import {validateMarmotRelays} from '../client/marmot-relay.js';
import {reserveProductionMarmotWriter} from '../client/marmot-keyring.js';

const hex=/^[0-9a-f]{64}$/,MAX_HISTORY=5000,MAX_GROUPS=50;
type Rumor=ReturnType<typeof createChatRumor>;
type SdkGroup=MarmotGroup<GroupRumorHistory>;
export interface ProductionMarmotGroup {id:string;peerPubkey:string;state:'pending'|'joined'|'retired'}
export interface ProductionMarmotInvitation {id:string;peerPubkey:string;groupName:string}
export interface ProductionMarmotMessage {id:string;groupId:string;sender:string;text:string;createdAt:number;state:'pending'|'sent'|'unknown'|'failed'}
export interface ProductionMarmotOptions {namespace:string;network:NostrNetworkInterface;storage:GenericKeyValueStore<unknown>;secretKey:Uint8Array;relays:string[];reviewedRelays?:string[]}
export interface ProductionMarmot {
 pubkey:string;deviceId:string;ensurePublished():Promise<void>;
 invite(peerHex:string,options?:{context?:string}):Promise<ProductionMarmotGroup>;
 invitations():Promise<ProductionMarmotInvitation[]>;
 accept(inviteId:string,expectedPeerHex:string):Promise<ProductionMarmotGroup>;
 groups():ProductionMarmotGroup[];members(groupId:string):string[];sync():Promise<void>;
 send(groupId:string,text:string):Promise<ProductionMarmotMessage>;
 messages(groupId:string,options?:{before?:string;limit?:number}):ProductionMarmotMessage[];
 dispose():Promise<void>;
}
interface Binding extends ProductionMarmotGroup {context:string;deliveryId?:string}
interface Outbox {event:Event;relays:string[];groupId:string;rumor:Rumor}
interface InvitationIntent {peer:string;context:string;deliveryId:string}
interface WelcomeRecord extends InvitationIntent {version:1;event:Event;relays:string[];state:'prepared'|'acknowledged'}
class RetiredConversation extends Error {constructor(){super('This conversation is retired because its membership or private state is no longer available.');}}
function scoped<T>(storage:GenericKeyValueStore<unknown>,prefix:string):GenericKeyValueStore<T>{
 const full=prefix+':';return{async getItem(key){return await storage.getItem(full+key) as T|null;},async setItem(key,value){await storage.setItem(full+key,value);return value;},async removeItem(key){await storage.removeItem(full+key);},async keys(){return(await storage.keys()).filter(key=>key.startsWith(full)).map(key=>key.slice(full.length));},async clear(){for(const key of await this.keys())await this.removeItem(key);}};
}
function textValue(value:unknown):string{
 if(typeof value!=='string'||value.length>16000)throw new Error('A plain text message of at most 8000 characters is required.');
 const text=value.replace(/\r\n/g,'\n');if(!text.trim()||text.length>8000||/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text)||new TextDecoder().decode(new TextEncoder().encode(text))!==text)throw new Error('A bounded Unicode plain text message is required.');return text;
}
function signed(event:Event):boolean{try{return JSON.stringify(event).length<=131072&&verifyEvent({id:event.id,pubkey:event.pubkey,created_at:event.created_at,kind:event.kind,tags:event.tags,content:event.content,sig:event.sig});}catch{return false;}}
const publicGroup=({id,peerPubkey,state}:Binding):ProductionMarmotGroup=>({id,peerPubkey,state});
const randomHex=()=>[...crypto.getRandomValues(new Uint8Array(32))].map(byte=>byte.toString(16).padStart(2,'0')).join('');

/** Non-AI native peer messaging. Supplied storage must encrypt persistent private material. */
export async function createProductionMarmot(options:ProductionMarmotOptions):Promise<ProductionMarmot>{
 const relays=validateMarmotRelays(options.relays,options.reviewedRelays),release=await reserveProductionMarmotWriter(options.namespace);
 let sdk:MarmotClient<GroupRumorHistory>|undefined,disposed=false,queue:Promise<unknown>=Promise.resolve();
 const secret=new Uint8Array(options.secretKey);let bindings:Binding[]=[];
 try{
  if(secret.length!==32)throw new Error('A dedicated messaging secret is required.');const pubkey=getPublicKey(secret);
  const scope='production:'+[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(options.namespace)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  const metadata=scoped<unknown>(options.storage,scope+':metadata'),outbox=scoped<Outbox>(options.storage,scope+':outbox'),welcomes=scoped<WelcomeRecord>(options.storage,scope+':welcomes');
  const storedPubkey=await metadata.getItem('pubkey');if(storedPubkey!==null&&storedPubkey!==pubkey)throw new Error('This messaging namespace belongs to another identity.');await metadata.setItem('pubkey',pubkey);
  const storedDevice=await metadata.getItem('device');if(storedDevice!==null&&(typeof storedDevice!=='string'||!hex.test(storedDevice)))throw new Error('Messaging device identity is invalid.');const deviceId=storedDevice as string|null??randomHex();await metadata.setItem('device',deviceId);
  bindings=await metadata.getItem('bindings') as Binding[]??[];if(!Array.isArray(bindings)||bindings.length>MAX_GROUPS)throw new Error('Messaging group bindings are invalid.');
  const cache=new Map<string,ProductionMarmotMessage[]>();let active:{groupId:string;rumor:Rumor;attempted:boolean}|undefined,activeInvitation:InvitationIntent|undefined;
  const saveBindings=()=>metadata.setItem('bindings',bindings.map(binding=>({...binding})));
  const open=()=>{if(disposed)throw new Error('Native messaging participant is disposed.');};
  const serial=<T>(operation:()=>Promise<T>):Promise<T>=>{const result=queue.then(()=>{open();return operation();});queue=result.catch(()=>{});return result;};
  const peerKey=(peer:string)=>{if(!hex.test(peer)||peer===pubkey)throw new Error('A distinct peer public hex key is required.');return peer;};
  const assertGroup=(group:SdkGroup,binding:Binding)=>{
   const members=getGroupMemberPubkeys(group.state);
   const routes=group.relays??[];
   let safe=false;try{safe=routes.length>0&&validateMarmotRelays(routes,relays).length===routes.length;}catch{/* Remote routing changes cannot authorize a new endpoint. */}
   if(group.snapshot.status!=='active'||members.length!==2||getMemberCount(group.state)!==2||!members.includes(pubkey)||!members.includes(binding.peerPubkey)||!safe)throw new RetiredConversation();
  };
  const retire=async(binding:Binding)=>{if(binding.state!=='retired'){binding.state='retired';await saveBindings();}};
  const current=async(id:string)=>{const binding=bindings.find(binding=>binding.id===id);if(!binding)throw new Error('Conversation group not found in this namespace.');if(binding.state==='retired')throw new RetiredConversation();let group:SdkGroup;try{group=await sdk!.groups.get(id);}catch{await retire(binding);throw new RetiredConversation();}try{assertGroup(group,binding);}catch(error){if(error instanceof RetiredConversation){await retire(binding);await refresh(group,binding);}throw error;}return{group,binding};};
  const refresh=async(group:SdkGroup|undefined,binding:Binding)=>{
   if(group&&binding.state!=='retired')try{assertGroup(group,binding);}catch(error){if(!(error instanceof RetiredConversation))throw error;await retire(binding);}
   const stored=scoped<Rumor>(options.storage,scope+':history:'+binding.id);
   const rumors=group?await group.history!.queryRumors({kinds:[9],limit:MAX_HISTORY+1}):(await Promise.all((await stored.keys()).slice(0,MAX_HISTORY+1).map(key=>stored.getItem(key)))).filter((rumor):rumor is Rumor=>rumor!==null&&rumor.kind===9);
   if(rumors.length>MAX_HISTORY)throw new Error('This conversation has reached its retained history limit.');
   const order=await metadata.getItem('order:'+binding.id) as string[]|null??[],ids=new Set(order);let changed=false;const next:ProductionMarmotMessage[]=[];
   for(const rumor of rumors.sort((a,b)=>a.created_at-b.created_at||a.id.localeCompare(b.id))){
    if(![pubkey,binding.peerPubkey].includes(rumor.pubkey))continue;let text:string;try{text=textValue(rumor.content);}catch{continue;}
    if(!ids.has(rumor.id)){order.push(rumor.id);ids.add(rumor.id);changed=true;}
    const state=await metadata.getItem('send:'+rumor.id) as ProductionMarmotMessage['state']|null;
    next.push({id:rumor.id,groupId:binding.id,sender:rumor.pubkey,text,createdAt:rumor.created_at,state:state??(rumor.pubkey===pubkey?'unknown':'sent')});
    if(rumor.pubkey===binding.peerPubkey&&binding.state==='pending'){binding.state='joined';await saveBindings();}
   }
   if(order.length>MAX_HISTORY)throw new Error('This conversation has reached its retained history limit.');
   if(changed)await metadata.setItem('order:'+binding.id,order);const positions=new Map(order.map((id,index)=>[id,index]));next.sort((a,b)=>positions.get(a.id)!-positions.get(b.id)!);cache.set(binding.id,next);
  };
  const acknowledge=async(pending:Outbox)=>{const{group,binding}=await current(pending.groupId);await group.history!.saveRumor(pending.rumor);await metadata.setItem('send:'+pending.rumor.id,'sent');await refresh(group,binding);};
  const network:NostrNetworkInterface={
   async publish(routes,event){
    open();const safe=validateMarmotRelays(routes,relays);let pending:Outbox|undefined,welcome:WelcomeRecord|undefined;
    if(event.kind===445&&active){const{group}=await current(active.groupId);const tag=[...group.groupData!.nostrGroupId!].map(byte=>byte.toString(16).padStart(2,'0')).join('');if(event.tags.some(item=>item[0]==='h'&&item[1]===tag)){pending={event:event as Event,relays:safe,groupId:active.groupId,rumor:active.rumor};await outbox.setItem(event.id,pending);}}
    if(event.kind===1059){if(!activeInvitation||!event.tags.some(tag=>tag[0]==='p'&&tag[1]===activeInvitation!.peer))throw new Error('A Welcome requires a durable invitation intent.');welcome={...activeInvitation,version:1,event:event as Event,relays:safe,state:'prepared'};await welcomes.setItem(event.id,welcome);}
    open();if(pending&&active)active.attempted=true;
    const result=await options.network.publish(safe,event);
    if(welcome&&Object.values(result).some(value=>value.ok))await welcomes.setItem(event.id,{...welcome,state:'acknowledged'});
    if(pending&&Object.values(result).some(value=>value.ok)){await acknowledge(pending);await outbox.removeItem(event.id);}return result;
   },
   async request(routes,filters){open();const safe=validateMarmotRelays(routes,relays),events=await options.network.request(safe,filters),list=Array.isArray(filters)?filters:[filters];if(events.length>4000)throw new Error('Relay response exceeds its bounded event count.');return events.filter(event=>signed(event as Event)&&matchFilters(list as Filter[],event));},
   subscription(routes,filters){validateMarmotRelays(routes,relays);return options.network.subscription(routes,filters);},
   async getUserInboxRelays(peer){const found=await options.network.getUserInboxRelays(peer);return found.filter(value=>{try{return validateMarmotRelays([value],relays).length===1;}catch{return false;}}).slice(0,4);},
  };
  sdk=new MarmotClient<GroupRumorHistory>({clientId:deviceId,network,signer:{getPublicKey:()=>pubkey,signEvent:draft=>{open();return finalizeEvent(draft,secret);},nip44:{encrypt:(peer,text)=>nip44.encrypt(text,nip44.utils.getConversationKey(secret,peer)),decrypt:(peer,text)=>nip44.decrypt(text,nip44.utils.getConversationKey(secret,peer))}},
   groupStateStore:scoped(options.storage,scope+':groups'),keyPackageStore:scoped(options.storage,scope+':packages'),inviteStore:scoped(options.storage,scope+':invites'),ingestStateStore:scoped(options.storage,scope+':ingest'),rewindStore:scoped(options.storage,scope+':rewind'),removedMarkerStore:scoped(options.storage,scope+':removed'),
   historyFactory:makeKeyValueRumorHistoryFactory(id=>{const store=scoped<Rumor>(options.storage,scope+':history:'+Array.from(id,byte=>byte.toString(16).padStart(2,'0')).join(''));return{...store,async setItem(key,value){if(await store.getItem(key)===null&&(await store.keys()).length>=MAX_HISTORY)throw new Error('Conversation history capacity reached.');return store.setItem(key,value);}};}),
  });
  const recoverPendingInvite=async()=>{
   const pending=await metadata.getItem('pending-invite') as {peer:string;context:string;deliveryId?:string;state?:'joined';inviteId?:string}|null;if(!pending)return;
   if(typeof pending.context!=='string'||!pending.context.length||pending.context.length>128||/[\u0000-\u001f\u007f]/.test(pending.context))throw new Error('Interrupted conversation context is invalid.');peerKey(pending.peer);
   const bound=bindings.find(binding=>binding.context===pending.context&&(pending.deliveryId?binding.deliveryId===pending.deliveryId:binding.state!=='retired'));
   if(bound){if(bound.peerPubkey!==pending.peer)throw new Error('Interrupted conversation context conflicts with its peer.');await saveBindings();if(pending.inviteId)await sdk!.invites.markAsRead(pending.inviteId);await metadata.removeItem('pending-invite');return;}
   const unknown:SdkGroup[]=[];
   for(const id of await sdk!.groups.listIds()){const group=await sdk!.groups.get(id);if(!bindings.some(binding=>binding.id===group.idStr))unknown.push(group);}
   if(!unknown.length){await metadata.removeItem('pending-invite');return;}
   const matching=unknown.filter(group=>{try{assertGroup(group,{id:group.idStr,peerPubkey:pending.peer,state:'pending',context:pending.context});return true;}catch{return false;}});
   if(matching.length!==1)throw new Error('Interrupted invitation needs deliberate recovery or fresh membership; existing MLS state was preserved.');
   const group=matching[0],binding:Binding={id:group.idStr,peerPubkey:pending.peer,state:pending.state==='joined'?'joined':'pending',context:pending.context,...(pending.deliveryId?{deliveryId:pending.deliveryId}:{})};bindings.push(binding);await saveBindings();if(pending.inviteId)await sdk!.invites.markAsRead(pending.inviteId);await metadata.removeItem('pending-invite');
  };
  await recoverPendingInvite();
  for(const binding of bindings){if(!hex.test(binding.id)||!hex.test(binding.peerPubkey)||!['pending','joined','retired'].includes(binding.state)||typeof binding.context!=='string'||binding.deliveryId!==undefined&&!hex.test(binding.deliveryId))throw new Error('Messaging group binding is invalid.');let group:SdkGroup|undefined;try{group=await sdk!.groups.get(binding.id);}catch{await retire(binding);}await refresh(group,binding);}
  const requireWelcome=async(binding:Binding,group:SdkGroup,retry:boolean)=>{
   const records=async()=>{const values=await Promise.all((await welcomes.keys()).map(key=>welcomes.getItem(key)));return values.filter((value):value is WelcomeRecord=>value!==null&&value.deliveryId===binding.deliveryId&&value.peer===binding.peerPubkey&&value.context===binding.context);};
   let pending=binding.deliveryId?await records():[];
   if(!pending.length&&retry&&binding.deliveryId&&group.pendingWelcomes.some(value=>value.recipient.pubkey===binding.peerPubkey)){
    activeInvitation={peer:binding.peerPubkey,context:binding.context,deliveryId:binding.deliveryId};try{await group.retryWelcome(binding.peerPubkey);}finally{activeInvitation=undefined;}pending=await records();
   }
   if(!pending.length){if(retry){await retire(binding);throw new Error('This invitation has no recoverable prepared Welcome. It is retired; invite again for fresh membership.');}throw new Error('The Welcome could not be prepared durably. Keep this pending invitation and retry.');}
   for(const record of pending){
    if(record.version!==1||record.event.kind!==1059||!signed(record.event)||!record.event.tags.some(tag=>tag[0]==='p'&&tag[1]===binding.peerPubkey))throw new Error('The saved invitation Welcome is invalid.');
    if(record.state==='acknowledged')continue;
    if(retry){const result=await options.network.publish(validateMarmotRelays(record.relays,relays),record.event);if(Object.values(result).some(value=>value.ok)){await welcomes.setItem(record.event.id,{...record,state:'acknowledged'});continue;}}
    throw new Error('No relay acknowledged this invitation Welcome. Retry this same invitation after reconnecting.');
   }
  };
  const discoverInvites=async()=>{
   const wraps=await network.request(relays,[{kinds:[1059],'#p':[pubkey],limit:500}]);for(const event of wraps)if(event.kind===1059&&event.tags.some(tag=>tag[0]==='p'&&tag[1]===pubkey))await sdk!.invites.ingestEvent(event);
   await sdk!.invites.decryptGiftWraps();const result:ProductionMarmotInvitation[]=[];
   for(const invite of(await sdk!.invites.getUnread()).slice(0,100)){
    if(!hex.test(invite.pubkey)||invite.pubkey===pubkey||!await sdk!.canJoinInvite(invite))continue;const preview=await sdk!.previewWelcome(invite);
    if(!preview.group||!preview.group.adminPubkeys.includes(invite.pubkey))continue;try{validateMarmotRelays(preview.group.relays,relays);}catch{continue;}
    result.push({id:invite.id,peerPubkey:invite.pubkey,groupName:preview.group.name.slice(0,120)});
   }return result;
  };
  const flush=async()=>{for(const id of await outbox.keys()){const pending=await outbox.getItem(id);if(!pending)continue;const binding=bindings.find(binding=>binding.id===pending.groupId);if(!binding||binding.state==='retired'||await metadata.getItem('send:'+pending.rumor.id)==='failed'){if(binding){await metadata.setItem('send:'+pending.rumor.id,'failed');await refresh(undefined,binding);}continue;}try{await current(pending.groupId);}catch(error){if(error instanceof RetiredConversation)continue;throw error;}const result=await options.network.publish(validateMarmotRelays(pending.relays,relays),pending.event);if(Object.values(result).some(response=>response.ok)){await acknowledge(pending);await outbox.removeItem(id);}}};
  const sync=async()=>{
   for(const binding of bindings){
    if(binding.state==='retired')continue;let group:SdkGroup;try{({group}=await current(binding.id));}catch(error){if(error instanceof RetiredConversation)continue;throw error;}
    const groupTag=Array.from(group.groupData!.nostrGroupId!,byte=>byte.toString(16).padStart(2,'0')).join(''),events=new Map<string,Event>();
    for(const relay of validateMarmotRelays(group.relays??[],relays)){
     let until:number|undefined;for(let page=0;page<20;page++){
      const filter:Filter={kinds:[445],'#h':[groupTag],limit:500,...(until===undefined?{}:{until})},batch=await network.request([relay],[filter]);
      for(const event of batch)if(event.kind===445&&event.tags.filter(tag=>tag[0]==='h').length===1&&event.tags.some(tag=>tag[0]==='h'&&tag[1]===groupTag))events.set(event.id,event as Event);
      if(batch.length<500)break;
      const oldest=Math.min(...batch.map(event=>event.created_at));
      // Fetch the complete boundary second before stepping past it. Timestamp-
      // only paging otherwise silently skips tied events beyond the page edge.
      const boundary=await network.request([relay],[{kinds:[445],'#h':[groupTag],since:oldest,until:oldest,limit:500}]);
      if(boundary.length>=500)throw new Error('Relay history is saturated within one second; catch-up is incomplete.');
      for(const event of boundary)if(event.tags.filter(tag=>tag[0]==='h').length===1)events.set(event.id,event as Event);
      until=oldest-1;if(page===19)throw new Error('Conversation catch-up exceeded its bounded page budget.');
     }
    }
    for await(const _result of group.ingest([...events.values()].sort((a,b)=>a.created_at-b.created_at||a.id.localeCompare(b.id)))){/* The SDK verifies MLS and binds the rumor author to its sender credential. */}
    await refresh(group,binding);
   }
   // Incorporate membership changes before retrying any previously prepared send.
   await flush();
  };
  return{pubkey,deviceId,
   ensurePublished:()=>serial(async()=>{await sdk!.keyPackages.ensurePublished({relays,client:'Quiet Ledger native messaging'});const inbox=finalizeEvent({kind:10050,created_at:Math.floor(Date.now()/1000),tags:relays.map(relay=>['relay',relay]),content:''},secret),result=await network.publish(relays,inbox);if(!Object.values(result).some(value=>value.ok))throw new Error('Inbox relays did not acknowledge publication.');}),
   invite:(peer,request={})=>serial(async()=>{
    await recoverPendingInvite();
    peerKey(peer);const context=request.context??'dm:'+peer;if(typeof context!=='string'||!context.length||context.length>128||/[\u0000-\u001f\u007f]/.test(context))throw new Error('A bounded private conversation context is required.');
    const prior=bindings.find(binding=>binding.context===context&&binding.state!=='retired');if(prior){if(prior.peerPubkey!==peer)throw new Error('This context is already bound to another peer.');const{group}=await current(prior.id);if(prior.state==='pending')await requireWelcome(prior,group,true);return publicGroup(prior);}
    if(bindings.length>=MAX_GROUPS)throw new Error('Native conversation capacity reached.');const candidates=await network.request(relays,[{kinds:[30443],authors:[peer],limit:16}]);let selected:Event|undefined;
    for(const event of candidates.filter(event=>event.kind===30443&&event.pubkey===peer).sort((a,b)=>b.created_at-a.created_at||b.id.localeCompare(a.id)))if(await sdk!.keyPackages.track(event,relays)){selected=event as Event;break;}
    if(!selected)throw new Error('The peer has no compatible, current signed key package on the reviewed relays.');
    const intent:InvitationIntent={peer,context,deliveryId:randomHex()};await metadata.setItem('pending-invite',intent);activeInvitation=intent;
    let group:SdkGroup;try{group=await sdk!.groups.create('Private conversation',{description:'Direct encrypted conversation.',relays,adminPubkeys:[pubkey],invitees:[selected]});}finally{activeInvitation=undefined;}
    const binding:Binding={id:group.idStr,peerPubkey:peer,state:'pending',context,deliveryId:intent.deliveryId};assertGroup(group,binding);bindings.push(binding);await saveBindings();await metadata.removeItem('pending-invite');await refresh(group,binding);await requireWelcome(binding,group,false);return publicGroup(binding);
   }),
   invitations:()=>serial(discoverInvites),
   accept:(inviteId,expectedPeer)=>serial(async()=>{
    await recoverPendingInvite();
    peerKey(expectedPeer);if(!hex.test(inviteId))throw new Error('A valid invitation ID is required.');const prior=bindings.find(binding=>binding.context==='invite:'+inviteId);if(prior){if(prior.peerPubkey!==expectedPeer)throw new Error('The invitation peer does not match.');await current(prior.id);return publicGroup(prior);}
    if(bindings.length>=MAX_GROUPS)throw new Error('Native conversation capacity reached.');const invitations=await discoverInvites(),candidate=invitations.find(invite=>invite.id===inviteId);if(!candidate||candidate.peerPubkey!==expectedPeer)throw new Error('The invitation does not match the expected peer.');
    const invite=(await sdk!.invites.getUnread()).find(invite=>invite.id===inviteId)!;
    // Stage the SDK join against cloned, ephemeral key-package storage. Validate
    // full member credentials before consuming any live key package or persisting membership.
    const packages=new InMemoryKeyValueStore<StoredKeyPackage>(),source=scoped<StoredKeyPackage>(options.storage,scope+':packages');
    for(const key of await source.keys()){const value=await source.getItem(key);if(value!==null)await packages.setItem(key,structuredClone(value));}
    const staging=new MarmotClient({clientId:deviceId,network:{...network,async publish(){throw new Error('Invitation preview cannot publish.');}},signer:sdk!.signer,groupStateStore:new InMemoryKeyValueStore(),keyPackageStore:packages});
    try{const preview=await staging.joinGroupFromWelcome({welcomeRumor:invite}),members=getGroupMemberPubkeys(preview.group.state);if(getMemberCount(preview.group.state)!==2||members.length!==2||!members.includes(pubkey)||!members.includes(expectedPeer))throw new Error('Only an explicitly selected two-member direct invitation can be accepted.');}
    finally{for(const group of staging.groups.loaded)group.dispose();await packages.clear();}
    await metadata.setItem('pending-invite',{peer:expectedPeer,context:'invite:'+inviteId,state:'joined',inviteId});
    const{group}=await sdk!.joinGroupFromWelcome({welcomeRumor:invite}),binding:Binding={id:group.idStr,peerPubkey:expectedPeer,state:'joined',context:'invite:'+inviteId};assertGroup(group,binding);bindings.push(binding);await saveBindings();await sdk!.invites.markAsRead(invite.id);await metadata.removeItem('pending-invite');await refresh(group,binding);return publicGroup(binding);
   }),
   groups(){open();return bindings.map(publicGroup);},
   members(id){open();const binding=bindings.find(binding=>binding.id===id),group=sdk!.groups.loaded.find(group=>group.idStr===id);if(!binding||!group)throw new Error('Conversation group not found in this namespace.');if(binding.state==='retired')throw new RetiredConversation();assertGroup(group,binding);return[...getGroupMemberPubkeys(group.state)];},
   sync:()=>serial(sync),
   send:(id,text)=>serial(async()=>{
    const content=textValue(text),{group,binding}=await current(id);if((cache.get(id)?.length??0)>=MAX_HISTORY)throw new Error('Conversation history capacity reached.');
    const rumor=createChatRumor({pubkey,content,tags:[['nonce',randomHex()]]});await metadata.setItem('send:'+rumor.id,'pending');await group.history!.saveRumor(rumor);const job={groupId:id,rumor,attempted:false};active=job;
    try{await sdk!.groups.send(group.id,createApplicationMessageIntent(rumor));}catch{/* Exact prepared ciphertext is retryable only after publication was attempted. */}finally{active=undefined;}
    if(!job.attempted){await metadata.setItem('send:'+rumor.id,'failed');await refresh(group,binding);throw new Error('The message could not be prepared durably for publication. Your draft is preserved; sending again must be a new explicit action.');}
    if(await metadata.getItem('send:'+rumor.id)!=='sent')await metadata.setItem('send:'+rumor.id,'unknown');await refresh(group,binding);return{...cache.get(id)!.find(message=>message.id===rumor.id)!};
   }),
   messages(id,request={}){open();if(!bindings.some(binding=>binding.id===id))throw new Error('Conversation group not found in this namespace.');const limit=request.limit??50;if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('Choose a message page size from one to one hundred.');const history=cache.get(id)??[];let end=history.length;if(request.before!==undefined){end=history.findIndex(message=>message.id===request.before);if(end<0)throw new Error('The message page cursor is invalid.');}return history.slice(Math.max(0,end-limit),end).map(message=>({...message}));},
   async dispose(){if(disposed)return;disposed=true;for(const group of sdk!.groups.loaded)group.dispose();await queue.catch(()=>{});sdk!.groups.removeAllListeners();sdk!.invites.removeAllListeners();sdk!.keyPackages.removeAllListeners();sdk=undefined;secret.fill(0);cache.clear();bindings=[];release();},
  };
 }catch(error){disposed=true;for(const group of sdk?.groups.loaded??[])group.dispose();secret.fill(0);release();throw error;}
}
