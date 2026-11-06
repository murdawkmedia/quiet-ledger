import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {getPublicKey} from 'nostr-tools';
import {Store} from '../server/store.js';
import {createInvoice} from '../server/domain.js';
import {createAccountAuth} from '../server/account-auth.js';
import {Clients} from '../server/clients.js';
import {InvoiceThreads} from '../server/invoice-threads.js';
import {InvoiceDelivery} from '../server/invoice-delivery.js';
import {InvoiceEmailInbox} from '../server/email-inbox.js';
import {EmailMarmotGateway} from '../server/email-marmot-gateway.js';
import {decryptBackup} from '../server/record-codec.js';
import type {GatewayMarmotMessage} from '../shared/email-gateway.js';
import {createEncryptedBackup,restoreEncryptedBackup,verifyEncryptedBackup} from '../ops/backup.js';

const storageKey=Buffer.alloc(32,53),backupKey=Buffer.alloc(32,54);
const workspace='fictional-recovery-a',other='fictional-recovery-b',owner='a'.repeat(64);
const now=()=>new Date('2026-11-06T15:00:00Z');
const privateText='FICTIONAL COMMUNICATIONS RECOVERY CONTENT';
const digest=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const resetTables=['marmot_gateway_identities','marmot_gateway_state','marmot_gateway_writers','email_marmot_gateways'];
const rows=(db:DatabaseSync,table:string)=>db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all().map(row=>({...row}));
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'ql-communications-backup-'));chmodSync(dir,0o700);
 const dbPath=join(dir,'ledger.sqlite'),store=new Store(dbPath,{encryptionKey:storageKey});
 const invoice=createInvoice(store,workspace,{customerName:'Fictional recovery client',customerEmail:'client@example.test',title:'Fictional recovery work',currency:'CAD',items:[{description:'Fictional work',quantity:1,unitAmount:125}],note:privateText},now());
 return{dir,dbPath,store,invoice,outputDir:join(dir,'backups'),close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
function gatewayFor(store:Store,invoiceId:string){
 const messages:GatewayMarmotMessage[]=[],posted:string[]=[];let actors=0,submissions=0;
 const gateway:EmailMarmotGateway=new EmailMarmotGateway(store,{
  now,marmotFor:()=>{actors++;return{pubkey:getPublicKey(gateway.records.secretKey(workspace)),invite:async()=>({id:randomUUID()}),send:async(_groupId,text)=>{posted.push(text);return{id:randomUUID()};},messages:()=>messages,sync:async()=>{}};},
  email:{authority:()=>'fictional-authority',active:()=>true,preview:(_w,_i,text)=>({to:['client@example.test'],cc:[],subject:'Fictional recovery invoice',text}),send:async()=>{submissions++;return{state:'unknown'};}},
 });
 const push=(groupId:string,text:string)=>messages.push({id:randomUUID(),groupId,sender:owner,text,createdAt:now().getTime()/1000});
 const process=()=>gateway.process(workspace,invoiceId);
 async function pair(){const settings=await gateway.configure(workspace,invoiceId,{enabled:true,ownerPubkey:owner});push(settings.groupId!,`/pair ${settings.pairCode}`);await process();assert.equal(gateway.settings(workspace,invoiceId).status,'paired');return settings;}
 async function prepare(groupId:string){push(groupId,`/email ${privateText}`);await process();const nonce=posted.findLast(text=>text.includes('/send '))?.match(/\/send ([A-Za-z0-9_-]{32})/)?.[1];assert.ok(nonce);return nonce;}
 return{gateway,push,process,pair,prepare,counts:()=>({actors,submissions})};
}

test('restore disables archived gateway ratchets while retaining encrypted business, account, mailbox and delivery records',async()=>{
 const f=fixture();let copy:Store|undefined;
 try{
  createAccountAuth({store:f.store,publicOrigin:'https://ledger.example.test',now,onAuthenticated:()=>{},getSession:()=>undefined});
  const account={id:workspace,workspaceId:workspace,displayName:'Fictional recovery owner',createdAt:now().toISOString()};
  f.store.db.prepare('INSERT INTO auth_accounts(id,workspace_id,data) VALUES(?,?,?)').run(workspace,workspace,f.store.encode(account,'auth_accounts',workspace,workspace));
  const credentialId=randomUUID(),credential={id:credentialId,accountId:workspace,type:'nostr',nostrPubkey:owner,createdAt:now().toISOString()};
  f.store.db.prepare('INSERT INTO auth_credentials(id,account_id,type,lookup_hash,data) VALUES(?,?,?,?,?)').run(credentialId,workspace,'nostr','fictional-lookup',f.store.encode(credential,'auth_credentials',credentialId,workspace));
  f.store.saveSession('fictional-session',{role:'owner',workspace,accountId:workspace,csrf:'fictional-csrf',expires:'2027-01-01T00:00:00Z'});
  const client=new Clients(f.store,now).save(workspace,{name:'Fictional recovery client',email:'client@example.test',notes:privateText});
  const threads=new InvoiceThreads(f.store,now),message=threads.append(workspace,f.invoice.id,{channel:'dashboard',direction:'internal',author:'Owner',text:privateText});
  const delivery=new InvoiceDelivery(f.store,{publicOrigin:'https://ledger.example.test',now,transportFactory:()=>({verify:async()=>true,sendMail:async()=>{throw new Error('Synthetic uncertain SMTP outcome');}})});
  delivery.saveSettings(workspace,{senderEmail:'merchant@example.test',appPassword:'abcdefghijklmnop',savedRecipients:[]});await delivery.verifyGmail(workspace,{demo:false});
  const inbox=new InvoiceEmailInbox(f.store,{now,threads,credentialFor:scope=>delivery.credentialForInbox(scope),mailboxFactory:()=>({open:async()=>({uidValidity:'100',uidNext:10}),headers:async()=>[],readText:async()=>({text:privateText,truncated:false}),close:()=>{}})});
  inbox.configure(workspace,{enabled:true,folder:'Quiet Ledger'});await inbox.sync(workspace);
  const mail=await delivery.send(workspace,f.invoice.id,{action:'send',to:['client@example.test'],copyToSelf:false},randomUUID(),{demo:false});assert.equal(mail.body.state,'unknown');inbox.trackOutbound(workspace,f.invoice.id,mail.body);
  const g=gatewayFor(f.store,f.invoice.id),paired=await g.pair();
  const unknownNonce=await g.prepare(paired.groupId!);g.push(paired.groupId!,`/send ${unknownNonce}`);await g.process();
  const preparedNonce=await g.prepare(paired.groupId!);assert.notEqual(preparedNonce,unknownNonce);
  await g.gateway.forwardApproved(workspace,f.invoice.id,{sourceId:'fictional-incoming',from:'client@example.test',text:privateText});
  const oldKey=g.gateway.records.secretKey(workspace);g.gateway.records.secretKey(other);
  await g.gateway.records.storage(workspace).setItem('fictional-ratchet',{epoch:10n,key:new Uint8Array([1,2,3])});
  await g.gateway.records.storage(other).setItem('other-ratchet',{epoch:20n});
  f.store.db.prepare('INSERT INTO marmot_gateway_writers(workspace,owner,expires) VALUES(?,?,?)').run(workspace,'pid:2147483647:fictional',Date.now()+60000);
  const allTables=f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>String(row.name));
  const before=new Map(allTables.map(table=>[table,rows(f.store.db,table)]));
  const source=readFileSync(f.dbPath),wal=readFileSync(f.dbPath+'-wal');
  const archive=await createEncryptedBackup({dbPath:f.dbPath,outputDir:f.outputDir,storageKey,backupKey}),encrypted=readFileSync(archive.file);
  const archivedDatabase=decryptBackup(encrypted,backupKey,'quiet-ledger/database/v1');
  assert.equal(encrypted.includes(Buffer.from(privateText)),false);assert.equal(archivedDatabase.includes(Buffer.from(privateText)),false);assert.equal(archivedDatabase.includes(Buffer.from(Buffer.from(oldKey).toString('hex'))),false);
  await verifyEncryptedBackup({backupPath:archive.file,storageKey,backupKey});
  const snapshotPath=join(f.dir,'archived.sqlite');writeFileSync(snapshotPath,archivedDatabase,{mode:0o600});
  const snapshot=new DatabaseSync(snapshotPath,{readOnly:true});try{for(const table of allTables)assert.deepEqual(rows(snapshot,table),before.get(table),`archive preserves ${table}`);}finally{snapshot.close();}
  const outputPath=join(f.dir,'restored.sqlite'),result=await restoreEncryptedBackup({backupPath:archive.file,outputPath,storageKey,backupKey});
  const restoredBytes=readFileSync(outputPath);
  const check=new DatabaseSync(outputPath,{readOnly:true});try{assert.equal(check.prepare('SELECT COUNT(*) n FROM marmot_gateway_identities').get()!.n,0,'restore must not resume archived sender identities');}finally{check.close();}
  assert.equal(result.sha256,digest(restoredBytes));assert.equal(result.bytes,statSync(outputPath).size);assert.equal(result.communicationsReset,true);assert.equal(result.archiveSha256,digest(encrypted));assert.notEqual(result.sha256,digest(archivedDatabase));
  assert.equal(restoredBytes.includes(Buffer.from(privateText)),false);assert.equal(statSync(outputPath).mode&0o777,0o600);
  copy=new Store(outputPath,{encryptionKey:storageKey});
  for(const table of allTables){
   if(resetTables.includes(table))assert.deepEqual(rows(copy.db,table),[],table);
   else if(table==='email_marmot_intents')assert.deepEqual(rows(copy.db,table),before.get(table)!.map(row=>({...row,state:row.state==='prepared'?'cancelled':row.state})));
   else assert.deepEqual(rows(copy.db,table),before.get(table),`restore retains ${table}`);
  }
  assert.equal(copy.getInvoice(f.invoice.id,workspace)?.note,privateText);assert.equal(copy.getInvoice(f.invoice.id,other),undefined);
  assert.equal(new Clients(copy,now).get(workspace,client.id)?.notes,privateText);assert.equal(new Clients(copy,now).get(other,client.id),undefined);
  assert.equal(new InvoiceThreads(copy,now).list(workspace,f.invoice.id).messages[0].id,message.id);assert.equal(copy.session('fictional-session')?.accountId,workspace);
  const restoredCredential=copy.db.prepare('SELECT data FROM auth_credentials WHERE id=?').get(credentialId)!;assert.deepEqual(copy.decode(restoredCredential.data,'auth_credentials',credentialId,workspace),credential);
  const fresh=gatewayFor(copy,f.invoice.id);assert.deepEqual(fresh.gateway.settings(workspace,f.invoice.id),{enabled:false,status:'disabled'});
  await fresh.process();assert.deepEqual(fresh.counts(),{actors:0,submissions:0});
  const newSettings=await fresh.pair();assert.notEqual(newSettings.gatewayPubkey,paired.gatewayPubkey);assert.notEqual(newSettings.groupId,paired.groupId);assert.notDeepEqual(fresh.gateway.records.secretKey(workspace),oldKey);assert.deepEqual(await fresh.gateway.records.storage(workspace).keys(),[]);
  fresh.push(paired.groupId!,`/send ${preparedNonce}`);fresh.push(newSettings.groupId!,`/send ${preparedNonce}`);fresh.push(newSettings.groupId!,`/send ${unknownNonce}`);await fresh.process();assert.equal(fresh.counts().submissions,0);
  // Restoring again starts a separate replacement identity, never an archived sender.
  const secondPath=join(f.dir,'second-restore.sqlite');await restoreEncryptedBackup({backupPath:archive.file,outputPath:secondPath,storageKey,backupKey});
  const second=new Store(secondPath,{encryptionKey:storageKey});try{const independent=gatewayFor(second,f.invoice.id);assert.equal(independent.gateway.settings(workspace,f.invoice.id).enabled,false);assert.notDeepEqual(independent.gateway.records.secretKey(workspace),fresh.gateway.records.secretKey(workspace));}finally{second.close();}
  assert.deepEqual(readFileSync(archive.file),encrypted);assert.deepEqual(decryptBackup(encrypted,backupKey,'quiet-ledger/database/v1'),archivedDatabase);
  assert.deepEqual(readFileSync(f.dbPath),source);assert.deepEqual(readFileSync(f.dbPath+'-wal'),wal);
  for(const table of allTables)assert.deepEqual(rows(f.store.db,table),before.get(table),`source retains ${table}`);
  const restarted=gatewayFor(f.store,f.invoice.id);assert.equal(restarted.gateway.settings(workspace,f.invoice.id).status,'paired');assert.deepEqual(restarted.gateway.records.secretKey(workspace),oldKey);
 }finally{copy?.close();f.close();}
});

test('gateway reset failure publishes no destination and preserves the original encrypted recovery archive',async()=>{
 const f=fixture();try{
  const g=gatewayFor(f.store,f.invoice.id),settings=await g.pair(),key=g.gateway.records.secretKey(workspace);
  f.store.db.exec("CREATE TRIGGER synthetic_restore_failure BEFORE DELETE ON email_marmot_gateways BEGIN SELECT RAISE(ABORT,'FICTIONAL RESET FAILURE'); END");
  const archive=await createEncryptedBackup({dbPath:f.dbPath,outputDir:f.outputDir,storageKey,backupKey}),bytes=readFileSync(archive.file),outputPath=join(f.dir,'failed-restore.sqlite');
  await assert.rejects(restoreEncryptedBackup({backupPath:archive.file,outputPath,storageKey,backupKey}),error=>error instanceof Error&&error.message==='Encrypted database backup operation failed.');
  assert.equal(existsSync(outputPath),false);assert.equal(readdirSync(f.dir).some(name=>name.startsWith('.quiet-ledger-backup-')),false);
  assert.deepEqual(readFileSync(archive.file),bytes);assert.deepEqual(g.gateway.records.secretKey(workspace),key);assert.deepEqual(g.gateway.settings(workspace,f.invoice.id).groupId,settings.groupId);
 }finally{f.close();}
});

test('restore CLI reports the final database hash and the independent encrypted archive hash',async()=>{
 const f=fixture();try{
  const g=gatewayFor(f.store,f.invoice.id);await g.pair();g.gateway.records.secretKey(workspace);
  const archive=await createEncryptedBackup({dbPath:f.dbPath,outputDir:f.outputDir,storageKey,backupKey});
  const storagePath=join(f.dir,'storage.key'),backupPath=join(f.dir,'backup.key'),outputPath=join(f.dir,'cli-restored.sqlite');
  writeFileSync(storagePath,storageKey.toString('base64url'),{mode:0o600});writeFileSync(backupPath,backupKey.toString('base64url'),{mode:0o600});
  const result=spawnSync(process.execPath,['--import','tsx','ops/backup.ts','restore',archive.file],{cwd:process.cwd(),env:{PATH:process.env.PATH,STORAGE_KEY_FILE:storagePath,BACKUP_KEY_FILE:backupPath,RESTORE_DB_PATH:outputPath},encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);const metadata=JSON.parse(result.stdout);
  assert.equal(metadata.integrity,'ok');assert.equal(metadata.communicationsReset,true);assert.equal(metadata.sha256,digest(readFileSync(outputPath)));assert.equal(metadata.bytes,statSync(outputPath).size);assert.equal(metadata.archiveSha256,archive.sha256);
  assert.equal(result.stdout.includes(f.dir),false);assert.equal(result.stdout.includes(storageKey.toString('base64url')),false);
 }finally{f.close();}
});

test('legacy and empty gateway backups restore unchanged bytes without creating communications state',async t=>{
 for(const emptyGateway of [false,true])await t.test(emptyGateway?'empty gateway tables':'legacy database',async()=>{
  const f=fixture();try{
   if(emptyGateway)gatewayFor(f.store,f.invoice.id);
   const archive=await createEncryptedBackup({dbPath:f.dbPath,outputDir:f.outputDir,storageKey,backupKey}),encrypted=readFileSync(archive.file),plain=decryptBackup(encrypted,backupKey,'quiet-ledger/database/v1');
   const outputPath=join(f.dir,'restored.sqlite'),result=await restoreEncryptedBackup({backupPath:archive.file,outputPath,storageKey,backupKey});
   assert.equal(result.communicationsReset,false);assert.equal(result.archiveSha256,digest(encrypted));assert.equal(result.sha256,digest(plain));assert.equal(result.bytes,plain.length);assert.deepEqual(readFileSync(outputPath),plain);
   const restored=new DatabaseSync(outputPath,{readOnly:true});try{const names=restored.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'marmot_gateway_%' OR name LIKE 'email_marmot_%'").all();assert.equal(names.length,emptyGateway?6:0);}finally{restored.close();}
  }finally{f.close();}
 });
});
