import assert from 'node:assert/strict';import {test} from 'node:test';import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';import {existsSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {createJournalBackup,restoreJournalBackup,MANIFEST_SUFFIX,BACKUP_MANIFEST_FORMAT} from '../../server/cashu/backup.mjs';import {sdk} from './fixtures.mjs';import {newDir,writePrivate,profileObject,storageKey} from './helpers.mjs';
import {prepareUncertain,makeKeyset,runtimeFor} from './helpers.mjs';
import {authentication} from './backup-auth-fixture.mjs';

function corruptPrepared(path) {
 const db=new DatabaseSync(path);
 try {const trigger=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='immutable_preparation'").get().sql;db.exec('DROP TRIGGER immutable_preparation');const row=db.prepare('SELECT op_id,prepared FROM operations LIMIT 1').get();const value=Buffer.from(row.prepared);value[value.length-1]^=1;db.prepare('UPDATE operations SET prepared=? WHERE op_id=?').run(value,row.op_id);db.exec(trigger);} finally {db.close();}
}

for(const altered of [false,true])for(const restoring of [false,true])test(`trigger drift is rejected without repair or publication (altered=${altered},restore=${restoring})`,async()=>{
 const dir=newDir('review-trigger-drift'),journalPath=join(dir,'source.sqlite'),out=join(dir,'backup.sqlite'),destination=join(dir,'restored.sqlite'),key=storageKey(),keyset=makeKeyset();await prepareUncertain({journalPath,key,keyset});
 if(restoring)await createJournalBackup({sdk,profile:profileObject({journalPath,keyset}),storageKey:key,out});
 const target=restoring?out:journalPath,db=new DatabaseSync(target);db.exec('DROP TRIGGER immutable_preparation');if(altered)db.exec("CREATE TRIGGER immutable_preparation BEFORE UPDATE OF prepared ON operations BEGIN SELECT 1; END;");db.close();const before=readFileSync(target);
 if(restoring){const manifest=JSON.parse(readFileSync(out+MANIFEST_SUFFIX));manifest.sha256=createHash('sha256').update(before).digest('hex');manifest.bytes=before.length;manifest.authentication=authentication(manifest,key);writeFileSync(out+MANIFEST_SUFFIX,JSON.stringify(manifest),{mode:0o600});assert.throws(()=>restoreJournalBackup({sdk,backupPath:out,destination,storageKey:key}),e=>e.code==='JOURNAL_NOT_INITIALIZED');assert.equal(existsSync(destination),false);}else{await assert.rejects(createJournalBackup({sdk,profile:profileObject({journalPath,keyset}),storageKey:key,out}),e=>e.code==='JOURNAL_NOT_INITIALIZED');assert.equal(existsSync(out),false);}
 assert.deepEqual(readFileSync(target),before);
});

test('a rewritten snapshot and unsigned digest cannot authenticate a backup',async()=>{
 const dir=newDir('review-backup-auth'),journalPath=join(dir,'source.sqlite'),out=join(dir,'backup.sqlite'),destination=join(dir,'restored.sqlite'),key=storageKey(),keyset=makeKeyset();await prepareUncertain({journalPath,key,keyset});await createJournalBackup({sdk,profile:profileObject({journalPath,keyset}),storageKey:key,out});corruptPrepared(out);const bytes=readFileSync(out),manifest=JSON.parse(readFileSync(out+MANIFEST_SUFFIX));manifest.sha256=createHash('sha256').update(bytes).digest('hex');manifest.bytes=bytes.length;writeFileSync(out+MANIFEST_SUFFIX,JSON.stringify(manifest),{mode:0o600});assert.throws(()=>restoreJournalBackup({sdk,backupPath:out,destination,storageKey:key}),e=>e.code==='BACKUP_AUTH_FAILED');assert.equal(existsSync(destination),false);assert.equal(readdirSync(dir).some(name=>name.includes('.restore-')),false);
});

test('backup authenticates every encrypted source payload before reporting success',async()=>{
 const dir=newDir('review-source-auth'),journalPath=join(dir,'source.sqlite'),out=join(dir,'backup.sqlite'),key=storageKey(),keyset=makeKeyset();await prepareUncertain({journalPath,key,keyset});corruptPrepared(journalPath);await assert.rejects(createJournalBackup({sdk,profile:profileObject({journalPath,keyset}),storageKey:key,out}),e=>['BACKUP_INVALID','CORRUPT_JOURNAL'].includes(e.code));assert.equal(existsSync(out),false);assert.equal(existsSync(out+MANIFEST_SUFFIX),false);
});

test('even a correctly signed snapshot with a corrupt encrypted payload cannot be restored',async()=>{
 const dir=newDir('review-signed-corrupt'),journalPath=join(dir,'source.sqlite'),out=join(dir,'backup.sqlite'),destination=join(dir,'restored.sqlite'),key=storageKey(),keyset=makeKeyset();await prepareUncertain({journalPath,key,keyset});await createJournalBackup({sdk,profile:profileObject({journalPath,keyset}),storageKey:key,out});corruptPrepared(out);const bytes=readFileSync(out),manifest=JSON.parse(readFileSync(out+MANIFEST_SUFFIX));manifest.sha256=createHash('sha256').update(bytes).digest('hex');manifest.bytes=bytes.length;manifest.authentication=authentication(manifest,key);writeFileSync(out+MANIFEST_SUFFIX,JSON.stringify(manifest),{mode:0o600});assert.throws(()=>restoreJournalBackup({sdk,backupPath:out,destination,storageKey:key}),e=>['BACKUP_INVALID','CORRUPT_JOURNAL'].includes(e.code));assert.equal(existsSync(destination),false);assert.equal(readdirSync(dir).some(name=>name.includes('.restore-')),false);
});

test('a finalized journal with historical restore and acknowledged outbox payloads survives backup authentication',async()=>{
 const dir=newDir('review-finalized-auth'),journalPath=join(dir,'source.sqlite'),out=join(dir,'backup.sqlite'),destination=join(dir,'restored.sqlite'),key=storageKey(),keyset=makeKeyset();const fixture=await prepareUncertain({journalPath,key,keyset});const runtime=runtimeFor({journalPath,key,keyset});try {await runtime.check('fictional-recovery-op',{apply:true,transport:args=>fixture.mint.check(args)});await runtime.restore('fictional-recovery-op',{apply:true,transport:args=>fixture.mint.restore(args)});await runtime.deliver({async credit(){}});} finally {runtime.close();}const result=await createJournalBackup({sdk,profile:profileObject({journalPath,keyset}),storageKey:key,out});assert.equal(result.counts.results,1);assert.equal(result.counts.merchantProofs,2);const restored=restoreJournalBackup({sdk,backupPath:out,destination,storageKey:key});assert.deepEqual(restored.counts,result.counts);
});

test('a keyed but incorrect count manifest is rejected by snapshot validation',async()=>{
 const dir=newDir('review-counts-auth'),journalPath=join(dir,'source.sqlite'),out=join(dir,'backup.sqlite'),destination=join(dir,'restored.sqlite'),key=storageKey(),keyset=makeKeyset();await prepareUncertain({journalPath,key,keyset});await createJournalBackup({sdk,profile:profileObject({journalPath,keyset}),storageKey:key,out});const manifest=JSON.parse(readFileSync(out+MANIFEST_SUFFIX));manifest.counts.operations+=1;manifest.authentication=authentication(manifest,key);writeFileSync(out+MANIFEST_SUFFIX,JSON.stringify(manifest),{mode:0o600});assert.throws(()=>restoreJournalBackup({sdk,backupPath:out,destination,storageKey:key}),e=>e.code==='BACKUP_COUNTS_MISMATCH');assert.equal(existsSync(destination),false);
});

test('backup rejects an empty file without initializing or publishing it',async()=>{
 const dir=newDir('review-backup-empty'),journalPath=join(dir,'source.sqlite'),out=join(dir,'backup.sqlite');writePrivate(journalPath,Buffer.alloc(0));await assert.rejects(createJournalBackup({sdk,profile:profileObject({journalPath}),storageKey:storageKey(),out}),error=>error.code==='JOURNAL_NOT_INITIALIZED');assert.equal(readFileSync(journalPath).length,0);assert.equal(existsSync(journalPath+'.writer-lock'),false);assert.equal(existsSync(out),false);assert.equal(existsSync(out+MANIFEST_SUFFIX),false);
});

test('backup refuses an unrelated SQLite database and preserves every source byte',async()=>{
 const dir=newDir('review-backup-unrelated'),journalPath=join(dir,'source.sqlite'),out=join(dir,'backup.sqlite');writePrivate(journalPath,Buffer.alloc(0));const db=new DatabaseSync(journalPath);db.exec("CREATE TABLE unrelated_payload(id INTEGER PRIMARY KEY,note TEXT);INSERT INTO unrelated_payload VALUES(1,'fictional original content');");db.close();const before=readFileSync(journalPath);await assert.rejects(createJournalBackup({sdk,profile:profileObject({journalPath}),storageKey:storageKey(),out}),error=>error.code==='JOURNAL_NOT_INITIALIZED');assert.deepEqual(readFileSync(journalPath),before);assert.equal(existsSync(journalPath+'.writer-lock'),false);assert.equal(existsSync(out),false);assert.equal(existsSync(out+MANIFEST_SUFFIX),false);
});

test('an authenticated journal with a missing table is refused without repairing its schema',async()=>{
 const dir=newDir('review-missing-table'),journalPath=join(dir,'source.sqlite'),out=join(dir,'backup.sqlite'),key=storageKey(),keyset=makeKeyset();await prepareUncertain({journalPath,key,keyset});const db=new DatabaseSync(journalPath);db.exec('DROP TABLE merchant_proofs');db.close();const before=readFileSync(journalPath);await assert.rejects(createJournalBackup({sdk,profile:profileObject({journalPath,keyset}),storageKey:key,out}),e=>e.code==='JOURNAL_NOT_INITIALIZED');assert.deepEqual(readFileSync(journalPath),before);assert.equal(existsSync(out),false);
});

for(const markerTable of [false,true])test(`a self-consistent forged backup without an authenticated key marker is rejected (table=${markerTable})`,()=>{
 const dir=newDir('review-backup-forged'),source=join(dir,'source.sqlite'),destination=join(dir,'restored.sqlite');writePrivate(source,Buffer.alloc(0));const db=new DatabaseSync(source);if(markerTable)db.exec('CREATE TABLE journal_key_check(id INTEGER PRIMARY KEY,payload BLOB);');else db.exec('PRAGMA user_version=1;');db.close();const bytes=readFileSync(source),before=Buffer.from(bytes),counts={operations:0,reservations:0,merchantProofs:0,results:0,outbox:0,observations:0};const manifest={format:BACKUP_MANIFEST_FORMAT,createdAt:'2026-11-06T00:00:00Z',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,counts};manifest.authentication=authentication(manifest,Buffer.alloc(32,254));writePrivate(source+MANIFEST_SUFFIX,Buffer.from(JSON.stringify(manifest)));
 assert.throws(()=>restoreJournalBackup({sdk,backupPath:source,destination,storageKey:Buffer.alloc(32,254)}),error=>error.code==='JOURNAL_NOT_INITIALIZED');assert.equal(existsSync(destination),false);assert.deepEqual(readFileSync(source),before);assert.equal(readdirSync(dir).some(name=>name.includes('.restore-')),false);
});
