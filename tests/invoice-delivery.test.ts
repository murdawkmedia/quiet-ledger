import test from 'node:test';
import assert from 'node:assert/strict';
import {Store,DomainError} from '../server/store.js';
import {InvoiceDelivery} from '../server/invoice-delivery.js';
import type {Invoice} from '../shared/contracts.js';

const instant='2026-11-06T10:00:00.000Z';
const invoice:Invoice={id:'fixture-invoice',number:'INV-101',token:'fictional-private-checkout',title:'Workshop recording',customerName:'Fictional Workshop',customerEmail:'client@example.test',currency:'KRW',items:[{description:'Recording',quantity:1,unitAmount:150000}],taxBps:0,subtotal:150000,tax:0,total:150000,totalCad:15000,amountSats:100000,status:'open',createdAt:instant,dueDate:'2026-11-20'};
function setup(){const store=new Store(':memory:',{encryptionKey:Buffer.alloc(32,41)});store.addInvoice('account-a',invoice);const delivery=new InvoiceDelivery(store,{publicOrigin:'https://ledger.example',now:()=>new Date(instant)});return{store,delivery};}
const draft={action:'draft',to:['client@example.test'],copyToSelf:true,message:'Thanks for the workshop.'};
const expectStatus=(status:number)=>(error:unknown)=>error instanceof DomainError&&error.status===status;

test('saved recipients and self-copy settings are encrypted and isolated by workspace',()=>{
 const {store,delivery}=setup();try{
  const settings=delivery.saveSettings('account-a',{savedRecipients:[{label:'Usual client',email:'regular@example.test'}],selfCopyEmail:'office@example.test'});
  assert.equal(settings.selfCopyEmail,'office@example.test');
  assert.deepEqual(delivery.settings('account-b'),{savedRecipients:[]});
  const raw=String(store.db.prepare('SELECT data FROM invoice_email_settings WHERE workspace=?').get('account-a')!.data);
  assert.equal(raw.includes('regular@example.test'),false);assert.equal(raw.includes('office@example.test'),false);
  const view=delivery.view('account-a',invoice.id,{demo:false});
  assert.deepEqual(view.recipients.map(row=>row.email),['regular@example.test','client@example.test']);
  assert.throws(()=>delivery.view('account-b',invoice.id,{demo:false}),expectStatus(404));
 }finally{store.close();}
});

test('mail app draft uses the trusted checkout origin, explicit To and optional CC without claiming delivery',()=>{
 const {store,delivery}=setup();try{
  delivery.saveSettings('account-a',{savedRecipients:[],selfCopyEmail:'office@example.test'});
  const result=delivery.compose('account-a',invoice.id,draft,'draft-1',{demo:false});
  assert.equal(result.status,200);assert.equal(result.body.state,'draft_ready');assert.deepEqual(result.body.to,['client@example.test']);assert.deepEqual(result.body.cc,['office@example.test']);
  assert.equal(result.body.checkoutUrl,'https://ledger.example/pay/fictional-private-checkout');
  assert.match(result.body.text,/150,000/);assert.match(result.body.text,/KRW|₩/);assert.match(result.body.text,/Thanks for the workshop/);
  const url=new URL(result.body.mailtoUrl!);assert.equal(url.protocol,'mailto:');assert.equal(decodeURIComponent(url.pathname),'client@example.test');assert.equal(url.searchParams.get('cc'),'office@example.test');assert.equal(url.searchParams.get('body'),result.body.text);
  assert.equal(result.body.mailtoUrl!.includes('+'),false);assert.match(result.body.mailtoUrl!,/%20/);
  assert.deepEqual(delivery.compose('account-a',invoice.id,draft,'draft-1',{demo:false}),result);
  assert.equal(store.audits('account-a').length,1);assert.match(store.audits('account-a')[0].action,/draft/);assert.equal(store.getInvoice(invoice.id,'account-a')!.status,'open');
  assert.throws(()=>delivery.compose('account-a',invoice.id,{...draft,message:'A different note.'},'draft-1',{demo:false}),expectStatus(409));
  assert.deepEqual(delivery.compose('account-a',invoice.id,{...draft,copyToSelf:false},'draft-2',{demo:false}).body.cc,[]);
 }finally{store.close();}
});

test('Gmail credentials are encrypted, never returned, scoped to the sender and prohibited in demo',async()=>{
 const {store}=setup();let verified=0;const delivery=new InvoiceDelivery(store,{publicOrigin:'https://ledger.example',now:()=>new Date(instant),transportFactory:async credentials=>{assert.equal(credentials.senderEmail,'sender@example.test');assert.equal(credentials.appPassword,'abcdefghijklmnop');return{verify:async()=>{verified++;return true;},sendMail:async()=>{throw new Error('Unexpected send.');}};}});
 try{
  assert.throws(()=>delivery.saveSettings('account-a',{savedRecipients:[],senderEmail:'sender@example.test',appPassword:'abcdefghijklmnop'},{demo:true}),expectStatus(403));
  const saved=delivery.saveSettings('account-a',{savedRecipients:[],senderEmail:'sender@example.test',appPassword:'abcd efgh ijkl mnop'},{demo:false});
  assert.equal(saved.gmailConfigured,true);assert.equal(saved.selfCopyEmail,'sender@example.test');assert.equal(JSON.stringify(saved).includes('abcdefghijklmnop'),false);assert.equal(verified,0);
  const credential=String(store.db.prepare('SELECT data FROM invoice_email_credentials WHERE workspace=?').get('account-a')!.data);assert.equal(credential.includes('abcdefghijklmnop'),false);
  assert.equal(delivery.settings('account-b').gmailConfigured,undefined);
  const connected=await delivery.verifyGmail('account-a',{demo:false});assert.equal(verified,1);assert.equal(connected.gmailVerifiedAt,instant);
  await assert.rejects(delivery.verifyGmail('account-a',{demo:true}),expectStatus(403));
  delivery.saveSettings('account-a',{savedRecipients:[],senderEmail:'other@example.test'},{demo:false});assert.equal(delivery.settings('account-a').gmailConfigured,undefined);
 }finally{store.close();}
});

test('real send only records SMTP acceptance after all recipients are accepted, and retry never resends',async()=>{
 const {store}=setup();let sends=0;const delivery=new InvoiceDelivery(store,{publicOrigin:'https://ledger.example',transportFactory:()=>({verify:async()=>true,sendMail:async message=>{sends++;assert.equal(message.from,'sender@example.test');assert.deepEqual(message.to,['client@example.test']);assert.deepEqual(message.cc,['sender@example.test']);assert.equal(message.disableUrlAccess,true);assert.equal(message.disableFileAccess,true);assert.match(message.messageId,/^<.+@ledger\.example>$/);return{messageId:'<fixture@example.test>',accepted:[...message.to,...message.cc],rejected:[]};}})});
 try{
  delivery.saveSettings('account-a',{savedRecipients:[],senderEmail:'sender@example.test',appPassword:'abcdefghijklmnop'},{demo:false});
  await assert.rejects(delivery.send('account-a',invoice.id,{...draft,action:'send'},'unverified',{demo:false}),expectStatus(409));
  await delivery.verifyGmail('account-a',{demo:false});
  const input={...draft,action:'send'};const result=await delivery.send('account-a',invoice.id,input,'send-1',{demo:false});
  assert.equal(result.body.state,'provider_accepted');assert.equal(result.body.messageId,'<fixture@example.test>');assert.equal(sends,1);assert.equal(store.getInvoice(invoice.id,'account-a')!.status,'open');
  assert.deepEqual(await delivery.send('account-a',invoice.id,input,'send-1',{demo:false}),result);assert.equal(sends,1);
  await assert.rejects(delivery.send('account-a',invoice.id,{...input,to:['different@example.test']},'send-1',{demo:false}),expectStatus(409));
  await assert.rejects(delivery.send('account-a',invoice.id,input,'send-demo',{demo:true}),expectStatus(403));assert.equal(sends,1);
  assert.equal(delivery.view('account-a',invoice.id,{demo:false}).deliveries[0].state,'provider_accepted');
 }finally{store.close();}
});

test('interrupted or partial SMTP submission never becomes a false send success or an automatic retry',async()=>{
 for(const outcome of ['timeout','partial','pending'] as const){
  const {store}=setup();let sends=0,release:(()=>void)|undefined;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  const options={publicOrigin:'https://ledger.example',transportFactory:()=>({verify:async()=>true,sendMail:async()=>{sends++;if(outcome==='timeout')throw new Error('Secret provider text abcdefghijklmnop');if(outcome==='pending')await pending;return{messageId:'<fixture@example.test>',accepted:['client@example.test'],rejected:outcome==='partial'?['sender@example.test']:[]};}})};
  const delivery=new InvoiceDelivery(store,options);
  try{
   delivery.saveSettings('account-a',{savedRecipients:[],senderEmail:'sender@example.test',appPassword:'abcdefghijklmnop'},{demo:false});
   await delivery.verifyGmail('account-a',{demo:false});
   const input={...draft,action:'send'};const first=delivery.send('account-a',invoice.id,input,'same-send',{demo:false});
   if(outcome==='pending'){await new Promise(resolve=>setImmediate(resolve));const concurrent=await delivery.send('account-a',invoice.id,input,'same-send',{demo:false});assert.equal(concurrent.body.state,'unknown');release!();}
   const result=await first;assert.equal(result.body.state,outcome==='partial'?'partial_rejection':'unknown');assert.equal(sends,1);
   const restarted=new InvoiceDelivery(store,options);assert.equal((await restarted.send('account-a',invoice.id,input,'same-send',{demo:false})).body.state,result.body.state);assert.equal(sends,1);
   assert.equal(JSON.stringify(result).includes('abcdefghijklmnop'),false);
   await assert.rejects(restarted.send('account-a',invoice.id,input,'new-key-after-uncertain',{demo:false}),expectStatus(409));
  }finally{release?.();store.close();}
 }
});

test('SMTP deadlines close stalled transports and persist uncertain submissions without retry',async()=>{
 const {store}=setup();let closes=0;
 const delivery=new InvoiceDelivery(store,{publicOrigin:'https://ledger.example',transportTimeoutMs:20,transportFactory:()=>({verify:async()=>new Promise(resolve=>setTimeout(()=>resolve(true),100)),sendMail:async()=>new Promise(resolve=>setTimeout(()=>resolve({accepted:[]}),100)),close:()=>{closes++;}})});
 try{
  delivery.saveSettings('account-a',{savedRecipients:[],senderEmail:'sender@example.test',appPassword:'abcdefghijklmnop'},{demo:false});
  await assert.rejects(delivery.verifyGmail('account-a',{demo:false}),expectStatus(502));assert.equal(closes,1);assert.equal(delivery.settings('account-a').gmailVerifiedAt,undefined);
  const sender=new InvoiceDelivery(store,{publicOrigin:'https://ledger.example',transportTimeoutMs:20,transportFactory:()=>({verify:async()=>true,sendMail:async()=>new Promise(resolve=>setTimeout(()=>resolve({accepted:['client@example.test','sender@example.test']}),100)),close:()=>{closes++;}})});
  await sender.verifyGmail('account-a',{demo:false});const before=closes,result=await sender.send('account-a',invoice.id,{...draft,action:'send'},'stalled',{demo:false});
  assert.equal(result.body.state,'unknown');assert.equal(closes,before+1);assert.equal((await sender.send('account-a',invoice.id,{...draft,action:'send'},'stalled',{demo:false})).body.state,'unknown');assert.equal(closes,before+1);
  assert.throws(()=>new InvoiceDelivery(store,{publicOrigin:'https://ledger.example',transportTimeoutMs:12001}));
 }finally{store.close();}
});

test('known Gmail authentication rejection records not_sent and requires reconnection before another attempt',async()=>{
 const {store}=setup();let sends=0;
 const delivery=new InvoiceDelivery(store,{publicOrigin:'https://ledger.example',transportFactory:()=>({verify:async()=>true,sendMail:async()=>{sends++;throw Object.assign(new Error('Private provider details must not escape'),{code:'EAUTH',command:'AUTH PLAIN'});}})});
 try{
  delivery.saveSettings('account-a',{savedRecipients:[],senderEmail:'sender@example.test',appPassword:'abcdefghijklmnop'},{demo:false});await delivery.verifyGmail('account-a',{demo:false});
  const input={...draft,action:'send'},result=await delivery.send('account-a',invoice.id,input,'auth-rejected',{demo:false});assert.equal(result.body.state,'not_sent');assert.equal(delivery.settings('account-a').gmailVerifiedAt,undefined);assert.equal(JSON.stringify(result).includes('Private provider'),false);
  assert.deepEqual(await delivery.send('account-a',invoice.id,input,'auth-rejected',{demo:false}),result);assert.equal(sends,1);
  await assert.rejects(delivery.send('account-a',invoice.id,input,'new-attempt',{demo:false}),expectStatus(409));
 }finally{store.close();}
});

test('a false SMTP verification response cannot enable automatic sending',async()=>{
 const {store}=setup();const delivery=new InvoiceDelivery(store,{publicOrigin:'https://ledger.example',transportFactory:()=>({verify:async()=>false,sendMail:async()=>{throw new Error('Unexpected send.');}})});
 try{delivery.saveSettings('account-a',{savedRecipients:[],senderEmail:'sender@example.test',appPassword:'abcdefghijklmnop'},{demo:false});await assert.rejects(delivery.verifyGmail('account-a',{demo:false}),expectStatus(502));assert.equal(delivery.settings('account-a').gmailVerifiedAt,undefined);}finally{store.close();}
});

test('demo only previews fictional messages and never exposes an external mail draft',()=>{
 const {store,delivery}=setup();try{
  const result=delivery.compose('account-a',invoice.id,{...draft,action:'preview',copyToSelf:false},'preview-1',{demo:true});
  assert.equal(result.body.state,'preview');assert.equal(result.body.mailtoUrl,undefined);
  assert.equal(delivery.view('account-a',invoice.id,{demo:true}).mailAppAvailable,false);
  assert.throws(()=>delivery.compose('account-a',invoice.id,{...draft,copyToSelf:false},'draft-denied',{demo:true}),expectStatus(403));
  assert.equal(store.audits('account-a').length,1);assert.equal(store.audits('account-a')[0].action,'invoice.email_preview');
 }finally{store.close();}
});

test('addresses, recipient count, self-copy configuration, ownership and revoked links fail closed',()=>{
 const {store,delivery}=setup();try{
  for(const email of ['client@example.test\r\nBcc: hidden@example.test','Name <client@example.test>','client@example.test,hidden@example.test','client@example.test?bcc=hidden@example.test'])assert.throws(()=>delivery.saveSettings('account-a',{savedRecipients:[{label:'Client',email}]}),expectStatus(400));
  assert.throws(()=>delivery.compose('account-a',invoice.id,draft,'no-copy-setting',{demo:false}),expectStatus(400));
  assert.throws(()=>delivery.compose('account-a',invoice.id,{...draft,to:Array.from({length:6},(_,i)=>`client${i}@example.test`),copyToSelf:false},'too-many',{demo:false}),expectStatus(400));
  delivery.saveSettings('account-a',{savedRecipients:[],selfCopyEmail:'office@example.test'});
  assert.throws(()=>delivery.compose('account-a',invoice.id,{...draft,to:Array.from({length:5},(_,i)=>`client${i}@example.test`)},'too-many-cc',{demo:false}),expectStatus(400));
  assert.throws(()=>delivery.compose('account-a',invoice.id,{...draft,subject:'Overridden'},'extra-field',{demo:false}),expectStatus(400));
  assert.throws(()=>delivery.compose('account-b',invoice.id,{...draft,copyToSelf:false},'foreign',{demo:false}),expectStatus(404));
  assert.throws(()=>delivery.compose('account-a',invoice.id,{...draft,copyToSelf:false},undefined,{demo:false}),expectStatus(400));
  store.revokeInvoiceLinks(invoice.id,'account-a',instant);
  assert.throws(()=>delivery.view('account-a',invoice.id,{demo:false}),expectStatus(409));
  assert.throws(()=>delivery.compose('account-a',invoice.id,{...draft,copyToSelf:false},'revoked',{demo:false}),expectStatus(409));
  assert.equal(store.audits('account-a').length,0);
 }finally{store.close();}
});

test('preview treats invoice strings as plain text and mailto query cannot inject headers',()=>{
 const {store,delivery}=setup();try{
  store.saveInvoice({...invoice,title:'Workshop\r\nBcc: hidden@example.test & ready?'});
  const result=delivery.compose('account-a',invoice.id,{...draft,copyToSelf:false},'escaped',{demo:false}).body;
  assert.equal(/[\r\n]/.test(result.subject),false);const url=new URL(result.mailtoUrl!);assert.equal(url.searchParams.has('bcc'),false);assert.equal(url.searchParams.get('subject'),result.subject);
  assert.throws(()=>new InvoiceDelivery(store,{publicOrigin:'https://evil.example/path'}));
  assert.throws(()=>new InvoiceDelivery(store,{publicOrigin:'http://remote.example'}));
 }finally{store.close();}
});
