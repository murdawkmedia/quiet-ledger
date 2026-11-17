import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,symlinkSync,linkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadDemoLiveAdapter} from '../server/demo-live-config.js';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';

test('optional demo receiver is absent unless explicitly configured',()=>{
  assert.equal(loadDemoLiveAdapter({}),undefined);
  assert.equal(loadDemoLiveAdapter({HOSTED_ACCOUNTS:'true',HACKATHON_DEMO_ENABLED:'true'}),undefined);
});
test('permission and link changes during credential reads are refused',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ql-demo-config-race-')),file=join(dir,'token');
  const env={HOSTED_ACCOUNTS:'true',HACKATHON_DEMO_ENABLED:'true',DEMO_LIVE_COINOS_TOKEN_FILE:file};
  const original=fs.readFileSync;
  try{
    for(const mutation of [()=>chmodSync(file,0o644),()=>linkSync(file,join(dir,'second-link'))]){
      writeFileSync(file,'ab'.repeat(32),{mode:0o600});chmodSync(file,0o600);
      fs.readFileSync=((...args:Parameters<typeof fs.readFileSync>)=>{const value=(original as Function)(...args);if(typeof args[0]==='number')mutation();return value;}) as typeof fs.readFileSync;
      syncBuiltinESMExports();assert.throws(()=>loadDemoLiveAdapter(env));
      fs.readFileSync=original;syncBuiltinESMExports();rmSync(join(dir,'second-link'),{force:true});
    }
  }finally{fs.readFileSync=original;syncBuiltinESMExports();rmSync(dir,{recursive:true,force:true});}
});
test('configured receiving token requires the hosted demo and a private canonical file',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ql-demo-config-')),file=join(dir,'terminal-token');
  const token='ab'.repeat(32);writeFileSync(file,token+'\n',{mode:0o600});
  const env={HOSTED_ACCOUNTS:'true',HACKATHON_DEMO_ENABLED:'true',DEMO_LIVE_COINOS_TOKEN_FILE:file};
  try{
    const adapter=loadDemoLiveAdapter(env)!;assert.equal(adapter.id,'demo-coinos-pos');assert.equal(adapter.mode,'live');assert.deepEqual(adapter.methods,['lightning']);
    assert.throws(()=>loadDemoLiveAdapter({...env,HACKATHON_DEMO_ENABLED:'false'}));
    assert.throws(()=>loadDemoLiveAdapter({...env,HOSTED_ACCOUNTS:'false'}));
    chmodSync(file,0o644);assert.throws(()=>loadDemoLiveAdapter(env));chmodSync(file,0o600);
    symlinkSync(file,join(dir,'alias'));assert.throws(()=>loadDemoLiveAdapter({...env,DEMO_LIVE_COINOS_TOKEN_FILE:join(dir,'alias')}));
    linkSync(file,join(dir,'hardlink'));assert.throws(()=>loadDemoLiveAdapter(env));rmSync(join(dir,'hardlink'));
    writeFileSync(file,'not-a-terminal-token',{mode:0o600});assert.throws(()=>loadDemoLiveAdapter(env),error=>error instanceof Error&&!error.message.includes(token));
    assert.throws(()=>loadDemoLiveAdapter({...env,DEMO_LIVE_COINOS_TOKEN_FILE:'relative-token'}));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
