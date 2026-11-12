import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.js';
import {InvoiceEditorDrafts,INVOICE_EDITOR_DRAFT_LIMITS} from '../server/invoice-drafts.js';
import {validateInvoiceEditorSnapshot,expenseFingerprint,type InvoiceEditorSnapshot} from '../shared/invoice-editor-drafts.js';

/**
 * Fictional service-level checks for private encrypted invoice editor drafts.
 * Every value below is invented; no real customer, provider or payment exists.
 */
const key=Buffer.alloc(32,53),workspace='fictional-drafts-owner',other='other-fictional-drafts-owner';
const now=()=>new Date('2026-11-11T12:00:00Z');
const snapshot=(over:Partial<InvoiceEditorSnapshot>={}):InvoiceEditorSnapshot=>({
  version:1,customerName:'Fictional Drafts Studio',customerEmail:'billing@fictional.example',title:'Fictional monthly service',
  issueDate:'2026-11-11',dueDate:'',currency:'CAD',tax:'5',discount:'0',premium:'0',note:'FICTIONAL_DRAFTS_PRIVATE_NOTE',
  lines:[
    {id:'line-service',description:'Fictional editing labour',quantity:'2',price:'125.00',kind:'service',adjustmentEligible:true},
    {id:'line-flight',description:'Fictional flight reimbursement',quantity:'1',price:'210.40',kind:'expense',adjustmentEligible:false},
  ],
  schedule:'30',customDays:'',paymentTerms:'Fictional Net30 terms',allMethods:false,accepted:['bitcoin','lightning'],
  methodRules:[{id:'rule-btc',method:'bitcoin',discount:'3',premium:''}],clientId:'',
  billing:{sellerName:'Fictional Seller',sellerAddress:'1 Fictional Way'},
  carriedLineIds:['line-flight'],
  ...over,
});
/** A strictly valid invoice derived from the same fictional editor content. */
const invoice=(over:Record<string,unknown>={})=>({customerName:'Fictional Drafts Studio',title:'Fictional monthly service',currency:'CAD',
  items:[{description:'Fictional editing labour',quantity:2,unitAmount:25000,kind:'service',adjustmentEligible:true},{description:'Fictional flight reimbursement',quantity:1,unitAmount:21040,kind:'expense',adjustmentEligible:false}],
  paymentTermDays:30,paymentTerms:'Fictional Net30 terms',taxBps:500,...over});
function fixture(options:ConstructorParameters<typeof Store>[1]={encryptionKey:key}){const store=new Store(':memory:',options);return {store,service:new InvoiceEditorDrafts(store,now)};}

test('snapshot validator is strict, versioned and bounded',()=>{
  const base=snapshot();
  assert.equal(validateInvoiceEditorSnapshot(base).ok,true);
  assert.equal(validateInvoiceEditorSnapshot({...base,version:2}).ok,false);
  assert.equal(validateInvoiceEditorSnapshot({...base,unknownField:'x'}).ok,false);
  assert.equal(validateInvoiceEditorSnapshot({...base,lines:undefined}).ok,false);
  assert.equal(validateInvoiceEditorSnapshot({...base,lines:Array.from({length:41},(_,index)=>({id:'line-'+index,description:'Fictional line',quantity:'1',price:'1.00',kind:'service',adjustmentEligible:true}))}).ok,false);
  assert.equal(validateInvoiceEditorSnapshot({...base,accepted:['not-a-method']}).ok,false);
  assert.equal(validateInvoiceEditorSnapshot({...base,note:'n'.repeat(2001)}).ok,false);
  assert.equal(validateInvoiceEditorSnapshot({...base,carriedExpenseAck:'not-hex'}).ok,false);
  assert.equal(validateInvoiceEditorSnapshot({...base,carriedExpenseAck:expenseFingerprint(base.lines.filter(line=>line.kind==='expense'))}).ok,true);
  assert.equal(validateInvoiceEditorSnapshot('nope').ok,false);
});

test('partial raw snapshots save, list and reload without issuing anything',()=>{
  const f=fixture();try{
  const partial=snapshot({title:'',tax:'',lines:[{id:'line-1',description:'',quantity:'',price:'',kind:'service',adjustmentEligible:true}],carriedLineIds:[]});
  const saved=f.service.save(workspace,randomUUID(),{expectedRevision:0,snapshot:partial});
  assert.equal(saved.draft.revision,1);assert.equal(saved.draft.status,'draft');assert.ok(saved.draft.id);
  assert.equal(saved.draft.title,'Untitled draft');assert.equal(saved.draft.customerName,'Fictional Drafts Studio');
  const listed=f.service.list(workspace);assert.equal(listed.length,1);assert.equal(listed[0].id,saved.draft.id);assert(!('snapshot'in listed[0]));
  const restored=f.service.get(workspace,saved.draft.id);
  assert.deepEqual(restored.snapshot,partial);assert.equal(restored.revision,1);
  // Saving a draft never issues: no invoice, no number, no token, no audit.
  assert.equal(f.store.listInvoices(workspace).length,0);assert.equal(f.store.audits(workspace).length,0);
  assert.throws(()=>f.service.get(workspace,randomUUID()),{status:404});
  assert.equal(f.service.list(other).length,0);assert.throws(()=>f.service.get(other,saved.draft.id),{status:404});
  }finally{f.store.close();}
});

test('a draft identifier owned by another workspace never reports a successful save',()=>{
  const f=fixture();try{
    const id=randomUUID(),original=snapshot();
    f.service.save(workspace,id,{expectedRevision:0,snapshot:original});
    assert.throws(()=>f.service.save(other,id,{expectedRevision:0,snapshot:snapshot({title:'Other workspace edit'})}),{status:404});
    assert.equal(f.service.list(other).length,0);
    assert.deepEqual(f.service.get(workspace,id).snapshot,original);
  }finally{f.store.close();}
});

test('saves advance the revision; exact retries replay; stale conflicting writes get 409 without overwrite',()=>{
  const f=fixture();try{
  const id=randomUUID(),first=f.service.save(workspace,id,{expectedRevision:0,snapshot:snapshot()});
  assert.equal(first.draft.revision,1);
  // Exact retry of an uncertain first save: same body, no duplicate, no second advance.
  assert.deepEqual(f.service.save(workspace,id,{expectedRevision:0,snapshot:snapshot()}),first);
  const edited=snapshot({title:'Fictional reviewed title'});
  const second=f.service.save(workspace,id,{expectedRevision:1,snapshot:edited});
  assert.equal(second.draft.revision,2);assert.equal(f.service.get(workspace,id).snapshot.title,'Fictional reviewed title');
  // Exact retry of the second save replays the stored result.
  assert.deepEqual(f.service.save(workspace,id,{expectedRevision:1,snapshot:edited}),second);
  // A different write with the stale revision conflicts and never overwrites.
  assert.throws(()=>f.service.save(workspace,id,{expectedRevision:1,snapshot:snapshot({title:'Stale tab edit'})}),{status:409});
  assert.equal(f.service.get(workspace,id).snapshot.title,'Fictional reviewed title');
  assert.equal(f.service.get(workspace,id).revision,2);
  assert.throws(()=>f.service.save(workspace,id,{expectedRevision:9,snapshot:edited}),{status:409});
  // A vanished draft is not silently re-created from a stale revision.
  const gone=randomUUID();assert.throws(()=>f.service.save(workspace,gone,{expectedRevision:3,snapshot:snapshot()}),{status:404});
  assert.equal(f.service.list(workspace).length,1);
  }finally{f.store.close();}
});

test('draft caps, payload size and identifier bounds are enforced',()=>{
  const f=fixture({encryptionKey:key,limits:{invoicesPerWorkspace:500}});try{
  for(let index=0;index<INVOICE_EDITOR_DRAFT_LIMITS.drafts;index++)f.service.save(workspace,randomUUID(),{expectedRevision:0,snapshot:snapshot({title:'Fictional draft '+index})});
  assert.throws(()=>f.service.save(workspace,randomUUID(),{expectedRevision:0,snapshot:snapshot()}),{status:429});
  assert.equal(f.service.list(workspace).length,INVOICE_EDITOR_DRAFT_LIMITS.drafts);
  assert.throws(()=>f.service.save(workspace,'not-a-uuid',{expectedRevision:0,snapshot:snapshot()}),{status:400});
  assert.throws(()=>f.service.save(workspace,randomUUID(),{expectedRevision:0,snapshot:snapshot({note:'n'.repeat(16000)})}),{status:400});
  assert.throws(()=>f.service.save(workspace,randomUUID(),{expectedRevision:-1,snapshot:snapshot()}),{status:400});
  assert.throws(()=>f.service.save(workspace,randomUUID(),{expectedRevision:0,snapshot:'nope'}),{status:400});
  }finally{f.store.close();}
});

test('issue is atomic and exactly-once across keys; changed payloads conflict; issued drafts are immutable',()=>{
  const f=fixture();try{
  const id=randomUUID(),saved=f.service.save(workspace,id,{expectedRevision:0,snapshot:snapshot()});
  const reviewed=invoice({title:'Fictional reviewed monthly service'});
  const path={expectedRevision:saved.draft.revision,invoice:reviewed};
  assert.throws(()=>f.service.issue(workspace,id,{expectedRevision:saved.draft.revision,invoice:invoice({items:[]})},'invalid-issue'),{status:400});
  assert.equal(f.store.listInvoices(workspace).length,0);
  const issued=f.service.issue(workspace,id,path,'issue-once');
  assert.equal(issued.status,201);assert.equal(issued.body.invoice.number,'QL-0001');assert.equal(issued.body.invoice.title,reviewed.title);
  assert.equal(issued.body.draft.status,'issued');assert.equal(issued.body.draft.invoiceId,issued.body.invoice.id);
  assert.equal(f.store.listInvoices(workspace).length,1);assert.equal(f.store.audits(workspace).length,1);
  // Same key and new-key retries of the same payload return the same invoice.
  assert.deepEqual(JSON.parse(JSON.stringify(f.service.issue(workspace,id,path,'issue-once'))),JSON.parse(JSON.stringify(issued)));
  assert.deepEqual(JSON.parse(JSON.stringify(f.service.issue(workspace,id,path,'brand-new-retry-key'))),JSON.parse(JSON.stringify(issued)));
  assert.equal(f.store.listInvoices(workspace).length,1);
  // A changed payload cannot re-issue the draft under any key.
  assert.throws(()=>f.service.issue(workspace,id,{expectedRevision:saved.draft.revision,invoice:invoice({title:'Changed after issue'})},'changed-key'),{status:409});
  assert.throws(()=>f.service.issue(workspace,id,path,''),{status:400});
  // Issued drafts are immutable and undeletable; the issue record is retained.
  assert.throws(()=>f.service.save(workspace,id,{expectedRevision:issued.body.draft.revision,snapshot:snapshot({title:'Edit after issue'})}),{status:409});
  assert.throws(()=>f.service.remove(workspace,id),{status:409});
  assert.equal(f.service.get(workspace,id).status,'issued');
  assert.equal(f.service.issue(workspace,id,path,'post-delete-retry').body.invoice.id,issued.body.invoice.id);
  }finally{f.store.close();}
});

test('issuing requires the exact saved revision and a wrong owner sees nothing',()=>{
  const f=fixture();try{
  const id=randomUUID();
  f.service.save(workspace,id,{expectedRevision:0,snapshot:snapshot()});
  f.service.save(workspace,id,{expectedRevision:1,snapshot:snapshot({title:'Fictional second save'})});
  assert.throws(()=>f.service.issue(workspace,id,{expectedRevision:1,invoice:invoice()},'stale-revision'),{status:409});
  assert.equal(f.store.listInvoices(workspace).length,0);
  const issued=f.service.issue(workspace,id,{expectedRevision:2,invoice:invoice()},'current-revision');
  assert.equal(issued.body.invoice.number,'QL-0001');
  // Tenant isolation: another workspace cannot read, save or issue this draft.
  assert.throws(()=>f.service.get(other,id),{status:404});
  assert.throws(()=>f.service.save(other,id,{expectedRevision:2,snapshot:snapshot()}),{status:404});
  assert.throws(()=>f.service.remove(other,id),{status:404});
  assert.throws(()=>f.service.issue(other,id,{expectedRevision:2,invoice:invoice()},'cross-tenant'),{status:404});
  assert.equal(f.service.list(other).length,0);
  }finally{f.store.close();}
});

test('unissued drafts are discarded exactly once; encrypted file restart restores the draft',()=>{
  const dir=mkdtempSync(join(tmpdir(),'fictional-invoice-drafts-')),path=join(dir,'fixture.sqlite');let a:Store|undefined,b:Store|undefined;
  try{
  a=new Store(path,{encryptionKey:key});const service=new InvoiceEditorDrafts(a,now);
  const id=randomUUID();service.save(workspace,id,{expectedRevision:0,snapshot:snapshot({title:'Fictional restart draft'})});
  service.remove(workspace,id);assert.throws(()=>service.remove(workspace,id),{status:404});assert.equal(service.list(workspace).length,0);
  const kept=randomUUID();service.save(workspace,kept,{expectedRevision:0,snapshot:snapshot({title:'Fictional kept draft',carriedExpenseAck:expenseFingerprint([snapshot().lines[1]])})});
  b=new Store(path,{encryptionKey:key});const restored=new InvoiceEditorDrafts(b,now);
  const draft=restored.get(workspace,kept);
  assert.equal(draft.snapshot.title,'Fictional kept draft');assert.equal(draft.revision,1);assert.equal(draft.snapshot.carriedExpenseAck,expenseFingerprint([snapshot().lines[1]]));
  assert.deepEqual(restored.save(workspace,kept,{expectedRevision:1,snapshot:snapshot({title:'Fictional edited after restart'})}).draft,{id:kept,revision:2,createdAt:draft.createdAt,updatedAt:draft.updatedAt,status:'draft',title:'Fictional edited after restart',customerName:'Fictional Drafts Studio',currency:'CAD'});
  assert(!readFileSync(path).includes(Buffer.from('FICTIONAL_DRAFTS_PRIVATE_NOTE')));
  assert(!readFileSync(path).includes(Buffer.from('Fictional Drafts Studio')));
  }finally{b?.close();a?.close();rmSync(dir,{recursive:true,force:true});}
});
