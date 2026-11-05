import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createServer} from 'node:http';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools';
import {v2 as nip44} from 'nostr-tools/nip44';
import {MarmotClient,createApplicationMessageIntent,createChatRumor,deserializeApplicationData,getGroupMemberPubkeys} from '@internet-privacy/marmot-ts';
import {Store} from '../server/store.js';
import {createMdkFactory} from '../server/demo-agent-mdk.js';
import {createDemoTeam,type DemoTeam,type DemoTeamOptions} from '../server/demo-agents.js';
import {createDemoStateBackup,verifyDemoStateBackup,restoreDemoStateBackup} from '../ops/demo-state-backup.js';

const binary=process.env.QL_DEMO_TEST_MDK_BINARY;
const pause=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
async function until<T>(fn:()=>Promise<T|false>|T|false,ms=18000):Promise<T>{
  const end=Date.now()+ms;let first:unknown;
  while(Date.now()<end){try{const value=await fn();if(value)return value as T;}catch(error){first??=error;}await pause(150);}
  throw new Error('Native demo condition timed out: '+String((first as Error)?.message??'none').replace(/[a-f0-9]{64,}/gi,'[id]').slice(0,180));
}
class MemoryStore {
  values=new Map<string,any>();
  async getItem(key:string){return structuredClone(this.values.get(key)??null);}
  async setItem(key:string,value:any){this.values.set(key,structuredClone(value));return value;}
  async removeItem(key:string){this.values.delete(key);}
  async clear(){this.values.clear();}
  async keys(){return [...this.values.keys()];}
}
/** Hash every cold private file; transient writer/process records are not restored capabilities. */
function fileHashes(root:string){
  const hashes=new Map<string,string>();
  function visit(directory:string,prefix=''){
    for(const name of readdirSync(directory).sort()){
      const path=prefix?prefix+'/'+name:name;
      if(path==='.writer-lock'||(path.split('/').length===3&&name==='runtime-process'))continue;
      const full=join(directory,name),stat=lstatSync(full);
      assert(!stat.isSymbolicLink());
      if(stat.isDirectory()){assert.equal(stat.mode&0o777,0o700);visit(full,path);}
      else{assert(stat.isFile());assert.equal(stat.mode&0o777,0o600);hashes.set(path,createHash('sha256').update(readFileSync(full)).digest('hex'));}
    }
  }
  visit(root);return hashes;
}

/** Actual native/SDK cryptography; inference is explicitly a fixed typed fixture, not an actual Hermes call. */
test('actual native independent direct and group rooms survive replay and encrypted cold backup/restore',{skip:!binary,timeout:180000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'ql-team-native-'));
  const storageKey=randomBytes(32),backupKey=randomBytes(32);
  assert(!storageKey.equals(backupKey));
  const store=new Store(':memory:',{encryptionKey:storageKey});
  const app=express();app.use(express.json());
  const server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  let group:any,relay='',calls=0,service:DemoTeam|undefined;const allGroups:any[]=[],modelInputs:{role:string;text:string;history:unknown}[]=[];let nativeTeam:any;
  const services:DemoTeam[]=[];
  const evidence:Record<string,unknown>={startedAt:new Date().toISOString(),status:'running',network:'isolated loopback relay; no public relay posts',sdk:'0.9.0',mdk:'0.14.0',inference:'injected fixed typed-intent fixture; not actual Hermes'};
  const options:DemoTeamOptions={
    store,now:()=>new Date(),publicOrigin:origin,binaryPath:binary!,allowLoopbackRelays:true,
    getSession:()=>({role:'demo',workspace:'fictional-native',accountId:'fictional-native',hackathonDemo:true,csrf:'fixture',expires:new Date(Date.now()+7200000).toISOString()}),
    getDemoCase:()=>({invoice:{currency:'CAD',subtotal:12500,tax:0,total:12500,status:'open',settlementMode:'simulation'} as any,caseVersion:1,checkoutToken:'fixture',expiresAt:new Date(Date.now()+7200000).toISOString()}),
    infer:async(role,text,_case,_id,_signal,history)=>{modelInputs.push({role,text,history});calls++;return {intent:'check-total',model:'hermes-injected-contract-fixture',runtime:'hermes'};},
  };
  function startService(runtimeRoot:string){
    const native=createMdkFactory({runtimeRoot,binaryPath:binary!,allowLoopbackRelays:true});
    const nativeStart=native.start.bind(native);native.start=async(...args)=>{nativeTeam=await nativeStart(...args);return nativeTeam;};
    const next=createDemoTeam({...options,runtimeRoot,mdkFactory:native});
    next.attachRelay(server,{standalone:true});services.push(next);service=next;return next;
  }
  startService(join(root,'mdk'));
  app.use((req,res,next)=>service!.router(req,res,next));
  app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({error:error.message}));
  async function api(path='',body?:unknown){
    const response=await fetch(origin+'/api/hackathon-demo/agents'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'X-CSRF-Token':'fixture','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const value=await response.json();if(!response.ok)throw new Error(`Demo API ${response.status}: ${value.error}`);return value;
  }
  async function call(frame:unknown[],query=false):Promise<any>{
    return new Promise((resolve,reject)=>{
      const ws=new WebSocket(relay),rows:any[]=[];let done=false;
      const timer=setTimeout(()=>{ws.terminate();finish(new Error('Relay timeout'));},10000);
      function finish(error?:Error,value?:unknown){if(done)return;done=true;clearTimeout(timer);ws.close();error?reject(error):resolve(value);}
      ws.on('unexpected-response',(_req,res)=>{res.destroy();finish(new Error('Relay HTTP '+res.statusCode));});
      ws.on('error',()=>finish(new Error('Relay connection failed')));
      ws.on('open',()=>ws.send(JSON.stringify(frame)));
      ws.on('message',raw=>{const input=JSON.parse(raw.toString());if(query&&input[0]==='EVENT')rows.push(input[2]);if(query&&input[0]==='EOSE')finish(undefined,rows);if(!query&&input[0]==='OK')finish(input[2]?undefined:new Error('Relay rejected event kind '+(frame[1] as any)?.kind),true);});
    });
  }
  try{
    const secret=generateSecretKey(),human=getPublicKey(secret);
    const started=await api('',{humanPubkey:human});relay=origin.replace(/^http/,'ws')+started.relayPath;
    const network:any={
      async publish(urls:string[],event:unknown){assert(urls.every(url=>url===relay));await call(['EVENT',event]);return {[relay]:{from:relay,ok:true}};},
      async request(urls:string[],filters:any){assert(urls.every(url=>url===relay));return call(['REQ',randomUUID(),...(Array.isArray(filters)?filters:[filters])],true);},
      subscription(){return {subscribe(){return {unsubscribe(){}};}};},async getUserInboxRelays(){return [relay];},
    };
    const client=new MarmotClient({
      clientId:'f'.repeat(64),signer:{getPublicKey:()=>human,signEvent:event=>finalizeEvent(event,secret),nip44:{encrypt:(peer,text)=>nip44.encrypt(text,nip44.utils.getConversationKey(secret,peer)),decrypt:(peer,text)=>nip44.decrypt(text,nip44.utils.getConversationKey(secret,peer))}},network,
      groupStateStore:new MemoryStore(),keyPackageStore:new MemoryStore(),inviteStore:new MemoryStore(),ingestStateStore:new MemoryStore(),rewindStore:new MemoryStore(),removedMarkerStore:new MemoryStore(),
    });
    await client.keyPackages.ensurePublished({relays:[relay],client:'Quiet Ledger isolated test'});
    const ready=await until(async()=>{const value=await api();return value.state==='waiting'?value:false;},30000);
    const originalPubkeys=ready.members.map((member:any)=>member.pubkey).sort();
    assert.equal(new Set([human,...originalPubkeys]).size,3);
    const usedPackages=new Set<string>();
    async function createRoom(channel:'client'|'accountant'|'group'){
      const members=ready.members.filter((member:any)=>channel==='group'||member.role===channel),authors=members.map((member:any)=>member.pubkey);
      const packages=await until(async()=>{const events=await network.request([relay],[{kinds:[30443,5],authors,limit:128}]);const deleted=new Set(events.filter((event:any)=>event.kind===5).flatMap((event:any)=>event.tags.filter((tag:string[])=>tag[0]==='e').map((tag:string[])=>tag[1])));const selected=authors.map((author:string)=>events.filter((event:any)=>event.kind===30443&&event.pubkey===author&&!deleted.has(event.id)).sort((a:any,b:any)=>b.created_at-a.created_at)[0]);return selected.every(Boolean)?selected:false;});
      packages.forEach((event:any)=>{assert(!usedPackages.has(event.id),'Native relay must retire consumed KeyPackages even without browser used-ID history');usedPackages.add(event.id);});
      const next=await client.groups.create('Fictional '+channel+' conversation',{description:'Fictional CAD125 only',relays:[relay],adminPubkeys:[human],invitees:packages});allGroups.push(next);
      const roster=[human,...authors].sort();assert.deepEqual(getGroupMemberPubkeys(next.state).sort(),roster);
      assert(next.groupData?.nostrGroupId);const groupId=Buffer.from(next.id).toString('hex'),nostrGroupId=Buffer.from(next.groupData.nostrGroupId).toString('hex');
      await until(()=>api('/connect',{groupId,nostrGroupId,channel}));return {group:next,groupId,nostrGroupId,roster};
    }
    const direct=await createRoom('client');const accountantDirect=await createRoom('accountant');
    assert.notEqual(direct.groupId,accountantDirect.groupId);assert.notEqual(direct.nostrGroupId,accountantDirect.nostrGroupId);
    await assert.rejects(()=>nativeTeam.groupInfo('accountant',direct.groupId));assert.deepEqual(await nativeTeam.timeline('accountant',direct.groupId),[]);
    await assert.rejects(()=>nativeTeam.groupInfo('client',accountantDirect.groupId));assert.deepEqual(await nativeTeam.timeline('client',accountantDirect.groupId),[]);
    const directReplies:{role:string;sender:string;text:string}[]=[];
    for(const [role,room]of [['client',direct],['accountant',accountantDirect]] as const)room.group.on('applicationMessage',(bytes:Uint8Array)=>{const rumor=deserializeApplicationData(bytes);if(rumor.pubkey!==human)directReplies.push({role,sender:rumor.pubkey,text:rumor.content});});
    async function sendRoom(room:typeof direct,text:string){await client.groups.send(room.group.id,createApplicationMessageIntent(createChatRumor({pubkey:human,content:text,tags:[['nonce',randomUUID()]]})));}
    async function syncRoom(room:typeof direct){const rows=await network.request([relay],[{kinds:[445],'#h':[room.nostrGroupId],limit:40}]);for await(const _result of room.group.ingest(rows)){};}
    await sendRoom(direct,'Riley-only fictional workshop question');await until(async()=>{await syncRoom(direct);return directReplies.length===1;},30000);
    await sendRoom(accountantDirect,'Accountant-only fictional records question');await until(async()=>{await syncRoom(accountantDirect);return directReplies.length===2;},30000);
    assert.equal(directReplies[0].sender,ready.members.find((member:any)=>member.role==='client').pubkey);assert.equal(directReplies[1].sender,ready.members.find((member:any)=>member.role==='accountant').pubkey);assert.equal(calls,2);
    assert(modelInputs.filter(input=>input.role==='accountant').every(input=>!JSON.stringify(input.history).includes('Riley-only')));
    const groupRoom=await createRoom('group');group=groupRoom.group;const {groupId,nostrGroupId}=groupRoom,exactRoster=[human,...originalPubkeys].sort();
    assert.notEqual(groupId,direct.groupId);assert.notEqual(groupId,accountantDirect.groupId);assert.equal((await api()).rooms.client.groupId,direct.groupId);assert.equal(usedPackages.size,4);
    evidence.independentRooms={clientMembers:2,accountantMembers:2,groupMembers:3,sameHumanAndNativeIdentities:true,otherNativeCannotOpenDirectRoom:true,freshSingleUsePackages:4,selectionWithoutBrowserUsedIds:true,directNativeReplies:2};
    const received:{sender:string;text:string;tags:string[][]}[]=[];
    group.on('applicationMessage',(bytes:Uint8Array)=>{const rumor=deserializeApplicationData(bytes);received.push({sender:rumor.pubkey,text:rumor.content,tags:rumor.tags});});
    let sentMessageId='';async function send(text:string){const rumor=createChatRumor({pubkey:human,content:text,tags:[['nonce',randomUUID()]]});sentMessageId=rumor.id;await client.groups.send(group.id,createApplicationMessageIntent(rumor));}
    async function sync(){const rows=await network.request([relay],[{kinds:[445],'#h':[nostrGroupId],limit:40}]);for await(const _result of group.ingest(rows)){};}
    const replyCount=()=>received.filter(message=>originalPubkeys.includes(message.sender)).length;
    await send('@Riley @Jordan please check the workshop total');
    await until(async()=>{await sync();return replyCount()===2;},30000);
    assert(received.filter(message=>originalPubkeys.includes(message.sender)).every(message=>message.tags.some(tag=>tag[0]==='e'&&tag[1]===sentMessageId)));evidence.replyTags=received.find(message=>originalPubkeys.includes(message.sender))!.tags.map(tag=>tag.map(value=>/^[a-f0-9]{64}$/.test(value)?'[message id]':value));assert.equal(calls,4);assert.equal(new Set(received.filter(message=>originalPubkeys.includes(message.sender)).map(message=>message.sender)).size,2);
    assert(received.filter(message=>originalPubkeys.includes(message.sender)).every(message=>message.text.includes('CAD 125.00')));assert(modelInputs.filter(input=>input.text.startsWith('@')).every(input=>!JSON.stringify(input.history).includes('Riley-only')&&!JSON.stringify(input.history).includes('Accountant-only')));
    await sync();await pause(1000);assert.equal(calls,4);assert.equal((await api()).roundsRemaining,9);
    const financialCounts=()=>Object.fromEntries(['invoices','receipts','payouts'].map(table=>[table,Number(store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n)]));
    const beforeFinancial=financialCounts();assert.deepEqual(beforeFinancial,{invoices:0,receipts:0,payouts:0});
    evidence.beforeRestore={roster:3,nativeReplies:replyCount(),inferenceTurns:calls,roundsRemaining:9,financialRows:beforeFinancial};

    // Cold backup: all native processes and the private writer lock must be gone.
    await service!.close();assert.equal(existsSync(join(root,'mdk','.writer-lock')),false);
    const originalHashes=fileHashes(join(root,'mdk'));assert(originalHashes.size>6);
    const layout:any[]=[];function inspect(directory:string,prefix=''){for(const name of readdirSync(directory)){const path=prefix?prefix+'/'+name:name,full=join(directory,name),stat=lstatSync(full);layout.push({path:path.replace(/[a-f0-9]{64,}/gi,'[id]'),bytes:stat.size,nlink:stat.nlink,mode:stat.mode&0o777,directory:stat.isDirectory(),nonstandard:path.split('/').some(part=>part.length>180||!/^[A-Za-z0-9_.-]+$/.test(part))});if(stat.isDirectory())inspect(full,path);}}inspect(join(root,'mdk'));evidence.coldLayout=layout;

    const backupDir=join(root,'backups');mkdirSync(backupDir,{mode:0o700});
    const storageKeyFile=join(root,'storage-key'),backupKeyFile=join(root,'backup-key');
    writeFileSync(storageKeyFile,storageKey.toString('base64url')+'\n',{mode:0o600});
    writeFileSync(backupKeyFile,backupKey.toString('base64url')+'\n',{mode:0o600});
    const keys={storageKeyFile,backupKeyFile};
    const backup=createDemoStateBackup({...keys,runtimeRoot:join(root,'mdk'),outputDir:backupDir});
    const backupPath=join(backupDir,backup.file),verified=verifyDemoStateBackup({...keys,backupPath});
    assert.equal(verified.leases,1);assert.equal(verified.files,originalHashes.size);
    const restoredRoot=join(root,'restored');
    const restored=restoreDemoStateBackup({...keys,backupPath,destination:restoredRoot});
    assert.deepEqual(restored,verified);assert.deepEqual(fileHashes(restoredRoot),originalHashes);
    assert.equal(existsSync(join(restoredRoot,'.writer-lock')),false);
    delete evidence.coldLayout;
    rmSync(join(root,'mdk'),{recursive:true});assert.equal(existsSync(join(root,'mdk')),false);
    evidence.backup={...verified,originalNativeHomesRemovedBeforeRecovery:true,encryptedBytes:backup.bytes,encryptedArchiveSha256:backup.sha256,independentKeys:true,exactFileHashesMatch:true,writerAndDeadProcessRecordsExcluded:true};

    // Reuse the live human SDK/MLS state, same registered lease and ciphertext store.
    // Only the two native identities and their MLS state come from the restored archive.
    startService(restoredRoot);
    await until(()=>api('/connect',{groupId,nostrGroupId}),30000);
    const recoveredPackages=await network.request([relay],[{kinds:[30443,5],authors:originalPubkeys,limit:128}]);const recoveredDeletions=new Set(recoveredPackages.filter((event:any)=>event.kind===5).flatMap((event:any)=>event.tags.filter((tag:string[])=>tag[0]==='e').map((tag:string[])=>tag[1])));for(const author of originalPubkeys){const candidate=recoveredPackages.filter((event:any)=>event.kind===30443&&event.pubkey===author&&!recoveredDeletions.has(event.id)).sort((a:any,b:any)=>b.created_at-a.created_at||a.id.localeCompare(b.id))[0];assert(candidate&&!usedPackages.has(candidate.id),'Recovered bootstrap must expose an unused KeyPackage without browser used-ID history');}evidence.recoveredKeyPackagesSafeWithoutBrowserUsedIds=true;
    const recovered=await api();assert.equal(recovered.state,'ready');assert.equal(recovered.leaseId,started.leaseId);assert.equal(recovered.relayPath,started.relayPath);
    assert.deepEqual(recovered.members.map((member:any)=>member.pubkey).sort(),originalPubkeys);
    assert.deepEqual(getGroupMemberPubkeys(group.state).sort(),exactRoster);
    await send('@Riley please check the workshop total after restoring your saved keys');
    await until(async()=>{await sync();return replyCount()===3;},30000);
    const restoredReply=received.filter(message=>originalPubkeys.includes(message.sender)).at(-1)!;
    assert.equal(restoredReply.sender,ready.members.find((member:any)=>member.role==='client').pubkey);
    assert.match(restoredReply.text,/CAD 125\.00/);assert(!/AI demo|snapshot v/i.test(restoredReply.text));
    assert.equal(calls,5);assert.equal((await api()).roundsRemaining,8);
    await sync();await pause(800);assert.equal(calls,5);assert.equal(replyCount(),3);
    assert.deepEqual(financialCounts(),beforeFinancial);
    evidence.afterRestore={sameNativePubkeys:true,exactRoster:3,newReplyDecrypted:true,nativeReplies:replyCount(),inferenceTurns:calls,roundsRemaining:8,financialRows:financialCounts(),replayDidNotRepeatInference:true};
    await sendRoom(direct,'Follow up in the same client room after recovery');await until(async()=>{await syncRoom(direct);return directReplies.length===3;},30000);
    await sendRoom(accountantDirect,'Follow up in the same accountant room after recovery');await until(async()=>{await syncRoom(accountantDirect);return directReplies.length===4;},30000);assert.equal(calls,7);assert.equal((await api()).roundsRemaining,6);evidence.restoredDirectReplies=2;evidence.finalRoundsRemaining=6;
    for(let round=0;round<6;round++){await send('Please check the total for round '+round);const expected=3+(round+1)*2;await until(async()=>{await sync();return replyCount()===expected;},30000);}assert.equal((await api()).roundsRemaining,0);assert.equal(calls,19);await send('This extra message must exceed the shared visit budget');await pause(1000);await sync();assert.equal(calls,19);evidence.exhaustedRounds={sharedHumanRounds:12,inferences:19,extraMessageRejected:true};
    evidence.ciphertextBudget={events:Number(store.db.prepare('SELECT COUNT(*) n FROM demo_agent_events').get()!.n),encodedBytes:Number(store.db.prepare('SELECT SUM(length(data)) n FROM demo_agent_events').get()!.n)};
    await api('/reset',{});
    evidence.status='passed';
  }catch(error){
    evidence.status='failed';evidence.errorName=(error as Error)?.name;
    evidence.error=String((error as Error)?.message??'Unknown failure').replace(/[a-f0-9]{64,}/gi,'[id]').slice(0,220);
    throw error;
  }finally{
    for(const saved of allGroups)saved.dispose();
    await Promise.all(services.map(instance=>instance.close()));
    await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();
    rmSync(root,{recursive:true,force:true});storageKey.fill(0);backupKey.fill(0);
    evidence.finishedAt=new Date().toISOString();evidence.ownFixtureRemoved=!existsSync(root);evidence.allServicesClosed=true;
    if(process.env.QL_DEMO_NATIVE_ACCEPTANCE_EVIDENCE)writeFileSync(process.env.QL_DEMO_NATIVE_ACCEPTANCE_EVIDENCE,JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
  }
});
