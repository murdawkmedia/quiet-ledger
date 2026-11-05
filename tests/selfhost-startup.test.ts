import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
const root=resolve(import.meta.dirname,'..');
async function freePort(){const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=(probe.address() as {port:number}).port;await new Promise<void>((resolve,reject)=>probe.close(error=>error?reject(error):resolve()));return port;}
test('actual self-host startup serves client/account API, starts empty encrypted, and preserves data across restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ql-selfhost-process-'));const data=join(dir,'data'),backups=join(dir,'backups'),secrets=join(dir,'secrets'),client=join(dir,'client');
 for(const p of [data,backups,secrets,client])mkdirSync(p,{mode:0o700});
 writeFileSync(join(client,'index.html'),'<!doctype html><title>Fictional standalone production build</title>');
 const storage=join(secrets,'storage'),proxy=join(secrets,'proxy'),backup=join(secrets,'backup');for(const [p,n] of [[storage,21],[proxy,22],[backup,23]] as const)writeFileSync(p,Buffer.alloc(32,n).toString('base64url')+'\n',{mode:0o600});
 const port=await freePort(),origin='http://localhost:'+port;
 const env={PATH:process.env.PATH,NODE_ENV:'production',SELF_HOSTED:'true',PUBLIC_ORIGIN:origin,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:data,BACKUP_DIR:backups,STORAGE_KEY_FILE:storage,PROXY_SHARED_SECRET_FILE:proxy,BACKUP_KEY_FILE:backup,SELFHOST_CLIENT_DIR:client};
 let child:ReturnType<typeof spawn>|undefined;let output='';
 async function start(){child=spawn(process.execPath,['--import','tsx','server/index.ts'],{cwd:root,env,stdio:['ignore','pipe','pipe']});child.stdout!.on('data',part=>{output+=part;});child.stderr!.on('data',part=>{output+=part;});
  const deadline=Date.now()+8000;while(Date.now()<deadline){if(child.exitCode!==null)break;try{const res=await fetch('http://127.0.0.1:'+port+'/api/health');if(res.ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw new Error('Synthetic self-host process did not become ready: '+output.slice(-1500));
 }
 async function stop(){if(!child||child.exitCode!==null)return;const process=child;process.kill('SIGTERM');await Promise.race([new Promise<void>(resolve=>process.once('exit',()=>resolve())),new Promise<never>((_resolve,reject)=>setTimeout(()=>{process.kill('SIGKILL');reject(new Error('Self-host process did not drain.'));},4000).unref())]);assert.equal(process.exitCode,0);child=undefined;}
 try{
  await start();const home=await fetch('http://127.0.0.1:'+port+'/');assert.equal(home.status,200);assert.match(await home.text(),/Fictional standalone production build/);assert.match(home.headers.get('content-security-policy')??'',/connect-src 'self'/);
  const session=await(await fetch('http://127.0.0.1:'+port+'/api/session')).json() as {authMode:string;authenticated:boolean;demoAvailable:boolean;marmotAvailable:boolean};assert.equal(session.authMode,'hosted');assert.equal(session.authenticated,false);assert.equal(session.demoAvailable,false);assert.equal(session.marmotAvailable,true);
  assert(!existsSync(join(data,'owner-token')));assert(!existsSync(join(data,'api-token')));
  await stop();let db=new DatabaseSync(join(data,'ledger.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_accounts').get()!.n,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invoices').get()!.n,0);assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');db.close();const before=readFileSync(join(data,'ledger.sqlite'));
  await start();await stop();db=new DatabaseSync(join(data,'ledger.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_accounts').get()!.n,0);assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');db.close();assert.deepEqual(readFileSync(join(data,'ledger.sqlite')),before);
  for(const p of [storage,proxy,backup])assert(!output.includes(readFileSync(p,'utf8').trim()));
 }finally{await stop();rmSync(dir,{recursive:true,force:true});}
});
