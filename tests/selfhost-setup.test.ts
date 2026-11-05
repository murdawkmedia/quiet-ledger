import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,statSync,rmSync,symlinkSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {setupSelfHost}=await import(pathToFileURL(resolve('scripts/setup-selfhost.mjs')).href);
function fixture(){const dir=mkdtempSync(join(tmpdir(),'ql-selfhost-setup-'));return {dir,root:join(dir,'instance'),close:()=>rmSync(dir,{recursive:true,force:true})};}
test('self-host setup creates independent private keys and preserves exact existing installation on repeat',()=>{
 const f=fixture();try{
  const first=setupSelfHost({directory:f.root});assert.equal(first.publicOrigin,'http://localhost:4417');assert.equal(first.demoEnabled,false);assert.equal(statSync(f.root).mode&0o777,0o700);
  const names=['storage-key','backup-key','proxy-secret'];const bytes=names.map(name=>readFileSync(join(f.root,'secrets',name)));for(const name of names)assert.equal(statSync(join(f.root,'secrets',name)).mode&0o777,0o600);assert.equal(new Set(bytes.map(b=>b.toString())).size,3);
  const env=readFileSync(join(f.root,'runtime.env'),'utf8');for(const key of bytes)assert(!env.includes(key.toString().trim()));assert.match(env,/SELF_HOSTED="true"/);assert.match(env,/HACKATHON_DEMO_ENABLED="false"/);
  for(const name of ['data','backups','secrets'])assert.equal(statSync(join(f.root,name)).mode&0o777,0o700);assert(!existsSync(join(f.root,'data','ledger.sqlite')));
  const before=readFileSync(join(f.root,'runtime.env'));const repeated=setupSelfHost({directory:f.root});assert.equal(repeated.publicOrigin,first.publicOrigin);assert.deepEqual(readFileSync(join(f.root,'runtime.env')),before);for(const [index,name] of names.entries())assert.deepEqual(readFileSync(join(f.root,'secrets',name)),bytes[index]);
  assert.throws(()=>setupSelfHost({directory:f.root,publicOrigin:'https://other.example'}));assert.throws(()=>setupSelfHost({directory:f.root,demo:true}));
 }finally{f.close();}
});
test('setup permits explicit demo opt-in and HTTPS reverse-proxy origins',()=>{
 const f=fixture();try{const value=setupSelfHost({directory:f.root,publicOrigin:'https://ledger.example.test',demo:true});assert.equal(value.publicOrigin,'https://ledger.example.test');assert.equal(value.demoEnabled,true);assert.match(readFileSync(join(f.root,'runtime.env'),'utf8'),/HACKATHON_DEMO_ENABLED="true"/);}finally{f.close();}
});
test('setup rejects foreign directories and unsafe paths without changing their bytes or permissions',()=>{
 const f=fixture();try{
  mkdirSync(f.root,{mode:0o755});writeFileSync(join(f.root,'keep.txt'),'Fictional existing work');assert.throws(()=>setupSelfHost({directory:f.root}));assert.equal(readFileSync(join(f.root,'keep.txt'),'utf8'),'Fictional existing work');assert.equal(statSync(f.root).mode&0o777,0o755);
  const alias=join(f.dir,'alias');symlinkSync(f.root,alias);assert.throws(()=>setupSelfHost({directory:join(alias,'new-instance')}));assert(!existsSync(join(f.root,'new-instance')));
  assert.throws(()=>setupSelfHost({directory:resolve('private-test-instance-not-created')}));assert(!existsSync(resolve('private-test-instance-not-created')));
  for(const origin of ['http://example.test:4417','http://192.0.2.8:4417','https://user:pass@example.test','https://example.test/path','https://example.test/'])assert.throws(()=>setupSelfHost({directory:join(f.dir,'invalid'),publicOrigin:origin}));
 }finally{f.close();}
});
test('setup refuses linked or exposed keys and tampered config on an owned installation',()=>{
 const f=fixture();try{
  setupSelfHost({directory:f.root});const path=join(f.root,'secrets','backup-key');chmodSync(path,0o644);assert.throws(()=>setupSelfHost({directory:f.root}));chmodSync(path,0o600);
  const env=join(f.root,'runtime.env');const saved=readFileSync(env);writeFileSync(env,saved.toString().replace('SELF_HOSTED="true"','SELF_HOSTED="false"'));assert.throws(()=>setupSelfHost({directory:f.root}));writeFileSync(env,saved);
  const key=join(f.root,'secrets','proxy-secret');const bytes=readFileSync(key);rmSync(key);symlinkSync(path,key);assert.throws(()=>setupSelfHost({directory:f.root}));rmSync(key);writeFileSync(key,bytes,{mode:0o600});assert.doesNotThrow(()=>setupSelfHost({directory:f.root}));
 }finally{f.close();}
});
