import test from 'node:test';
test('gateway dispatch authority is revoked while the email port is preparing its transport',async()=>{
 const f=setup();let release!:()=>void,entered!:()=>void,pending:Promise<unknown>|undefined;const held=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});let submissions=0;
 f.options.email.send=async(...args)=>{entered();await held;const guard=(args as unknown[])[4] as {assertCurrent:()=>void|Promise<void>}|undefined;await guard?.assertCurrent();submissions++;return{state:'sent'};};
 try{const settings=await paired(f),{nonce}=await prepare(f,settings.groupId!);f.push(settings.groupId!,`/send ${nonce}`);pending=f.gateway.process(workspace,f.bill.id);await ready;f.gateway.disconnect(workspace,f.bill.id);release();await pending;assert.equal(submissions,0);}finally{release();await pending?.catch(()=>{});f.store.close();}
});
test('forwarding approved email synchronizes current membership before sending any plaintext envelope',async()=>{
 const f=setup();let revoked=false,current=true,syncs=0;const actor=f.options.marmotFor(workspace) as Awaited<ReturnType<typeof f.options.marmotFor>>;
 actor.isAuthorized=()=>current;actor.sync=async()=>{syncs++;if(revoked)current=false;};
 try{await paired(f);revoked=true;const before=syncs;await assert.rejects(f.gateway.forwardApproved(workspace,f.bill.id,{sourceId:'approved-fixture',from:'client@example.test',text:'Fictional private email'}),status(409));assert.ok(syncs>before);assert.equal(f.posted.some(v=>v.text.includes('Fictional private email')),false);}finally{f.store.close();}
});
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,DomainError} from '../server/store.js';
import {EmailMarmotGateway,type EmailMarmotGatewayOptions} from '../server/email-marmot-gateway.js';
import {MarmotGatewayStore} from '../server/marmot-gateway-store.js';
import type {GatewayEmailPayload,GatewayMarmotMessage} from '../shared/email-gateway.js';
import type {Invoice} from '../shared/contracts.js';

const workspace='fictional-gateway-a',other='fictional-gateway-b';
const owner='a'.repeat(64),impostor='b'.repeat(64),gatewayKey='c'.repeat(64);
const instant=Date.parse('2026-11-06T15:00:00Z');
const status=(code:number)=>(error:unknown)=>error instanceof DomainError&&error.status===code;
function invoice():Invoice{return{id:randomUUID(),number:'INV-GATEWAY',token:randomUUID(),title:'Fictional service',customerName:'Fictional Client',currency:'CAD',items:[{description:'Recording',quantity:1,unitAmount:10000}],taxBps:0,subtotal:10000,tax:0,total:10000,totalCad:10000,amountSats:100000,status:'open',createdAt:new Date(instant).toISOString()};}
function setup(path=':memory:',existingInvoice?:Invoice){
 const store=new Store(path,{encryptionKey:Buffer.alloc(32,91)}),bill=existingInvoice??invoice();
 if(!existingInvoice)store.addInvoice(workspace,bill);
 let time=instant,active=true,to='client@example.test',duringPreview:undefined|(()=>void);
 const messages:GatewayMarmotMessage[]=[],posted:{groupId:string;text:string}[]=[],invitations:{peer:string;context?:string}[]=[],sent:{payload:GatewayEmailPayload;intentKey:string}[]=[];
 let sendOutcome:'sent'|'unknown'|'failed'='sent',sendThrows=false,inviteThrows=false;
 const marmot={pubkey:gatewayKey,async invite(peer:string,opts?:{context?:string}){if(inviteThrows)throw new Error('Private transport error');invitations.push({peer,context:opts?.context});return{id:randomUUID()};},async send(groupId:string,text:string){posted.push({groupId,text});return{id:randomUUID()};},messages:(groupId:string)=>messages.filter(m=>m.groupId===groupId||m.groupId==='malicious-group'),async sync(){}};
 const email={authority:()=>active?'fictional-authority':undefined,active:()=>active,preview:(_w:string,_i:string,text:string)=>{duringPreview?.();return{to:[to],cc:['merchant@example.test'],subject:'Invoice INV-GATEWAY',text};},async send(_w:string,_i:string,payload:GatewayEmailPayload,intentKey:string){sent.push({payload:structuredClone(payload),intentKey});if(sendThrows)throw new Error('Network submission uncertain');return{state:sendOutcome,messageId:'fictional-provider-id'};}};
 const options:EmailMarmotGatewayOptions={now:()=>new Date(time),marmotFor:()=>marmot,email};
 const gateway=new EmailMarmotGateway(store,options);
 const push=(groupId:string,text:string,sender=owner,createdAt=time/1000)=>{const message={id:randomUUID(),groupId,sender,text,createdAt};messages.push(message);return message;};
 return{store,bill,gateway,options,posted,invitations,sent,messages,push,setTime:(value:number)=>time=value,setActive:(value:boolean)=>active=value,setRecipient:(value:string)=>to=value,setPreviewHook:(value:()=>void)=>duringPreview=value,setOutcome:(value:typeof sendOutcome)=>sendOutcome=value,setSendThrows:()=>sendThrows=true,setInviteThrows:()=>inviteThrows=true};
}
async function paired(f:ReturnType<typeof setup>){const settings=await f.gateway.configure(workspace,f.bill.id,{enabled:true,ownerPubkey:owner});assert.equal(settings.status,'pending');assert.ok(settings.pairCode);assert.ok(settings.groupId);f.push(settings.groupId,`/pair ${settings.pairCode}`);await f.gateway.process(workspace,f.bill.id);assert.equal(f.gateway.settings(workspace,f.bill.id).status,'paired');return settings;}
async function prepare(f:ReturnType<typeof setup>,groupId:string,text='Fictional reply'){f.push(groupId,`/email ${text}`);await f.gateway.process(workspace,f.bill.id);const preview=f.posted.findLast(item=>item.text.includes('/send '));assert.ok(preview);const nonce=preview.text.match(/\/send ([A-Za-z0-9_-]+)/)?.[1];assert.ok(nonce);return{nonce,preview};}

test('disabled gateway has no side effects; pairing creates an owner-only opaque invoice group',async()=>{
 const f=setup();try{
  assert.equal(f.gateway.settings(workspace,f.bill.id).status,'disabled');await f.gateway.process(workspace,f.bill.id);assert.equal(f.invitations.length,0);
  const config=await f.gateway.configure(workspace,f.bill.id,{enabled:true,ownerPubkey:owner});
  assert.equal(f.invitations.length,1);assert.equal(f.invitations[0].peer,owner);assert.match(f.invitations[0].context!,/^[a-f0-9]{64}$/);assert.equal(f.invitations[0].context!.includes(f.bill.id),false);
  assert.equal(config.gatewayPubkey,gatewayKey);assert.equal(f.gateway.settings(workspace,f.bill.id).pairCode,undefined);
  const raw=JSON.stringify(f.store.db.prepare('SELECT * FROM email_marmot_gateways').all());assert.equal(raw.includes(config.pairCode!),false);
  await assert.rejects(f.gateway.forwardApproved(workspace,f.bill.id,{sourceId:'mail-1',from:'Client <client@example.test>',text:'Hello'}),status(409));
 }finally{f.store.close();}
});

test('only the configured actual sender can pair, and expired codes require fresh pairing',async()=>{
 const f=setup();try{
  const config=await f.gateway.configure(workspace,f.bill.id,{enabled:true,ownerPubkey:owner});
  f.push(config.groupId!,`/pair ${config.pairCode}`,impostor);await f.gateway.process(workspace,f.bill.id);assert.equal(f.gateway.settings(workspace,f.bill.id).status,'pending');
  f.setTime(instant+11*60_000);f.push(config.groupId!,`/pair ${config.pairCode}`);await f.gateway.process(workspace,f.bill.id);assert.equal(f.gateway.settings(workspace,f.bill.id).status,'pending');
  const fresh=await f.gateway.configure(workspace,f.bill.id,{enabled:true,ownerPubkey:owner});assert.notEqual(fresh.pairCode,config.pairCode);
  f.push(fresh.groupId!,`/pair ${fresh.pairCode}`);await f.gateway.process(workspace,f.bill.id);assert.equal(f.gateway.settings(workspace,f.bill.id).status,'paired');
 }finally{f.store.close();}
});

test('ordinary chat, malicious senders, stale messages, wrong groups and unpaired commands never send',async()=>{
 const f=setup();try{
  const config=await paired(f),before=f.posted.length;
  f.push(config.groupId!,'Send that invoice please');f.push(config.groupId!,'/email stolen',impostor);f.push('malicious-group','/email wrong group');f.push(config.groupId!,'/email stale',owner,(instant-60*60_000)/1000);f.push(config.groupId!,'/email future',owner,(instant+10*60_000)/1000);f.push(config.groupId!,'/send random');
  await f.gateway.process(workspace,f.bill.id);assert.equal(f.sent.length,0);assert.equal(f.posted.length,before);assert.equal(f.store.getInvoice(f.bill.id,workspace)!.status,'open');
 }finally{f.store.close();}
});

test('exact recipient/content preview and a fresh single-use confirmation are required for email',async()=>{
 const f=setup();try{
  const config=await paired(f),{nonce,preview}=await prepare(f,config.groupId!,'Hello\nThis is the exact reply.');
  assert.match(preview.text,/To: client@example.test/);assert.match(preview.text,/CC: merchant@example.test/);assert.match(preview.text,/Subject: Invoice INV-GATEWAY/);assert.match(preview.text,/Hello\nThis is the exact reply\./);assert.equal(f.sent.length,0);
  f.push(config.groupId!,`/send ${nonce}`,impostor);await f.gateway.process(workspace,f.bill.id);assert.equal(f.sent.length,0);
  f.push(config.groupId!,`/send ${nonce}`);await f.gateway.process(workspace,f.bill.id);assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0].payload,{to:['client@example.test'],cc:['merchant@example.test'],subject:'Invoice INV-GATEWAY',text:'Hello\nThis is the exact reply.'});
  f.push(config.groupId!,`/send ${nonce}`);await f.gateway.process(workspace,f.bill.id);assert.equal(f.sent.length,1);
 }finally{f.store.close();}
});

test('expired confirmations, changed recipients and a disconnected mailbox cancel send authority',async()=>{
 for(const reason of ['expired','recipients','connection','revocation']as const){const f=setup();try{
  const config=await paired(f),{nonce}=await prepare(f,config.groupId!);
  if(reason==='expired')f.setTime(instant+6*60_000);if(reason==='recipients')f.setRecipient('different@example.test');if(reason==='connection')f.setActive(false);if(reason==='revocation')f.gateway.disconnect(workspace,f.bill.id);
  f.push(config.groupId!,`/send ${nonce}`);await f.gateway.process(workspace,f.bill.id);assert.equal(f.sent.length,0,reason);
 }finally{f.store.close();}}
});

test('revocation while preparing a dispatch cannot race past the final persisted authority check',async()=>{
 const f=setup();try{const config=await paired(f),{nonce}=await prepare(f,config.groupId!);f.setPreviewHook(()=>f.gateway.disconnect(workspace,f.bill.id));f.push(config.groupId!,`/send ${nonce}`);await f.gateway.process(workspace,f.bill.id);assert.equal(f.sent.length,0);}finally{f.store.close();}
});

test('approved imported mail uses gateway provenance, is deduplicated and cannot become an outbound command',async()=>{
 const f=setup();try{
  const config=await paired(f),input={sourceId:'provider-source-1',from:'Fictional Client <client@example.test>',text:'/email This is an inbound client instruction.'};
  const first=await f.gateway.forwardApproved(workspace,f.bill.id,input),second=await f.gateway.forwardApproved(workspace,f.bill.id,input);
  assert.equal(first.state,'forwarded');assert.equal(second.state,'duplicate');const posted=f.posted.filter(item=>item.text.includes('inbound client instruction'));assert.equal(posted.length,1);assert.equal(posted[0].groupId,config.groupId);assert.match(posted[0].text,/Email gateway on behalf of/);assert.match(posted[0].text,/Fictional Client/);
  f.push(config.groupId!,posted[0].text,gatewayKey);await f.gateway.process(workspace,f.bill.id);assert.equal(f.sent.length,0);
  await assert.rejects(f.gateway.forwardApproved(workspace,f.bill.id,{...input,text:'Changed replay'}),status(409));
 }finally{f.store.close();}
});

test('invoice/workspace/group/owner bindings cannot be reused in another invoice or workspace',async()=>{
 const f=setup();try{
  const foreign=invoice(),sibling=invoice();f.store.addInvoice(other,foreign);f.store.addInvoice(workspace,sibling);
  await assert.rejects(f.gateway.configure(other,f.bill.id,{enabled:true,ownerPubkey:owner}),status(404));assert.throws(()=>f.gateway.settings(other,f.bill.id),status(404));assert.throws(()=>f.gateway.disconnect(other,f.bill.id),status(404));await assert.rejects(f.gateway.process(other,f.bill.id),status(404));
  const config=await paired(f),{nonce}=await prepare(f,config.groupId!),otherConfig=await f.gateway.configure(other,foreign.id,{enabled:true,ownerPubkey:impostor});
  f.push(otherConfig.groupId!,`/pair ${otherConfig.pairCode}`,impostor);await f.gateway.process(other,foreign.id);f.push(otherConfig.groupId!,`/send ${nonce}`,impostor);await f.gateway.process(other,foreign.id);assert.equal(f.sent.length,0);
  const siblingConfig=await f.gateway.configure(workspace,sibling.id,{enabled:true,ownerPubkey:owner});assert.notEqual(siblingConfig.groupId,config.groupId);assert.notEqual(f.invitations[0].context,f.invitations.at(-1)!.context);
  await f.gateway.configure(workspace,f.bill.id,{enabled:true,ownerPubkey:impostor});f.push(config.groupId!,`/send ${nonce}`);await f.gateway.process(workspace,f.bill.id);assert.equal(f.sent.length,0);
 }finally{f.store.close();}
});

test('unknown submission and a persisted pre-transmission intent never resend after restart',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'quiet-ledger-gateway-')),path=join(directory,'private.sqlite');let f=setup(path);try{
  const config=await paired(f),{nonce}=await prepare(f,config.groupId!);f.setSendThrows();f.push(config.groupId!,`/send ${nonce}`);await f.gateway.process(workspace,f.bill.id);assert.equal(f.sent.length,1);
  assert.equal(f.store.db.prepare("SELECT state FROM email_marmot_intents").get()!.state,'unknown');const bill=f.bill;f.store.close();f=setup(path,bill);f.push(config.groupId!,`/send ${nonce}`);await f.gateway.process(workspace,f.bill.id);assert.equal(f.sent.length,0);assert.equal(f.gateway.settings(workspace,bill.id).status,'paired');
  // The same durable unknown state is committed before invoking the external email port.
  const next=await prepare(f,config.groupId!,'Second explicit message');let observed=false;f.options.email.send=async()=>{observed=f.store.db.prepare("SELECT COUNT(*) n FROM email_marmot_intents WHERE state='unknown'").get()!.n===2;throw new Error('crash boundary');};f.push(config.groupId!,`/send ${next.nonce}`);await f.gateway.process(workspace,bill.id);assert.equal(observed,true);
  const bytes=readFileSync(path);assert.equal(bytes.includes(Buffer.from('Second explicit message')),false);assert.equal(bytes.includes(Buffer.from(nonce)),false);
 }finally{f.store.close();rmSync(directory,{recursive:true,force:true});}
});

test('body/recipient bounds and failed invitation do not create send authority',async()=>{
 const f=setup();try{
  f.setInviteThrows();await assert.rejects(f.gateway.configure(workspace,f.bill.id,{enabled:true,ownerPubkey:owner}),status(503));assert.equal(f.gateway.settings(workspace,f.bill.id).status,'disabled');
  for(const bad of ['', 'nsec1secret','d'.repeat(63)])await assert.rejects(f.gateway.configure(workspace,f.bill.id,{enabled:true,ownerPubkey:bad}),status(400));
 }finally{f.store.close();}
 const g=setup();try{const config=await paired(g);g.push(config.groupId!,'/email '+'x'.repeat(8001));await g.gateway.process(workspace,g.bill.id);assert.equal(g.sent.length,0);await assert.rejects(g.gateway.forwardApproved(workspace,g.bill.id,{sourceId:'oversize',from:'Client',text:'x'.repeat(8001)}),status(400));g.setRecipient('a\r\nBcc: hidden@example.test');g.push(config.groupId!,'/email valid');await g.gateway.process(workspace,g.bill.id);assert.equal(g.sent.length,0);assert.equal(g.posted.some(item=>item.text.startsWith('Email gateway preview')),false);}finally{g.store.close();}
});

test('gateway-only key and SDK states are encrypted, workspace-scoped and preserve typed arrays/BigInt',async()=>{
 const f=setup();try{
  const records=new MarmotGatewayStore(f.store),key=records.secretKey(workspace);assert.equal(key.length,32);assert.deepEqual(records.secretKey(workspace),key);assert.notDeepEqual(records.secretKey(other),key);
  const storage=records.storage(workspace),foreign=records.storage(other),value={bytes:new Uint8Array([1,2,255]),epoch:9007199254740999n,nested:[new Uint32Array([4294967295]),undefined],map:new Map([['peer',new Uint8Array([4])]])};
  assert.deepEqual(await storage.setItem('groups:fictional',value),value);assert.deepEqual(await storage.getItem('groups:fictional'),value);assert.equal(await foreign.getItem('groups:fictional'),null);assert.deepEqual(await storage.keys(),['groups:fictional']);
  for(const row of f.store.db.prepare('SELECT data FROM marmot_gateway_state').all())assert.match(String(row.data),/^qlr:v1:/);assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM marmot_gateway_state').all()).includes('groups:fictional'),false);
  await storage.removeItem('groups:fictional');assert.equal(await storage.getItem('groups:fictional'),null);await storage.setItem('one',false);await storage.clear();assert.deepEqual(await storage.keys(),[]);assert.deepEqual(records.secretKey(workspace),key);
 }finally{f.store.close();}
});

test('gateway SDK writes require encrypted storage and reject unsafe serialization and oversized state',async()=>{
 const plain=new Store(':memory:');try{assert.throws(()=>new MarmotGatewayStore(plain),status(503));}finally{plain.close();}
 const f=setup();try{const storage=new MarmotGatewayStore(f.store).storage(workspace);for(const value of [()=>undefined,new Date(),JSON.parse('{"__proto__":{"polluted":true}}'),'x'.repeat(2*1024*1024)])await assert.rejects(storage.setItem('bad',value));const cycle:any={};cycle.self=cycle;await assert.rejects(storage.setItem('bad',cycle));assert.equal(({}as any).polluted,undefined);}finally{f.store.close();}
});

test('a complete preview/provenance envelope must fit the native message limit without truncating email',async()=>{
 const f=setup();try{
  const config=await paired(f);f.push(config.groupId!,'/email '+'x'.repeat(7900));await f.gateway.process(workspace,f.bill.id);
  assert.equal(f.posted.some(item=>item.text.startsWith('Email gateway preview')),false);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM email_marmot_intents').get()!.n,0);
  await assert.rejects(f.gateway.forwardApproved(workspace,f.bill.id,{sourceId:'too-large-envelope',from:'x'.repeat(320),text:'x'.repeat(7900)}),status(400));
  assert.equal(f.posted.every(item=>item.text.length<=8000),true);
 }finally{f.store.close();}
});

test('disconnecting the email connection while resolving the Marmot port prevents inbound dispatch',async()=>{
 const f=setup();try{await paired(f);const posted=f.posted.length;f.options.marmotFor=()=>{f.setActive(false);return{pubkey:gatewayKey,invite:async()=>({id:'unused'}),send:async(groupId:string,text:string)=>{f.posted.push({groupId,text});return{id:randomUUID()};},messages:()=>[],sync:async()=>{}};};await assert.rejects(f.gateway.forwardApproved(workspace,f.bill.id,{sourceId:'disconnected-during-port',from:'Client',text:'Fictional incoming email'}),status(409));assert.equal(f.posted.length,posted);}finally{f.store.close();}
});

test('an uncertain imported-mail transmission stays unknown across duplicate requests without sending again',async()=>{
 const f=setup();try{await paired(f);let calls=0;f.options.marmotFor=()=>({pubkey:gatewayKey,invite:async()=>({id:'unused'}),send:async()=>{calls++;throw new Error('Unknown relay publication');},messages:()=>[],sync:async()=>{}});const input={sourceId:'uncertain-import',from:'Client',text:'Fictional incoming email'};assert.equal((await f.gateway.forwardApproved(workspace,f.bill.id,input)).state,'unknown');assert.equal((await f.gateway.forwardApproved(workspace,f.bill.id,input)).state,'unknown');assert.equal(calls,1);}finally{f.store.close();}
});

test('the same workspace has one writer across connections and lock release survives an operation failure',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'quiet-ledger-gateway-lock-')),path=join(directory,'private.sqlite'),key=Buffer.alloc(32,92),a=new Store(path,{encryptionKey:key}),b=new Store(path,{encryptionKey:key});
 try{const first=new MarmotGatewayStore(a),second=new MarmotGatewayStore(b);let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);const running=first.runExclusive(workspace,()=>held);await assert.rejects(second.runExclusive(workspace,async()=>{}),status(409));await second.runExclusive(other,async()=>{});release();await running;await assert.rejects(first.runExclusive(workspace,async()=>{throw new Error('Operation failed');}),/Operation failed/);await second.runExclusive(workspace,async()=>{});assert.equal(a.db.prepare('SELECT COUNT(*) n FROM marmot_gateway_writers').get()!.n,0);}finally{a.close();b.close();rmSync(directory,{recursive:true,force:true});}
});

test('each actor is created inside the writer lease and disposed even after transport failure',async()=>{
 const f=setup();try{
  const original=f.options.marmotFor;let disposed=0,created=0,failSync=false;
  f.options.marmotFor=async w=>{assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM marmot_gateway_writers WHERE workspace=?').get(w)!.n,1);created++;const port=await original(w);return{...port,sync:async()=>{if(failSync)throw new Error('Fictional relay failure');},dispose:async()=>{disposed++;}};};
  const config=await paired(f);assert.equal(created,2);assert.equal(disposed,2);await f.gateway.forwardApproved(workspace,f.bill.id,{sourceId:'fresh-actor',from:'Client',text:'Fictional email'});assert.equal(disposed,3);failSync=true;await assert.rejects(f.gateway.process(workspace,f.bill.id),status(503));assert.equal(disposed,4);assert.equal(created,disposed);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM marmot_gateway_writers').get()!.n,0);assert.equal(f.gateway.settings(workspace,f.bill.id).groupId,config.groupId);
 }finally{f.store.close();}
});

test('the approved reply context is preserved in the exact send payload and bound into the nonce',async()=>{
 for(const changeContext of [false,true]){const f=setup();try{
  let context=randomUUID();const preview=f.options.email.preview;f.options.email.preview=async(w,i,text)=>({...await preview(w,i,text),replyContextId:context});const config=await paired(f),{nonce}=await prepare(f,config.groupId!);const original=context;if(changeContext)context=randomUUID();f.push(config.groupId!,`/send ${nonce}`);await f.gateway.process(workspace,f.bill.id);assert.equal(f.sent.length,changeContext?0:1);if(!changeContext)assert.equal((f.sent[0].payload as any).replyContextId,original);
 }finally{f.store.close();}}
});

test('a current membership guard revokes pairing and pending confirmations before transmission',async()=>{
 for(const phase of ['sync','dispatch','import']as const){const f=setup();try{
  let authorized=true;const original=f.options.marmotFor;f.options.marmotFor=async w=>({...await original(w),isAuthorized:async(groupId:string,expectedOwner:string)=>{assert.ok(groupId);assert.equal(expectedOwner,owner);return authorized;}});const config=await paired(f),{nonce}=await prepare(f,config.groupId!);const posted=f.posted.length;
  if(phase==='dispatch')f.setPreviewHook(()=>authorized=false);else authorized=false;
  if(phase==='import')await assert.rejects(f.gateway.forwardApproved(workspace,f.bill.id,{sourceId:'revoked-membership',from:'Client',text:'Fictional mail'}),status(409));else{f.push(config.groupId!,`/send ${nonce}`);await f.gateway.process(workspace,f.bill.id);}
  assert.equal(f.sent.length,0);assert.equal(f.posted.length,posted);assert.equal(f.gateway.settings(workspace,f.bill.id).status,'disabled');assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM email_marmot_intents WHERE state='prepared'").get()!.n,0);
 }finally{f.store.close();}}
});

test('an expired lease cannot replace a live process writer; a dead process can be recovered immediately',async()=>{
 const f=setup();try{
  const records=new MarmotGatewayStore(f.store);f.store.db.prepare('INSERT INTO marmot_gateway_writers(workspace,owner,expires) VALUES(?,?,?)').run(workspace,`pid:${process.pid}:fictional-live-writer`,0);await assert.rejects(records.runExclusive(workspace,async()=>{}),status(409));
  f.store.db.prepare('UPDATE marmot_gateway_writers SET owner=?,expires=? WHERE workspace=?').run('pid:2147483647:fictional-dead-writer',Date.now()+120000,workspace);await records.runExclusive(workspace,async()=>{});assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM marmot_gateway_writers').get()!.n,0);
 }finally{f.store.close();}
});

test('SDK serialization never selects inherited typed-array constructors',async()=>{
 const f=setup();try{const view=new DataView(new ArrayBuffer(4));Object.defineProperty(view,'constructor',{value:{name:'constructor'}});await assert.rejects(new MarmotGatewayStore(f.store).storage(workspace).setItem('forged-constructor',view));}finally{f.store.close();}
});

test('unverified mail is gateway-labelled review data and only the owner in this invoice room can approve',async()=>{
 const f=setup();try{
  const config=await paired(f),inboxItemId=randomUUID(),otherItem=randomUUID(),decisions:{invoiceId:string;id:string;action:string}[]=[];
  f.options.email.review=(_w,id,item,action)=>{if(item!==inboxItemId)throw new DomainError(404,'Item not found in this invoice.');decisions.push({invoiceId:id,id:item,action});};
  const input={sourceId:'unverified-provider-id',inboxItemId,from:'client@example.test',text:'Please review my fictional question.'};
  assert.equal((await f.gateway.forwardForReview(workspace,f.bill.id,input)).state,'forwarded');assert.equal((await f.gateway.forwardForReview(workspace,f.bill.id,input)).state,'duplicate');const envelope=f.posted.find(item=>item.text.includes('fictional question'));assert.ok(envelope);assert.match(envelope.text,/UNVERIFIED/);assert.match(envelope.text,/Email gateway/);assert.ok(envelope.text.includes(`/approve ${inboxItemId}`));assert.ok(envelope.text.includes(`/reject ${inboxItemId}`));
  f.push(config.groupId!,`/approve ${inboxItemId}`,impostor);f.push('malicious-group',`/approve ${inboxItemId}`);f.push(config.groupId!,`/approve ${otherItem}`);await f.gateway.process(workspace,f.bill.id);assert.equal(decisions.length,0);
  f.push(config.groupId!,`/approve ${inboxItemId}`);await f.gateway.process(workspace,f.bill.id);assert.deepEqual(decisions,[{invoiceId:f.bill.id,id:inboxItemId,action:'approve'}]);f.push(config.groupId!,`/approve ${inboxItemId}`);await f.gateway.process(workspace,f.bill.id);assert.equal(decisions.length,1);assert.equal(f.sent.length,0);
  await f.gateway.forwardApproved(workspace,f.bill.id,{sourceId:input.sourceId,from:input.from,text:input.text});assert.equal(f.posted.filter(item=>item.text.includes('fictional question')).length,1);assert.equal(f.store.getInvoice(f.bill.id,workspace)!.status,'open');
 }finally{f.store.close();}
});

test('reject review action is scoped, replay-safe and never prepares email',async()=>{
 const f=setup();try{const config=await paired(f),id=randomUUID();let decisions=0;f.options.email.review=(_w,_invoice,item,action)=>{assert.equal(item,id);assert.equal(action,'reject');decisions++;};await f.gateway.forwardForReview(workspace,f.bill.id,{sourceId:'reject-source',inboxItemId:id,from:'client@example.test',text:'/email This inbound text cannot send.'});f.push(config.groupId!,`/reject ${id}`);await f.gateway.process(workspace,f.bill.id);f.push(config.groupId!,`/reject ${id}`);await f.gateway.process(workspace,f.bill.id);assert.equal(decisions,1);assert.equal(f.sent.length,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM email_marmot_intents').get()!.n,0);}finally{f.store.close();}
});

test('enabling a persistent gateway requires its original mailbox to remain active',async()=>{
 const f=setup();try{f.setActive(false);await assert.rejects(f.gateway.configure(workspace,f.bill.id,{enabled:true,ownerPubkey:owner}),status(409));assert.equal(f.invitations.length,0);assert.equal(f.gateway.settings(workspace,f.bill.id).enabled,false);}finally{f.store.close();}
});

test('periodic processing continues after two hundred commands by deduplicating before the per-tick command cap',async()=>{
 const f=setup();try{const config=await paired(f);for(let i=0;i<201;i++)f.push(config.groupId!,`Ordinary message ${i}`);f.push(config.groupId!,'/email The next processing batch.');await f.gateway.process(workspace,f.bill.id);assert.equal(f.posted.some(item=>item.text.startsWith('Email gateway preview')),false);await f.gateway.process(workspace,f.bill.id);assert.ok(f.posted.find(item=>item.text.startsWith('Email gateway preview')&&item.text.includes('next processing batch')));}finally{f.store.close();}
});

test('the final SMTP guard rechecks the confirmation expiry and mailbox connection after transport setup',async()=>{
 for(const change of ['expired','disconnected'] as const){const f=setup();let submissions=0;try{const settings=await paired(f),{nonce}=await prepare(f,settings.groupId!);f.options.email.send=async(...args)=>{if(change==='expired')f.setTime(instant+6*60000);else f.setActive(false);await args[4]?.assertCurrent();submissions++;return{state:'sent'};};f.push(settings.groupId!,`/send ${nonce}`);await f.gateway.process(workspace,f.bill.id);assert.equal(submissions,0,change);}finally{f.store.close();}}
});
