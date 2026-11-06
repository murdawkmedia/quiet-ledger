import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,DomainError} from '../server/store.js';
import {InvoiceTemplates} from '../server/invoice-templates.js';
import {RecurringDrafts,RECURRING_LIMITS} from '../server/recurring-drafts.js';
import {occurrenceDate} from '../shared/recurring.js';

const key=Buffer.alloc(32,43),workspace='fictional-recurring-owner';
const invoiceInput={customerName:'Fictional recurring studio',title:'Fictional monthly service',currency:'CAD' as const,items:[{description:'Fictional recording',quantity:1,unitAmount:25000}],note:'FICTIONAL_RECURRING_PRIVATE_NOTE'};
const now=()=>new Date('2026-03-31T22:59:00Z');
function fixture(options:ConstructorParameters<typeof Store>[1]={encryptionKey:key}){const store=new Store(':memory:',options),templates=new InvoiceTemplates(store),service=new RecurringDrafts(store,now);const template=templates.save(workspace,{label:'Fictional retained service',draft:invoiceInput});return {store,templates,service,template,create:(extra:object={})=>service.createPlan(workspace,{templateId:template.id,label:'Fictional monthly plan',startDate:'2026-01-31',frequency:{type:'monthly'},...extra},'fictional-create')};}

test('monthly occurrence retains original day across leap years and February clamps',()=>{
 assert.deepEqual([0,1,2,3].map(i=>occurrenceDate('2024-01-31',{type:'monthly'},i)),['2024-01-31','2024-02-29','2024-03-31','2024-04-30']);
 assert.equal(occurrenceDate('2025-01-31',{type:'monthly'},1),'2025-02-28');
 assert.equal(occurrenceDate('2026-03-07',{type:'days',intervalDays:7},1),'2026-03-14');
 assert.equal(occurrenceDate('9999-12-31',{type:'monthly'},1),undefined);
 assert.equal(occurrenceDate('9999-12-31',{type:'days',intervalDays:1},1),undefined);
});

test('plan captures an immutable template snapshot; preparing never issues or sends',()=>{
 const f=fixture();try{const plan=f.create().body.plan;f.templates.save(workspace,{id:f.template.id,label:'Changed later',draft:{...invoiceInput,title:'Later edit'}});f.templates.remove(workspace,f.template.id);
 const prepared=f.service.prepare(workspace,{},'fictional-prepare');assert.equal(prepared.body.createdCount,3);assert.equal(prepared.body.hasMore,false);assert.equal(f.store.listInvoices(workspace).length,0);assert.equal(f.store.audits(workspace).length,0);
 const drafts=f.service.listDrafts(workspace);assert.equal(drafts.length,3);assert(drafts.every(row=>row.planId===plan.id&&row.draft.title===invoiceInput.title&&!('token' in row)&&!('number' in row)));assert.deepEqual(drafts.map(row=>row.periodDate).sort(),['2026-01-31','2026-02-28','2026-03-31']);
 assert.deepEqual(f.service.prepare(workspace,{},'fictional-prepare'),prepared);assert.equal(f.service.prepare(workspace,{},'fictional-prepare-another').body.createdCount,0);
 assert.equal(f.service.listPlans('other-fictional-workspace').length,0);assert.equal(f.service.listDrafts('other-fictional-workspace').length,0);assert.throws(()=>f.service.getDraft('other-fictional-workspace',drafts[0].id),{status:404});
 }finally{f.store.close();}
});

test('relative terms rebase per period; legacy absolute due dates demand explicit conversion',()=>{
 const f=fixture();try{const relative=f.templates.save(workspace,{label:'Fictional Net30',draft:{...invoiceInput,issueDate:'2025-12-01',dueDate:'2025-12-31',paymentTermDays:30,paymentTerms:'Fictional agreement'}});f.service.createPlan(workspace,{templateId:relative.id,label:'Net30 plan',startDate:'2026-01-31',frequency:{type:'monthly'}},'net30-plan');f.service.prepare(workspace,{},'net30-prepare');const draft=f.service.listDrafts(workspace).find(row=>row.periodDate==='2026-02-28')!;assert.equal(draft.draft.issueDate,'2026-02-28');assert.equal(draft.draft.dueDate,'2026-03-30');assert.equal(draft.draft.paymentTermDays,30);
 const legacy=f.templates.save(workspace,{label:'Fictional old date',draft:{...invoiceInput,issueDate:'2025-01-01',dueDate:'2025-01-16'}});const body={templateId:legacy.id,label:'Converted old date',startDate:'2026-03-30',frequency:{type:'monthly'}};assert.throws(()=>f.service.createPlan(workspace,body,'legacy-ambiguous'),{status:400});f.service.createPlan(workspace,{...body,dueOffsetDays:15},'legacy-relative');f.service.prepare(workspace,{},'legacy-prepare');assert.equal(f.service.listDrafts(workspace).find(row=>row.planLabel==='Converted old date')!.draft.dueDate,'2026-04-14');
 }finally{f.store.close();}
});

test('explicit preparation is bounded, future dates rejected, pause preserves earlier drafts',()=>{
 const f=fixture();try{const plan=f.create({startDate:'2020-01-01',frequency:{type:'days',intervalDays:1}}).body.plan;const first=f.service.prepare(workspace,{},'catch-up-1').body;assert.equal(first.createdCount,RECURRING_LIMITS.prepareBatch);assert.equal(first.hasMore,true);assert.equal(new Set(first.drafts.map(row=>row.id)).size,first.createdCount);
 const second=f.service.prepare(workspace,{},'catch-up-2').body;assert.equal(second.drafts[0].periodIndex,RECURRING_LIMITS.prepareBatch);assert.throws(()=>f.service.prepare(workspace,{asOf:'2026-04-01'},'future-prepare'),{status:400});
 f.service.pause(workspace,plan.id,{paused:true},'pause-plan');assert.equal(f.service.prepare(workspace,{},'paused-prepare').body.createdCount,0);assert.equal(f.service.listDrafts(workspace).length,RECURRING_LIMITS.prepareBatch*2);f.service.pause(workspace,plan.id,{paused:false},'resume-plan');assert.equal(f.service.prepare(workspace,{},'resumed-prepare').body.createdCount,RECURRING_LIMITS.prepareBatch);
 }finally{f.store.close();}
});

test('issuing is atomic, exactly once across keys, and edited payload retries conflict',()=>{
 const f=fixture();try{f.create({startDate:'2026-03-31'});f.service.prepare(workspace,{},'issue-prepare');const draft=f.service.listDrafts(workspace)[0];const edited={...draft.draft,title:'Fictional reviewed title'};
 assert.throws(()=>f.service.issue(workspace,draft.id,{draft:{...edited,items:[]}},'invalid-issue'),{status:400});assert.equal(f.store.listInvoices(workspace).length,0);assert.equal(f.service.getDraft(workspace,draft.id).status,'draft');
 const issued=f.service.issue(workspace,draft.id,{draft:edited},'issue-once');assert.equal(issued.body.invoice.number,'QL-0001');assert.equal(issued.body.draft.invoiceId,issued.body.invoice.id);assert.equal(f.store.listInvoices(workspace).length,1);
 assert.deepEqual(f.service.issue(workspace,draft.id,{draft:edited},'issue-once'),issued);assert.deepEqual(f.service.issue(workspace,draft.id,{draft:edited},'different-issue-key'),issued);assert.equal(f.store.listInvoices(workspace).length,1);
 for(const retryKey of ['issue-once','different-edits-key'])assert.throws(()=>f.service.issue(workspace,draft.id,{draft:{...edited,title:'Changed after issue'}},retryKey),{status:409});assert.throws(()=>f.service.issue('other-fictional-workspace',draft.id,{draft:edited},'cross-tenant-issue'),{status:404});
 assert.throws(()=>f.service.issue(workspace,draft.id,{draft:edited},''),{status:400});
 }finally{f.store.close();}
});

test('encrypted file restart and two stores retain uniqueness and exact issued response',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fictional-recurring-')),path=join(dir,'fixture.sqlite');let a:Store|undefined,b:Store|undefined;
 try{a=new Store(path,{encryptionKey:key});const templates=new InvoiceTemplates(a),service=new RecurringDrafts(a,now),template=templates.save(workspace,{label:'Fictional restart template',draft:invoiceInput});service.createPlan(workspace,{templateId:template.id,label:'Fictional restart plan',startDate:'2026-03-31',frequency:{type:'monthly'}},'restart-plan');b=new Store(path,{encryptionKey:key});const other=new RecurringDrafts(b,now);const first=service.prepare(workspace,{},'restart-prepare'),second=other.prepare(workspace,{},'other-process-prepare');assert.equal(first.body.createdCount+second.body.createdCount,1);const draft=first.body.drafts[0];const issued=service.issue(workspace,draft.id,{draft:draft.draft},'restart-issue');assert.deepEqual(other.issue(workspace,draft.id,{draft:draft.draft},'concurrent-new-key'),issued);b.close();b=undefined;a.close();a=undefined;
 assert(!readFileSync(path).includes(Buffer.from(invoiceInput.note)));assert(!readFileSync(path).includes(Buffer.from(invoiceInput.customerName)));a=new Store(path,{encryptionKey:key});const restored=new RecurringDrafts(a,now);assert.deepEqual(restored.issue(workspace,draft.id,{draft:draft.draft},'after-restart-key'),issued);assert.equal(a.listInvoices(workspace).length,1);assert.equal(restored.prepare(workspace,{},'after-restart-prepare').body.createdCount,0);
 }finally{b?.close();a?.close();rmSync(dir,{recursive:true,force:true});}
});

test('invoice quota rolls back issuance association and audit, existing retries survive capacity',()=>{
 const f=fixture({encryptionKey:key,limits:{invoicesPerWorkspace:1}});try{f.create({startDate:'2026-02-28'});f.service.prepare(workspace,{},'quota-prepare');const drafts=f.service.listDrafts(workspace);const first=f.service.issue(workspace,drafts[0].id,{draft:drafts[0].draft},'quota-first');assert.throws(()=>f.service.issue(workspace,drafts[1].id,{draft:drafts[1].draft},'quota-second'),{status:429});assert.equal(f.service.getDraft(workspace,drafts[1].id).status,'draft');assert.equal(f.store.audits(workspace).length,1);assert.equal(f.store.listInvoices(workspace).length,1);assert.deepEqual(f.service.issue(workspace,drafts[0].id,{draft:drafts[0].draft},'quota-retry-new-key'),first);
 }finally{f.store.close();}
});

test('draft quota admits the final partial batch and then protects existing retries',()=>{
 const f=fixture();try{f.create({startDate:'2020-01-01',frequency:{type:'days',intervalDays:1}});let count=0;for(let i=0;i<20;i++)count+=f.service.prepare(workspace,{},'draft-quota-'+i).body.createdCount;assert.equal(count,480);
 const last=f.service.prepare(workspace,{},'draft-quota-last');assert.equal(last.body.createdCount,20);assert.equal(last.body.hasMore,true);assert.equal(f.service.listDrafts(workspace).length,RECURRING_LIMITS.drafts);assert.deepEqual(f.service.prepare(workspace,{},'draft-quota-last'),last);assert.throws(()=>f.service.prepare(workspace,{},'draft-quota-over'),{status:429});assert.equal(f.service.listDrafts(workspace).length,500);
 }finally{f.store.close();}
});

test('plan limit preserves original retry and rejects a new plan without writing',()=>{
 const f=fixture();try{const input={templateId:f.template.id,label:'Fictional quota plan',startDate:'2026-03-31',frequency:{type:'monthly'}};const first=f.service.createPlan(workspace,input,'plan-limit-first');for(let i=1;i<RECURRING_LIMITS.plans;i++)f.service.createPlan(workspace,input,'plan-limit-'+i);assert.throws(()=>f.service.createPlan(workspace,input,'plan-limit-over'),{status:429});assert.equal(f.service.listPlans(workspace).length,100);assert.deepEqual(f.service.createPlan(workspace,input,'plan-limit-first'),first);
 }finally{f.store.close();}
});

test('an association write failure rolls back invoice, audit, and retry identity',()=>{
 const f=fixture();try{f.create({startDate:'2026-03-31'});f.service.prepare(workspace,{},'rollback-prepare');const draft=f.service.listDrafts(workspace)[0];f.store.db.exec("CREATE TRIGGER fictional_association_failure BEFORE UPDATE ON recurring_drafts BEGIN SELECT RAISE(ABORT,'Fictional association failure');END;");assert.throws(()=>f.service.issue(workspace,draft.id,{draft:draft.draft},'rollback-issue'),/Fictional association failure/);assert.equal(f.store.listInvoices(workspace).length,0);assert.equal(f.store.audits(workspace).length,0);assert.equal(f.service.getDraft(workspace,draft.id).status,'draft');assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM idempotency WHERE scope=?").get('recurring-issue:'+workspace)!.n,0);
 f.store.db.exec('DROP TRIGGER fictional_association_failure');assert.equal(f.service.issue(workspace,draft.id,{draft:draft.draft},'rollback-issue').body.invoice.number,'QL-0001');
 }finally{f.store.close();}
});

test('two independent processes preparing and issuing concurrently create one period and one invoice',async()=>{
 const {fork}=await import('node:child_process');const dir=mkdtempSync(join(tmpdir(),'fictional-recurring-race-')),path=join(dir,'fixture.sqlite'),store=new Store(path,{encryptionKey:key}),templates=new InvoiceTemplates(store),service=new RecurringDrafts(store,now);
 async function race(kind:'prepare'|'issue',body:object,id=''){
  const children=[0,1].map(()=>fork(new URL('./fixtures/recurring-concurrency-worker.ts',import.meta.url),[path],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']}));
  try{
   await Promise.all(children.map(child=>new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('message',message=>{if((message as {ready?:boolean}).ready)resolve();else reject(new Error('Fixture worker not ready.'));});child.once('exit',code=>{if(code)reject(new Error('Fixture exited '+code));});})));
   return await Promise.all(children.map((child,index)=>new Promise<any>((resolve,reject)=>{child.once('message',message=>{const outcome=message as {result?:unknown;error?:string};if(outcome.error)reject(new Error(outcome.error));else resolve(outcome.result);});child.once('error',reject);child.send({kind,workspace,body,id,key:kind+'-race-'+index});})));
  }finally{for(const child of children)if(child.connected)child.kill();}
 }
 try{const template=templates.save(workspace,{label:'Fictional race template',draft:invoiceInput});service.createPlan(workspace,{templateId:template.id,label:'Fictional race',startDate:'2026-03-31',frequency:{type:'monthly'}},'race-create');const prepared=await race('prepare',{});assert.deepEqual(prepared.map(row=>row.body.createdCount).sort(),[0,1]);const record=service.listDrafts(workspace)[0];const issued=await race('issue',{draft:record.draft},record.id);assert.deepEqual(issued[0],issued[1]);assert.equal(store.listInvoices(workspace).length,1);assert.equal(service.listDrafts(workspace).length,1);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('a successful new-key historical issue retry binds that key to its original draft',()=>{
 const f=fixture();try{f.create({startDate:'2026-02-28'});f.service.prepare(workspace,{},'retry-binding-prepare');const [a,b]=f.service.listDrafts(workspace);const issued=f.service.issue(workspace,a.id,{draft:a.draft},'retry-binding-original');assert.deepEqual(f.service.issue(workspace,a.id,{draft:a.draft},'retry-binding-new'),issued);assert.throws(()=>f.service.issue(workspace,b.id,{draft:b.draft},'retry-binding-new'),{status:409});assert.equal(f.store.listInvoices(workspace).length,1);assert.equal(f.service.getDraft(workspace,b.id).status,'draft');
 }finally{f.store.close();}
});

test('saved-operation limit retains original issue result and rejects a fresh retry key',()=>{
 const f=fixture({encryptionKey:key,limits:{idempotencyPerScope:1}});try{f.create({startDate:'2026-03-31'});f.service.prepare(workspace,{},'operation-limit-prepare');const draft=f.service.listDrafts(workspace)[0],body={draft:draft.draft},first=f.service.issue(workspace,draft.id,body,'operation-limit-first');assert.deepEqual(f.service.issue(workspace,draft.id,body,'operation-limit-first'),first);assert.throws(()=>f.service.issue(workspace,draft.id,body,'operation-limit-new'),{status:429});assert.equal(f.store.listInvoices(workspace).length,1);assert.equal(f.service.getDraft(workspace,draft.id).invoiceId,first.body.invoice.id);
 }finally{f.store.close();}
});

test('invalid schedules and dates cannot create plans or future drafts',()=>{
 const f=fixture();try{const input={templateId:f.template.id,label:'Fictional invalid input',startDate:'2026-03-31',frequency:{type:'monthly'}};for(const change of [{startDate:'2026-02-30'},{startDate:'2026-2-03'},{startDate:'2026-01-01T00:00:00Z'},{frequency:{type:'days',intervalDays:0}},{frequency:{type:'days',intervalDays:1.5}},{frequency:{type:'days',intervalDays:3651}},{frequency:{type:'yearly'}},{dueOffsetDays:3651},{unknown:'field'}])assert.throws(()=>f.service.createPlan(workspace,{...input,...change},'invalid-plan'),{status:400});assert.equal(f.service.listPlans(workspace).length,0);assert.throws(()=>f.service.createPlan(workspace,{...input,startDate:'9999-12-31',dueOffsetDays:1},'outside-calendar'),{status:400});
 f.create({startDate:'2026-04-01'});assert.equal(f.service.prepare(workspace,{},'not-yet-due').body.createdCount,0);for(const value of ['2026-02-30','2026-03-32','2026-3-31'])assert.throws(()=>f.service.prepare(workspace,{asOf:value},'invalid-asof'),{status:400});assert.equal(f.service.listDrafts(workspace).length,0);
 }finally{f.store.close();}
});
