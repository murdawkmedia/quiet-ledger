import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {Store,type StoredSession} from '../server/store.js';
import {createDemoTeam} from '../server/demo-agents.js';
import type {DemoAgentProvider,DemoRole} from '../shared/demo-agents.js';
import type {DemoMdkFactory,DemoMdkTeam,MdkTimelineMessage} from '../server/demo-agent-mdk.js';
const human='a'.repeat(64),client='b'.repeat(64),accountant='c'.repeat(64),groupId='d'.repeat(64),nostrGroupId='e'.repeat(64);const origin='http://127.0.0.1';
const delay=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
async function until(fn:()=>unknown,ms=4000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await delay(20);}assert.fail('condition did not become true');}
function fixture(held=false,providers?:Partial<Record<DemoRole,DemoAgentProvider>>,gate?:(role:DemoRole,text:string,signal:AbortSignal)=>Promise<void>){const now=new Date();const store=new Store(':memory:',{encryptionKey:Buffer.alloc(32,9)});let release:()=>void=()=>{};const barrier=new Promise<void>(done=>{release=done;});const messages:MdkTimelineMessage[]=[];const sends:{role:string;groupId:string;text:string;key:string;replyTo?:string}[]=[];const blockedDeliveries=new Set<string>(),deliveryAttempts:typeof sends=[];const roomMessages=new Map<string,MdkTimelineMessage[]>(),counts=new Map<string,number>(),inputs:{role:string;text:string;history:unknown}[]=[],timelineCalls:{role:string;groupId:string}[]=[],packages:string[]=[],publicationFailures=new Set<string>(),inferenceFailures=new Set<string>();let stopped=0,retired=0,paid=false,inferences=0;
 const team:DemoMdkTeam={members:[{role:'client',name:'Riley',pubkey:client},{role:'accountant',name:'Jordan',pubkey:accountant}],async publishKeyPackage(role){packages.push(role);if(publicationFailures.delete(role))throw new Error('Fixture KeyPackage publication failed.');},async groupInfo(role,id){return {member_count:counts.get(role+':'+id)??(id===groupId?3:2)};},async timeline(role,id){timelineCalls.push({role,groupId:id});return roomMessages.get(id)??messages;},async send(role,id,text,key,_signal,replyTo){const attempt={role,groupId:id,text,key,replyTo};deliveryAttempts.push(attempt);if(blockedDeliveries.has(role+':'+id))throw new Error('Fictional room delivery outage.');sends.push(attempt);},async close(){stopped++;}};
 const factory:DemoMdkFactory={async start(){if(held)await barrier;return team;},async retire(){retired++;},async close(){}};
 const session:StoredSession={role:'demo',hackathonDemo:true,workspace:'fictional',accountId:'fictional-account',csrf:'fictional-csrf',expires:new Date(now.getTime()+7200000).toISOString()};
 const service=createDemoTeam({providers,store,now:()=>now,publicOrigin:origin,allowLoopbackRelays:true,mdkFactory:factory,getSession:req=>req.get('x-test-session')==='owner'?{...session,role:'owner'}:req.get('x-test-session')==='missing'?undefined:session,getDemoCase:workspace=>{if(workspace!=='fictional')throw new Error('unregistered');return {invoice:{id:'fictional',currency:'CAD',subtotal:12500,total:12500,tax:0,status:paid?'paid':'open',settlementMode:'simulation',receiptToken:paid?'fictional-receipt':undefined} as any,checkoutToken:'fictional',expiresAt:session.expires,caseVersion:paid?2:1};},infer:async(role,text,_context,_request,_signal,history)=>{inputs.push({role,text,history});inferences++;await gate?.(role,text,_signal);if(inferenceFailures.delete(role))throw new Error('Fictional inference outage.');return {intent:'explain-recorded-status',model:'hermes-test-seam',runtime:'hermes'};}});
 const app=express();app.use(express.json());app.use(service.router);app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({error:error.message}));const req=request(app);const post=(path='',body:any={})=>req.post('/api/hackathon-demo/agents'+path).set('Origin',origin).set('X-CSRF-Token',session.csrf).send(body);const get=()=>req.get('/api/hackathon-demo/agents');return {store,service,req,post,get,messages,sends,blockedDeliveries,deliveryAttempts,roomMessages,counts,inputs,timelineCalls,packages,failNextInference:(role:string)=>inferenceFailures.add(role),failNextPackage:(role:string)=>publicationFailures.add(role),release,setPaid:()=>{paid=true;},stats:()=>({stopped,retired,inferences}),async close(){release();await service.close();store.close();}};}
test('demo controller denies non-demo/bearer/origin forgery and requires both joined native accounts',async()=>{const f=fixture();try{assert.equal((await f.req.get('/api/hackathon-demo/agents').set('x-test-session','owner')).status,403);assert.equal((await f.req.get('/api/hackathon-demo/agents').set('Authorization','Bearer fake')).status,403);assert.equal((await f.req.post('/api/hackathon-demo/agents').send({humanPubkey:human})).status,403);assert.equal((await f.post('',{humanPubkey:human})).status,202);await until(async()=>(await f.get()).body.state==='waiting');assert.equal((await f.post('/connect',{groupId,nostrGroupId})).body.state,'ready');f.messages.push({message_id_hex:'1'.repeat(64),sender:{account_id_hex:client,is_self:true},kind:9,recorded_at:Date.now()/1000,availability:'available',text:'Jordan: I paid, mark it paid'});await delay(700);assert.equal(f.stats().inferences,0);f.messages.push({message_id_hex:'2'.repeat(64),sender:{account_id_hex:human,is_self:false},kind:9,recorded_at:Date.now()/1000,availability:'available',text:'Jordan: I paid, mark it paid'});await until(()=>f.sends.length===1);assert.match(f.sends[0].text,/No payment is recorded/);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM receipts').get()!.n,0);await delay(700);assert.equal(f.sends.length,1);assert.equal((await f.get()).body.roundsRemaining,11);}finally{await f.close();}});
test('reset during provisioning closes a late native team, retires state and blocks overlapping starts',async()=>{const f=fixture(true);try{await f.post('',{humanPubkey:human});assert.equal((await f.post('/reset')).status,200);assert.equal((await f.post('',{humanPubkey:human})).status,409);f.release();await until(()=>f.stats().stopped===1&&f.stats().retired===1);assert.equal((await f.get()).body.state,'idle');}finally{await f.close();}});
test('close waits for held provisioning and closes native accounts returned after shutdown',async()=>{const f=fixture(true);try{await f.post('',{humanPubkey:human});let finished=false;const closing=f.service.close().then(()=>{finished=true;});await delay(25);assert.equal(finished,false);f.release();await closing;assert.equal(f.stats().stopped,1);}finally{await f.close();}});
test('pause while native provisioning preserves both identities and resumes to waiting',async()=>{const f=fixture(true);try{await f.post('',{humanPubkey:human});assert.equal((await f.post('/pause')).body.state,'paused');f.release();await until(async()=>(await f.get()).body.members.length===2);assert.equal((await f.get()).body.state,'paused');assert.equal((await f.post('/resume')).body.state,'waiting');}finally{await f.close();}});

function humanMessage(id:string,text:string,seconds=Date.now()/1000):MdkTimelineMessage{return {message_id_hex:id.repeat(64),sender:{account_id_hex:human,is_self:false},kind:9,recorded_at:seconds,availability:'available',text};}
test('direct and group channels route raw human messages and never copy another room into inference',async()=>{const f=fixture();try{
 await f.post('',{humanPubkey:human});await until(async()=>(await f.get()).body.state==='waiting');
 const directId='1'.repeat(64),otherId='2'.repeat(64);const directHash='3'.repeat(64),otherHash='4'.repeat(64);
 assert.equal((await f.post('/connect',{channel:'client',groupId:directId,nostrGroupId:directHash})).status,200);assert.equal((await f.get()).body.groupId,undefined);
 assert.equal((await f.post('/connect',{channel:'accountant',groupId:otherId,nostrGroupId:otherHash})).status,200);
 assert.equal((await f.post('/connect',{groupId,nostrGroupId})).status,200);assert.equal((await f.post('/connect',{channel:'accountant',groupId:directId,nostrGroupId:directHash})).status,409);
 const timestamp=Date.now()/1000;const history=humanMessage('5','Riley-only confidential fictional phrase',timestamp-1),forged={...humanMessage('6','wrong-room accountant text',timestamp-1),sender:{account_id_hex:accountant,is_self:false}};
 f.roomMessages.set(directId,[history,forged,humanMessage('7','What does your company do?',timestamp)]);f.roomMessages.set(otherId,[humanMessage('8','What records do you need?',timestamp)]);f.roomMessages.set(groupId,[]);
 await until(()=>f.sends.length===3);assert.equal(f.inputs.filter(input=>input.role==='client').at(-1)?.text,'What does your company do?');const latestClient=f.inputs.filter(input=>input.role==='client').at(-1)!;assert.deepEqual(latestClient.history,[{speaker:'human',text:history.text}]);
 const accountantInput=f.inputs.find(input=>input.role==='accountant')!;assert.equal(accountantInput.text,'What records do you need?');assert.deepEqual(accountantInput.history,[]);assert(f.sends.filter(send=>send.role==='client').every(send=>send.groupId===directId));assert(f.sends.every(send=>send.replyTo&&/^[a-f0-9]{64}$/.test(send.replyTo)));assert(f.sends.filter(send=>send.role==='accountant').every(send=>send.groupId===otherId));
 assert(f.timelineCalls.some(call=>call.role==='accountant'&&call.groupId===otherId));assert(!f.timelineCalls.some(call=>call.role==='client'&&call.groupId===otherId));
 f.roomMessages.set(groupId,[humanMessage('9','Hello both of you',timestamp+1)]);await until(()=>f.sends.length===5);assert.deepEqual(f.inputs.slice(-2).map(input=>input.role).sort(),['accountant','client']);assert(f.inputs.slice(-2).every(input=>JSON.stringify(input.history)==='[]'));
 f.roomMessages.get(groupId)!.push(humanMessage('a','@Jordan please check the total',timestamp+2));await until(()=>f.sends.length===6);await delay(700);assert.equal(f.sends.length,6);assert.equal(f.inputs.at(-1)?.role,'accountant');
 assert.deepEqual(f.packages.sort(),['accountant','accountant','client','client']);assert.equal((await f.get()).body.roundsRemaining,7);
 }finally{await f.close();}});

test('direct membership count and bounded authenticated prior history are enforced',async()=>{const f=fixture();try{
 await f.post('',{humanPubkey:human});await until(async()=>(await f.get()).body.state==='waiting');const id='1'.repeat(64),hash='2'.repeat(64);
 f.counts.set('client:'+id,3);assert.equal((await f.post('/connect',{channel:'client',groupId:id,nostrGroupId:hash})).status,409);f.counts.set('client:'+id,2);assert.equal((await f.post('/connect',{channel:'client',groupId:id,nostrGroupId:hash})).status,200);
 await f.post('/pause');const timestamp=Date.now()/1000;const messages=Array.from({length:12},(_,index)=>({...humanMessage(index.toString(16),'😀'.repeat(500),timestamp-4+index/100),sender:{account_id_hex:client,is_self:true}}));
 messages.push({...humanMessage('c','malformed prior'),availability:'missing'});messages.push(humanMessage('d','current direct text',timestamp));messages.push({...humanMessage('e','future data must be absent',timestamp+1),sender:{account_id_hex:client,is_self:true}});f.roomMessages.set(id,messages);await f.post('/resume');await until(()=>f.inputs.length===1);
 const input=f.inputs[0] as {history:{speaker:string;text:string}[]};assert(input.history.length<=8);assert(input.history.every(row=>row.speaker==='client'&&row.text.length<=1000));assert(input.history.reduce((total,row)=>total+Buffer.byteLength(row.text),0)<=6000);assert(!JSON.stringify(input.history).includes('future data'));
 // A post-connect roster change stops future admission in this room.
 f.counts.set('client:'+id,3);messages.push(humanMessage('f','should not infer',timestamp+2));await delay(700);assert.equal(f.inputs.length,1);
 }finally{await f.close();}});

test('a transient fresh-KeyPackage publication failure is retried without rebinding the room',async()=>{const f=fixture();try{await f.post('',{humanPubkey:human});await until(async()=>(await f.get()).body.state==='waiting');const body={channel:'client',groupId:'1'.repeat(64),nostrGroupId:'2'.repeat(64)};f.failNextPackage('client');assert.equal((await f.post('/connect',body)).status,500);assert.equal((await f.get()).body.rooms.client.groupId,body.groupId);assert.equal((await f.post('/connect',body)).status,200);assert.equal((await f.post('/connect',body)).status,200);assert.deepEqual(f.packages,['client','client']);}finally{await f.close();}});


test('configured role providers are disclosed without changing the default Hermes contract',async()=>{
 const plain=fixture();try{const view=(await plain.get()).body;assert.equal(view.runtime,'hermes');assert.equal(view.providers,undefined);}finally{await plain.close();}
 const providers={client:{runtime:'hermes' as const,model:'fictional-hermes'},accountant:{runtime:'codex' as const,model:'fictional-codex',reasoningEffort:'max' as const}},mixed=fixture(false,providers);
 try{const view=(await mixed.get()).body;assert.equal(view.runtime,'mixed');assert.deepEqual(view.providers,providers);}finally{await mixed.close();}
});


test('controller returns current authenticated turn issues and preserves another role failure after success',async()=>{
 const f=fixture();try{await f.post('',{humanPubkey:human});await until(async()=>(await f.get()).body.state==='waiting');await f.post('/connect',{groupId,nostrGroupId});f.failNextInference('client');f.messages.push(humanMessage('1','A fictional first question.'));await until(async()=>(await f.get()).body.turnIssues?.length===1&&f.sends.length===1);const failed=(await f.get()).body;assert.deepEqual(failed.turnIssues,[{messageId:'1'.repeat(64),role:'client',channel:'group'}]);assert.equal(f.sends[0].role,'accountant');
 f.messages.push(humanMessage('2','@Riley A valid next question.'));await until(()=>f.sends.length===2);const recovered=(await f.get()).body;assert.equal(recovered.issue,undefined);assert.deepEqual(recovered.turnIssues,[]);assert.equal(f.sends[1].replyTo,'2'.repeat(64));
 f.failNextInference('client');f.messages.push(humanMessage('3','@Riley A new fictional failure.'));await until(async()=>(await f.get()).body.turnIssues?.[0]?.messageId==='3'.repeat(64));assert((await f.get()).body.issue);
 }finally{await f.close();}
});


test('stalled direct and group deliveries do not silence the same role in the other room',async()=>{
 const f=fixture();try{
  await f.post('',{humanPubkey:human});await until(async()=>(await f.get()).body.state==='waiting');
  const clientRoom='1'.repeat(64),accountantRoom='2'.repeat(64);
  await f.post('/connect',{channel:'client',groupId:clientRoom,nostrGroupId:'3'.repeat(64)});await f.post('/connect',{channel:'accountant',groupId:accountantRoom,nostrGroupId:'4'.repeat(64)});await f.post('/connect',{groupId,nostrGroupId});
  f.blockedDeliveries.add('client:'+clientRoom);f.blockedDeliveries.add('accountant:'+groupId);
  f.roomMessages.set(clientRoom,[humanMessage('5','The first fictional Riley DM.')]);f.roomMessages.set(accountantRoom,[]);f.roomMessages.set(groupId,[humanMessage('6','@Jordan The first fictional Group question.')]);
  await until(()=>f.deliveryAttempts.some(row=>row.role==='client')&&f.deliveryAttempts.some(row=>row.role==='accountant'));const originals=f.deliveryAttempts.slice(0,2);
  f.setPaid();f.roomMessages.get(groupId)!.push(humanMessage('7','@Riley A new question after switching to Group.'));f.roomMessages.get(accountantRoom)!.push(humanMessage('8','A new question after switching to Jordan DM.'));
  await until(()=>f.sends.length===2);assert.deepEqual(f.sends.map(row=>[row.role,row.groupId]).sort(),[['accountant',accountantRoom],['client',groupId]]);
  assert.equal(f.stats().inferences,4);assert(f.sends.every(row=>/simulated CAD 125\.00 receipt/i.test(row.text)));
  f.blockedDeliveries.clear();await until(()=>f.sends.length===4);assert.equal(f.stats().inferences,4);assert.equal((await f.get()).body.roundsRemaining,8);
  for(const original of originals){const retries=f.deliveryAttempts.filter(row=>row.replyTo===original.replyTo);assert(retries.length>=2);assert(retries.every(row=>JSON.stringify(row)===JSON.stringify(original)));assert.equal(f.sends.filter(row=>row.replyTo===original.replyTo).length,1);assert.match(original.text,/No payment is recorded/i);}
  await delay(700);assert.equal(f.sends.length,4);
 }finally{await f.close();}
});

test('messages sent after a room switch wait for active role inference and retain their original room',async()=>{
 for(const role of ['client','accountant'] as const){
  let release:()=>void=()=>{};const held=new Promise<void>(done=>{release=done;});
  const f=fixture(false,undefined,async(inferredRole,text)=>{if(inferredRole===role&&text.includes('held original'))await held;});
  try{
   await f.post('',{humanPubkey:human});await until(async()=>(await f.get()).body.state==='waiting');const directId='1'.repeat(64);
   const direct={channel:role,groupId:directId,nostrGroupId:'2'.repeat(64)},group={groupId,nostrGroupId};
   const oldRoom=role==='client'?directId:groupId,newRoom=role==='client'?groupId:directId;
   await f.post('/connect',role==='client'?direct:group);f.roomMessages.set(oldRoom,[humanMessage('3',role==='client'?'A held original Riley DM.':'@Jordan A held original Group question.')]);
   await until(()=>f.inputs.length===1);await f.post('/connect',role==='client'?group:direct);
   f.roomMessages.set(newRoom,[humanMessage('4',role==='client'?'@Riley A Group question sent during DM inference.':'A Jordan DM sent during Group inference.')]);
   await delay(700);assert.equal(f.inputs.length,1,'same-role inference must stay serialized');assert.equal(f.sends.length,0);release();
   await until(()=>f.sends.length===2);assert.deepEqual(f.sends.map(row=>[row.role,row.groupId,row.replyTo]),[[role,oldRoom,'3'.repeat(64)],[role,newRoom,'4'.repeat(64)]]);
   assert.equal(f.inputs.length,2);assert.deepEqual(f.inputs[1].history,[]);assert.equal((await f.get()).body.roundsRemaining,10);await delay(700);assert.equal(f.sends.length,2);
  }finally{release();await f.close();}
 }
});

test('an old room roster mismatch cannot block the role in a different valid room',async()=>{
 let release:()=>void=()=>{};const held=new Promise<void>(done=>{release=done;});const f=fixture(false,undefined,async(role,text)=>{if(role==='client'&&text.includes('original'))await held;});
 try{
  await f.post('',{humanPubkey:human});await until(async()=>(await f.get()).body.state==='waiting');const directId='1'.repeat(64);
  await f.post('/connect',{channel:'client',groupId:directId,nostrGroupId:'2'.repeat(64)});await f.post('/connect',{groupId,nostrGroupId});f.roomMessages.set(groupId,[]);
  f.roomMessages.set(directId,[humanMessage('3','A fictional original Riley DM.')]);await until(()=>f.inputs.length===1);f.counts.set('client:'+directId,3);release();
  f.roomMessages.get(groupId)!.push(humanMessage('4','@Riley A new fictional Group question.'));await until(()=>f.sends.length===1);assert.equal(f.sends[0].groupId,groupId);assert.equal(f.sends[0].replyTo,'4'.repeat(64));assert.equal(f.stats().inferences,2);assert(!f.deliveryAttempts.some(row=>row.groupId===directId));
  f.counts.set('client:'+directId,2);await until(()=>f.sends.length===2);assert.equal(f.stats().inferences,2);assert.equal(f.sends[1].groupId,directId);assert.equal(f.sends[1].replyTo,'3'.repeat(64));
 }finally{release();await f.close();}
});
