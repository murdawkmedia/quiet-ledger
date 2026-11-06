import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {EmailApprovedReplyContext,EmailInboxError,EmailInboxItem,EmailInboxReason,EmailInboxSettings,EmailInboxSyncResult,EmailOutboundBinding} from '../shared/email-inbox.js';
import type {InvoiceEmailResult} from '../shared/invoice-delivery.js';
import type {InvoiceGmailCredentials} from './invoice-delivery.js';
import {invoiceMailThreadHeaders} from './invoice-delivery.js';
import {InvoiceThreads} from './invoice-threads.js';
import {createGmailMailbox,mailboxLimits,type InvoiceMailbox,type MailboxHeader} from './gmail-mailbox.js';
import {DomainError,Store,hash} from './store.js';

const settingsTable='email_inbox_settings',bindingTable='email_outbound_bindings',itemTable='email_inbox_items',referenceTable='email_inbox_references',seenTable='email_inbox_seen';
const retentionNotice='Disconnecting stops new reads. Imported mail, review decisions and encrypted backups remain retained. The folder limits processing; this credential can access more of the mailbox. No old-mail backfill is enabled.';
const singleLine=(max:number)=>z.string().max(max).refine(value=>!/[\u0000-\u001f\u007f-\u009f]/.test(value)).trim().min(1);
const workspaceSchema=singleLine(512),configureSchema=z.object({enabled:z.boolean(),folder:singleLine(200)}).strict();
const listSchema=z.object({invoiceId:z.uuid().optional(),limit:z.number().int().min(1).max(100).default(50)}).strict();
const active=new WeakMap<Store,Map<string,AbortController>>();
interface InboxState extends Omit<EmailInboxSettings,'retentionNotice'> {revision:string;cursor?:{uidValidity:string;nextUid:number}}
export interface InvoiceEmailInboxOptions {
 now?:()=>Date;threads:InvoiceThreads;credentialFor:(workspace:string)=>InvoiceGmailCredentials|undefined;
 mailboxFactory?:(credentials:InvoiceGmailCredentials,options:{signal:AbortSignal})=>InvoiceMailbox|Promise<InvoiceMailbox>;timeoutMs?:number;
}
class Cancelled extends Error {}
const emptyResult=(status:EmailInboxSyncResult['status']):EmailInboxSyncResult=>({status,imported:0,quarantined:0,skipped:0});
function parsed<T>(schema:z.ZodType<T>,input:unknown):T {const value=schema.safeParse(input);if(!value.success)throw new DomainError(400,'Check the inbox folder, identifiers and field limits.');return value.data;}

/** Internal receive/review service. It never sends mail, forwards to Marmot or settles invoices. */
export class InvoiceEmailInbox {
 private now:()=>Date;private timeout:number;private running:Map<string,AbortController>;private pending=new Set<Promise<unknown>>();private closed=false;
 constructor(private store:Store,private options:InvoiceEmailInboxOptions){
  this.now=options.now??(()=>new Date());this.timeout=options.timeoutMs??10000;if(!Number.isSafeInteger(this.timeout)||this.timeout<1||this.timeout>30000)throw new Error('Inbox deadline must be from one millisecond to thirty seconds.');
  this.running=active.get(store)??new Map();active.set(store,this.running);
  store.db.exec(`
   CREATE TABLE IF NOT EXISTS ${settingsTable}(workspace TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS ${bindingTable}(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,mailbox_id TEXT NOT NULL,delivery_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(workspace,mailbox_id,delivery_id));
   CREATE TABLE IF NOT EXISTS ${referenceTable}(workspace TEXT NOT NULL,mailbox_id TEXT NOT NULL,rfc_hash TEXT NOT NULL,binding_id TEXT NOT NULL REFERENCES ${bindingTable}(id),PRIMARY KEY(workspace,mailbox_id,rfc_hash,binding_id));
   CREATE TABLE IF NOT EXISTS ${itemTable}(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,mailbox_id TEXT NOT NULL,source_hash TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(workspace,mailbox_id,source_hash));
   CREATE INDEX IF NOT EXISTS email_inbox_items_workspace ON ${itemTable}(workspace,mailbox_id);
   CREATE TABLE IF NOT EXISTS ${seenTable}(workspace TEXT NOT NULL,mailbox_id TEXT NOT NULL,provider_hash TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(workspace,mailbox_id,provider_hash));
  `);
 }
 private workspace(workspace:string){parsed(workspaceSchema,workspace);}
 private owner(context:{demo:boolean}){if(context.demo)throw new DomainError(403,'The demo cannot read or review mailbox messages.');}
 private saved(workspace:string):InboxState {this.workspace(workspace);const row=this.store.db.prepare(`SELECT data FROM ${settingsTable} WHERE workspace=?`).get(workspace);return row?this.store.decode(row.data,settingsTable,workspace,workspace):{enabled:false,folder:'Quiet Ledger',revision:'unconfigured'};}
 private save(workspace:string,state:InboxState){this.store.assertWriteBudget();this.store.db.prepare(`INSERT INTO ${settingsTable}(workspace,data) VALUES(?,?) ON CONFLICT(workspace) DO UPDATE SET data=excluded.data`).run(workspace,this.store.encode(state,settingsTable,workspace,workspace));}
 settings(workspace:string):EmailInboxSettings {const {revision:_revision,cursor:_cursor,...publicState}=this.saved(workspace);return{...publicState,retentionNotice};}
 /** Server-only opaque binding for short-lived send authority; not exposed by settings. */
 authorityRevision(workspace:string):string|undefined{const state=this.saved(workspace),credential=this.options.credentialFor(workspace);if(!state.enabled||!state.cursor||!state.lastSyncedAt||!credential?.verifiedAt||credential.senderEmail!==state.senderEmail)return;return this.store.indexValue('email-inbox-authority',hash(JSON.stringify([state.revision,credential.senderEmail,credential.appPassword,credential.verifiedAt])));}
 configure(workspace:string,body:unknown,context:{demo:boolean}={demo:false}):EmailInboxSettings {
  this.owner(context);const input=parsed(configureSchema,body),prior=this.saved(workspace),credential=input.enabled?this.options.credentialFor(workspace):undefined;
  if(input.enabled&&!this.store.encrypted)throw new DomainError(400,'Encrypted storage is required before enabling inbox reads.');
  if(input.enabled&&(!credential?.verifiedAt||!credential.senderEmail))throw new DomainError(409,'Connect and authenticate a Gmail account before explicitly enabling inbox reads.');
  const sameMailbox=prior.mailboxId&&prior.senderEmail===credential?.senderEmail&&prior.folder===input.folder;
  if(prior.enabled===input.enabled&&prior.folder===input.folder&&(!input.enabled||sameMailbox))return this.settings(workspace);
  this.running.get(workspace)?.abort();
  this.store.transaction(()=>{const state:InboxState={enabled:input.enabled,folder:input.folder,revision:randomUUID(),...(input.enabled?{mailboxId:sameMailbox?prior.mailboxId:randomUUID(),senderEmail:credential!.senderEmail}:prior.mailboxId?{mailboxId:prior.mailboxId,senderEmail:prior.senderEmail}:{})};this.save(workspace,state);this.store.audit(workspace,input.enabled?'email.inbox_enabled':'email.inbox_disabled',input.enabled?'Mailbox reading explicitly enabled for one folder; the first sync starts with new mail only.':'Mailbox reading disabled; encrypted imported records and backups remain retained.',this.now().toISOString());});
  return this.settings(workspace);
 }
 disconnect(workspace:string,context:{demo:boolean}={demo:false}):EmailInboxSettings {return this.configure(workspace,{enabled:false,folder:this.saved(workspace).folder},context);}
 private index(kind:string,value:string){return this.store.indexValue('email-inbox-'+kind,hash(value));}
 private references(workspace:string,mailboxId:string,ids:string[]):EmailOutboundBinding[]{
  const bindings=new Map<string,EmailOutboundBinding>();for(const id of ids)for(const row of this.store.db.prepare(`SELECT b.id,b.data FROM ${referenceTable} r JOIN ${bindingTable} b ON b.id=r.binding_id AND b.workspace=r.workspace AND b.mailbox_id=r.mailbox_id WHERE r.workspace=? AND r.mailbox_id=? AND r.rfc_hash=?`).all(workspace,mailboxId,this.index('rfc',id)))if(!bindings.has(String(row.id)))bindings.set(String(row.id),this.store.decode(row.data,bindingTable,String(row.id),workspace));return[...bindings.values()];
 }
 private addReference(workspace:string,mailboxId:string,id:string,bindingId:string){this.store.db.prepare(`INSERT OR IGNORE INTO ${referenceTable}(workspace,mailbox_id,rfc_hash,binding_id) VALUES(?,?,?,?)`).run(workspace,mailboxId,this.index('rfc',id),bindingId);}
 trackOutbound(workspace:string,invoiceId:string,result:InvoiceEmailResult):EmailOutboundBinding|undefined {
  const invoice=this.store.getInvoice(invoiceId,workspace);if(!invoice)throw new DomainError(404,'Invoice not found.');const state=this.saved(workspace);if(!state.enabled)return undefined;
  if(!state.cursor||!state.lastSyncedAt)throw new DomainError(409,'Initialize the mailbox baseline before sending a tracked email.');
  if(!result.deliveryId||!result.requestedMessageId||!result.senderEmail||result.senderEmail!==state.senderEmail||!['sending','provider_accepted','partial_rejection','unknown'].includes(result.state))throw new DomainError(400,'Only a recorded outbound submission from this mailbox can establish an email thread.');
  invoiceMailThreadHeaders({inReplyTo:result.requestedMessageId});
  const delivery=this.store.db.prepare('SELECT data FROM invoice_email_deliveries WHERE id=? AND workspace=? AND invoice_id=?').get(result.deliveryId,workspace,invoiceId);
  const original=delivery?this.store.decode<InvoiceEmailResult>(delivery.data,'invoice_email_deliveries',result.deliveryId,workspace):undefined;
  if(!original||original.requestedMessageId!==result.requestedMessageId||original.messageId!==result.messageId||original.senderEmail!==result.senderEmail||JSON.stringify(original.to)!==JSON.stringify(result.to)||JSON.stringify(original.cc)!==JSON.stringify(result.cc)||original.subject!==result.subject||original.state!==result.state)throw new DomainError(409,'The outbound email does not match its saved submission.');
  return this.store.transaction(()=>{
   const old=this.store.db.prepare(`SELECT id,data FROM ${bindingTable} WHERE workspace=? AND mailbox_id=? AND delivery_id=?`).get(workspace,state.mailboxId!,result.deliveryId!);if(old){const binding=this.store.decode<EmailOutboundBinding>(old.data,bindingTable,String(old.id),workspace);if(result.state!=='sending'&&result.messageId&&binding.providerMessageId!==result.messageId){binding.providerMessageId=result.messageId;this.store.db.prepare(`UPDATE ${bindingTable} SET data=? WHERE id=? AND workspace=?`).run(this.store.encode(binding,bindingTable,binding.id,workspace),binding.id,workspace);try{invoiceMailThreadHeaders({inReplyTo:result.messageId});this.addReference(workspace,binding.mailboxId,result.messageId,binding.id);}catch{/* Keep opaque provider identifiers as metadata only. */}}return binding;}
   this.store.assertWriteBudget();const thread=this.options.threads.getOrCreate(workspace,invoiceId),binding:EmailOutboundBinding={id:randomUUID(),mailboxId:state.mailboxId!,invoiceId,threadId:thread.id,deliveryId:result.deliveryId!,requestedMessageId:result.requestedMessageId!,...(result.state!=='sending'&&result.messageId?{providerMessageId:result.messageId}:{}),...(result.references?{references:[...result.references]}:{}),senderEmail:result.senderEmail!,to:[...result.to],cc:[...result.cc],subject:result.subject,createdAt:this.now().toISOString()};
   this.store.db.prepare(`INSERT INTO ${bindingTable}(id,workspace,mailbox_id,delivery_id,data) VALUES(?,?,?,?,?)`).run(binding.id,workspace,binding.mailboxId,binding.deliveryId,this.store.encode(binding,bindingTable,binding.id,workspace));this.addReference(workspace,binding.mailboxId,binding.requestedMessageId,binding.id);
   if(binding.providerMessageId&&binding.providerMessageId!==binding.requestedMessageId){try{invoiceMailThreadHeaders({inReplyTo:binding.providerMessageId});this.addReference(workspace,binding.mailboxId,binding.providerMessageId,binding.id);}catch{/* Non-RFC provider identifiers stay separate metadata. */}}
   return binding;
  });
 }
 list(workspace:string,body:{invoiceId?:string;limit?:number}={}):EmailInboxItem[]{
  this.workspace(workspace);const input=parsed(listSchema,body);if(input.invoiceId&&!this.store.getInvoice(input.invoiceId,workspace))throw new DomainError(404,'Invoice not found.');
  const items=this.store.db.prepare(`SELECT id,data FROM ${itemTable} WHERE workspace=? ORDER BY rowid DESC`).all(workspace).map(row=>this.store.decode<EmailInboxItem>(row.data,itemTable,String(row.id),workspace));return items.filter(row=>!input.invoiceId||row.invoiceId===input.invoiceId).slice(0,input.limit);
 }
 /** Internal bounded inventory, independent of the public one-hundred-item page. */
 listRetained(workspace:string,invoiceId?:string):EmailInboxItem[]{
  this.workspace(workspace);if(invoiceId&&!this.store.getInvoice(invoiceId,workspace))throw new DomainError(404,'Invoice not found.');
  return this.store.db.prepare(`SELECT id,data FROM ${itemTable} WHERE workspace=? ORDER BY rowid ASC LIMIT 5000`).all(workspace).map(row=>this.store.decode<EmailInboxItem>(row.data,itemTable,String(row.id),workspace)).filter(item=>!invoiceId||item.invoiceId===invoiceId);
 }
 itemForInvoice(workspace:string,invoiceId:string,id:string):EmailInboxItem{
  this.workspace(workspace);parsed(z.uuid(),id);if(!this.store.getInvoice(invoiceId,workspace))throw new DomainError(404,'Invoice not found.');const row=this.store.db.prepare(`SELECT data FROM ${itemTable} WHERE id=? AND workspace=?`).get(id,workspace);if(!row)throw new DomainError(404,'Inbox item not found.');const item=this.store.decode<EmailInboxItem>(row.data,itemTable,id,workspace);if(item.invoiceId!==invoiceId)throw new DomainError(404,'Inbox item not found.');return item;
 }
 listEnabled():string[]{return this.store.db.prepare(`SELECT workspace,data FROM ${settingsTable} LIMIT 5000`).all().filter(row=>this.store.decode<InboxState>(row.data,settingsTable,String(row.workspace),String(row.workspace)).enabled).map(row=>String(row.workspace));}
 cancel(workspace?:string){if(workspace!==undefined){this.workspace(workspace);this.running.get(workspace)?.abort();}else for(const controller of this.running.values())controller.abort();}
 async close(){this.closed=true;this.cancel();await Promise.allSettled([...this.pending]);}
 private review(workspace:string,id:string,decision:'approved'|'rejected',context:{demo:boolean}):EmailInboxItem {
  this.owner(context);this.workspace(workspace);parsed(z.uuid(),id);return this.store.transaction(()=>{const row=this.store.db.prepare(`SELECT data FROM ${itemTable} WHERE id=? AND workspace=?`).get(id,workspace);if(!row)throw new DomainError(404,'Inbox item not found.');const item=this.store.decode<EmailInboxItem>(row.data,itemTable,id,workspace);if(item.status===decision)return item;if(item.status==='approved'||item.status==='rejected'||(decision==='approved'&&item.status!=='requires_review'))throw new DomainError(409,'This inbox item cannot take that review decision.');this.store.assertWriteBudget();item.status=decision;item.reviewedAt=this.now().toISOString();this.store.db.prepare(`UPDATE ${itemTable} SET data=? WHERE id=? AND workspace=?`).run(this.store.encode(item,itemTable,id,workspace),id,workspace);this.store.audit(workspace,'email.inbox_'+decision,`Inbox item ${id}: owner ${decision} this unverified email; no outbound message or payment action followed.`,item.reviewedAt);return item;});
 }
 approve(workspace:string,id:string,context:{demo:boolean}={demo:false}){return this.review(workspace,id,'approved',context);}
 reject(workspace:string,id:string,context:{demo:boolean}={demo:false}){return this.review(workspace,id,'rejected',context);}
 approvedReplyContext(workspace:string,invoiceId:string,id:string):EmailApprovedReplyContext {
  this.workspace(workspace);parsed(z.uuid(),id);if(!this.store.getInvoice(invoiceId,workspace))throw new DomainError(404,'Invoice not found.');
  const row=this.store.db.prepare(`SELECT data FROM ${itemTable} WHERE id=? AND workspace=?`).get(id,workspace);if(!row)throw new DomainError(404,'Inbox item not found.');const item=this.store.decode<EmailInboxItem>(row.data,itemTable,id,workspace);if(item.invoiceId!==invoiceId)throw new DomainError(404,'Inbox item not found.');if(item.status!=='approved'||!item.bindingId||!item.messageId)throw new DomainError(409,'Review and approve the email before preparing an explicit reply.');
  const parent=this.store.db.prepare(`SELECT data FROM ${bindingTable} WHERE id=? AND workspace=? AND mailbox_id=?`).get(item.bindingId,workspace,item.mailboxId);if(!parent)throw new DomainError(409,'The original outbound recipient binding is unavailable.');const binding=this.store.decode<EmailOutboundBinding>(parent.data,bindingTable,item.bindingId,workspace);if(binding.invoiceId!==invoiceId||binding.threadId!==item.threadId)throw new DomainError(409,'The email thread binding does not match this invoice.');
  const state=this.saved(workspace),credential=this.options.credentialFor(workspace);if(!state.enabled||!state.cursor||!state.lastSyncedAt||state.mailboxId!==item.mailboxId||state.senderEmail!==binding.senderEmail||!credential?.verifiedAt||credential.senderEmail!==binding.senderEmail)throw new DomainError(409,'Reconnect and initialize the original mailbox before preparing an explicit reply.');return{item,binding};
 }
 latestApprovedReplyContext(workspace:string,invoiceId:string):EmailApprovedReplyContext {
  for(const item of this.listRetained(workspace,invoiceId).reverse())if(item.status==='approved')return this.approvedReplyContext(workspace,invoiceId,item.id);throw new DomainError(409,'Approve a received email before preparing a threaded reply.');
 }

 async sync(workspace:string,context:{demo:boolean}={demo:false}):Promise<EmailInboxSyncResult>{
  this.owner(context);if(this.closed)return emptyResult('cancelled');const initial=this.saved(workspace);if(!initial.enabled)return emptyResult('disabled');if(this.running.has(workspace))return emptyResult('busy');const credential=this.options.credentialFor(workspace);if(!credential?.verifiedAt||credential.senderEmail!==initial.senderEmail)return emptyResult('disconnected');
  const controller=new AbortController();this.running.set(workspace,controller);let mailbox:InvoiceMailbox|undefined,closed=false,timedOut=false;const result=emptyResult('synced');
  const close=()=>{if(mailbox&&!closed){closed=true;try{mailbox.close();}catch{/* Never expose a provider error. */}}};
  const check=()=>{if(controller.signal.aborted||this.closed){close();throw new Cancelled();}const current=this.saved(workspace),live=this.options.credentialFor(workspace);if(!current.enabled||current.revision!==initial.revision||!live?.verifiedAt||live.senderEmail!==credential.senderEmail||live.appPassword!==credential.appPassword){close();throw new Cancelled();}};
  const commit=(nextUid:number,operation?:()=>void,error?:EmailInboxError)=>this.store.transaction(()=>{check();operation?.();const state=this.saved(workspace);state.cursor={uidValidity:currentValidity,nextUid};state.lastSyncedAt=this.now().toISOString();if(error)state.lastError=error;else delete state.lastError;this.save(workspace,state);});
  let currentValidity='';const aborted=new Promise<never>((_resolve,reject)=>controller.signal.addEventListener('abort',()=>{close();reject(new Cancelled());},{once:true}));
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},this.timeout);
  const work=(async()=>{
   mailbox=await(this.options.mailboxFactory??createGmailMailbox)(credential,{signal:controller.signal});check();const box=await mailbox.open(initial.folder);check();
   if(!/^\d{1,20}$/.test(box.uidValidity)||!Number.isSafeInteger(box.uidNext)||box.uidNext<1||box.uidNext>4294967295)throw new Error('Invalid mailbox state.');currentValidity=box.uidValidity;
   if(!initial.cursor){commit(box.uidNext);result.status='initialized';return result;}
   if(initial.cursor.uidValidity!==box.uidValidity){commit(box.uidNext,undefined,'uid_validity_changed');result.status='reset';result.error='uid_validity_changed';return result;}
   const from=initial.cursor.nextUid;if(from>=box.uidNext){commit(from);return result;}const through=Math.min(from+mailboxLimits.uidSpan-1,box.uidNext-1),headers=await mailbox.headers(from,through);check();if(headers.length>mailboxLimits.uidSpan)throw new Error('Too many messages.');const uids=new Set<number>();
   for(const header of [...headers].sort((a,b)=>a.uid-b.uid)){
    check();if(!Number.isSafeInteger(header.uid)||header.uid<from||header.uid>through||uids.has(header.uid)||typeof header.providerId!=='string'||!header.providerId.length||header.providerId.length>254||! /^[a-f0-9]{64}$/.test(header.fingerprint))throw new Error('Invalid mail metadata.');uids.add(header.uid);
    const providerHash=this.index('provider',header.providerId),fingerprint=this.index('header',header.fingerprint),seen=this.store.db.prepare(`SELECT fingerprint FROM ${seenTable} WHERE workspace=? AND mailbox_id=? AND provider_hash=?`).get(workspace,initial.mailboxId!,providerHash);
    if(seen?.fingerprint===fingerprint){commit(header.uid+1);result.skipped++;continue;}
    let references=[...new Set([...(header.inReplyTo?[header.inReplyTo]:[]),...header.references.slice(-32).reverse()])].slice(0,32),badReferences=false;
    while(references.join(' ').length>4096)references.pop();
    try{invoiceMailThreadHeaders({...(references.length?{references}:{})});}catch{references=[];badReferences=true;}
    const bindings=this.references(workspace,initial.mailboxId!,references),invoiceIds=new Set(bindings.map(binding=>binding.invoiceId));let reason:EmailInboxReason|undefined=badReferences?'malformed_headers':seen?'provider_id_collision':undefined;
    if(!reason&&header.messageId&&this.references(workspace,initial.mailboxId!,[header.messageId]).length)reason='rfc_id_collision';
    if(!reason&&!bindings.length){commit(header.uid+1);result.skipped++;continue;}
    if(!reason&&invoiceIds.size!==1)reason='ambiguous_references';const binding=bindings[0];
    if(!reason){const allowed=new Set([...binding.to,...binding.cc,binding.senderEmail].map(value=>value.toLowerCase()));if(!this.store.getInvoice(binding.invoiceId,workspace)||header.from.length!==1||header.from[0]===binding.senderEmail.toLowerCase()||!allowed.has(header.from[0].toLowerCase())||!header.to.some(value=>value.toLowerCase()===binding.senderEmail.toLowerCase())||[...header.to,...header.cc].some(value=>!allowed.has(value.toLowerCase())))reason='recipient_mismatch';}
    if(!reason&&header.malformed)reason='malformed_headers';if(!reason&&header.automated)reason='automated_message';if(!reason&&!header.plainPart)reason='no_plain_text';if(!reason&&header.plainBytes!==undefined&&(!Number.isSafeInteger(header.plainBytes)||header.plainBytes<0||header.plainBytes>mailboxLimits.bodyBytes))reason='oversize_body';
    let text:string|undefined;if(!reason){check();const body=await mailbox.readText(header.uid,header.plainPart!);check();if(body.truncated||Buffer.byteLength(body.text)>mailboxLimits.bodyBytes||body.text.length>mailboxLimits.bodyCharacters)reason='oversize_body';else{text=body.text.replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,'�');if(!text.trim())reason='no_plain_text';}}
    const collision=reason==='provider_id_collision',sourceId=`email:${initial.mailboxId}:${hash(header.providerId)}${collision?':collision:'+header.fingerprint:''}`,sourceHash=this.index('source',sourceId);
    const priorItem=this.store.db.prepare(`SELECT 1 FROM ${itemTable} WHERE workspace=? AND mailbox_id=? AND source_hash=?`).get(workspace,initial.mailboxId!,sourceHash);if(priorItem){commit(header.uid+1);result.skipped++;continue;}
    const item:EmailInboxItem={id:randomUUID(),mailboxId:initial.mailboxId!,providerId:header.providerId,uid:header.uid,uidValidity:currentValidity,sourceId,...(header.messageId?{messageId:header.messageId}:{}),from:reason?[]:[...header.from],to:reason?[]:[...header.to],cc:reason?[]:[...header.cc],replyTo:reason?[]:[...header.replyTo],hasAttachments:header.hasAttachments,authentication:'unverified',status:reason?'quarantined':'requires_review',reason:reason??'unverified_sender',createdAt:this.now().toISOString(),...(!reason?{invoiceId:binding.invoiceId,threadId:binding.threadId,bindingId:binding.id,...(header.subject?{subject:header.subject}:{}),text}: {})};
    commit(header.uid+1,()=>{
     this.store.assertWriteBudget();if(Number(this.store.db.prepare(`SELECT COUNT(*) n FROM ${itemTable} WHERE workspace=?`).get(workspace)!.n)>=Math.min(this.store.limits.idempotencyPerScope,5000))throw new DomainError(429,'This workspace has reached its retained inbox limit.');
     if(!reason){const message=this.options.threads.append(workspace,binding.invoiceId,{channel:'email',direction:'inbound',author:'Unverified email',text:item.text!,state:'pending',sourceId:item.sourceId});item.threadMessageId=message.id;this.addReference(workspace,initial.mailboxId!,header.messageId!,binding.id);}
     this.store.db.prepare(`INSERT INTO ${itemTable}(id,workspace,mailbox_id,source_hash,data) VALUES(?,?,?,?,?)`).run(item.id,workspace,item.mailboxId,sourceHash,this.store.encode(item,itemTable,item.id,workspace));
     this.store.db.prepare(`INSERT OR IGNORE INTO ${seenTable}(workspace,mailbox_id,provider_hash,fingerprint) VALUES(?,?,?,?)`).run(workspace,initial.mailboxId!,providerHash,fingerprint);
    });if(reason)result.quarantined++;else result.imported++;
   }
   commit(through+1);return result;
  })();
  this.pending.add(work);void work.finally(()=>this.pending.delete(work)).catch(()=>{});
  try{return await Promise.race([work,aborted]);}catch(error){if(error instanceof Cancelled&&!timedOut||controller.signal.aborted&&this.closed)return{...result,status:'cancelled'};const code:EmailInboxError=timedOut?'timed_out':'sync_failed';const latest=this.saved(workspace);if(latest.enabled&&latest.revision===initial.revision)this.store.transaction(()=>{latest.lastError=code;this.save(workspace,latest);});return{...result,status:'failed',error:code};}finally{clearTimeout(timer);close();if(this.running.get(workspace)===controller)this.running.delete(workspace);}
 }
}
