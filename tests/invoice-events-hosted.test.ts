import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {Store} from '../server/store.js';

// Two fictional hosted workspaces in an isolated encrypted database. Existing
// proxy/session/key middleware is real; no real accounts or bank calls occur.
const secret='fictional-event-feed-proxy-secret-at-least32';
const key=Buffer.alloc(32,61),origin='http://localhost:4349';
const now=()=>new Date('2026-11-08T12:00:00.000Z');

test('hosted application binds event keys and cursors to each real session workspace and honors revocation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ql-event-hosted-')),dbPath=join(dir,'fictional.sqlite');
 const app=createApp({dbPath,encryptionKey:key,now,hosted:{publicOrigin:origin,proxySecret:secret,allowInsecureLoopback:true},receivingQuote:async invoice=>({expectedAtomic:String(invoice.total),cadEquivalent:invoice.total,source:'Fictional exact CAD quote',observedAt:now().toISOString()})});
 const store=new Store(dbPath,{encryptionKey:key});
 function actor(){
  const accountId=randomUUID(),workspace=randomUUID(),token=randomBytes(32).toString('base64url'),csrf=randomUUID();
  store.saveSession(token,{role:'owner',accountId,workspace,csrf,expires:'2026-11-09T12:00:00.000Z'});
  const headers={'x-quiet-ledger-proxy':secret,Cookie:'ql_session='+token,'X-CSRF-Token':csrf,Origin:origin};
  return {workspace,headers,get:(path:string)=>request(app).get(path).set(headers),post:(path:string,body:object)=>request(app).post(path).set(headers).set('Idempotency-Key',randomUUID()).send(body),newKey:(scopes:string[])=>request(app).post('/api/account/api-keys').set(headers).send({label:'Fictional accounting feed',scopes})};
 }
 const feed=(token:string,cursor?:string)=>request(app).get('/api/v1/invoice-events').set('x-quiet-ledger-proxy',secret).set('Authorization','Bearer '+token).query(cursor?{cursor}:{});
 try{
  const a=actor(),b=actor();
  const aKey=(await a.newKey(['events:read']).expect(201)).body.key;
  const bKey=(await b.newKey(['events:read']).expect(201)).body.key;
  const limitedKey=(await b.newKey(['invoices:read']).expect(201)).body.key;
  const emptyA=(await feed(aKey.token).expect(200)).body,emptyB=(await feed(bKey.token).expect(200)).body;
  assert.notEqual(emptyA.nextCursor,emptyB.nextCursor);
  const invoice=(await a.post('/api/invoices',{customerName:'Fictional hosted client',title:'Fictional hosted bank receipt',currency:'CAD',items:[{description:'Fictional service',quantity:1,unitAmount:125}],acceptedMethods:['interac']}).expect(201)).body;
  const receive=(await a.post('/api/receiving',{invoiceId:invoice.id,method:'interac',adapterId:'owner-confirmed-manual'}).expect(201)).body.request;
  await a.post(`/api/receiving/${receive.id}/confirm`,{transactionId:'fictional-bank-reference',note:'Fictional controlled owner-reviewed receipt; no bank was contacted.'}).expect(200);
  const events=(await feed(aKey.token,emptyA.nextCursor).expect(200)).body;
  assert.deepEqual(events.events.map((event:any)=>event.type),['payment.received','invoice.paid']);
  assert.equal(events.events[0].payment.verification,'manual');
  assert.deepEqual((await feed(bKey.token,emptyB.nextCursor).expect(200)).body.events,[]);
  await feed(bKey.token,events.nextCursor).expect(400);
  await feed(limitedKey.token).expect(403);
  await b.get('/api/invoice-events?workspace='+a.workspace).expect(400);
  await request(app).get('/api/v1/invoice-events').set('x-quiet-ledger-proxy',secret).set('Authorization','Bearer '+bKey.token).query({workspace:a.workspace}).expect(403);
  const cookiePage=(await a.get('/api/invoice-events').expect(200)).body;assert.deepEqual(cookiePage.events,events.events);
  for(const field of [invoice.token,invoice.customerName,receive.token,'fictional-bank-reference'])assert.ok(!JSON.stringify(events).includes(field));
  await request(app).delete('/api/account/api-keys/'+aKey.id).set(a.headers).expect(204);
  await feed(aKey.token).expect(401);
 }finally{store.close();await app.locals.closeAsync();rmSync(dir,{recursive:true,force:true});}
});
