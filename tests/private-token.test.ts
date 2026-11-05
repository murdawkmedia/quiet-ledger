import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,statSync,chmodSync,symlinkSync,linkSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadOrCreatePrivateToken} from '../server/private-token.js';

const syntheticToken='synthetic-private-token-value-for-tests-only';
function fixture(run:(directory:string,path:string)=>void){const directory=mkdtempSync(join(tmpdir(),'ledger-token-'));try{run(directory,join(directory,'token'));}finally{rmSync(directory,{recursive:true,force:true});}}
function rejectsPrivately(path:string){assert.throws(()=>loadOrCreatePrivateToken(path),error=>error instanceof Error&&error.message==='Private access token file is invalid or unavailable.');}

test('startup token creation is private, random and stable across repeated loads',()=>fixture((_directory,path)=>{
  const value=loadOrCreatePrivateToken(path);
  assert.match(value,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(statSync(path).mode&0o777,0o600);
  assert.equal(loadOrCreatePrivateToken(path),value);
  assert.equal(readFileSync(path,'utf8'),value+'\n');
}));

test('existing valid token is preserved byte for byte without rotation',()=>fixture((_directory,path)=>{
  writeFileSync(path,syntheticToken+'\r\n',{mode:0o600});
  assert.equal(loadOrCreatePrivateToken(path),syntheticToken);
  assert.equal(readFileSync(path,'utf8'),syntheticToken+'\r\n');
}));

test('token loader refuses a symlink without changing its target permissions or bytes',()=>fixture((directory,path)=>{
  const target=join(directory,'unrelated-target');writeFileSync(target,syntheticToken,{mode:0o644});symlinkSync(target,path);
  rejectsPrivately(path);assert.equal(statSync(target).mode&0o777,0o644);assert.equal(readFileSync(target,'utf8'),syntheticToken);
}));

test('token loader refuses hardlinks without modifying the original',()=>fixture((directory,path)=>{
  const target=join(directory,'original');writeFileSync(target,syntheticToken,{mode:0o600});linkSync(target,path);
  rejectsPrivately(path);assert.equal(readFileSync(target,'utf8'),syntheticToken);assert.equal(statSync(target).nlink,2);
}));

test('token loader rejects unsafe permissions instead of silently chmodding',()=>fixture((_directory,path)=>{
  writeFileSync(path,syntheticToken,{mode:0o644});rejectsPrivately(path);assert.equal(statSync(path).mode&0o777,0o644);
  chmodSync(path,0o400);rejectsPrivately(path);assert.equal(statSync(path).mode&0o777,0o400);
}));

test('token loader rejects malformed, oversized and whitespace-bearing contents without exposing them',()=>fixture((_directory,path)=>{
  for(const value of ['short','s'.repeat(515),' '+syntheticToken,syntheticToken+'\n\n',syntheticToken+'\t',syntheticToken+'é']){
    writeFileSync(path,value,{mode:0o600});chmodSync(path,0o600);rejectsPrivately(path);assert.equal(readFileSync(path,'utf8'),value);
  }
}));

test('token loader rejects a directory without replacing it',()=>fixture((_directory,path)=>{
  mkdirSync(path,{mode:0o700});rejectsPrivately(path);assert.equal(statSync(path).isDirectory(),true);
}));

test('token loader rejects a FIFO without blocking',()=>fixture((_directory,path)=>{
  const result=spawnSync('mkfifo',['-m','600',path],{timeout:2000});assert.equal(result.status,0);
  const started=Date.now();rejectsPrivately(path);assert.ok(Date.now()-started<1000);
}));
