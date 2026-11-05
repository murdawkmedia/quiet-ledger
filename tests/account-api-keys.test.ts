import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Store,DomainError,type StoredSession} from '../server/store.js';
import type {ApiScope} from '../server/api-access.js';

const implementation=await import('../server/account-api-keys.js').catch(()=>undefined);
const ready=()=>{assert.ok(implementation,'Account API key management is not implemented.');return implementation;};
const defaults:ApiScope[]=['invoices:read','invoices:write','receiving:read','receiving:write','collateral:read'];
const allScopes:ApiScope[]=[...defaults,'payments:confirm','records:read'];
const start=Date.parse('2026-11-05T06:00:00.000Z');
function fixture(path=':memory:'){
  const api=ready(),store=new Store(path,{encryptionKey:Buffer.alloc(32,17)});let time=start;
  const sessions:Record<string,StoredSession|undefined>={
    a:{role:'owner',workspace:'workspace-a',accountId:'account-a',csrf:'synthetic-csrf-a',expires:new Date(start+365*86400000).toISOString()},
    b:{role:'owner',workspace:'workspace-b',accountId:'account-b',csrf:'synthetic-csrf-b',expires:new Date(start+365*86400000).toISOString()},
    other:{role:'owner',workspace:'workspace-other',accountId:'account-a',csrf:'synthetic-csrf-other',expires:new Date(start+365*86400000).toISOString()},
    demo:{role:'demo',workspace:'demo',csrf:'synthetic-csrf-demo',expires:new Date(start+86400000).toISOString()},
    local:{role:'owner',workspace:'owner',csrf:'synthetic-csrf-local',expires:new Date(start+86400000).toISOString()},
    reserved:{role:'owner',workspace:'owner',accountId:'account-a',csrf:'synthetic-csrf-reserved',expires:new Date(start+86400000).toISOString()},
    expired:{role:'owner',workspace:'workspace-a',accountId:'account-a',csrf:'synthetic-csrf-expired',expires:new Date(start-1).toISOString()},
  };
  const service=api.createAccountApiKeys({store,now:()=>new Date(time),getSession:req=>sessions[req.get('X-Test-Session')??'']});
  const app=express();app.use(express.json());app.use((req,res,next)=>{if(req.get('X-Test-Api-Access'))res.locals.apiAccess={keyId:'synthetic-api'};next();});app.use(service.router);
  app.use((_req,res)=>res.status(404).json({error:'Not found.'}));
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{if(error instanceof DomainError)return res.status(error.status).json({error:error.message});res.status(500).json({error:'Synthetic harness failure.'});});
  const client=(method:'get'|'post'|'delete',path='/api/account/api-keys',who='a')=>{let call=request(app)[method](path).set('X-Test-Session',who);if(sessions[who])call=call.set('X-CSRF-Token',sessions[who]!.csrf);return call;};
  return {app,store,service,client,sessions,setTime:(value:number)=>{time=value;},close:()=>store.close()};
}
const body=(overrides:Record<string,unknown>={})=>({label:'Fictional website key',scopes:defaults,...overrides});

test('account API key manager API is available',()=>{assert.equal(typeof ready().createAccountApiKeys,'function');});

test('created key resolves only to its saved account workspace and explicit scopes',async()=>{
  const f=fixture();try{
    const created=await f.client('post').send(body());assert.equal(created.status,201);assert.match(created.body.key.token,/^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(f.service.resolve(created.body.key.token),{keyId:created.body.key.id,scopes:defaults,workspace:'workspace-a',accountId:'account-a'});
    assert.equal(created.body.key.expiresAt,new Date(start+30*86400000).toISOString());assert.equal(created.body.key.createdAt,new Date(start).toISOString());
    const listing=await f.client('get');assert.equal(listing.status,200);assert.equal(listing.body.keys.length,1);
    assert.equal(listing.body.keys[0].token,undefined);assert.equal(listing.body.keys[0].tokenHash,undefined);assert.equal(listing.body.keys[0].accountId,undefined);assert.equal(listing.body.keys[0].workspace,undefined);
    assert.ok(!JSON.stringify(listing.body).includes(created.body.key.token));assert.match(created.headers['cache-control'],/no-store/);assert.match(listing.headers['cache-control'],/no-store/);
  }finally{f.close();}
});

test('management requires an unexpired tenant owner session and never accepts local owner or demo',async()=>{
  const f=fixture();try{
    assert.equal((await request(f.app).get('/api/account/api-keys')).status,401);
    for(const who of ['demo','local','reserved'])assert.equal((await f.client('get',undefined,who)).status,403);
    f.sessions.malformed={...f.sessions.a!,workspace:undefined} as any;assert.equal((await f.client('get',undefined,'malformed')).status,403);
    assert.equal((await f.client('get',undefined,'expired')).status,401);
    assert.equal((await f.client('post',undefined,'b').unset('X-CSRF-Token').send(body())).status,403);
    assert.equal((await f.client('post').set('X-CSRF-Token','wrong-synthetic-value').send(body())).status,403);
    assert.equal((await f.client('delete','/api/account/api-keys/unknown').unset('X-CSRF-Token')).status,403);
  }finally{f.close();}
});

test('Authorization-bearing requests and API-access markers cannot manage account keys',async()=>{
  const f=fixture();try{
    for(const authorization of ['Bearer '+'x'.repeat(43),'Nostr synthetic','Basic synthetic']){
      assert.equal((await f.client('get').set('Authorization',authorization)).status,403);
      assert.equal((await f.client('post').set('Authorization',authorization).send(body())).status,403);
    }
    assert.equal((await f.client('get').set('X-Test-Api-Access','1')).status,403);
  }finally{f.close();}
});

test('create requires explicit unique known scopes and rejects account privilege injection',async()=>{
  const f=fixture();try{
    for(const value of [{},{scopes:[]},body({scopes:['admin']}),body({scopes:['invoices:read','invoices:read']}),body({scopes:'invoices:read'}),body({workspace:'workspace-b'}),body({accountId:'account-b'}),body({token:'caller-chosen'}),body({label:'x'.repeat(81)}),body({expiresInDays:0}),body({expiresInDays:91}),body({expiresInDays:1.5}),body({expiresInDays:'30'})]){
      assert.equal((await f.client('post').send(value)).status,400);
    }
    const created=await f.client('post').send(body({scopes:allScopes,expiresInDays:90,label:'  Fictional all-scopes key  '}));assert.equal(created.status,201);assert.deepEqual(created.body.key.scopes,allScopes);assert.equal(created.body.key.label,'Fictional all-scopes key');
    assert.equal(created.body.key.expiresAt,new Date(start+90*86400000).toISOString());
  }finally{f.close();}
});

test('token creation has no persisted retry response or repeat-reveal endpoint',async()=>{
  const f=fixture();try{
    assert.equal((await f.client('post').set('Idempotency-Key','fictional-attempt').send(body())).status,400);
    const first=await f.client('post').send(body()),second=await f.client('post').send(body());assert.equal(first.status,201);assert.equal(second.status,201);assert.notEqual(first.body.key.token,second.body.key.token);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM idempotency').get()!.n,0);
    assert.equal((await f.client('get','/api/account/api-keys/'+first.body.key.id)).status,404);
    assert.equal(f.store.audits('workspace-a').filter(event=>event.action==='api_key.created').length,2);
  }finally{f.close();}
});

test('list and revoke are isolated by both account and exact workspace',async()=>{
  const f=fixture();try{
    const created=await f.client('post').send(body());assert.equal(created.status,201);const id=created.body.key.id,token=created.body.key.token;
    for(const who of ['b','other']){
      assert.deepEqual((await f.client('get',undefined,who)).body.keys,[]);
      assert.equal((await f.client('delete','/api/account/api-keys/'+id,who)).status,404);
    }
    assert.ok(f.service.resolve(token));assert.equal((await f.client('delete','/api/account/api-keys/unknown')).status,404);
    assert.equal((await f.client('delete','/api/account/api-keys/'+id)).status,204);assert.equal(f.service.resolve(token),undefined);
    assert.equal((await f.client('delete','/api/account/api-keys/'+id)).status,204);
    const listed=(await f.client('get')).body.keys[0];assert.equal(listed.revokedAt,new Date(start).toISOString());
    assert.equal(f.store.audits('workspace-a').filter(event=>event.action==='api_key.revoked').length,1);
  }finally{f.close();}
});

test('resolve rejects malformed unknown expired and revoked token values',async()=>{
  const f=fixture();try{
    const created=await f.client('post').send(body({expiresInDays:1}));assert.equal(created.status,201);const token=created.body.key.token;
    for(const value of ['',token+'x',token+'\n','x'.repeat(43),'한'.repeat(43),null,undefined,{},'x'.repeat(100000)])assert.equal(f.service.resolve(value as any),undefined);
    f.setTime(start+86400000-1);assert.ok(f.service.resolve(token));f.setTime(start+86400000);assert.equal(f.service.resolve(token),undefined);
  }finally{f.close();}
});

test('active key count is limited to20 and revocation or expiry releases capacity',async()=>{
  const f=fixture();try{
    const ids:string[]=[];for(let i=0;i<20;i++){const created=await f.client('post').send(body({expiresInDays:1}));assert.equal(created.status,201);ids.push(created.body.key.id);}
    assert.equal((await f.client('post').send(body())).status,409);
    assert.equal((await f.client('post',undefined,'other').send(body())).status,409);
    assert.equal((await f.client('delete','/api/account/api-keys/'+ids[0])).status,204);assert.equal((await f.client('post').send(body({expiresInDays:1}))).status,201);
    f.setTime(start+86400000);assert.equal((await f.client('post').send(body())).status,201);
    assert.equal((await f.client('get')).body.keys.length,22);
  }finally{f.close();}
});

test('two service instances enforce the shared active-key cap transactionally',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'fictional-key-cap-')),path=join(dir,'fictional.sqlite');const first=fixture(path),second=fixture(path);
  try{
    for(let i=0;i<19;i++)assert.equal((await first.client('post').send(body())).status,201);
    const attempts=await Promise.all([first.client('post').send(body()),second.client('post').send(body())]);assert.deepEqual(attempts.map(r=>r.status).sort(),[201,409]);
    assert.equal((await second.client('get')).body.keys.length,20);
  }finally{first.close();second.close();rmSync(dir,{recursive:true,force:true});}
});

test('metadata stays encrypted and raw API tokens never enter the database or WAL',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'fictional-key-encryption-')),path=join(dir,'fictional.sqlite');const f=fixture(path);
  try{
    const marker='FICTIONAL_PRIVATE_KEY_LABEL_SENTINEL',created=await f.client('post').send(body({label:marker}));assert.equal(created.status,201);const token=created.body.key.token;
    const rows=f.store.db.prepare('SELECT * FROM account_api_keys').all();assert.equal(rows.length,1);assert.equal(rows[0].token_hash,createHash('sha256').update(token).digest('hex'));assert.match(String(rows[0].data),/^qlr:v1:/);
    for(const file of [path,path+'-wal']){let bytes:Buffer;try{bytes=readFileSync(file);}catch{continue;}assert.ok(!bytes.includes(Buffer.from(token)));assert.ok(!bytes.includes(Buffer.from(marker)));}
    assert.ok(!JSON.stringify(rows).includes(token));
  }finally{f.close();rmSync(dir,{recursive:true,force:true});}
});

test('resolver fails closed if lookup account scope expiry or ciphertext are substituted',async()=>{
  for(const changed of ['workspace','account_id','expires_at','token_hash','data']){
    const f=fixture();try{
      const created=await f.client('post').send(body());assert.equal(created.status,201);const token=created.body.key.token;
      let value=changed==='expires_at'?new Date(start+90*86400000).toISOString():changed==='data'?'{}':'different-value';
      if(changed==='token_hash'){
        const otherToken='a'.repeat(43);value=createHash('sha256').update(otherToken).digest('hex');f.store.db.prepare('UPDATE account_api_keys SET token_hash=? WHERE id=?').run(value,created.body.key.id);assert.equal(f.service.resolve(otherToken),undefined);
      }else{
        f.store.db.prepare('UPDATE account_api_keys SET '+changed+'=? WHERE id=?').run(value,created.body.key.id);assert.equal(f.service.resolve(token),undefined);
      }
    }finally{f.close();}
  }
});

test('key metadata and revocation survive reopening with the external storage key',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'fictional-key-restart-')),path=join(dir,'fictional.sqlite');let f=fixture(path);
  try{
    const created=await f.client('post').send(body());assert.equal(created.status,201);const token=created.body.key.token;f.close();f=fixture(path);
    assert.ok(f.service.resolve(token));assert.equal((await f.client('delete','/api/account/api-keys/'+created.body.key.id)).status,204);f.close();f=fixture(path);assert.equal(f.service.resolve(token),undefined);
  }finally{f.close();rmSync(dir,{recursive:true,force:true});}
});

test('list pagination is bounded stable and cannot use a foreign account cursor',async()=>{
  const f=fixture();try{
    const ids:string[]=[];for(let i=0;i<5;i++){const result=await f.client('post').send(body());assert.equal(result.status,201);ids.push(result.body.key.id);}
    const first=await f.client('get','/api/account/api-keys?limit=2');assert.equal(first.status,200);assert.deepEqual(first.body.keys.map((k:any)=>k.id),ids.slice(-2).reverse());assert.equal(typeof first.body.nextCursor,'string');
    assert.equal((await f.client('post').send(body())).status,201);
    const second=await f.client('get','/api/account/api-keys?limit=2&cursor='+encodeURIComponent(first.body.nextCursor));assert.equal(second.status,200);assert.deepEqual(second.body.keys.map((k:any)=>k.id),ids.slice(1,3).reverse());
    assert.equal((await f.client('get','/api/account/api-keys?cursor='+encodeURIComponent(first.body.nextCursor),'b')).status,400);
    for(const query of ['limit=0','limit=101','limit=1.5','limit=01','limit=2&limit=3','cursor=invalid','unexpected=field'])assert.equal((await f.client('get','/api/account/api-keys?'+query)).status,400);
  }finally{f.close();}
});
