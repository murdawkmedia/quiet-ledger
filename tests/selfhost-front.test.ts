import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import request from 'supertest';
import express from 'express';
import {finalizeEvent,getPublicKey} from 'nostr-tools/pure';
import {createApp} from '../server/app.js';
import {Store} from '../server/store.js';
import {createSelfHostFrontend} from '../server/selfhost-front.js';

const origin='http://localhost:4417',proxy='synthetic-selfhost-proxy-secret-at-least32-bytes',key=Buffer.alloc(32,17);
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'ql-selfhost-front-')),client=join(dir,'client'),data=join(dir,'data');mkdirSync(client,{mode:0o700});mkdirSync(data,{mode:0o700});
 writeFileSync(join(client,'index.html'),'<!doctype html><title>Fictional self-host build</title><div id="root"></div>');writeFileSync(join(client,'asset.js'),'window.fictionalSelfhost=true;');
 const db=join(data,'ledger.sqlite');const api=createApp({dbPath:db,encryptionKey:key,hosted:{publicOrigin:origin,proxySecret:proxy,allowInsecureLoopback:true}});
 const app=createSelfHostFrontend(api,{clientDir:client,proxySecret:proxy,publicOrigin:origin}),store=new Store(db,{encryptionKey:key});
 return {dir,client,data,db,api,app,store,close(){store.close();api.locals.close();rmSync(dir,{recursive:true,force:true});}};
}
async function signup(f:ReturnType<typeof fixture>){
 const key=new Uint8Array(32);key[31]=67;const challenge=await request(f.app).post('/api/auth/nostr/challenge').set('Origin',origin).send({action:'register',pubkey:getPublicKey(key),displayName:'Fictional standalone account'});assert.equal(challenge.status,200);
 const body=JSON.stringify(challenge.body.payload),event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',challenge.body.verifyUrl],['method','POST'],['payload',createHash('sha256').update(body).digest('hex')]]},key);
 const cookie=String(challenge.headers['set-cookie'][0]).split(';')[0];
 const response=await request(f.app).post('/api/auth/nostr/verify').set('Origin',origin).set('Cookie',cookie).set('Content-Type','application/json').set('Authorization','Nostr '+Buffer.from(JSON.stringify(event)).toString('base64')).send(body);assert.equal(response.status,200);
 return {cookie:String((response.headers['set-cookie'] as unknown as string[]).find(value=>value.startsWith('ql_session='))).split(';')[0],csrf:response.body.csrfToken,accountId:response.body.accountId};
}
test('standalone front serves built routes/assets and securely delegates account API without a vendor proxy',async()=>{
 const f=fixture();try{
  const home=await request(f.app).get('/');assert.equal(home.status,200);assert.match(home.text,/Fictional self-host build/);assert.match(home.headers['content-security-policy'],/connect-src 'self'/);assert.match(home.headers['content-security-policy'],/frame-ancestors 'none'/);assert.equal(home.headers['referrer-policy'],'no-referrer');assert.equal(home.headers['cache-control'],'no-store');
  assert.equal((await request(f.app).get('/conversations')).status,200);assert.equal((await request(f.app).get('/asset.js')).status,200);
  const health=await request(f.app).get('/api/health').set('x-quiet-ledger-proxy','attacker-supplied').set('x-quiet-ledger-client-ip','203.0.113.66');assert.equal(health.status,200);assert.equal(health.body.authMode,'hosted');assert(!JSON.stringify(health.headers).includes(proxy));
  assert.equal((await request(f.api).get('/api/health')).status,403);assert.equal((await request(f.app).get('/api/nonexistent')).status,401);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM auth_accounts').get()!.n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM invoices').get()!.n,0);
  for(const path of ['/.env','/server/index.ts','/data/ledger.sqlite','/secrets/storage-key'])assert.equal((await request(f.app).get(path)).status,404,path);
 }finally{f.close();}
});
test('actual standalone signup creates private records, preserves CSRF/origin and stores no plaintext invoice',async()=>{
 const f=fixture();try{
  const actor=await signup(f);const input={customerName:'SYNTHETIC_STANDALONE_CUSTOMER_8842',title:'Fictional self-host invoice',currency:'CAD',items:[{description:'Synthetic private workshop',quantity:1,unitAmount:12500}]};
  const path='/api/invoices';assert.equal((await request(f.app).post(path).set('Cookie',actor.cookie).set('Origin',origin).send(input)).status,403);
  assert.equal((await request(f.app).post(path).set('Cookie',actor.cookie).set('Origin','https://other.example').set('X-CSRF-Token',actor.csrf).send(input)).status,403);
  const made=await request(f.app).post(path).set('Cookie',actor.cookie).set('Origin',origin).set('X-CSRF-Token',actor.csrf).set('Idempotency-Key',randomUUID()).send(input);assert.equal(made.status,201);
  assert.equal((await request(f.app).get('/api/invoices').set('Cookie',actor.cookie)).body.invoices.length,1);
  assert.equal((await request(f.app).get('/api/invoices')).status,401);
  f.store.db.exec('PRAGMA wal_checkpoint(FULL)');assert(!readFileSync(f.db).includes(Buffer.from(input.customerName)));assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE data LIKE 'qlr:v1:%'").get()!.n,1);
 }finally{f.close();}
});
test('frontend trusts socket IP only and exposes the same sanitizer for upgrade handlers',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ql-selfhost-sanitize-'));try{
  writeFileSync(join(dir,'index.html'),'<!doctype html>');const api=express();api.get('/api/probe',(req,res)=>res.json({ip:req.headers['x-quiet-ledger-client-ip'],proxy:req.headers['x-quiet-ledger-proxy'],forwarded:req.headers['x-forwarded-for']}));const front=createSelfHostFrontend(api,{clientDir:dir,proxySecret:proxy,publicOrigin:origin});
  const response=await request(front).get('/api/probe').set('x-quiet-ledger-client-ip','203.0.113.66').set('x-forwarded-for','203.0.113.67').set('x-quiet-ledger-proxy','wrong');assert.equal(response.status,200);assert(!['203.0.113.66','203.0.113.67'].includes(response.body.ip));assert.equal(response.body.proxy,proxy);assert.equal(response.body.forwarded,undefined);
  const upgrade={headers:{'x-forwarded-for':'203.0.113.66','x-quiet-ledger-client-ip':'203.0.113.66'},socket:{remoteAddress:'127.0.0.9'}};front.locals.prepareUpgradeRequest(upgrade);assert.equal(upgrade.headers['x-quiet-ledger-client-ip'],'127.0.0.9');assert.equal(upgrade.headers['x-forwarded-for'],undefined);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('frontend refuses a symlinked build directory and never serves a build symlink to private data',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ql-selfhost-static-'));try{
  const client=join(dir,'client');mkdirSync(client);writeFileSync(join(client,'index.html'),'<!doctype html>');const alias=join(dir,'alias');symlinkSync(client,alias);assert.throws(()=>createSelfHostFrontend(express(),{clientDir:alias,proxySecret:proxy,publicOrigin:origin}));
  writeFileSync(join(dir,'private-key'),'synthetic-not-a-real-secret');symlinkSync(join(dir,'private-key'),join(client,'asset.js'));assert.throws(()=>createSelfHostFrontend(express(),{clientDir:client,proxySecret:proxy,publicOrigin:origin}));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
