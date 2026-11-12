import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {createApiAccess,type ApiScope} from '../server/api-access.js';
import {ACCOUNT_API_SCOPES,DEFAULT_ACCOUNT_API_SCOPES,createAccountApiKeys} from '../server/account-api-keys.js';
import {Store,DomainError,type StoredSession} from '../server/store.js';

// Fictional credentials and memory-only stores. This checks permission wiring,
// not the event router, a production account or real external automation.
const token='fictional-events-read-api-key-000000000000';
const auth=`Bearer ${token}`;
const eventScope='events:read' as ApiScope;
function appFor(scopes:ApiScope[]){
 const app=express();app.use(createApiAccess({keys:[{token,scopes}]}));
 app.use((_req,res)=>res.locals.apiAccess?res.json({access:res.locals.apiAccess}):res.status(401).json({error:'unauthorized'}));
 return app;
}

test('event feed bearer access needs the dedicated scope and rewrites only the exact version alias',async()=>{
 const app=appFor([eventScope]);
 for(const path of ['/api/v1/invoice-events','/api/invoice-events','/api/v1/invoice-events?limit=1&cursor=opaque_cursor']){
  const res=await request(app).get(path).set('Authorization',auth).expect(200);
  assert.deepEqual(res.body.access.scopes,['events:read']);assert.ok(!JSON.stringify(res.body).includes(token));
 }
 await request(app).get('/api/v1/invoice-events').expect(401);
 for(const path of ['/api/v1/invoices','/api/v1/receiving','/api/v1/evidence/export','/api/v1/invoice-events/private'])await request(app).get(path).set('Authorization',auth).expect(403);
 for(const method of ['post','put','patch','delete','head'] as const)await request(app)[method]('/api/v1/invoice-events').set('Authorization',auth).expect(403);
 for(const path of ['/api/v1/invoice-events?workspace=other','/api/v1/invoice-events?limit=1&limit=2','/api/v1/Invoice-events','/api/v1/invoice-events?limit=101'])await request(app).get(path).set('Authorization',auth).expect(403);
});

test('invoice, records and default API keys do not implicitly gain the event feed',async()=>{
 for(const scopes of [['invoices:read'],['records:read'],[...DEFAULT_ACCOUNT_API_SCOPES]] as ApiScope[][]){
  await request(appFor(scopes)).get('/api/v1/invoice-events').set('Authorization',auth).expect(403);
 }
 assert.ok(!DEFAULT_ACCOUNT_API_SCOPES.includes(eventScope));
 assert.ok((ACCOUNT_API_SCOPES as readonly string[]).includes('events:read'));
});

test('an owner can explicitly create and revoke an events-only account API key',async()=>{
 const store=new Store(':memory:',{encryptionKey:Buffer.alloc(32,73)}),now=new Date('2026-11-08T12:00:00.000Z');
 const session:StoredSession={role:'owner',workspace:'fictional-events-workspace',accountId:'fictional-events-owner',csrf:'fictional-csrf',expires:'2026-11-09T12:00:00.000Z'};
 const keys=createAccountApiKeys({store,now:()=>now,getSession:()=>session});
 const app=express();app.use(express.json());app.use(keys.router);
 app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error instanceof DomainError?error.status:500).json({error:error instanceof DomainError?error.message:'Fixture failure'}));
 try{
  const created=await request(app).post('/api/account/api-keys').set('X-CSRF-Token',session.csrf).send({label:'Fictional accounting feed',scopes:['events:read']}).expect(201);
  const resolved=keys.resolve(created.body.key.token)!;
  assert.deepEqual(resolved.scopes,['events:read']);assert.equal(resolved.workspace,session.workspace);
  const list=await request(app).get('/api/account/api-keys').expect(200);
  assert.ok(!JSON.stringify(list.body).includes(created.body.key.token));
  await request(app).delete(`/api/account/api-keys/${created.body.key.id}`).set('X-CSRF-Token',session.csrf).expect(204);
  assert.equal(keys.resolve(created.body.key.token),undefined);
 }finally{store.close();}
});
