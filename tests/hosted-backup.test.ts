import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,readdirSync,rmSync,chmodSync,symlinkSync,linkSync,existsSync,truncateSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {Store} from '../server/store.js';
import {createInvoice} from '../server/domain.js';
import {encryptBackup,MAX_BACKUP_BYTES} from '../server/record-codec.js';
import {createEncryptedBackup,verifyEncryptedBackup,restoreEncryptedBackup} from '../ops/backup.js';

const context='quiet-ledger/database/v1';
const storageKey=Buffer.alloc(32,3),backupKey=Buffer.alloc(32,4);
const sentinel='FICTIONAL BACKUP PRIVATE CUSTOMER SENTINEL';
const input={customerName:sentinel,title:'Fictional backup invoice',currency:'CAD',items:[{description:'Fictional service',quantity:1,unitAmount:125}],note:'FICTIONAL BACKUP PRIVATE NOTE SENTINEL'};
const digest=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'ql-backup-test-')),dbPath=join(dir,'ledger.sqlite'),outputDir=join(dir,'backups');
  const store=new Store(dbPath,{encryptionKey:storageKey});store.db.exec('PRAGMA wal_autocheckpoint=0');const invoice=createInvoice(store,'fictional-backup-account',input,new Date());
  return {dir,dbPath,outputDir,store,invoice,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
function generic(error:unknown){return error instanceof Error&&error.message==='Encrypted database backup operation failed.';}
test('encrypted backup includes committed WAL, verifies storage identity and restores scoped invoice content',async()=>{
  const f=fixture();try{const source=readFileSync(f.dbPath),wal=readFileSync(f.dbPath+'-wal');assert.ok(wal.length>0);
    const result=await createEncryptedBackup({dbPath:f.dbPath,storageKey,backupKey,outputDir:f.outputDir,now:()=>new Date('2026-11-05T07:00:00Z')});
    assert.equal(result.bytes,statSync(result.file).size);assert.equal(result.sha256,digest(readFileSync(result.file)));assert.equal(statSync(result.file).mode&0o777,0o600);assert.equal(statSync(f.outputDir).mode&0o777,0o700);
    const archive=readFileSync(result.file);assert.ok(!archive.includes(Buffer.from(sentinel)));assert.ok(!archive.includes(Buffer.from(input.note)));assert.ok(!archive.includes(Buffer.from('SQLite format')));
    const checked=await verifyEncryptedBackup({backupPath:result.file,storageKey,backupKey});assert.equal(checked.integrity,'ok');assert.ok(checked.tables>=7);
    const restoredPath=join(f.dir,'restored.sqlite');const restored=await restoreEncryptedBackup({backupPath:result.file,storageKey,backupKey,outputPath:restoredPath});assert.equal(restored.integrity,'ok');assert.equal(statSync(restoredPath).mode&0o777,0o600);
    const copy=new Store(restoredPath,{encryptionKey:storageKey});try{assert.equal(copy.getInvoice(f.invoice.id,'fictional-backup-account')?.note,input.note);assert.equal(copy.getInvoice(f.invoice.id,'another-fictional-account'),undefined);}finally{copy.close();}
    assert.deepEqual(readFileSync(f.dbPath),source,'read-only backup must not change source database bytes');assert.deepEqual(readFileSync(f.dbPath+'-wal'),wal,'read-only backup must not checkpoint or truncate source WAL');
    assert.deepEqual(readdirSync(f.outputDir),[result.file.split('/').at(-1)]);
  }finally{f.close();}
});
test('successive backups are exclusive unique files and preserve existing archives',async()=>{
  const f=fixture();try{mkdirSync(f.outputDir,{mode:0o700});const preserved=join(f.outputDir,'preserved.qlb');writeFileSync(preserved,'fictional-existing-backup',{mode:0o600});
    const options={dbPath:f.dbPath,storageKey,backupKey,outputDir:f.outputDir,now:()=>new Date('2026-11-05T07:00:00Z')};const first=await createEncryptedBackup(options),second=await createEncryptedBackup(options);
    assert.notEqual(first.file,second.file);assert.equal(readFileSync(preserved,'utf8'),'fictional-existing-backup');assert.equal(readdirSync(f.outputDir).length,3);
    const bytes=readFileSync(first.file);await assert.rejects(restoreEncryptedBackup({backupPath:second.file,storageKey,backupKey,outputPath:first.file}),generic);assert.deepEqual(readFileSync(first.file),bytes);
    const alias=join(f.dir,'existing-link.sqlite');symlinkSync(f.dbPath,alias);await assert.rejects(restoreEncryptedBackup({backupPath:first.file,storageKey,backupKey,outputPath:alias}),generic);assert.equal(f.store.getInvoice(f.invoice.id)?.note,input.note);
  }finally{f.close();}
});
test('wrong keys, archive tampering and missing storage markers fail without key/path/data leakage',async(t)=>{
  const f=fixture();try{const result=await createEncryptedBackup({dbPath:f.dbPath,storageKey,backupKey,outputDir:f.outputDir});
    await t.test('wrong archive key',()=>assert.rejects(verifyEncryptedBackup({backupPath:result.file,storageKey,backupKey:Buffer.alloc(32,9)}),generic));
    await t.test('wrong storage key',()=>assert.rejects(verifyEncryptedBackup({backupPath:result.file,storageKey:Buffer.alloc(32,9),backupKey}),generic));
    await t.test('tamper',async()=>{const bytes=readFileSync(result.file);bytes[bytes.length-1]^=1;const path=join(f.dir,'tampered.qlb');writeFileSync(path,bytes,{mode:0o600});await assert.rejects(verifyEncryptedBackup({backupPath:path,storageKey,backupKey}),generic);assert.equal(readFileSync(path).at(-1),bytes.at(-1));});
    await t.test('missing marker',async()=>{const path=join(f.dir,'unmarked.sqlite'),db=new DatabaseSync(path);db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');db.close();const archive=join(f.dir,'unmarked.qlb');writeFileSync(archive,encryptBackup(readFileSync(path),backupKey,context),{mode:0o600});await assert.rejects(verifyEncryptedBackup({backupPath:archive,storageKey,backupKey}),generic);});
    await t.test('invalid key length',()=>assert.rejects(createEncryptedBackup({dbPath:f.dbPath,storageKey:Buffer.alloc(31),backupKey,outputDir:f.outputDir}),generic));
    await t.test('nonindependent keys',()=>assert.rejects(createEncryptedBackup({dbPath:f.dbPath,storageKey,backupKey:storageKey,outputDir:f.outputDir}),generic));
    assert.equal(readdirSync(f.outputDir).length,1);
  }finally{f.close();}
});
test('backup refuses plaintext stores and oversized source files without changing them',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ql-backup-plain-'));try{const path=join(dir,'plain.sqlite'),store=new Store(path);createInvoice(store,'fictional',input,new Date());store.close();const before=readFileSync(path);
    await assert.rejects(createEncryptedBackup({dbPath:path,storageKey,backupKey,outputDir:join(dir,'backups')}),generic);assert.deepEqual(readFileSync(path),before);
    truncateSync(path,MAX_BACKUP_BYTES+1);const size=statSync(path).size;await assert.rejects(createEncryptedBackup({dbPath:path,storageKey,backupKey,outputDir:join(dir,'backups')}),generic);assert.equal(statSync(path).size,size);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('snapshot is transactionally consistent while a separate WAL connection continues writing',async()=>{
  const f=fixture();let timer:NodeJS.Timeout|undefined;try{
    f.store.db.exec('CREATE TABLE synthetic_padding(id INTEGER PRIMARY KEY,data BLOB NOT NULL);CREATE TABLE synthetic_live(id INTEGER PRIMARY KEY,value INTEGER NOT NULL)');
    const padding=f.store.db.prepare('INSERT INTO synthetic_padding(data) VALUES(zeroblob(4096))');f.store.transaction(()=>{for(let i=0;i<600;i++)padding.run();});
    let counter=0;const increment=()=>f.store.transaction(()=>{counter++;f.store.db.prepare('INSERT INTO synthetic_live(id,value) VALUES(?,?)').run(counter,counter);f.store.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('synthetic-count',?)").run(String(counter));});for(let i=0;i<20;i++)increment();
    const pending=createEncryptedBackup({dbPath:f.dbPath,storageKey,backupKey,outputDir:f.outputDir});increment();timer=setInterval(()=>{if(counter<100)increment();},1);
    const result=await pending;clearInterval(timer);timer=undefined;const restoredPath=join(f.dir,'live-copy.sqlite');await restoreEncryptedBackup({backupPath:result.file,storageKey,backupKey,outputPath:restoredPath});const copy=new DatabaseSync(restoredPath,{readOnly:true});try{const stored=Number(copy.prepare("SELECT value FROM meta WHERE key='synthetic-count'").get()!.value),row=copy.prepare('SELECT COUNT(*) as n,SUM(value) as total FROM synthetic_live').get()!;assert.ok(stored>=20&&stored<=counter);assert.equal(row.n,stored);assert.equal(row.total,stored*(stored+1)/2);assert.equal(copy.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');}finally{copy.close();}
    assert.ok(counter>=21);assert.equal(f.store.db.prepare('SELECT COUNT(*) as n FROM synthetic_live').get()!.n,counter);
  }finally{if(timer)clearInterval(timer);f.close();}
});
test('backup path guards refuse linked/exposed sources, inputs and output directories',async()=>{
  const f=fixture();try{const alias=join(f.dir,'source-link.sqlite');symlinkSync(f.dbPath,alias);await assert.rejects(createEncryptedBackup({dbPath:alias,storageKey,backupKey,outputDir:f.outputDir}),generic);
    const result=await createEncryptedBackup({dbPath:f.dbPath,storageKey,backupKey,outputDir:f.outputDir});chmodSync(result.file,0o644);await assert.rejects(verifyEncryptedBackup({backupPath:result.file,storageKey,backupKey}),generic);chmodSync(result.file,0o600);
    const linkedArchive=join(f.dir,'linked.qlb');linkSync(result.file,linkedArchive);await assert.rejects(verifyEncryptedBackup({backupPath:result.file,storageKey,backupKey}),generic);
    const exposed=join(f.dir,'exposed');mkdirSync(exposed,{mode:0o755});await assert.rejects(createEncryptedBackup({dbPath:f.dbPath,storageKey,backupKey,outputDir:exposed}),generic);
  }finally{f.close();}
});
test('rejected symlink ancestors never create an output directory outside the requested path namespace',async()=>{
  const f=fixture();try{const outside=join(f.dir,'outside'),alias=join(f.dir,'directory-link');mkdirSync(outside,{mode:0o700});symlinkSync(outside,alias);await assert.rejects(createEncryptedBackup({dbPath:f.dbPath,storageKey,backupKey,outputDir:join(alias,'must-not-be-created')}),generic);assert.equal(existsSync(join(outside,'must-not-be-created')),false);}finally{f.close();}
});
test('a bounded snapshot-progress abort cleans its scratch without publishing a partial backup',async()=>{
  const f=fixture();const originalNow=Date.now;try{f.store.db.exec('CREATE TABLE synthetic_large(id INTEGER PRIMARY KEY,data BLOB NOT NULL)');const insert=f.store.db.prepare('INSERT INTO synthetic_large(data) VALUES(zeroblob(4096))');f.store.transaction(()=>{for(let i=0;i<400;i++)insert.run();});let reads=0;Date.now=()=>++reads===1?100000:130001;await assert.rejects(createEncryptedBackup({dbPath:f.dbPath,storageKey,backupKey,outputDir:f.outputDir}),generic);assert.deepEqual(readdirSync(f.outputDir),[]);assert.equal(f.store.getInvoice(f.invoice.id)?.note,input.note);}finally{Date.now=originalNow;f.close();}
});
test('restore write failure never publishes a partial destination database',async()=>{
  const f=fixture();const originalWrite=fs.writeFileSync;try{const result=await createEncryptedBackup({dbPath:f.dbPath,storageKey,backupKey,outputDir:f.outputDir}),outputPath=join(f.dir,'failed-restore.sqlite');let writes=0;
    fs.writeFileSync=((file:any,data:any,...rest:any[])=>{if(Buffer.isBuffer(data)&&data.subarray(0,15).toString()==='SQLite format 3'&&++writes===2){originalWrite(file,data.subarray(0,16));throw new Error('SYNTHETIC_WRITE_FAILURE');}return (originalWrite as any)(file,data,...rest);}) as typeof fs.writeFileSync;syncBuiltinESMExports();
    await assert.rejects(restoreEncryptedBackup({backupPath:result.file,storageKey,backupKey,outputPath}),generic);assert.equal(existsSync(outputPath),false);
  }finally{fs.writeFileSync=originalWrite;syncBuiltinESMExports();f.close();}
});
test('CLI reads only existing external private key files and prints bounded metadata',()=>{
  const f=fixture();try{f.store.close();const storagePath=join(f.dir,'storage.key'),backupPath=join(f.dir,'backup.key');writeFileSync(storagePath,storageKey.toString('base64url')+'\n',{mode:0o600});writeFileSync(backupPath,backupKey.toString('base64url')+'\n',{mode:0o600});
    const env={PATH:process.env.PATH,DATA_DIR:f.dir,BACKUP_DIR:f.outputDir,STORAGE_KEY_FILE:storagePath,BACKUP_KEY_FILE:backupPath};
    const run=(command:string,extra:Record<string,string>={})=>spawnSync(process.execPath,['--import','tsx','ops/backup.ts',command],{cwd:resolve('.'),env:{...env,...extra},encoding:'utf8',timeout:15000});
    const created=run('backup');assert.equal(created.status,0,created.stderr);const metadata=JSON.parse(created.stdout);assert.ok(metadata.bytes>0);assert.equal(metadata.file,metadata.file.split('/').at(-1));assert.ok(!created.stdout.includes(storageKey.toString('base64url')));assert.ok(!created.stdout.includes(sentinel));
    const verified=run('verify',{BACKUP_FILE:join(f.outputDir,metadata.file)});assert.equal(verified.status,0,verified.stderr);assert.equal(JSON.parse(verified.stdout).integrity,'ok');
    const before=readFileSync(storagePath);chmodSync(storagePath,0o644);const bad=run('backup');assert.notEqual(bad.status,0);assert.ok(!bad.stderr.includes(storagePath));assert.ok(!bad.stderr.includes(storageKey.toString('base64url')));assert.deepEqual(readFileSync(storagePath),before);assert.equal(statSync(storagePath).mode&0o777,0o644);chmodSync(storagePath,0o600);
    const missing=join(f.dir,'missing.key');assert.notEqual(run('backup',{STORAGE_KEY_FILE:missing}).status,0);assert.equal(existsSync(missing),false);
    const link=join(f.dir,'key-link');symlinkSync(storagePath,link);assert.notEqual(run('backup',{STORAGE_KEY_FILE:link}).status,0);
    const hard=join(f.dir,'key-hard-link');linkSync(storagePath,hard);assert.notEqual(run('backup',{STORAGE_KEY_FILE:hard}).status,0);
  }finally{f.close();}
});
