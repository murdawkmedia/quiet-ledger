import type {NostrNetworkInterface} from '@internet-privacy/marmot-ts';
import {createProductionMarmot,type ProductionMarmot} from '../integrations/marmot-client.js';
import {createMarmotRelayNetwork,DEFAULT_MARMOT_RELAYS} from '../client/marmot-relay.js';
import {Store,DomainError,hash} from './store.js';
import {EmailMarmotGateway} from './email-marmot-gateway.js';
import type {InvoiceEmailInbox} from './email-inbox.js';
import type {InvoiceThreads} from './invoice-threads.js';
import type {ThreadEmailService} from './thread-email.js';
import type {InvoiceDelivery} from './invoice-delivery.js';
import type {GatewayMarmotMessage,GatewayMarmotPort} from '../shared/email-gateway.js';

export interface CommunicationsRuntimeOptions {
 store:Store;inbox:InvoiceEmailInbox;threads:InvoiceThreads;replies:ThreadEmailService;delivery:InvoiceDelivery;now:()=>Date;
 /** Controlled transports are injectable; the production default uses only reviewed US/EU relays. */
 networkFactory?:(workspace:string,options:{signal:AbortSignal})=>(NostrNetworkInterface&{dispose?():void})|Promise<NostrNetworkInterface&{dispose?():void}>;
}
export interface CommunicationsWorkerState {kind:'inbox'|'gateway'|'import';invoiceId?:string;failures:number;nextAttemptAt:string;lastError:'inbox-unavailable'|'gateway-unavailable'|'forward-unavailable'}
export interface CommunicationsTick {status:'completed'|'stopped';inboxes:number;gateways:number;forwarded:number;failures:number}
export interface CommunicationsRuntime {
 gateway:EmailMarmotGateway;readonly busy:boolean;start():void;tick():Promise<CommunicationsTick>;stop():void;close():Promise<void>;status(workspace:string):CommunicationsWorkerState[];
}
const workerTable='communications_worker_state',maxInboxes=20,maxGateways=25,maxImports=20;
/** Dedicated non-AI worker. Starting it is separate from opting in any mailbox or invoice. */
export function createCommunicationsRuntime(options:CommunicationsRuntimeOptions):CommunicationsRuntime {
 const{store,inbox,replies,delivery,now}=options;
 store.db.exec(`CREATE TABLE IF NOT EXISTS ${workerTable}(workspace TEXT NOT NULL,key_hash TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(workspace,key_hash));`);
 let accepting=true,started=false,closed=false,timer:ReturnType<typeof setTimeout>|undefined,inFlight:Promise<CommunicationsTick>|undefined,closing:Promise<void>|undefined,inboxOffset=0,gatewayOffset=0;
 const actors=new Set<{done:Promise<void>;cancel:()=>void}>();
 const assertRunning=()=>{if(!accepting||closed)throw new DomainError(503,'The communications worker is stopped.');};
 const active=(workspace:string)=>{if(!accepting||closed)return false;const settings=inbox.settings(workspace),credential=delivery.credentialForInbox(workspace);return Boolean(settings.enabled&&settings.lastSyncedAt&&credential?.verifiedAt&&credential.senderEmail===settings.senderEmail);};
 const workerKey=(kind:string,resource:string)=>store.indexValue('communications-worker',hash(kind+':'+resource));
 const saved=(workspace:string,key:string):CommunicationsWorkerState|undefined=>{const row=store.db.prepare(`SELECT data FROM ${workerTable} WHERE workspace=? AND key_hash=?`).get(workspace,key);return row?store.decode(row.data,workerTable,key,workspace):undefined;};
 const ready=(workspace:string,key:string)=>{const value=saved(workspace,key);return!value||Date.parse(value.nextAttemptAt)<=now().getTime();};
 const success=(workspace:string,key:string)=>store.db.prepare(`DELETE FROM ${workerTable} WHERE workspace=? AND key_hash=?`).run(workspace,key);
 const failed=(workspace:string,key:string,kind:CommunicationsWorkerState['kind'],lastError:CommunicationsWorkerState['lastError'],invoiceId?:string)=>{
  const failures=Math.min((saved(workspace,key)?.failures??0)+1,7),value:CommunicationsWorkerState={kind,...(invoiceId?{invoiceId}:{}),failures,nextAttemptAt:new Date(now().getTime()+Math.min(300000,5000*2**(failures-1))).toISOString(),lastError};
  store.assertWriteBudget();store.db.prepare(`INSERT INTO ${workerTable}(workspace,key_hash,data) VALUES(?,?,?) ON CONFLICT(workspace,key_hash) DO UPDATE SET data=excluded.data`).run(workspace,key,store.encode(value,workerTable,key,workspace));
 };
 let gateway!:EmailMarmotGateway;
 const marmotFor=async(workspace:string):Promise<GatewayMarmotPort>=>{
  assertRunning();let finish!:()=>void;const done=new Promise<void>(resolve=>finish=resolve),controller=new AbortController();let network:(NostrNetworkInterface&{dispose?():void})|undefined,engine:ProductionMarmot|undefined,secret:Uint8Array|undefined,disposed=false;
  const entry={done,cancel:()=>{controller.abort();network?.dispose?.();}};actors.add(entry);
  const dispose=async()=>{if(disposed)return;disposed=true;try{await engine?.dispose();}finally{try{network?.dispose?.();}finally{secret?.fill(0);actors.delete(entry);finish();}}};
  try{
   network=await(options.networkFactory??(()=>createMarmotRelayNetwork()))(workspace,{signal:controller.signal});assertRunning();if(controller.signal.aborted)throw new DomainError(503,'The communications worker is stopped.');
   const stored=gateway.records.secretKey(workspace);try{secret=new Uint8Array(stored);}finally{stored.fill(0);}
   engine=await createProductionMarmot({namespace:'email-gateway:'+hash(workspace),storage:gateway.records.storage(workspace),secretKey:secret,network,relays:[...DEFAULT_MARMOT_RELAYS]});secret.fill(0);assertRunning();
   const participant=engine;
   return{
    pubkey:participant.pubkey,invite:(peer,settings)=>{assertRunning();return participant.invite(peer,settings);},
    send:async(groupId,text)=>{assertRunning();const result=await participant.send(groupId,text);if(result.state!=='sent')throw new DomainError(503,'Marmot publication is uncertain.');return{id:result.id};},
    sync:async()=>{assertRunning();await participant.sync();assertRunning();},
    isAuthorized:(groupId,owner)=>{if(!accepting||closed)return false;try{const binding=participant.groups().find(group=>group.id===groupId),members=participant.members(groupId);return Boolean(binding&&binding.state!=='retired'&&binding.peerPubkey===owner&&members.length===2&&new Set(members).size===2&&members.includes(participant.pubkey)&&members.includes(owner));}catch{return false;}},
    messages(groupId){const history:GatewayMarmotMessage[]=[];let before:string|undefined;for(let page=0;page<50;page++){const batch=participant.messages(groupId,{limit:100,...(before?{before}:{})});history.unshift(...batch);if(batch.length<100)break;before=batch[0].id;}return history;},
    dispose,
   };
  }catch{await dispose();throw new DomainError(503,'The persistent gateway could not open its private messaging state.');}
 };
 gateway=new EmailMarmotGateway(store,{now,marmotFor,email:{
  active,authority:workspace=>{assertRunning();return inbox.authorityRevision(workspace);},
  preview:(workspace,id,text)=>{assertRunning();if(!active(workspace))throw new DomainError(409,'The original mailbox is disconnected.');return replies.preview(workspace,id,{text},{demo:false});},
  send:async(workspace,id,payload,key,dispatch)=>{
   assertRunning();const result=await replies.send(workspace,id,payload,key,{demo:false},{assertCurrent:async()=>{assertRunning();if(!active(workspace))throw new DomainError(409,'The original mailbox is disconnected.');await dispatch?.assertCurrent();assertRunning();if(!active(workspace))throw new DomainError(409,'The original mailbox is disconnected.');}});
   return{state:result.body.state==='provider_accepted'?'sent':result.body.state==='not_sent'?'failed':'unknown',...(result.body.messageId?{messageId:result.body.messageId}:{})};
  },
  review:(workspace,id,itemId,action)=>{assertRunning();if(!active(workspace))throw new DomainError(409,'The original mailbox is disconnected.');inbox.itemForInvoice(workspace,id,itemId);inbox[action](workspace,itemId,{demo:false});},
 }});
 const rotate=<T>(items:T[],offset:number,limit:number)=>Array.from({length:Math.min(items.length,limit)},(_,index)=>items[(offset+index)%items.length]);
 const work=async():Promise<CommunicationsTick>=>{
  const result:CommunicationsTick={status:'completed',inboxes:0,gateways:0,forwarded:0,failures:0};
  const enabled=inbox.listEnabled(),mailboxes=rotate(enabled,inboxOffset,maxInboxes);inboxOffset=enabled.length?(inboxOffset+mailboxes.length)%enabled.length:0;
  for(const workspace of mailboxes){if(!accepting)break;const key=workerKey('inbox',workspace);if(!ready(workspace,key))continue;const sync=await inbox.sync(workspace,{demo:false});result.inboxes++;if(!accepting)break;if(sync.status==='failed'||sync.status==='disconnected'){failed(workspace,key,'inbox','inbox-unavailable');result.failures++;}else if(sync.status!=='busy'&&sync.status!=='cancelled')success(workspace,key);}
  const configs=gateway.listEnabled(),selected=rotate(configs,gatewayOffset,maxGateways);gatewayOffset=configs.length?(gatewayOffset+selected.length)%configs.length:0;let imports=0;
  for(const config of selected){
   if(!accepting)break;const{workspace,invoiceId}=config,key=workerKey('gateway',invoiceId);if(!active(workspace)||!ready(workspace,key))continue;
   try{const settings=await gateway.process(workspace,invoiceId);result.gateways++;if(settings.lastError)throw new Error('Gateway unavailable.');success(workspace,key);if(settings.status!=='paired')continue;}catch{if(!accepting)break;gateway.reportFailure(workspace,invoiceId);failed(workspace,key,'gateway','gateway-unavailable',invoiceId);result.failures++;continue;}
   // Deduplication precedes this tick's import cap so retained early items cannot starve later arrivals.
   for(const item of inbox.listRetained(workspace,invoiceId)){
    if(!accepting||imports>=maxImports)break;if((item.status!=='approved'&&item.status!=='requires_review')||!item.text||!item.from.length)continue;
    const kind=item.status==='approved'?'approved':'review';if(gateway.hasForwarded(workspace,invoiceId,item.sourceId,kind))continue;
    const itemKey=workerKey('import',item.id+':'+kind);if(!ready(workspace,itemKey))continue;imports++;
    try{const input={sourceId:item.sourceId,from:item.from.join(', '),text:item.text},outcome=kind==='review'?await gateway.forwardForReview(workspace,invoiceId,{...input,inboxItemId:item.id}):await gateway.forwardApproved(workspace,invoiceId,input);if(outcome.state==='unknown')throw new Error('Marmot publication uncertain.');success(workspace,itemKey);result.forwarded++;}catch{if(!accepting)break;failed(workspace,itemKey,'import','forward-unavailable',invoiceId);result.failures++;}
   }
  }
  return result;
 };
 const tick=():Promise<CommunicationsTick>=>{if(!accepting||closed)return Promise.resolve({status:'stopped',inboxes:0,gateways:0,forwarded:0,failures:0});if(inFlight)return inFlight;const current=work();inFlight=current;void current.finally(()=>{if(inFlight===current)inFlight=undefined;}).catch(()=>{});return current;};
 const schedule=()=>{if(!started||closed)return;timer=setTimeout(()=>{timer=undefined;void tick().catch(()=>{}).finally(schedule);},5000);timer.unref();};
 const stop=()=>{accepting=false;started=false;if(timer)clearTimeout(timer);timer=undefined;inbox.cancel();for(const actor of actors)try{actor.cancel();}catch{/* Cancellation does not expose transport details. */}};
 return{
  gateway,get busy(){return Boolean(inFlight||actors.size);},
  start(){if(closed||started)return;accepting=true;started=true;void tick().catch(()=>{}).finally(schedule);},tick,stop,
  close(){if(closing)return closing;closed=true;stop();closing=(async()=>{await inFlight?.catch(()=>{});await Promise.allSettled([...actors].map(actor=>actor.done));await inbox.close();})();return closing;},
  status(workspace){return store.db.prepare(`SELECT key_hash,data FROM ${workerTable} WHERE workspace=? ORDER BY rowid LIMIT 5000`).all(workspace).map(row=>store.decode<CommunicationsWorkerState>(row.data,workerTable,String(row.key_hash),workspace));},
 };
}
