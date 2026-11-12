import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {Store,DomainError,type StoredSession} from '../server/store.js';
import {InvoiceLedger} from '../server/invoice-ledger.js';
import {createInvoice} from '../server/domain.js';
import {BillingRecords} from '../server/billing-records.js';
import {billingRouter} from '../server/billing-router.js';

const workspace='fictional-billing-owner',other='fictional-billing-other';
const invoiceInput={customerName:'Fictional Billing Client',title:'Fictional milestone work',currency:'CAD',items:[{description:'Fictional milestone delivery',quantity:1,unitAmount:125000}]};
function fixture(){
  const store=new Store(':memory:',{encryptionKey:Buffer.alloc(32,83)}),ledger=new InvoiceLedger(store),billing=new BillingRecords(store,ledger,()=>new Date('2026-11-08T12:00:00Z')),app=express();
  app.use(express.json({limit:'48kb'}));
  const session:StoredSession={role:'owner',workspace,csrf:'fictional-billing-csrf',expires:'2027-01-01T00:00:00Z'};
  app.use((req,res,next)=>{
    if(req.get('X-Fictional-Session')!=='none')res.locals.session={...session,...(req.get('X-Fictional-Session')==='demo'?{role:'demo'}:{}),...(req.get('X-Fictional-Session')==='hackathon'?{role:'owner' as const,hackathonDemo:true,workspace:'fictional-hackathon-workspace'}:{})};
    if(req.get('X-Fictional-Api'))res.locals.apiAccess={};
    next();
  });
  app.use('/api/billing',billingRouter(store,billing,()=>new Date('2026-11-08T12:00:00Z')));
  app.use((error:Error,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error instanceof DomainError?error.status:500).json({error:error.message}));
  const invoice=createInvoice(store,workspace,invoiceInput,new Date('2026-11-08T12:00:00Z'));
  return {store,ledger,billing,app,invoice,close:()=>store.close(),key:()=>'fictional-key-'+randomUUID()};
}

test('every route requires a signed-in owner browser and rejects demo, hackathon and API-key callers before any replay',async()=>{
  const f=fixture();try{
    const ownerKey=f.key();
    const project=await request(f.app).post('/api/billing/projects').set('Idempotency-Key',ownerKey).send({name:'Fictional replay project'}).expect(201);
    for(const [method,path,body] of [['get','/projects',undefined],['post','/projects',{name:'Nope'}],['patch','/projects/'+project.body.project.id,{name:'Nope'}],['delete','/projects/'+project.body.project.id,undefined],['get','/milestones/'+randomUUID(),undefined],['post','/milestones',{label:'Nope',amount:1,currency:'CAD'}],['patch','/milestones/'+randomUUID(),{label:'Nope'}],['delete','/milestones/'+randomUUID(),undefined],['post','/deliverables',{invoiceId:f.invoice.id,label:'Nope',url:'https://fictional.invalid/nope.zip'}],['patch','/deliverables/'+randomUUID(),{label:'Nope'}],['delete','/deliverables/'+randomUUID(),undefined],['post','/deliverables/'+randomUUID()+'/release',{}],['post','/deliverables/'+randomUUID()+'/unrelease',{}]] as const){
      for(const header of ['demo','hackathon'])await (request(f.app)[method] as (path:string)=>request.Test)('/api/billing'+path).set('X-Fictional-Session',header).set('Idempotency-Key',f.key()).send(body).expect(403);
      await (request(f.app)[method] as (path:string)=>request.Test)('/api/billing'+path).set('X-Fictional-Session','none').set('Idempotency-Key',f.key()).send(body).expect(401);
      await (request(f.app)[method] as (path:string)=>request.Test)('/api/billing'+path).set('X-Fictional-Api','true').set('Idempotency-Key',f.key()).send(body).expect(403);
    }
    // Authorization runs before idempotent replay: an attacker cannot read a saved owner
    // response by replaying the owner's idempotency key from a demo or API-key context.
    const stolen=await request(f.app).post('/api/billing/projects').set('X-Fictional-Session','demo').set('Idempotency-Key',ownerKey).send({name:'Fictional replay project'}).expect(403);
    assert(!JSON.stringify(stolen.body).includes('Fictional replay project'));
  }finally{f.close();}
});

test('strict schemas accept exact planned records and reject unknown fields, bad amounts and bad currencies',async()=>{
  const f=fixture();try{
    await request(f.app).post('/api/billing/projects').set('Idempotency-Key',f.key()).send({name:'Fictional strict project',extra:true}).expect(400);
    const milestone=await request(f.app).post('/api/billing/milestones').set('Idempotency-Key',f.key()).send({label:'Fictional strict milestone',amount:125000,currency:'CAD',projectId:randomUUID()}).expect(404);
    assert(!milestone.body.project);
    const created=await request(f.app).post('/api/billing/milestones').set('Idempotency-Key',f.key()).send({label:'Fictional strict milestone',amount:125000,currency:'CAD'}).expect(201);
    assert.equal(created.body.milestone.amount,125000);assert.equal(created.body.milestone.currency,'CAD');
    for(const body of [{label:'x',amount:0,currency:'CAD'},{label:'x',amount:1_000_000_001,currency:'CAD'},{label:'x',amount:1.5,currency:'CAD'},{label:'x',amount:1000,currency:'CHF'},{label:'',amount:1000,currency:'CAD'},{label:'x'.repeat(241),amount:1000,currency:'CAD'},{label:'x',amount:1000,currency:'CAD',surprise:1}])await request(f.app).post('/api/billing/milestones').set('Idempotency-Key',f.key()).send(body).expect(400);
    // Planned amounts are immutable after creation; labels and links stay editable.
    await request(f.app).patch(`/api/billing/milestones/${created.body.milestone.id}`).set('Idempotency-Key',f.key()).send({amount:1}).expect(400);
    await request(f.app).patch(`/api/billing/milestones/${created.body.milestone.id}`).set('Idempotency-Key',f.key()).send({currency:'USD'}).expect(400);
    const relabelled=await request(f.app).patch(`/api/billing/milestones/${created.body.milestone.id}`).set('Idempotency-Key',f.key()).send({label:'Relabelled milestone',invoiceId:f.invoice.id}).expect(200);
    assert.equal(relabelled.body.milestone.label,'Relabelled milestone');
    assert.equal(relabelled.body.milestone.invoice.id,f.invoice.id);
    const unlinked=await request(f.app).patch(`/api/billing/milestones/${created.body.milestone.id}`).set('Idempotency-Key',f.key()).send({invoiceId:null}).expect(200);
    assert.equal(unlinked.body.milestone.invoice,undefined);
    // Cross-workspace invoice links 404 without leaking existence.
    const foreign=createInvoice(f.store,other,invoiceInput,new Date('2026-11-08T12:00:00Z'));
    await request(f.app).patch(`/api/billing/milestones/${created.body.milestone.id}`).set('Idempotency-Key',f.key()).send({invoiceId:foreign.id}).expect(404);
    await request(f.app).get(`/api/billing/milestones/${randomUUID()}`).expect(404);
  }finally{f.close();}
});

test('delivery links accept only clean https URLs within the length bound',async()=>{
  const f=fixture();try{
    const good=await request(f.app).post('/api/billing/deliverables').set('Idempotency-Key',f.key()).send({invoiceId:f.invoice.id,label:'Fictional deliverable',url:'https://files.fictional.example/blueprint.zip'}).expect(201);
    assert.equal(good.body.deliverable.released,false);
    for(const url of ['http://files.fictional.example/blueprint.zip','javascript:alert(1)','data:text/html,hello','blob:https://fictional.invalid','ftp://files.fictional.example/file.zip','files.fictional.example/blueprint.zip','https://','https://user:secret@files.fictional.example/file.zip','https://files.fictional.example/file\u0001.zip','https://files.fictional.example/'+ 'a'.repeat(2000)])
      await request(f.app).post('/api/billing/deliverables').set('Idempotency-Key',f.key()).send({invoiceId:f.invoice.id,label:'Fictional deliverable',url}).expect(400);
    // A full 2000-character https URL is still accepted.
    const longest='https://files.fictional.example/'+'a'.repeat(2000-'https://files.fictional.example/'.length);
    assert.equal(longest.length,2000);
    await request(f.app).post('/api/billing/deliverables').set('Idempotency-Key',f.key()).send({invoiceId:f.invoice.id,label:'Fictional deliverable',url:longest}).expect(201);
    // Errors never echo the rejected destination.
    const rejected=await request(f.app).post('/api/billing/deliverables').set('Idempotency-Key',f.key()).send({invoiceId:f.invoice.id,label:'Fictional deliverable',url:'https://user:secret@files.fictional.example/file.zip'}).expect(400);
    assert(!JSON.stringify(rejected.body).includes('secret'));
  }finally{f.close();}
});

test('mutations are idempotent per key and conflict on changed bodies',async()=>{
  const f=fixture();try{
    const key=f.key();
    const first=await request(f.app).post('/api/billing/projects').set('Idempotency-Key',key).send({name:'Fictional idempotent project'}).expect(201);
    const retry=await request(f.app).post('/api/billing/projects').set('Idempotency-Key',key).send({name:'Fictional idempotent project'}).expect(201);
    assert.equal(retry.body.project.id,first.body.project.id);
    assert.equal(f.billing.overview(workspace).projects.length,1);
    await request(f.app).post('/api/billing/projects').set('Idempotency-Key',key).send({name:'Different body'}).expect(409);
    await request(f.app).post('/api/billing/projects').send({name:'Missing key'}).expect(400);
    const deliverable=await request(f.app).post('/api/billing/deliverables').set('Idempotency-Key',f.key()).send({invoiceId:f.invoice.id,label:'Fictional deliverable',url:'https://files.fictional.example/file.zip'}).expect(201);
    const releaseKey=f.key();
    await request(f.app).post(`/api/billing/deliverables/${deliverable.body.deliverable.id}/release`).set('Idempotency-Key',releaseKey).send({}).expect(200);
    const releasedAgain=await request(f.app).post(`/api/billing/deliverables/${deliverable.body.deliverable.id}/release`).set('Idempotency-Key',releaseKey).send({}).expect(200);
    assert.equal(releasedAgain.body.deliverable.released,true);
    assert.equal(f.billing.overview(workspace).deliverables[0].released,true);
    await request(f.app).post(`/api/billing/deliverables/${deliverable.body.deliverable.id}/unrelease`).set('Idempotency-Key',f.key()).send({}).expect(200);
    assert.equal(f.billing.overview(workspace).deliverables[0].released,false);
  }finally{f.close();}
});

test('deleting a project with milestones returns 409; milestone deletes preserve other records',async()=>{
  const f=fixture();try{
    const project=(await request(f.app).post('/api/billing/projects').set('Idempotency-Key',f.key()).send({name:'Fictional project'}).expect(201)).body.project;
    const milestone=(await request(f.app).post('/api/billing/milestones').set('Idempotency-Key',f.key()).send({label:'Fictional milestone',amount:1000,currency:'CAD',projectId:project.id}).expect(201)).body.milestone;
    await request(f.app).delete(`/api/billing/projects/${project.id}`).set('Idempotency-Key',f.key()).expect(409);
    await request(f.app).delete(`/api/billing/milestones/${milestone.id}`).set('Idempotency-Key',f.key()).expect(200);
    await request(f.app).delete(`/api/billing/projects/${project.id}`).set('Idempotency-Key',f.key()).expect(200);
    assert.equal(f.store.getInvoice(f.invoice.id,workspace)!.id,f.invoice.id);
    assert.equal(f.billing.overview(workspace).looseMilestones.length,0);
  }finally{f.close();}
});

test('project views enrich milestones from the live ledger without duplicating totals',async()=>{
  const f=fixture();try{
    const project=(await request(f.app).post('/api/billing/projects').set('Idempotency-Key',f.key()).send({name:'Fictional enriched project'}).expect(201)).body.project;
    await request(f.app).post('/api/billing/milestones').set('Idempotency-Key',f.key()).send({label:'Fictional enriched milestone',amount:999000,currency:'CAD',projectId:project.id,invoiceId:f.invoice.id}).expect(201);
    const view=await request(f.app).get('/api/billing/projects').expect(200);
    assert.match(view.headers['cache-control'] as string,/no-store/);
    const milestone=view.body.projects[0].milestones[0];
    assert.equal(milestone.amount,999000);
    assert.equal(milestone.invoice.number,f.invoice.number);
    assert.equal(milestone.invoice.effectiveTotal,125000);
    assert.equal(milestone.invoice.state,'unpaid');
    assert.equal(milestone.invoice.mode,'live');
    const detail=await request(f.app).get(`/api/billing/milestones/${milestone.id}`).expect(200);
    assert.equal(detail.body.milestone.label,'Fictional enriched milestone');
    assert.equal(detail.body.milestone.invoice.effectiveTotal,125000);
    assert.deepEqual(Object.keys(detail.body.milestone.invoice).sort(),['currency','due','effectiveTotal','id','mode','number','paid','state','total']);
    assert.equal(detail.body.milestone.invoice.priceAgreementId,undefined);
    assert.deepEqual(Object.keys(detail.body.milestone).filter(key=>!['deliverables','invoice'].includes(key)).sort(),['amount','createdAt','currency','id','label','projectId','updatedAt']);
  }finally{f.close();}
});

test('record caps surface as 429 responses without eviction',async()=>{
  const f=fixture();try{
    for(let index=0;index<100;index++)await request(f.app).post('/api/billing/projects').set('Idempotency-Key',f.key()).send({name:`Fictional project ${index}`}).expect(201);
    const capped=await request(f.app).post('/api/billing/projects').set('Idempotency-Key',f.key()).send({name:'One too many'}).expect(429);
    assert(!capped.body.project);
    const view=await request(f.app).get('/api/billing/projects').expect(200);
    assert.equal(view.body.projects.length,100);
    for(let index=0;index<20;index++)await request(f.app).post('/api/billing/deliverables').set('Idempotency-Key',f.key()).send({invoiceId:f.invoice.id,label:`Fictional deliverable ${index}`,url:'https://files.fictional.example/file.zip'}).expect(201);
    await request(f.app).post('/api/billing/deliverables').set('Idempotency-Key',f.key()).send({invoiceId:f.invoice.id,label:'One too many',url:'https://files.fictional.example/file.zip'}).expect(429);
  }finally{f.close();}
});

test('the public deliverable projection is available only through the helper, never an owner route leak',async()=>{
  const f=fixture();try{
    // No route in the owner browser router exposes raw URLs to any non-owner context
    // (publicDeliverables is consumed by the parent-owned checkout extension).
    const urls=['/public-deliverables','/deliverables/public','/checkout'];
    for(const url of urls)await request(f.app).get('/api/billing'+url).expect(404);
    await request(f.app).get('/api/billing/projects').set('X-Fictional-Session','demo').expect(403);
  }finally{f.close();}
});
