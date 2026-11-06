import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from '../server/store.js';
import {createApp} from '../server/app.js';
const ownerToken='fictional-recurring-browser-owner',apiToken='fictional-recurring-api-token-at-least-32';
const draft={customerName:'Fictional recurring customer',title:'Fictional monthly service',currency:'CAD',items:[{description:'Fictional service',quantity:1,unitAmount:12000}],paymentTermDays:30,paymentTerms:'Fictional terms'};
const clock=()=>new Date('2026-11-06T12:00:00Z');
async function owner(app:ReturnType<typeof createApp>){const agent=request.agent(app),login=await agent.post('/api/session/owner').send({token:ownerToken}).expect(200);return {agent,csrf:login.body.csrfToken,post:(path:string,body:object={},key:string=randomUUID())=>agent.post(path).set('X-CSRF-Token',login.body.csrfToken).set('Idempotency-Key',key).send(body)};}

test('actual app recurring owner flow prepares monthly drafts then issues exactly once',async()=>{
 const app=createApp({dbPath:':memory:',ownerToken,now:clock});try{const user=await owner(app),template=(await user.post('/api/invoice-templates',{label:'Fictional recurring template',draft}).expect(201)).body.template;
 const plan=(await user.post('/api/recurring/plans',{templateId:template.id,label:'Fictional retainers',startDate:'2026-09-30',frequency:{type:'monthly'}}).expect(201)).body.plan;assert.equal(plan.dueOffsetDays,30);
 const before=(await user.agent.get('/api/invoices').expect(200)).body.invoices.length;
 const prepared=(await user.post('/api/recurring/prepare',{},'fictional-api-prepare').expect(200)).body;assert.equal(prepared.createdCount,2);assert.equal((await user.agent.get('/api/invoices')).body.invoices.length,before);
 const record=prepared.drafts.find((row:any)=>row.periodDate==='2026-10-30');assert.equal(record.draft.dueDate,'2026-11-29');assert.deepEqual((await user.agent.get('/api/recurring/drafts/'+record.id).expect(200)).body.draft,record);
 const reviewed={...record.draft,title:'Fictional owner-reviewed recurring service'},path='/api/recurring/drafts/'+record.id+'/issue';const issued=(await user.post(path,{draft:reviewed},'fictional-api-issue').expect(201)).body;
 assert.equal(issued.invoice.title,reviewed.title);assert.equal(issued.draft.status,'issued');assert.equal(issued.invoice.paymentTermDays,30);assert.equal(issued.invoice.paymentTerms,'Fictional terms');
 assert.deepEqual((await user.post(path,{draft:reviewed},'fictional-api-issue-again').expect(201)).body,issued);await user.post(path,{draft:{...reviewed,paymentTermDays:60,dueDate:'2026-12-29'}},'fictional-api-edited-retry').expect(409);
 assert.equal((await user.agent.get('/api/invoices')).body.invoices.length,before+1);const listed=(await user.agent.get('/api/recurring/drafts')).body.drafts.find((row:any)=>row.id===record.id);assert.equal(listed.invoiceId,issued.invoice.id);assert(!('issuedInputFingerprint' in listed));assert(!('issuedInvoice' in listed));
 }finally{app.locals.close();}
});

test('actual app recurring routes reject signed-out, demo, API and missing CSRF callers',async()=>{
 const app=createApp({dbPath:':memory:',ownerToken,now:clock,apiKeys:[{token:apiToken,scopes:['invoices:read','invoices:write','records:read']}]});try{
 await request(app).get('/api/recurring/plans').expect(401);await request(app).post('/api/recurring/prepare').set('Idempotency-Key','unsigned').send({}).expect(401);
 const user=await owner(app);await user.agent.post('/api/recurring/prepare').set('Idempotency-Key','missing-csrf').send({}).expect(403);await user.post('/api/recurring/prepare',{},'').expect(400);
 const demo=request.agent(app),login=await demo.post('/api/session/demo').send({}).expect(200);for(const path of ['/api/recurring/plans','/api/recurring/drafts','/api/recurring/drafts/fictional-id'])await demo.get(path).expect(403);await demo.post('/api/recurring/prepare').set('X-CSRF-Token',login.body.csrfToken).set('Idempotency-Key','demo-denied').send({}).expect(403);
 for(const prefix of ['/api','/api/v1']){await request(app).get(prefix+'/recurring/plans').set('Authorization','Bearer '+apiToken).expect(403);await request(app).post(prefix+'/recurring/prepare').set('Authorization','Bearer '+apiToken).set('Idempotency-Key','api-denied').send({}).expect(403);}
 assert.equal((await user.agent.get('/api/recurring/plans').expect(200)).body.plans.length,0);assert.equal((await user.agent.get('/api/recurring/drafts')).body.drafts.length,0);
 }finally{app.locals.close();}
});

test('encrypted actual app workspaces cannot read, prepare, pause or issue another owner records',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fictional-recurring-api-')),dbPath=join(dir,'fixture.sqlite'),encryptionKey=Buffer.alloc(32,54),publicOrigin='http://localhost:4359',proxySecret='fictional-recurring-proxy-secret-at-least32';
 const app=createApp({dbPath,encryptionKey,now:clock,hosted:{publicOrigin,proxySecret,allowInsecureLoopback:true}}),store=new Store(dbPath,{encryptionKey});
 function actor(){const token=randomBytes(32).toString('base64url'),workspace=randomUUID(),csrf=randomUUID();store.saveSession(token,{role:'owner',workspace,accountId:randomUUID(),csrf,expires:'2027-01-01T00:00:00Z'});const headers={'x-quiet-ledger-proxy':proxySecret,Cookie:'ql_session='+token,'X-CSRF-Token':csrf,Origin:publicOrigin};return {get:(path:string)=>request(app).get(path).set(headers),post:(path:string,body:object={})=>request(app).post(path).set(headers).set('Idempotency-Key',randomUUID()).send(body)};}
 try{const a=actor(),b=actor(),template=(await a.post('/api/invoice-templates',{label:'Fictional tenant-only template',draft}).expect(201)).body.template;
 const input={templateId:template.id,label:'Fictional private plan',startDate:'2026-11-06',frequency:{type:'monthly'}},plan=(await a.post('/api/recurring/plans',input).expect(201)).body.plan;await b.post('/api/recurring/plans',input).expect(404);
 const record=(await a.post('/api/recurring/prepare').expect(200)).body.drafts[0];assert.equal((await b.get('/api/recurring/plans')).body.plans.length,0);assert.equal((await b.get('/api/recurring/drafts')).body.drafts.length,0);assert.equal((await b.post('/api/recurring/prepare').expect(200)).body.createdCount,0);
 await b.get('/api/recurring/drafts/'+record.id).expect(404);await b.post('/api/recurring/plans/'+plan.id+'/pause',{paused:true}).expect(404);await b.post('/api/recurring/drafts/'+record.id+'/issue',{draft:record.draft}).expect(404);assert.equal((await a.get('/api/recurring/drafts/'+record.id)).body.draft.status,'draft');assert.equal((await a.get('/api/recurring/plans')).body.plans[0].paused,false);
 }finally{store.close();app.locals.close();rmSync(dir,{recursive:true,force:true});}
});
