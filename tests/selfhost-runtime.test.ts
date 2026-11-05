import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadHostedRuntime} from '../server/hosted-runtime.js';

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'ql-selfhost-runtime-'));const secrets=join(dir,'secrets'),data=join(dir,'data'),backups=join(dir,'backups');
 for(const p of [secrets,data,backups])mkdirSync(p,{mode:0o700});
 const storage=join(secrets,'storage-key'),proxy=join(secrets,'proxy-secret'),backup=join(secrets,'backup-key');
 for(const [p,byte] of [[storage,7],[proxy,8],[backup,9]] as const)writeFileSync(p,Buffer.alloc(32,byte).toString('base64url')+'\n',{mode:0o600});
 const env={SELF_HOSTED:'true',PUBLIC_ORIGIN:'http://localhost:4417',HOST:'127.0.0.1',DATA_DIR:data,BACKUP_DIR:backups,STORAGE_KEY_FILE:storage,PROXY_SHARED_SECRET_FILE:proxy,BACKUP_KEY_FILE:backup};
 return {dir,storage,proxy,backup,secrets,data,backups,env,close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('self-host account mode accepts explicit loopback HTTP with fresh private keys and no owner inheritance',()=>{
 const f=fixture();try{
  const runtime=loadHostedRuntime(f.env)!;assert(runtime);assert.equal(runtime.hosted.publicOrigin,f.env.PUBLIC_ORIGIN);assert.equal(runtime.hosted.allowInsecureLoopback,true);assert.equal(runtime.hosted.hackathonDemo,false);assert.equal(runtime.selfHosted,true);assert.deepEqual(runtime.encryptionKey,Buffer.alloc(32,7));
  assert.equal(loadHostedRuntime({...f.env,HACKATHON_DEMO_ENABLED:'true'})!.hosted.hackathonDemo,true);
  for(const extra of [{HOST:'0.0.0.0'},{HOST:'192.0.2.1'},{PUBLIC_ORIGIN:'http://192.0.2.1:4417'},{PUBLIC_ORIGIN:'http://example.test'},{PUBLIC_ORIGIN:'http://localhost:4417/path'},{PUBLIC_ORIGIN:'http://localhost:4417/'},{OWNER_TOKEN:'synthetic-local-owner'},{PRIVATE_SCENARIO_PATH:'fictional.json'},{RECEIVING_CONNECTIONS_FILE:'fictional.json'}])assert.throws(()=>loadHostedRuntime({...f.env,...extra}));
 }finally{f.close();}
});
test('self-host remote HTTPS is supported without a vendor account and keeps development exceptions off',()=>{
 const f=fixture();try{const runtime=loadHostedRuntime({...f.env,PUBLIC_ORIGIN:'https://ledger.example.test',HOST:'0.0.0.0'})!;assert.equal(runtime.selfHosted,true);assert.equal(runtime.hosted.allowInsecureLoopback,undefined);assert.equal(runtime.hosted.publicOrigin,'https://ledger.example.test');}finally{f.close();}
});
test('self-host refuses unsafe directories, missing backup keys, key reuse and linked secret files',()=>{
 const f=fixture();try{
  assert.throws(()=>loadHostedRuntime({...f.env,BACKUP_KEY_FILE:undefined}));
  assert.throws(()=>loadHostedRuntime({...f.env,BACKUP_KEY_FILE:f.storage}));
  assert.throws(()=>loadHostedRuntime({...f.env,PROXY_SHARED_SECRET_FILE:f.storage}));
  chmodSync(f.data,0o755);assert.throws(()=>loadHostedRuntime(f.env));chmodSync(f.data,0o700);
  chmodSync(f.backups,0o755);assert.throws(()=>loadHostedRuntime(f.env));chmodSync(f.backups,0o700);
  const linked=join(f.dir,'linked-data');symlinkSync(f.data,linked);assert.throws(()=>loadHostedRuntime({...f.env,DATA_DIR:linked}));
  const secretLink=join(f.secrets,'linked-key');symlinkSync(f.storage,secretLink);assert.throws(()=>loadHostedRuntime({...f.env,STORAGE_KEY_FILE:secretLink}));
  chmodSync(f.backup,0o644);assert.throws(()=>loadHostedRuntime(f.env));
 }finally{f.close();}
});
