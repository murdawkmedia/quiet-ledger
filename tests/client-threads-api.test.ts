import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.js';
import {Store} from '../server/store.js';

const origin='https://fictional-threads.example',proxy='fictional-thread-proxy-key-at-least32characters';
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'ql-client-threads-')),path=join(dir,'ledger.sqlite'),key=Buffer.alloc(32,72);
 const app=createApp({dbPath:path,encryptionKey:key,hosted:{publicOrigin:origin,proxySecret:proxy,hackathonDemo:true},now:()=>new Date('2026-11-06T12:00:00Z')});
 const store=new Store(path,{encryptionKey:key});
 const owner=()=>{const token=randomBytes(32).toString('base64url'),csrf=randomUUID();store.saveSession(token,{role:'owner',workspace:randomUUID(),accountId:randomUUID(),csrf,expires:'2026-12-01T00:00:00Z'});return{Cookie:'ql_session='+token,'X-CSRF-Token':csrf};};
 const get=(url:string,headers={})=>request(app).get(url).set({...headers,Origin:origin,'x-quiet-ledger-proxy':proxy});
 const post=(url:string,body:object,headers={},id=randomUUID())=>request(app).post(url).set({...headers,Origin:origin,'x-quiet-ledger-proxy':proxy,'Idempotency-Key':id}).send(body);
 const del=(url:string,headers={})=>request(app).delete(url).set({...headers,Origin:origin,'x-quiet-ledger-proxy':proxy});
 const invoice=(headers:ReturnType<typeof owner>)=>post('/api/invoices',{customerName:'Fictional client',title:'Fictional video editing',currency:'CAD',items:[{description:'Editing',quantity:1,unitAmount:10000}]},headers);
 return{app,store,owner,get,post,del,invoice,close(){store.close();app.locals.close();rmSync(dir,{recursive:true,force:true});}};
}

test('private clients persist with workspace isolation, CSRF and strict ownership',async()=>{
 const f=fixture();try{
  const a=f.owner(),b=f.owner();
  assert.equal((await f.get('/api/clients')).status,401);
  const saved=await f.post('/api/clients',{name:'Fictional client',email:'client@example.test',currency:'KRW'},a);
  assert.equal(saved.status,201);assert.equal(saved.body.client.currency,'KRW');
  assert.equal((await f.get('/api/clients',a)).body.clients.length,1);
  assert.equal((await f.get('/api/clients',b)).body.clients.length,0);
  assert.equal((await f.post('/api/clients',{name:'No token'},{Cookie:a.Cookie})).status,403);
  assert.equal((await f.post('/api/clients',{name:'Injected',workspace:'other'},a)).status,400);
  assert.equal((await f.post('/api/clients',{id:saved.body.client.id,name:'Overwrite'},b)).status,404);
  assert.equal((await f.del('/api/clients/'+saved.body.client.id,b)).status,404);
  assert.equal((await f.del('/api/clients/'+saved.body.client.id,a)).status,200);
 }finally{f.close();}
});

test('invoice threads keep private notes scoped, idempotent and separate from settlement',async()=>{
 const f=fixture();try{
  const a=f.owner(),b=f.owner(),issued=await f.invoice(a),id=issued.body.id,endpoint='/api/invoices/'+id+'/thread';
  assert.equal(issued.status,201);
  assert.equal((await f.get(endpoint,a)).status,404);
  assert.equal((await f.post(endpoint,{},a)).status,200);
  assert.equal((await f.get(endpoint,a)).status,200);
  assert.equal((await f.get(endpoint,b)).status,404);
  const body={text:'Fictional private note\nConfirm the editing dates.'},key=randomUUID();
  const first=await f.post(endpoint+'/messages',body,a,key);assert.equal(first.status,201);
  assert.equal(first.body.message.channel,'dashboard');assert.equal(first.body.message.direction,'internal');
  assert.equal((await f.post(endpoint+'/messages',body,a,key)).body.message.id,first.body.message.id);
  assert.equal((await f.post(endpoint+'/messages',{text:'Changed'},a,key)).status,409);
  assert.equal((await f.get(endpoint,a)).body.messages.length,1);
  assert.equal((await f.post(endpoint+'/messages',{text:'spoof',channel:'email',direction:'inbound',author:'Client'},a)).status,400);
  assert.equal((await f.post(endpoint+'/messages',body,b)).status,404);
  assert.equal((await f.post(endpoint+'/messages',body,{Cookie:a.Cookie})).status,403);
  assert.equal((await f.get(endpoint+'?limit=0',a)).status,400);
  assert.equal((await f.get('/api/dashboard',a)).body.invoices.find((v:{id:string})=>v.id===id).status,'open');
 }finally{f.close();}
});

test('fictional demo cannot enter real clients or invoice thread routes',async()=>{
 const f=fixture();try{
  const owner=f.owner(),issued=await f.invoice(owner),login=await f.post('/api/session/hackathon-demo',{password:'marmot'});
  const demo={Cookie:String(login.headers['set-cookie'][0]).split(';')[0],'X-CSRF-Token':login.body.csrfToken};
  assert.equal((await f.get('/api/clients',demo)).status,403);
  assert.equal((await f.post('/api/clients',{name:'Fictional prohibited client'},demo)).status,403);
  assert.equal((await f.get('/api/invoices/'+issued.body.id+'/thread',demo)).status,403);
  assert.equal((await f.post('/api/invoices/'+issued.body.id+'/thread',{},demo)).status,403);
  assert.equal((await f.post('/api/invoices/'+issued.body.id+'/thread/messages',{text:'No access'},demo)).status,403);
 }finally{f.close();}
});
