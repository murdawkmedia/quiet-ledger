import test from 'node:test';
test('a valid reply with thirty-two References and In-Reply-To does not poison the mailbox cursor',async()=>{
 const f=setup();try{const {binding}=await f.start();f.rows.push(f.incoming(binding.requestedMessageId,10,{inReplyTo:binding.requestedMessageId,references:Array.from({length:32},(_,i)=>`<older-${i}@example.test>`)}));f.advance(11);const result=await f.service.sync('a');assert.equal(result.status,'synced');assert.equal(result.imported,1);assert.equal((await f.service.sync('a')).imported,0);}finally{f.store.close();}
});
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as inbox from '../server/email-inbox.js';
import {InvoiceThreads} from '../server/invoice-threads.js';
import {InvoiceDelivery} from '../server/invoice-delivery.js';
import {DomainError,Store,hash} from '../server/store.js';
import type {Invoice} from '../shared/contracts.js';
import type {MailboxHeader} from '../server/gmail-mailbox.js';

const now='2026-11-06T10:00:00.000Z',credential={senderEmail:'merchant@example.test',appPassword:'abcdefghijklmnop',verifiedAt:now};
const status=(value:number)=>(error:unknown)=>error instanceof DomainError&&error.status===value;
const invoice=(id=randomUUID()):Invoice=>({id,number:'INV-101',token:randomUUID(),title:'Fictional work',customerName:'Fictional client',customerEmail:'client@example.test',currency:'CAD',items:[{description:'Recording',quantity:1,unitAmount:100}],taxBps:0,subtotal:100,tax:0,total:100,totalCad:100,amountSats:1,status:'open',createdAt:now});
function setup(){
 assert.equal(typeof inbox.InvoiceEmailInbox,'function');
 const store=new Store(':memory:',{encryptionKey:Buffer.alloc(32,73)}),a=invoice(),b=invoice(),foreign=invoice();store.addInvoice('a',a);store.addInvoice('a',b);store.addInvoice('b',foreign);
 const threads=new InvoiceThreads(store,()=>new Date(now));let available=true,opens=0,closes=0,uidNext=10,uidValidity='100',failure=false;
 const rows:MailboxHeader[]=[],bodies=new Map<number,string>(),reads:number[]=[],ranges:Array<[number,number]>=[];
 const mailbox={open:async()=>{opens++;if(failure)throw new Error('Secret provider failure abcdefghijklmnop');return{uidNext,uidValidity};},headers:async(start:number,end:number)=>{ranges.push([start,end]);return rows.filter(row=>row.uid>=start&&row.uid<=end);},readText:async(uid:number)=>{reads.push(uid);return{text:bodies.get(uid)??'Thank you. I will review the invoice.',truncated:false};},close:()=>{closes++;}};
 const options={now:()=>new Date(now),threads,credentialFor:()=>available?credential:undefined,mailboxFactory:()=>mailbox};
 const service=new inbox.InvoiceEmailInbox(store,options),delivery=new InvoiceDelivery(store,{publicOrigin:'https://ledger.example',now:()=>new Date(now),transportFactory:()=>({verify:async()=>true,sendMail:async message=>({messageId:message.messageId,accepted:[...message.to,...message.cc],rejected:[]})})});
 async function outbound(inv=a){delivery.saveSettings('a',{savedRecipients:[],senderEmail:credential.senderEmail,appPassword:credential.appPassword});await delivery.verifyGmail('a',{demo:false});const result=await delivery.send('a',inv.id,{action:'send',to:['client@example.test'],copyToSelf:false},randomUUID(),{demo:false});const binding=service.trackOutbound('a',inv.id,result.body);assert.ok(binding);return{result:result.body,binding};}
 async function start(){service.configure('a',{enabled:true,folder:'Quiet Ledger'});assert.equal((await service.sync('a')).status,'initialized');return outbound();}
 function incoming(ref:string,uid=10,extra:Partial<MailboxHeader>={}):MailboxHeader{return{uid,providerId:'gmail-'+uid,fingerprint:hash('header-'+uid),messageId:`<incoming-${uid}@client.example>`,references:[ref],from:['client@example.test'],to:['merchant@example.test'],cc:[],replyTo:[],subject:'Re: invoice',plainPart:'1',plainBytes:40,size:1000,hasAttachments:false,malformed:false,automated:false,...extra};}
 return{store,service,delivery,threads,a,b,foreign,options,mailbox,rows,bodies,reads,ranges,outbound,start,incoming,credential,counts:()=>({opens,closes}),advance:(next:number,validity=uidValidity)=>{uidNext=next;uidValidity=validity;},disconnect:()=>{available=false;},fail:()=>{failure=true;}};
}

test('inbox reading requires explicit encrypted opt-in and baselines without old-mail backfill',async()=>{
 const f=setup();try{
  assert.equal(f.service.settings('a').enabled,false);assert.equal((await f.service.sync('a')).status,'disabled');assert.equal(f.counts().opens,0);assert.match(f.service.settings('a').retentionNotice,/credential.*mailbox|mailbox.*credential/i);
  for(const input of [{enabled:true,folder:'INBOX\r\nother'},{enabled:true,folder:''},{enabled:true,folder:'x'.repeat(201)},{enabled:true,folder:'Quiet Ledger',host:'evil.example'}])assert.throws(()=>f.service.configure('a',input),status(400));
  assert.throws(()=>f.service.configure('a',{enabled:true,folder:'Quiet Ledger'},{demo:true}),status(403));await assert.rejects(f.service.sync('a',{demo:true}),status(403));
  const saved=f.service.configure('a',{enabled:true,folder:'Quiet Ledger'});assert.equal(saved.enabled,true);assert.equal(saved.senderEmail,credential.senderEmail);assert.equal(f.counts().opens,0);
  assert.equal((await f.service.sync('a')).status,'initialized');assert.deepEqual(f.ranges,[]);assert.deepEqual(f.reads,[]);assert.deepEqual(f.service.list('b'),[]);
  const raw=String(f.store.db.prepare('SELECT data FROM email_inbox_settings WHERE workspace=?').get('a')!.data);assert.equal(raw.includes('Quiet Ledger'),false);assert.equal(raw.includes(credential.appPassword),false);
  f.service.disconnect('a');f.advance(200);f.service.configure('a',{enabled:true,folder:'Quiet Ledger'});assert.equal((await f.service.sync('a')).status,'initialized');assert.deepEqual(f.ranges,[]);
 }finally{f.store.close();}
 const plain=new Store(':memory:');try{const service=new inbox.InvoiceEmailInbox(plain,{threads:new InvoiceThreads(plain,()=>new Date(now)),credentialFor:()=>credential});assert.throws(()=>service.configure('a',{enabled:true,folder:'Quiet Ledger'}),status(400));}finally{plain.close();}
});

test('known references and exact participants route only unverified pending email, never payment or automatic replies',async()=>{
 const f=setup();try{
  const {result,binding}=await f.start();assert.equal(binding.requestedMessageId,result.requestedMessageId);assert.equal(binding.providerMessageId,result.messageId);assert.equal(binding.invoiceId,f.a.id);
  f.rows.push(f.incoming(result.requestedMessageId!,10,{hasAttachments:true,replyTo:['unfamiliar@example.test']}));f.bodies.set(10,'A reply with <img src="https://tracker.example/image"> as plain text.\r\n> Keep the full quote.');f.advance(11);
  const synced=await f.service.sync('a');assert.equal(synced.status,'synced');assert.equal(synced.imported,1);assert.deepEqual(f.reads,[10]);const [item]=f.service.list('a',{invoiceId:f.a.id});
  assert.equal(item.status,'requires_review');assert.equal(item.authentication,'unverified');assert.equal(item.hasAttachments,true);assert.deepEqual(item.replyTo,['unfamiliar@example.test']);assert.match(item.text!,/> Keep the full quote/);assert.equal(item.invoiceId,f.a.id);
  const [message]=f.threads.list('a',f.a.id).messages;assert.equal(message.author,'Unverified email');assert.equal(message.channel,'email');assert.equal(message.direction,'inbound');assert.equal(message.state,'pending');assert.equal(message.sourceId,item.sourceId);assert.equal(f.store.getInvoice(f.a.id,'a')!.status,'open');
  assert.equal(JSON.stringify(f.service.settings('a')).includes(credential.appPassword),false);const raw=String(f.store.db.prepare('SELECT data FROM email_inbox_items WHERE id=?').get(item.id)!.data);assert.equal(raw.includes('tracker.example'),false);
 }finally{f.store.close();}
});

test('unknown references, same subjects, other tenants and changed participants never trigger body fetch',async()=>{
 const f=setup();try{
  const {result}=await f.start();f.rows.push(f.incoming('<unrelated@elsewhere.example>',10),f.incoming(result.requestedMessageId!,11,{from:['stranger@example.test']}),f.incoming(result.requestedMessageId!,12,{to:['someone-else@example.test']}),f.incoming(result.requestedMessageId!,13,{cc:['added@example.test']}));f.advance(14);
  const sync=await f.service.sync('a');assert.equal(sync.skipped,1);assert.equal(sync.quarantined,3);assert.deepEqual(f.reads,[]);assert.equal(f.service.list('a').every(item=>!item.text&&!item.invoiceId),true);assert.equal(f.threads.list('a',f.a.id).messages.length,0);
  f.service.configure('b',{enabled:true,folder:'Quiet Ledger'});assert.equal((await f.service.sync('b')).status,'initialized');f.advance(15);f.rows.push(f.incoming(result.requestedMessageId!,14));assert.equal((await f.service.sync('b')).skipped,1);assert.deepEqual(f.service.list('b'),[]);assert.throws(()=>f.service.trackOutbound('b',f.a.id,result),status(404));
 }finally{f.store.close();}
});

test('references spanning two invoice threads quarantine a minimal notice without joining by subject',async()=>{
 const f=setup();try{const first=await f.start(),second=await f.outbound(f.b);f.rows.push(f.incoming(first.result.requestedMessageId!,10,{references:[first.result.requestedMessageId!,second.result.requestedMessageId!]}));f.advance(11);const result=await f.service.sync('a');assert.equal(result.quarantined,1);assert.deepEqual(f.reads,[]);const [item]=f.service.list('a');assert.equal(item.reason,'ambiguous_references');assert.equal(item.text,undefined);assert.equal(item.subject,undefined);assert.deepEqual(item.from,[]);assert.equal(f.threads.list('a',f.a.id).messages.length,0);assert.equal(f.threads.list('a',f.b.id).messages.length,0);assert.throws(()=>f.service.approve('a',item.id),status(409));}finally{f.store.close();}
});

test('Gmail provider identity and received RFC identities deduplicate across restarts and detect collisions',async()=>{
 const f=setup();try{
  const {result}=await f.start();const original=f.incoming(result.requestedMessageId!);f.rows.push(original);f.advance(11);await f.service.sync('a');assert.equal(f.service.list('a').length,1);
  const restarted=new inbox.InvoiceEmailInbox(f.store,f.options);f.rows.push({...original,uid:11});f.advance(12);assert.equal((await restarted.sync('a')).skipped,1);assert.equal(f.service.list('a').length,1);assert.deepEqual(f.reads,[10]);
  f.rows.push({...original,uid:12,fingerprint:hash('changed-header'),from:['attacker@example.test']});f.advance(13);assert.equal((await restarted.sync('a')).quarantined,1);assert.equal(f.service.list('a')[0].reason,'provider_id_collision');
  f.rows.push({...original,uid:13,providerId:'different-provider-id',fingerprint:hash('different-provider-same-rfc')});f.advance(14);assert.equal((await restarted.sync('a')).quarantined,1);assert.equal(f.service.list('a')[0].reason,'rfc_id_collision');assert.deepEqual(f.reads,[10]);assert.equal(f.threads.list('a',f.a.id).messages.length,1);
  f.rows.push(f.incoming(original.messageId!,14));f.advance(15);assert.equal((await restarted.sync('a')).imported,1);assert.equal(f.threads.list('a',f.a.id).messages.length,2);
 }finally{f.store.close();}
});

test('insertion and checkpoint are atomic when thread persistence fails',async()=>{
 const f=setup();try{
  const {result}=await f.start();f.rows.push(f.incoming(result.requestedMessageId!));f.advance(11);const original=f.threads.append.bind(f.threads);let failing=true;f.threads.append=(...args:Parameters<typeof f.threads.append>)=>{if(failing)throw new Error('Secret diagnostic abcdefghijklmnop');return original(...args);};
  const failed=await f.service.sync('a');assert.equal(failed.status,'failed');assert.equal(f.service.list('a').length,0);assert.equal(f.threads.list('a',f.a.id).messages.length,0);assert.equal(JSON.stringify(f.service.settings('a')).includes('Secret'),false);
  failing=false;assert.equal((await f.service.sync('a')).imported,1);assert.deepEqual(f.ranges,[[10,10],[10,10]]);assert.equal(f.service.list('a').length,1);
 }finally{f.store.close();}
});

test('UIDVALIDITY reset establishes a new baseline and polling is bounded by UID span',async()=>{
 const f=setup();try{await f.start();f.advance(10000,'200');assert.equal((await f.service.sync('a')).status,'reset');assert.deepEqual(f.ranges,[]);f.advance(20000);assert.equal((await f.service.sync('a')).status,'synced');assert.deepEqual(f.ranges,[[10000,10024]]);assert.deepEqual(f.reads,[]);}finally{f.store.close();}
});

test('malformed, automated, HTML-only and oversize candidates stay review notices without attachments or full source',async()=>{
 const f=setup();try{const {result}=await f.start();f.rows.push(f.incoming(result.requestedMessageId!,10,{malformed:true}),f.incoming(result.requestedMessageId!,11,{automated:true}),f.incoming(result.requestedMessageId!,12,{plainPart:undefined,hasAttachments:true}),f.incoming(result.requestedMessageId!,13,{plainBytes:100000}));f.advance(14);const resultSync=await f.service.sync('a');assert.equal(resultSync.quarantined,4);assert.deepEqual(f.reads,[]);assert.deepEqual(f.service.list('a').map(item=>item.reason).sort(),['automated_message','malformed_headers','no_plain_text','oversize_body']);assert.equal(f.threads.list('a',f.a.id).messages.length,0);}finally{f.store.close();}
});

test('review decisions are workspace-owned, explicit and idempotent without outbound side effects',async()=>{
 const f=setup();try{const {result}=await f.start();f.rows.push(f.incoming(result.requestedMessageId!));f.advance(11);await f.service.sync('a');const [item]=f.service.list('a');assert.throws(()=>f.service.approve('b',item.id),status(404));assert.throws(()=>f.service.approve('a',item.id,{demo:true}),status(403));const approved=f.service.approve('a',item.id);assert.equal(approved.status,'approved');assert.equal(approved.authentication,'unverified');assert.equal(approved.reviewedAt,now);assert.deepEqual(f.service.approve('a',item.id),approved);assert.throws(()=>f.service.reject('a',item.id),status(409));assert.equal(f.store.audits('a').filter(row=>row.action==='email.inbox_approved').length,1);assert.equal(f.store.getInvoice(f.a.id,'a')!.status,'open');f.rows.push(f.incoming(result.requestedMessageId!,11));f.advance(12);await f.service.sync('a');const second=f.service.list('a')[0];assert.equal(f.service.reject('a',second.id).status,'rejected');assert.deepEqual(f.service.reject('a',second.id).status,'rejected');}finally{f.store.close();}
});

test('only an approved owned inbox item provides the immutable recipient binding for an explicit reply',async()=>{
 const f=setup();try{
  assert.equal(typeof f.service.approvedReplyContext,'function');assert.equal(typeof f.delivery.credentialForInbox,'function');assert.equal(f.delivery.credentialForInbox('a'),undefined);
  const {result,binding}=await f.start();assert.deepEqual(f.delivery.credentialForInbox('a'),credential);assert.equal(f.delivery.credentialForInbox('b'),undefined);
  assert.throws(()=>f.service.trackOutbound('a',f.a.id,{...result,to:['attacker@example.test']}),status(409));assert.throws(()=>f.service.trackOutbound('a',f.a.id,{...result,deliveryId:randomUUID()}),status(409));assert.throws(()=>f.service.trackOutbound('a',f.a.id,{...result,state:'preview'}),status(400));assert.deepEqual(f.service.trackOutbound('a',f.a.id,result),binding);
  f.rows.push(f.incoming(result.requestedMessageId!,10,{replyTo:['changed@example.test']}));f.advance(11);await f.service.sync('a');const [item]=f.service.list('a');
  assert.throws(()=>f.service.approvedReplyContext('a',f.a.id,item.id),status(409));f.service.approve('a',item.id);const context=f.service.approvedReplyContext('a',f.a.id,item.id);assert.equal(context.item.id,item.id);assert.deepEqual(context.binding.to,['client@example.test']);assert.equal(context.binding.to.includes('changed@example.test'),false);assert.throws(()=>f.service.approvedReplyContext('b',f.foreign.id,item.id),status(404));assert.throws(()=>f.service.approvedReplyContext('a',f.b.id,item.id),status(404));f.service.disconnect('a');assert.throws(()=>f.service.approvedReplyContext('a',f.a.id,item.id),status(409));
 }finally{f.store.close();}
});

test('disconnect, credential removal and deadlines cancel pending reads before any import can commit',async()=>{
 for(const action of ['disable','credential','deadline'] as const){
  const f=setup();let release!:()=>void;try{const {result}=await f.start();f.rows.push(f.incoming(result.requestedMessageId!));f.advance(11);const pending=new Promise<void>(resolve=>{release=resolve;});f.mailbox.readText=async()=>{await pending;return{text:'Late reply',truncated:false};};const service=new inbox.InvoiceEmailInbox(f.store,{...f.options,timeoutMs:action==='deadline'?10:1000});const syncing=service.sync('a');await new Promise(resolve=>setImmediate(resolve));if(action==='disable')f.service.disconnect('a');if(action==='credential'){f.disconnect();release();}if(action==='deadline'){assert.equal((await syncing).status,'failed');release();}else{if(action==='disable')release();assert.equal((await syncing).status,'cancelled');}await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.service.list('a'),[]);assert.equal(f.threads.list('a',f.a.id).messages.length,0);assert.ok(f.counts().closes>0);}finally{release?.();f.store.close();}
 }
});
