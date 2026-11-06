import {DatabaseSync,backup} from 'node:sqlite';
import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,readSync,writeFileSync,fsyncSync,mkdirSync,mkdtempSync,chmodSync,rmSync,linkSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve,relative,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {encryptBackup,decryptBackup,MAX_BACKUP_BYTES} from '../server/record-codec.js';
import {Store} from '../server/store.js';

const CONTEXT='quiet-ledger/database/v1';
const FAILURE='Encrypted database backup operation failed.';
const APP_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const CORE_TABLES=['meta','invoices','receipts','payouts','audits','sessions','idempotency'];
const fail=()=>new Error(FAILURE);
const own=(stat:{uid:number})=>!process.getuid||stat.uid===process.getuid();
export interface BackupKeys {storageKey:Buffer;backupKey:Buffer}
export interface CreateBackupOptions extends BackupKeys {dbPath:string;outputDir:string;now?:()=>Date}
export interface VerifyBackupOptions extends BackupKeys {backupPath:string}
export interface BackupVerification {integrity:'ok';tables:number}
export interface BackupResult {file:string;sha256:string;bytes:number}
export interface RestoreResult extends BackupResult,BackupVerification {archiveSha256:string;communicationsReset:boolean}

function keys(options:BackupKeys){
  if(!Buffer.isBuffer(options.storageKey)||options.storageKey.length!==32||!Buffer.isBuffer(options.backupKey)||options.backupKey.length!==32||timingSafeEqual(options.storageKey,options.backupKey))throw fail();
  return {storageKey:Buffer.from(options.storageKey),backupKey:Buffer.from(options.backupKey)};
}
function absolute(path:string){if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0'))throw fail();return resolve(path);}
function privateDirectory(path:string,create=false){
  const value=absolute(path);
  // Validate existing ancestors before creating even the final component. A
  // rejected symlink must not leave a directory in another path namespace.
  if(realpathSync(dirname(value))!==dirname(value))throw fail();
  if(create)try{mkdirSync(value,{mode:0o700});}catch(error){if(!error||typeof error!=='object'||!('code'in error)||error.code!=='EEXIST')throw error;}
  const stat=lstatSync(value);if(!stat.isDirectory()||(stat.mode&0o777)!==0o700||!own(stat)||realpathSync(value)!==value)throw fail();
  return value;
}
function openPrivateFile(path:string,max:number,min=1){
  const value=absolute(path);const fd=openSync(value,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o777)!==0o600||!own(stat)||stat.size<min||stat.size>max||realpathSync(dirname(value))!==dirname(value))throw fail();return {fd,size:stat.size,path:value,dev:stat.dev,ino:stat.ino};}
  catch(error){closeSync(fd);throw error;}
}
function readBoundedPrivate(path:string,max:number,min=1){
  const file=openPrivateFile(path,max,min);
  try{
    const value=Buffer.alloc(file.size);let offset=0;
    while(offset<value.length){const read=readSync(file.fd,value,offset,value.length-offset,offset);if(!read)throw fail();offset+=read;}
    const after=fstatSync(file.fd);if(after.size!==file.size||after.nlink!==1||(after.mode&0o777)!==0o600)throw fail();return value;
  }finally{closeSync(file.fd);}
}
function privateScratch(parent?:string){const directory=absolute(parent??tmpdir());if(realpathSync(directory)!==directory)throw fail();const path=mkdtempSync(join(directory,'.quiet-ledger-backup-'));chmodSync(path,0o700);return path;}
function removeScratch(path:string|undefined){if(path)try{rmSync(path,{recursive:true,force:true});}catch{throw fail();}}
function exclusiveFile(path:string,data:Buffer){
  const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,data);fsyncSync(fd);}finally{closeSync(fd);}
}
function syncDirectory(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
function inspectDatabase(path:string,storageKey:Buffer):BackupVerification{
  const check=new DatabaseSync(path,{readOnly:true,defensive:true});let tables:number;
  try{
    check.exec('PRAGMA query_only=ON');
    const integrity=check.prepare('PRAGMA integrity_check').all();if(integrity.length!==1||Object.values(integrity[0])[0]!=='ok')throw fail();
    const names=check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row=>String(row.name));
    if(CORE_TABLES.some(table=>!names.includes(table)))throw fail();
    const marker=check.prepare("SELECT value FROM meta WHERE key='encrypted-storage-v1'").get();if(!marker||typeof marker.value!=='string'||!marker.value.startsWith('qlr:v1:'))throw fail();tables=names.length;
  }finally{check.close();}
  // Store checks the authenticated storage-key marker. It opens only our scratch
  // copy, so schema/connection setup cannot modify the source or restore target.
  const store=new Store(path,{encryptionKey:storageKey});try{if(!store.encrypted)throw fail();}finally{store.close();}
  return {integrity:'ok',tables};
}
async function verifiedArchive(options:VerifyBackupOptions):Promise<{plain:Buffer;verification:BackupVerification;archiveSha256:string}>{
  const privateKeys=keys(options);let scratch:string|undefined,plain:Buffer|undefined;
  try{
    const encrypted=readBoundedPrivate(options.backupPath,MAX_BACKUP_BYTES+32,32);
    plain=decryptBackup(encrypted,privateKeys.backupKey,CONTEXT);if(plain.length<512||plain.length>MAX_BACKUP_BYTES)throw fail();
    scratch=privateScratch();const path=join(scratch,'snapshot.sqlite');exclusiveFile(path,plain);
    const verification=inspectDatabase(path,privateKeys.storageKey);return {plain,verification,archiveSha256:createHash('sha256').update(encrypted).digest('hex')};
  }catch{plain?.fill(0);throw fail();}
  finally{privateKeys.storageKey.fill(0);privateKeys.backupKey.fill(0);removeScratch(scratch);}
}

/** Consistent online SQLite snapshot, including committed WAL pages. Never opens the source for writes. */
export async function createEncryptedBackup(options:CreateBackupOptions):Promise<BackupResult>{
  let privateKeys:BackupKeys|undefined,source:DatabaseSync|undefined,sourceFd:number|undefined,scratch:string|undefined,plain:Buffer|undefined;
  try{
    privateKeys=keys(options);const dbPath=absolute(options.dbPath),directory=privateDirectory(options.outputDir,true);
    const file=openPrivateFile(dbPath,MAX_BACKUP_BYTES,512);sourceFd=file.fd;
    source=new DatabaseSync(dbPath,{readOnly:true,defensive:true});source.exec('PRAGMA query_only=ON;PRAGMA busy_timeout=5000');
    const pageSize=Number(source.prepare('PRAGMA page_size').get()!.page_size),pages=Number(source.prepare('PRAGMA page_count').get()!.page_count);
    if(!Number.isSafeInteger(pageSize)||pageSize<512||!Number.isSafeInteger(pages)||pages<1||pageSize*pages>MAX_BACKUP_BYTES)throw fail();
    scratch=privateScratch(directory);const snapshot=join(scratch,'snapshot.sqlite');exclusiveFile(snapshot,Buffer.alloc(0));const started=Date.now();
    await backup(source,snapshot,{rate:256,progress:({totalPages})=>{if(totalPages*pageSize>MAX_BACKUP_BYTES||Date.now()-started>30000)throw fail();}});
    const current=lstatSync(dbPath);if(current.dev!==file.dev||current.ino!==file.ino||current.isSymbolicLink())throw fail();
    source.close();source=undefined;closeSync(sourceFd);sourceFd=undefined;
    inspectDatabase(snapshot,privateKeys.storageKey);plain=readBoundedPrivate(snapshot,MAX_BACKUP_BYTES,512);
    const encrypted=encryptBackup(plain,privateKeys.backupKey,CONTEXT);const staged=join(scratch,'archive.qlb');exclusiveFile(staged,encrypted);
    const roundtrip=decryptBackup(encrypted,privateKeys.backupKey,CONTEXT);try{if(!roundtrip.equals(plain))throw fail();}finally{roundtrip.fill(0);}
    const stamp=(options.now??(()=>new Date()))().toISOString().replaceAll(/[^0-9TZ]/g,'');const target=join(directory,`quiet-ledger-${stamp}-${randomUUID()}.qlb`);
    // A hard link publishes the complete staged file atomically and refuses any
    // existing destination. Scratch removal leaves one private archive link.
    linkSync(staged,target);syncDirectory(directory);
    return {file:target,sha256:createHash('sha256').update(encrypted).digest('hex'),bytes:encrypted.length};
  }catch{throw fail();}
  finally{plain?.fill(0);source?.close();if(sourceFd!==undefined)closeSync(sourceFd);privateKeys?.storageKey.fill(0);privateKeys?.backupKey.fill(0);removeScratch(scratch);}
}

export async function verifyEncryptedBackup(options:VerifyBackupOptions):Promise<BackupVerification>{
  const result=await verifiedArchive(options);try{return result.verification;}finally{result.plain.fill(0);}
}

/** Restore-only operation on our unpublished copy. An archived MLS sender must never silently resume. */
function resetRestoredCommunications(path:string):boolean{
  const db=new DatabaseSync(path,{defensive:true});
  try{
    const names=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>String(row.name)));
    const runtime=['marmot_gateway_identities','marmot_gateway_state','marmot_gateway_writers','email_marmot_gateways'].filter(table=>names.has(table));
    const hasIntents=names.has('email_marmot_intents');
    const changed=runtime.some(table=>Boolean(db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()))||Boolean(hasIntents&&db.prepare("SELECT 1 FROM email_marmot_intents WHERE state='prepared' LIMIT 1").get());
    if(!changed)return false;
    // Keep the completed restore in one file before publishing it. No WAL or
    // inherited process lease can stand in for fresh membership after recovery.
    db.exec('PRAGMA journal_mode=DELETE;BEGIN IMMEDIATE');
    for(const table of runtime)db.exec(`DELETE FROM ${table}`);
    // Retain the encrypted intent evidence, especially uncertain SMTP outcomes.
    // Pending confirmations lose authority even if their old command is replayed.
    if(hasIntents)db.exec("UPDATE email_marmot_intents SET state='cancelled' WHERE state='prepared'");
    db.exec('COMMIT');
    const integrity=db.prepare('PRAGMA integrity_check').all();if(integrity.length!==1||Object.values(integrity[0])[0]!=='ok')throw fail();
    return true;
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}finally{db.close();}
}

/** Fresh destination only; archived persistent gateways require a new identity and explicit pairing. */
export async function restoreEncryptedBackup(options:VerifyBackupOptions&{outputPath:string}):Promise<RestoreResult>{
  let result:Awaited<ReturnType<typeof verifiedArchive>>|undefined,scratch:string|undefined,restored:Buffer|undefined;
  try{
    const outputPath=absolute(options.outputPath);privateDirectory(dirname(outputPath));
    result=await verifiedArchive(options);scratch=privateScratch(dirname(outputPath));const staged=join(scratch,'restore.sqlite');exclusiveFile(staged,result.plain);
    const communicationsReset=resetRestoredCommunications(staged);restored=readBoundedPrivate(staged,MAX_BACKUP_BYTES,512);
    const fd=openSync(staged,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}
    linkSync(staged,outputPath);syncDirectory(dirname(outputPath));
    return {...result.verification,file:outputPath,sha256:createHash('sha256').update(restored).digest('hex'),bytes:restored.length,archiveSha256:result.archiveSha256,communicationsReset};
  }catch{throw fail();}finally{result?.plain.fill(0);restored?.fill(0);removeScratch(scratch);}
}

function privateKeyFile(path:string|undefined){
  if(!path)throw fail();const resolved=absolute(path),rel=relative(APP_ROOT,realpathSync(resolved));if(!rel.startsWith('..'+sep)&&!isAbsolute(rel))throw fail();
  const bytes=readBoundedPrivate(resolved,45,43);try{const text=bytes.toString('utf8'),match=/^([A-Za-z0-9_-]{43})(?:\r?\n)?$/.exec(text);if(!match)throw fail();const key=Buffer.from(match[1],'base64url');if(key.length!==32||key.toString('base64url')!==match[1])throw fail();return key;}finally{bytes.fill(0);}
}
async function cli(){
  let storageKey:Buffer|undefined,backupKey:Buffer|undefined;
  try{
    storageKey=privateKeyFile(process.env.STORAGE_KEY_FILE);backupKey=privateKeyFile(process.env.BACKUP_KEY_FILE);const command=process.argv[2];
    if(command==='backup'){
      if(!process.env.DATA_DIR||!process.env.BACKUP_DIR)throw fail();const result=await createEncryptedBackup({dbPath:join(absolute(process.env.DATA_DIR),'ledger.sqlite'),storageKey,backupKey,outputDir:process.env.BACKUP_DIR});console.log(JSON.stringify({...result,file:basename(result.file)}));
    }else if(command==='verify'){
      const path=process.env.BACKUP_FILE??process.argv[3];if(!path)throw fail();console.log(JSON.stringify(await verifyEncryptedBackup({backupPath:absolute(path),storageKey,backupKey})));
    }else if(command==='restore'){
      const path=process.env.BACKUP_FILE??process.argv[3],outputPath=process.env.RESTORE_DB_PATH;if(!path||!outputPath)throw fail();const result=await restoreEncryptedBackup({backupPath:absolute(path),storageKey,backupKey,outputPath});console.log(JSON.stringify({integrity:result.integrity,tables:result.tables,bytes:result.bytes,sha256:result.sha256,archiveSha256:result.archiveSha256,communicationsReset:result.communicationsReset}));
    }else throw fail();
  }finally{storageKey?.fill(0);backupKey?.fill(0);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)cli().catch(()=>{console.error(FAILURE);process.exitCode=1;});
