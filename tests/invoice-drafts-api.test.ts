import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {Store} from '../server/store.js';
import type {InvoiceEditorSnapshot} from '../shared/invoice-editor-drafts.js';

/**
 * Actual-app checks for private invoice editor drafts through the real
 * createApp middleware chain (sessions, same-origin CSRF, idempotency).
 * All data is fictional; no provider or payment is contacted.
 */
const ownerToken='fictional-drafts-browser-owner',apiToken='fictional-drafts-api-token-at-least-32';
const now=()=>new Date('2026-11-11T12:00:00Z');
const snapshot=(over:Partial<InvoiceEditorSnapshot>={}):InvoiceEditorSnapshot=>({
  version:1,customerName:'Fictional API Studio',customerEmail:'',title:'Fictional API monthly service',issueDate:'2026-11-11',dueDate:'',
  currency:'CAD',tax:'5',discount:'0',premium:'0',note:'',lines:[{id:'line-1',description:'Fictional API labour',quantity:'1',price:'100.00',kind:'service',adjustmentEligible:true}],
  schedule:'30',customDays:'',paymentTerms:'',allMethods:true,accepted:[],methodRules:[],clientId:'',billing:{},carriedLineIds:[],...over});
const invoice={customerName:'Fictional API Studio',title:'Fictional API monthly service',currency:'CAD',items:[{description:'Fictional API labour',quantity:1,unitAmount:10000,kind:'service',adjustmentEligible:true}],paymentTermDays:30,taxBps:500};

async function owner(app:ReturnType<typeof createApp>){
  const agent=request.agent(app),login=await agent.post('/api/session/owner').send({token:ownerToken}).expect(200);
  return {agent,csrf:login.body.csrfToken as string,
    put:(path:string,body:object)=>agent.put(path).set('X-CSRF-Token',login.body.csrfToken).send(body),
    post:(path:string,body:object,key:string=randomUUID())=>agent.post(path).set('X-CSRF-Token',login.body.csrfToken).set('Idempotency-Key',key).send(body),
    del:(path:string)=>agent.delete(path).set('X-CSRF-Token',login.body.csrfToken)};
}

test('actual app owner draft flow: save without issuing, then issue exactly once',async()=>{
  const app=createApp({dbPath:':memory:',ownerToken,now});try{
  const user=await owner(app),id=randomUUID();
  // The route is really mounted behind the browser authorization boundary.
  assert.notEqual((await request(app).get('/api/invoice-drafts')).status,404);
  const saved=await user.put('/api/invoice-drafts/'+id,{expectedRevision:0,snapshot:snapshot()}).expect(200);
  assert.equal(saved.body.draft.revision,1);
  assert.equal((await user.agent.get('/api/invoices').expect(200)).body.invoices.length,0);
  // Debounced autosave-style second save with a changed title advances the revision.
  const second=await user.put('/api/invoice-drafts/'+id,{expectedRevision:1,snapshot:snapshot({title:'Fictional reviewed API title'})}).expect(200);
  assert.equal(second.body.draft.revision,2);
  assert.deepEqual((await user.put('/api/invoice-drafts/'+id,{expectedRevision:1,snapshot:snapshot({title:'Fictional reviewed API title'})})).body,second.body);
  const list=(await user.agent.get('/api/invoice-drafts').expect(200)).body.drafts;
  assert.equal(list.length,1);assert.equal(list[0].id,id);assert(!('snapshot'in list[0]));
  const fetched=(await user.agent.get('/api/invoice-drafts/'+id).expect(200)).body.draft;
  assert.equal(fetched.snapshot.title,'Fictional reviewed API title');
  const issued=await user.post('/api/invoice-drafts/'+id+'/issue',{expectedRevision:2,invoice},'fictional-api-issue').expect(201);
  assert.equal(issued.body.invoice.number,'QL-0001');assert.equal(issued.body.draft.status,'issued');
  // New-key retry of the same payload returns the identical invoice.
  const retried=await user.post('/api/invoice-drafts/'+id+'/issue',{expectedRevision:2,invoice},'fictional-api-issue-retry').expect(201);
  assert.deepEqual(retried.body,issued.body);
  assert.equal((await user.agent.get('/api/invoices').expect(200)).body.invoices.length,1);
  await user.post('/api/invoice-drafts/'+id+'/issue',{expectedRevision:2,invoice:{...invoice,title:'Changed after issue'}},'fictional-api-changed').expect(409);
  await user.put('/api/invoice-drafts/'+id,{expectedRevision:2,snapshot:snapshot({title:'Edit after issue'})}).expect(409);
  await user.del('/api/invoice-drafts/'+id).expect(409);
  // Duplicate source read stays owner-scoped: the issued invoice is readable only in this workspace.
  const invoiceId=issued.body.invoice.id;
  assert.equal((await user.agent.get('/api/invoices/'+invoiceId).expect(200)).body.id,invoiceId);
  }finally{app.locals.close();}
});

test('actual app draft routes reject anonymous, demo, API-key, missing-CSRF and invalid input',async()=>{
  const app=createApp({dbPath:':memory:',ownerToken,now,apiKeys:[{token:apiToken,scopes:['invoices:read','invoices:write','records:read']}]});try{
  await request(app).get('/api/invoice-drafts').expect(401);
  await request(app).put('/api/invoice-drafts/'+randomUUID()).send({expectedRevision:0,snapshot:snapshot()}).expect(401);
  const user=await owner(app);
  await user.agent.put('/api/invoice-drafts/'+randomUUID()).send({expectedRevision:0,snapshot:snapshot()}).expect(403); // missing CSRF
  const demo=request.agent(app),login=await demo.post('/api/session/demo').send({}).expect(200);
  for(const path of ['/api/invoice-drafts','/api/invoice-drafts/'+randomUUID()])await demo.get(path).expect(403);
  await demo.put('/api/invoice-drafts/'+randomUUID()).send({expectedRevision:0,snapshot:snapshot()}).set('X-CSRF-Token',login.body.csrfToken).expect(403);
  for(const prefix of ['/api','/api/v1']){
    await request(app).get(prefix+'/invoice-drafts').set('Authorization','Bearer '+apiToken).expect(403);
    await request(app).put(prefix+'/invoice-drafts/'+randomUUID()).send({expectedRevision:0,snapshot:snapshot()}).set('Authorization','Bearer '+apiToken).expect(403);
    await request(app).post(prefix+'/invoice-drafts/'+randomUUID()+'/issue').send({expectedRevision:0,invoice}).set('Authorization','Bearer '+apiToken).set('Idempotency-Key','api-key-issue').expect(403);
  }
  await user.put('/api/invoice-drafts/not-a-uuid',{expectedRevision:0,snapshot:snapshot()}).expect(400);
  await user.put('/api/invoice-drafts/'+randomUUID(),{expectedRevision:0,snapshot:{version:9}}).expect(400);
  await user.post('/api/invoice-drafts/'+randomUUID()+'/issue',{expectedRevision:0,invoice},'').expect(400);
  await user.post('/api/invoice-drafts/'+randomUUID()+'/issue',{expectedRevision:0,invoice},'invalid key with spaces').expect(400);
  assert.equal((await user.agent.get('/api/invoice-drafts').expect(200)).body.drafts.length,0);
  }finally{app.locals.close();}
});

test('encrypted actual app workspaces cannot see, save or issue another owner drafts',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'fictional-drafts-api-')),dbPath=join(dir,'fixture.sqlite'),encryptionKey=Buffer.alloc(32,59);
  const publicOrigin='http://localhost:4367',proxySecret='fictional-drafts-proxy-secret-at-least32';
  const app=createApp({dbPath:dbPath,encryptionKey,now,hosted:{publicOrigin,proxySecret,allowInsecureLoopback:true}});
  const store=new Store(dbPath,{encryptionKey});
  function actor(){
    const token=randomBytes(32).toString('base64url'),workspace=randomUUID(),csrf=randomUUID();
    store.saveSession(token,{role:'owner',workspace,accountId:randomUUID(),csrf,expires:'2027-01-01T00:00:00Z'});
    const headers={'x-quiet-ledger-proxy':proxySecret,Cookie:'ql_session='+token,'X-CSRF-Token':csrf,Origin:publicOrigin};
    return {get:(path:string)=>request(app).get(path).set(headers),
      put:(path:string,body:object)=>request(app).put(path).set(headers).send(body),
      del:(path:string)=>request(app).delete(path).set(headers),
      post:(path:string,body:object)=>request(app).post(path).set(headers).set('Idempotency-Key',randomUUID()).send(body)};
  }
  try{
  const a=actor(),b=actor(),id=randomUUID();
  const saved=await a.put('/api/invoice-drafts/'+id,{expectedRevision:0,snapshot:snapshot({title:'Fictional tenant A draft'})}).expect(200);
  assert.equal(saved.body.draft.revision,1);
  await b.get('/api/invoice-drafts/'+id).expect(404);
  await b.put('/api/invoice-drafts/'+id,{expectedRevision:1,snapshot:snapshot({title:'Fictional tenant B overwrite'})}).expect(404);
  await b.del('/api/invoice-drafts/'+id).expect(404);
  await b.post('/api/invoice-drafts/'+id+'/issue',{expectedRevision:1,invoice}).expect(404);
  assert.equal((await b.get('/api/invoice-drafts').expect(200)).body.drafts.length,0);
  assert.equal((await a.get('/api/invoice-drafts/'+id).expect(200)).body.draft.snapshot.title,'Fictional tenant A draft');
  }finally{store.close();app.locals.close();rmSync(dir,{recursive:true,force:true});}
});
