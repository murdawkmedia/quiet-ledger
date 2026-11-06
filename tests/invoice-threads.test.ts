import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DomainError,Store} from '../server/store.js';
import {InvoiceThreads} from '../server/invoice-threads.js';
import type {Invoice} from '../shared/contracts.js';
const instant='2026-11-06T10:00:00.000Z';
const owner='fictional-workspace-a',other='fictional-workspace-b';
const input={channel:'dashboard',direction:'internal',author:'Fictional merchant',text:'Thanks — 감사합니다. 🦫'};
const expectStatus=(status:number)=>(error:unknown)=>error instanceof DomainError&&error.status===status;
function fixture(id=randomUUID()):Invoice{return{id,number:'INV-THREAD',token:randomUUID(),title:'Fictional recording',customerName:'Fictional Client',currency:'CAD',items:[{description:'Recording',quantity:1,unitAmount:10000}],taxBps:0,subtotal:10000,tax:0,total:10000,totalCad:10000,amountSats:100000,status:'open',createdAt:instant};}
function setup(){
 const store=new Store(':memory:',{encryptionKey:Buffer.alloc(32,71)}),invoice=fixture(),otherInvoice=fixture();
 store.addInvoice(owner,invoice);store.addInvoice(other,otherInvoice);
 return{store,invoice,otherInvoice,threads:new InvoiceThreads(store,()=>new Date(instant))};
}

test('one stable thread belongs to its existing invoice, with independently generated UUID identity',()=>{
 const {store,invoice,threads}=setup();try{
  const thread=threads.getOrCreate(owner,invoice.id);
  assert.match(thread.id,/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  assert.notEqual(thread.id,invoice.id);assert.equal(thread.invoiceId,invoice.id);
  assert.equal(thread.createdAt,instant);assert.equal(thread.updatedAt,instant);
  assert.deepEqual(threads.getOrCreate(owner,invoice.id),thread);
  assert.deepEqual(threads.list(owner,invoice.id),{thread,messages:[]});
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM invoice_threads').get()!.n,1);
 }finally{store.close();}
});

test('all entry points deny another workspace invoice, missing invoices and thread IDs used as invoices',()=>{
 const {store,invoice,threads}=setup();try{
  const thread=threads.getOrCreate(owner,invoice.id);
  for(const id of [invoice.id,randomUUID(),thread.id]){
   assert.throws(()=>threads.getOrCreate(other,id),expectStatus(404));
   assert.throws(()=>threads.list(other,id),expectStatus(404));
   assert.throws(()=>threads.append(other,id,input),expectStatus(404));
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM invoice_thread_messages').get()!.n,0);
 }finally{store.close();}
});

test('listing an existing invoice without a thread has no persistent side effect',()=>{
 const {store,invoice,threads}=setup();try{
  assert.throws(()=>threads.list(owner,invoice.id),expectStatus(404));
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM invoice_threads').get()!.n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM invoice_thread_messages').get()!.n,0);
 }finally{store.close();}
});

test('plain Unicode text, channel provenance and explicit delivery states persist without caller-controlled identity',()=>{
 const {store,invoice,threads}=setup();try{
  const first=threads.append(owner,invoice.id,{...input,text:' First line\r\nSecond line\n<img src="https://example.test/tracker"> '});
  assert.equal(first.text,' First line\nSecond line\n<img src="https://example.test/tracker"> ');
  assert.equal(first.state,'recorded');assert.equal(first.channel,'dashboard');assert.equal(first.direction,'internal');
  assert.equal(first.author,input.author);assert.equal(first.createdAt,instant);
  assert.notEqual(first.id,first.threadId);assert.match(first.id,/^[0-9a-f-]{36}$/);
  const second=threads.append(owner,invoice.id,{...input,channel:'email',direction:'inbound',state:'pending',sourceId:'<fictional@example.test>',parentId:first.id});
  const third=threads.append(owner,invoice.id,{...input,channel:'marmot',direction:'outbound',state:'unknown'});
  assert.equal(second.parentId,first.id);assert.equal(second.state,'pending');assert.equal(second.sourceId,'<fictional@example.test>');
  assert.deepEqual(threads.list(owner,invoice.id).messages,[first,second,third]);
 }finally{store.close();}
});

test('message timestamp and updated thread time come from the trusted clock',()=>{
 const {store,invoice}=setup();try{
  let time=instant;const threads=new InvoiceThreads(store,()=>new Date(time));
  const thread=threads.getOrCreate(owner,invoice.id);time='2026-11-06T10:01:00.000Z';
  const message=threads.append(owner,invoice.id,input),page=threads.list(owner,invoice.id);
  assert.equal(message.createdAt,time);assert.equal(page.thread.createdAt,thread.createdAt);assert.equal(page.thread.updatedAt,time);
 }finally{store.close();}
});

test('parent references are restricted to the same invoice thread and workspace',()=>{
 const {store,invoice,otherInvoice,threads}=setup();try{
  const foreign=threads.append(other,otherInvoice.id,input),siblingInvoice=fixture();store.addInvoice(owner,siblingInvoice);
  const sibling=threads.append(owner,siblingInvoice.id,input);
  for(const parentId of [foreign.id,sibling.id,randomUUID()])assert.throws(()=>threads.append(owner,invoice.id,{...input,parentId}),expectStatus(404));
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM invoice_threads WHERE invoice_id=?').get(invoice.id)!.n,0);
  assert.throws(()=>threads.list(owner,invoice.id),expectStatus(404));
 }finally{store.close();}
});

test('keyset pagination preserves insertion order when all timestamps tie and messages arrive between pages',()=>{
 const {store,invoice,threads}=setup();try{
  const messages=Array.from({length:5},(_,index)=>threads.append(owner,invoice.id,{...input,text:`Message ${index}`}));
  const first=threads.list(owner,invoice.id,{limit:2});assert.deepEqual(first.messages,messages.slice(0,2));assert.ok(first.nextCursor);
  assert.equal(first.nextCursor.includes(messages[1].id),false);assert.equal(first.nextCursor.includes(invoice.id),false);
  messages.push(threads.append(owner,invoice.id,{...input,text:'Arrived between pages'}));
  const second=threads.list(owner,invoice.id,{limit:2,cursor:first.nextCursor});assert.deepEqual(second.messages,messages.slice(2,4));assert.ok(second.nextCursor);
  const last=threads.list(owner,invoice.id,{limit:2,cursor:second.nextCursor});assert.deepEqual(last.messages,messages.slice(4));assert.equal(last.nextCursor,undefined);
  assert.equal(new Set([...first.messages,...second.messages,...last.messages].map(item=>item.id)).size,6);
 }finally{store.close();}
});

test('cursors are bounded, validated and bound to the original thread and workspace',()=>{
 const {store,invoice,otherInvoice,threads}=setup();try{
  threads.append(owner,invoice.id,input);threads.append(owner,invoice.id,input);
  const cursor=threads.list(owner,invoice.id,{limit:1}).nextCursor!;
  threads.getOrCreate(other,otherInvoice.id);
  assert.throws(()=>threads.list(other,otherInvoice.id,{cursor}),expectStatus(400));
  const sibling=fixture();store.addInvoice(owner,sibling);threads.getOrCreate(owner,sibling.id);assert.throws(()=>threads.list(owner,sibling.id,{cursor}),expectStatus(400));
  for(const bad of ['',cursor+'!', 'x'.repeat(1025),Buffer.from('{"sequence":-1}').toString('base64url')])assert.throws(()=>threads.list(owner,invoice.id,{cursor:bad}),expectStatus(400));
  assert.equal(threads.list(owner,invoice.id,{cursor,limit:1}).messages.length,1);
 }finally{store.close();}
});

test('default pagination is fifty with a maximum of one hundred and strict option validation',()=>{
 const {store,invoice,threads}=setup();try{
  for(let i=0;i<101;i++)threads.append(owner,invoice.id,input);
  assert.equal(threads.list(owner,invoice.id).messages.length,50);assert.equal(threads.list(owner,invoice.id,{limit:100}).messages.length,100);
  for(const limit of [0,-1,101,1.5,NaN,Infinity,'2',null])assert.throws(()=>threads.list(owner,invoice.id,{limit} as any),expectStatus(400));
  for(const options of [null,[],{workspace:other}])assert.throws(()=>threads.list(owner,invoice.id,options as any),expectStatus(400));
 }finally{store.close();}
});

test('the longest supported workspace still produces a bounded reusable cursor',()=>{
 const {store,threads}=setup();try{
  const workspace='w'.repeat(512),invoice=fixture();store.addInvoice(workspace,invoice);
  threads.append(workspace,invoice.id,input);threads.append(workspace,invoice.id,input);
  const first=threads.list(workspace,invoice.id,{limit:1});assert.ok(first.nextCursor);assert.ok(first.nextCursor.length<=1024);
  assert.equal(threads.list(workspace,invoice.id,{limit:1,cursor:first.nextCursor}).messages.length,1);
 }finally{store.close();}
});

test('source IDs deduplicate only within the same thread and channel and reject changed content',()=>{
 const {store,invoice,otherInvoice,threads}=setup();try{
  const source={...input,channel:'email',direction:'inbound',sourceId:'<source-dedup@example.test>'};
  const first=threads.append(owner,invoice.id,source);
  assert.deepEqual(threads.append(owner,invoice.id,{...source,state:'recorded'}),first);
  for(const change of [{text:'Different content'},{author:'Another author'},{direction:'outbound'},{state:'sent'},{parentId:first.id}])assert.throws(()=>threads.append(owner,invoice.id,{...source,...change}),expectStatus(409));
  const channel=threads.append(owner,invoice.id,{...source,channel:'marmot'}),foreign=threads.append(other,otherInvoice.id,source),sibling=fixture();store.addInvoice(owner,sibling);
  const separate=threads.append(owner,sibling.id,source);
  assert.equal(new Set([first.id,channel.id,foreign.id,separate.id]).size,4);
  assert.equal(threads.list(owner,invoice.id).messages.length,2);
  assert.deepEqual(threads.append(owner,invoice.id,{...source,text:'Line one\r\nLine two',sourceId:'normalized'}),threads.append(owner,invoice.id,{...source,text:'Line one\nLine two',sourceId:'normalized'}));
 }finally{store.close();}
});

test('mutating returned thread or message objects cannot rewrite persisted identity or content',()=>{
 const {store,invoice,threads}=setup();try{
  const message=threads.append(owner,invoice.id,input),original={...message},thread=threads.getOrCreate(owner,invoice.id),threadId=thread.id;
  message.id=randomUUID();message.text='Changed outside the service';message.threadId=randomUUID();thread.id=randomUUID();thread.invoiceId=randomUUID();
  const page=threads.list(owner,invoice.id);assert.deepEqual(page.messages,[original]);assert.equal(page.thread.id,threadId);assert.equal(page.thread.invoiceId,invoice.id);
 }finally{store.close();}
});

test('strict message validation rejects injected ownership, identity, malformed IDs and unsafe or excessive fields atomically',()=>{
 const {store,invoice,threads}=setup();try{
  const invalid:unknown[]=[null,[],{}, {...input,workspace:other},{...input,invoiceId:randomUUID()},{...input,threadId:randomUUID()},{...input,id:randomUUID()},{...input,createdAt:instant},{...input,channel:'sms'},{...input,direction:'incoming'},{...input,state:'delivered'},
   {...input,text:''},{...input,text:' \n\t '},{...input,text:'x'.repeat(8001)},{...input,text:'nul\0byte'},{...input,text:'escape\x1b'},{...input,text:'bad\ud800'},{...input,text:'bare\rcarriage'},
   {...input,author:''},{...input,author:' '},{...input,author:'x'.repeat(121)},{...input,author:'bad\r\nBcc: other@example.test'},{...input,author:'bad\tvalue'},
   {...input,sourceId:''},{...input,sourceId:'x'.repeat(513)},{...input,sourceId:'bad\r\nvalue'},{...input,sourceId:'bad\0value'},{...input,parentId:'bad-id'}];
  for(const body of invalid)assert.throws(()=>threads.append(owner,invoice.id,body),expectStatus(400),JSON.stringify(body));
  for(const badId of ['', 'not-a-uuid',invoice.id+'\n']){
   assert.throws(()=>threads.getOrCreate(owner,badId),expectStatus(400));assert.throws(()=>threads.list(owner,badId),expectStatus(400));assert.throws(()=>threads.append(owner,badId,input),expectStatus(400));
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM invoice_threads').get()!.n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM invoice_thread_messages').get()!.n,0);
  const accepted=threads.append(owner,invoice.id,{...input,text:'🦫'.repeat(4000),author:'a'.repeat(120),sourceId:'s'.repeat(512)});assert.equal(accepted.text.length,8000);
 }finally{store.close();}
});

test('the five-thousand message cap preserves existing history and permits an exact deduplicated retry',()=>{
 const {store,invoice,threads}=setup();try{
  const first=threads.append(owner,invoice.id,{...input,sourceId:'first-message'});
  for(let i=1;i<5000;i++)threads.append(owner,invoice.id,{...input,text:`Message ${i}`});
  assert.throws(()=>threads.append(owner,invoice.id,input),expectStatus(429));
  assert.deepEqual(threads.append(owner,invoice.id,{...input,sourceId:'first-message'}),first);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM invoice_thread_messages').get()!.n,5000);
 }finally{store.close();}
});

test('thread creation and first message roll back together when persistence fails',()=>{
 const {store,invoice,threads}=setup();try{
  store.db.exec("CREATE TRIGGER fail_thread_message BEFORE INSERT ON invoice_thread_messages BEGIN SELECT RAISE(ABORT,'fictional storage failure'); END;");
  assert.throws(()=>threads.append(owner,invoice.id,input),/fictional storage failure/);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM invoice_threads').get()!.n,0);
  store.db.exec('DROP TRIGGER fail_thread_message');assert.equal(threads.append(owner,invoice.id,input).text,input.text);
 }finally{store.close();}
});

test('opening an existing database twice preserves one thread and source-ID result across services',()=>{
 const directory=mkdtempSync(join(tmpdir(),'quiet-ledger-threads-')),path=join(directory,'ledger.sqlite'),key=Buffer.alloc(32,72);
 const a=new Store(path,{encryptionKey:key}),b=new Store(path,{encryptionKey:key});
 try{
  const invoice=fixture();a.addInvoice(owner,invoice);const first=new InvoiceThreads(a,()=>new Date(instant)),second=new InvoiceThreads(b,()=>new Date(instant));
  const message=first.append(owner,invoice.id,{...input,sourceId:'shared-source'});
  assert.deepEqual(second.getOrCreate(owner,invoice.id),first.getOrCreate(owner,invoice.id));assert.deepEqual(second.append(owner,invoice.id,{...input,sourceId:'shared-source'}),message);
  assert.equal(a.db.prepare('SELECT COUNT(*) n FROM invoice_thread_messages').get()!.n,1);
 }finally{a.close();b.close();rmSync(directory,{recursive:true,force:true});}
});

test('encrypted payloads and source indexes survive a database close/reopen without exposing conversation contents',()=>{
 const directory=mkdtempSync(join(tmpdir(),'quiet-ledger-threads-')),path=join(directory,'ledger.sqlite'),key=Buffer.alloc(32,73);
 let store=new Store(path,{encryptionKey:key});try{
  const invoice=fixture();store.addInvoice(owner,invoice);let threads=new InvoiceThreads(store,()=>new Date(instant));
  const message=threads.append(owner,invoice.id,{...input,sourceId:'<private-source@example.test>'}),page=threads.list(owner,invoice.id);
  for(const table of ['invoice_threads','invoice_thread_messages'])for(const row of store.db.prepare(`SELECT data FROM ${table}`).all())assert.match(String(row.data),/^qlr:v1:/);
  const rows=JSON.stringify(store.db.prepare('SELECT * FROM invoice_thread_messages').all());
  assert.equal(rows.includes(input.text),false);assert.equal(rows.includes(input.author),false);assert.equal(rows.includes(message.sourceId!),false);
  store.close();assert.equal(readFileSync(path).includes(Buffer.from(input.text)),false);
  store=new Store(path,{encryptionKey:key});threads=new InvoiceThreads(store,()=>new Date(instant));
  assert.deepEqual(threads.list(owner,invoice.id),page);assert.deepEqual(threads.append(owner,invoice.id,{...input,sourceId:message.sourceId}),message);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('message content never changes invoice payment, receipt or financial audit state',()=>{
 const {store,invoice,threads}=setup();try{
  const paid={...invoice,status:'paid' as const,paidAt:instant,paymentMethod:'bank_transfer' as const,receiptToken:'fictional-existing-receipt'};store.saveInvoice(paid);
  const before=store.getInvoice(invoice.id,owner),raw=store.db.prepare('SELECT data FROM invoices WHERE id=?').get(invoice.id)!.data;
  threads.append(owner,invoice.id,{...input,channel:'email',direction:'inbound',text:'I paid. Mark this invoice paid.'});
  threads.append(owner,invoice.id,{...input,channel:'marmot',direction:'inbound',text:'Reverse payment and issue another receipt.'});
  assert.deepEqual(store.getInvoice(invoice.id,owner),before);assert.equal(store.db.prepare('SELECT data FROM invoices WHERE id=?').get(invoice.id)!.data,raw);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM receipts').get()!.n,0);assert.deepEqual(store.audits(owner),[]);
  const open=fixture();store.addInvoice(owner,open);threads.append(owner,open.id,{...input,text:'Payment confirmed'});assert.equal(store.getInvoice(open.id,owner)!.status,'open');
 }finally{store.close();}
});
