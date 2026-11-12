import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Store,DomainError} from '../server/store.js';
import {InvoiceLedger} from '../server/invoice-ledger.js';
import {ReceivingService} from '../server/receiving-service.js';
import {createInvoice,settleInvoice} from '../server/domain.js';
import type {ReceivingAdapter} from '../shared/receiving.js';
import {BillingRecords} from '../server/billing-records.js';
import type {Currency} from '../shared/contracts.js';

const workspace='fictional-billing-owner',other='fictional-billing-other';
const when=()=>new Date('2026-11-08T12:00:00Z');
const invoiceInput={customerName:'Fictional Billing Client',title:'Fictional milestone work',currency:'CAD',items:[{description:'Fictional milestone delivery',quantity:1,unitAmount:125000}]};
const SECRET_LABEL='Zephyr-Handshake-Blueprint',SECRET_URL='https://files.fictional.example/zephyr-handshake-blueprint.zip',SECRET_PROJECT='Aurora-Lantern-Planning';

function fixture(){
  const store=new Store(':memory:',{encryptionKey:Buffer.alloc(32,77)}),ledger=new InvoiceLedger(store),billing=new BillingRecords(store,ledger,when);
  return {store,ledger,billing,close:()=>store.close()};
}
/** A live receiving service over a fictional provider that reports paid on demand. */
function liveReceiving(store:Store,ledger:InvoiceLedger){
  let paid=false;
  const adapter:ReceivingAdapter={id:'fictional-billing-live',mode:'live',methods:['bank','lightning','wire'],
    create:async context=>({providerId:context.requestId,request:'fictional-billing-request',network:'fiat',asset:'CAD'}),
    check:async context=>paid?{status:'paid',paymentId:'fictional-billing-pay-'+context.requestId,reference:context.requestId,amount:context.amount,currency:context.currency}:{status:'pending'}};
  const service=new ReceivingService(store,[adapter],async invoice=>({expectedAtomic:String(invoice.total*10),...(invoice.totalCad!==undefined?{cadEquivalent:invoice.totalCad}:{}),source:'fictional billing quote',observedAt:when().toISOString()}),when,undefined,ledger.agreements);
  return {service,markPaid(){paid=true;}};
}
async function livePay(store:Store,ledger:InvoiceLedger,workspaceId:string,invoice:{id:string},amount?:number,verification:'provider'|'manual'='provider'){
  const {service,markPaid}=liveReceiving(store,ledger);
  const request=await service.create(workspaceId,{invoiceId:invoice.id,method:'bank',adapterId:'fictional-billing-live',...(amount!==undefined?{amount}:{})},randomUUID());
  if(verification==='manual')return service.confirm(request.id,workspaceId,'Fictional owner bank review','fictional-bank-ref-'+randomUUID().slice(0,8));
  markPaid();return service.check(request.id,workspaceId);
}
function rawBillingRows(store:Store){
  return ['billing_projects','billing_milestones','billing_deliverables'].flatMap(table=>store.db.prepare(`SELECT * FROM ${table}`).all().map(row=>JSON.stringify(row)));
}

test('planning records round-trip exact integer amounts in every supported currency inside encrypted payloads',()=>{
  const f=fixture();try{
    const project=f.billing.createProject(workspace,SECRET_PROJECT);
    assert.equal(project.name,SECRET_PROJECT);
    const planned:[Currency,number][]=[['CAD',125000],['USD',99000],['KRW',144001],['EUR',50001],['GBP',75000],['SAT',21000000]];
    for(const [currency,amount] of planned){
      const milestone=f.billing.createMilestone(workspace,{label:`Fictional ${currency} milestone`,amount,currency,projectId:project.id});
      assert.equal(milestone.amount,amount);assert.equal(milestone.currency,currency);
      const view=f.billing.milestone(workspace,milestone.id);
      assert.equal(view.amount,amount);assert.equal(view.currency,currency);assert.equal(view.projectId,project.id);
    }
    const overview=f.billing.overview(workspace);
    assert.equal(overview.projects.length,1);assert.equal(overview.projects[0].milestones.length,6);
    assert.deepEqual(overview.projects[0].milestones.map(row=>[row.currency,row.amount]),planned);
    // Nothing readable outside the caller's view: the raw database rows are ciphertext.
    const rows=rawBillingRows(f.store).join('\n');
    for(const secret of [SECRET_PROJECT,'Fictional CAD milestone','144001','21000000'])assert(!rows.includes(secret),`plaintext leaked: ${secret}`);
  }finally{f.close();}
});

test('cross-workspace reads return nothing and foreign invoice links are rejected inside the transaction',()=>{
  const f=fixture();try{
    const project=f.billing.createProject(workspace,SECRET_PROJECT),invoice=createInvoice(f.store,workspace,invoiceInput,when());
    const foreignInvoice=createInvoice(f.store,other,{...invoiceInput,customerName:'Fictional Other Client'},when());
    assert.equal(f.billing.overview(other).projects.length,0);
    assert.throws(()=>f.billing.milestone(other,project.id),(error:unknown)=>error instanceof DomainError&&error.status===404);
    assert.throws(()=>f.billing.updateMilestone(other,project.id,{label:'stolen'}),(error:unknown)=>error instanceof DomainError&&error.status===404);
    assert.throws(()=>f.billing.createMilestone(other,{label:'Foreign milestone',amount:1000,currency:'CAD',invoiceId:invoice.id}),(error:unknown)=>error instanceof DomainError&&error.status===404);
    assert.throws(()=>f.billing.createDeliverable(other,{invoiceId:invoice.id,label:SECRET_LABEL,url:SECRET_URL}),(error:unknown)=>error instanceof DomainError&&error.status===404);
    // A milestone may only link an invoice in the same workspace, rechecked inside the write.
    const milestone=f.billing.createMilestone(workspace,{label:'Fictional linking milestone',amount:125000,currency:'CAD',projectId:project.id});
    assert.throws(()=>f.billing.updateMilestone(workspace,milestone.id,{invoiceId:foreignInvoice.id}),(error:unknown)=>error instanceof DomainError&&error.status===404);
    f.billing.updateMilestone(workspace,milestone.id,{invoiceId:invoice.id});
    assert.equal(f.billing.milestone(workspace,milestone.id).invoice?.id,invoice.id);
    // The public helper never serves another workspace.
    assert.deepEqual(f.billing.publicDeliverables(other,invoice.id),[]);
  }finally{f.close();}
});

test('record caps fail closed with 429 and never evict existing records',()=>{
  const f=fixture();try{
    for(let index=0;index<100;index++)f.billing.createProject(workspace,`Fictional project ${index}`);
    assert.throws(()=>f.billing.createProject(workspace,'One project too many'),(error:unknown)=>error instanceof DomainError&&error.status===429);
    assert.equal(f.billing.overview(workspace).projects.length,100);
    f.billing.deleteProject(workspace,f.billing.overview(workspace).projects.at(-1)!.id);
    assert.equal(f.billing.overview(workspace).projects.length,99);
    const again=f.billing.createProject(workspace,'Fictional replacement project');
    assert.equal(again.name,'Fictional replacement project');
    const invoice=createInvoice(f.store,workspace,invoiceInput,when());
    for(let index=0;index<20;index++)f.billing.createDeliverable(workspace,{invoiceId:invoice.id,label:`Fictional deliverable ${index}`,url:`https://files.fictional.example/deliverable-${index}.zip`});
    assert.throws(()=>f.billing.createDeliverable(workspace,{invoiceId:invoice.id,label:'One per invoice too many',url:SECRET_URL}),(error:unknown)=>error instanceof DomainError&&error.status===429);
    for(let index=0;index<49;index++){
      const extra=createInvoice(f.store,workspace,{...invoiceInput,customerName:`Fictional cap client ${index}`},when());
      for(let deliverable=0;deliverable<20;deliverable++)f.billing.createDeliverable(workspace,{invoiceId:extra.id,label:'Fictional deliverable',url:'https://files.fictional.example/fictional.zip'});
    }
    const spare=createInvoice(f.store,workspace,{...invoiceInput,customerName:'Fictional spare client'},when());
    assert.throws(()=>f.billing.createDeliverable(workspace,{invoiceId:spare.id,label:'One per workspace too many',url:SECRET_URL}),(error:unknown)=>error instanceof DomainError&&error.status===429);
    for(let index=0;index<500;index++)f.billing.createMilestone(workspace,{label:`Fictional milestone ${index}`,amount:1000,currency:'CAD'});
    assert.throws(()=>f.billing.createMilestone(workspace,{label:'One milestone too many',amount:1000,currency:'CAD'}),(error:unknown)=>error instanceof DomainError&&error.status===429);
    assert.equal(f.billing.overview(workspace).looseMilestones.length,500);
  }finally{f.close();}
});

test('the paid gate stays closed for unpaid, simulated, credited, partial, self-reported and unverified states',async()=>{
  const f=fixture();try{
    const unpaid=createInvoice(f.store,workspace,invoiceInput,when());
    const releasedUnpaid=f.billing.createDeliverable(workspace,{invoiceId:unpaid.id,label:SECRET_LABEL,url:SECRET_URL});
    f.billing.release(workspace,releasedUnpaid.id);
    assert.deepEqual(f.billing.publicDeliverables(workspace,unpaid.id),[]);
    // A simulated settlement never unlocks.
    const simulatedInvoice=createInvoice(f.store,workspace,invoiceInput,when());
    settleInvoice(f.store,workspace,simulatedInvoice,'cashu',when());
    const releasedSimulated=f.billing.createDeliverable(workspace,{invoiceId:simulatedInvoice.id,label:SECRET_LABEL,url:SECRET_URL});
    f.billing.release(workspace,releasedSimulated.id);
    assert.deepEqual(f.billing.publicDeliverables(workspace,simulatedInvoice.id),[]);
    // A credit note never marks an invoice paid.
    const credited=createInvoice(f.store,workspace,invoiceInput,when());
    f.ledger.credit(workspace,credited.id,125000,'Fictional full credit note',when());
    const releasedCredited=f.billing.createDeliverable(workspace,{invoiceId:credited.id,label:SECRET_LABEL,url:SECRET_URL});
    f.billing.release(workspace,releasedCredited.id);
    assert.deepEqual(f.billing.publicDeliverables(workspace,credited.id),[]);
    // A partial live payment is not sufficient.
    const partial=createInvoice(f.store,workspace,invoiceInput,when());
    await livePay(f.store,f.ledger,workspace,partial,100000);
    const releasedPartial=f.billing.createDeliverable(workspace,{invoiceId:partial.id,label:SECRET_LABEL,url:SECRET_URL});
    f.billing.release(workspace,releasedPartial.id);
    assert.deepEqual(f.billing.publicDeliverables(workspace,partial.id),[]);
    // A self-reported status flag without live receipt-backed records is not evidence.
    const selfReported=createInvoice(f.store,workspace,invoiceInput,when());
    f.store.saveInvoice({...selfReported,status:'paid',paidAt:when().toISOString(),paymentMethod:'bank',settlementMode:'live'});
    const releasedSelfReported=f.billing.createDeliverable(workspace,{invoiceId:selfReported.id,label:SECRET_LABEL,url:SECRET_URL});
    f.billing.release(workspace,releasedSelfReported.id);
    assert.deepEqual(f.billing.publicDeliverables(workspace,selfReported.id),[]);
    // Unrelease hides again without touching anything else.
    const locked=createInvoice(f.store,workspace,invoiceInput,when());
    await livePay(f.store,f.ledger,workspace,locked);
    const releasedLocked=f.billing.createDeliverable(workspace,{invoiceId:locked.id,label:SECRET_LABEL,url:SECRET_URL});
    assert.deepEqual(f.billing.publicDeliverables(workspace,locked.id),[]);
    f.billing.release(workspace,releasedLocked.id);
    assert.deepEqual(f.billing.publicDeliverables(workspace,locked.id),[{label:SECRET_LABEL,url:SECRET_URL}]);
    f.billing.unrelease(workspace,releasedLocked.id);
    assert.deepEqual(f.billing.publicDeliverables(workspace,locked.id),[]);
  }finally{f.close();}
});

test('the paid gate opens only for authoritative live receipt-backed payment at the effective total',async()=>{
  const f=fixture();try{
    const invoice=createInvoice(f.store,workspace,invoiceInput,when());
    const deliverable=f.billing.createDeliverable(workspace,{invoiceId:invoice.id,label:SECRET_LABEL,url:SECRET_URL});
    f.billing.release(workspace,deliverable.id);
    assert.deepEqual(f.billing.publicDeliverables(workspace,invoice.id),[]);
    await livePay(f.store,f.ledger,workspace,invoice);
    const view=f.ledger.read(workspace,invoice.id);
    assert.equal(view.balance.state,'paid');assert.equal(view.balance.mode,'live');
    assert.deepEqual(f.billing.publicDeliverables(workspace,invoice.id),[{label:SECRET_LABEL,url:SECRET_URL}]);
    // Revoking checkout links hides the deliverable again on the next fresh read.
    f.store.revokeInvoiceLinks(invoice.id,workspace,when().toISOString());
    assert.deepEqual(f.billing.publicDeliverables(workspace,invoice.id),[]);
    // An owner-confirmed manual bank receipt is a valid live ledger record.
    const manual=createInvoice(f.store,workspace,{...invoiceInput,customerName:'Fictional manual client'},when());
    const manualDeliverable=f.billing.createDeliverable(workspace,{invoiceId:manual.id,label:SECRET_LABEL,url:SECRET_URL});
    await livePay(f.store,f.ledger,workspace,manual,undefined,'manual');
    f.billing.release(workspace,manualDeliverable.id);
    assert.deepEqual(f.billing.publicDeliverables(workspace,manual.id),[{label:SECRET_LABEL,url:SECRET_URL}]);
    // Demo and hackathon workspaces never expose deliverables, even when live-paid and released.
    f.store.db.exec('CREATE TABLE IF NOT EXISTS hackathon_demo_workspaces (id TEXT PRIMARY KEY)');
    f.store.db.prepare('INSERT INTO hackathon_demo_workspaces(id) VALUES(?)').run('fictional-hackathon-workspace');
    const hackathon=createInvoice(f.store,'fictional-hackathon-workspace',invoiceInput,when());
    await livePay(f.store,f.ledger,'fictional-hackathon-workspace',hackathon);
    const hackathonDeliverable=f.billing.createDeliverable('fictional-hackathon-workspace',{invoiceId:hackathon.id,label:SECRET_LABEL,url:SECRET_URL});
    f.billing.release('fictional-hackathon-workspace',hackathonDeliverable.id);
    assert.deepEqual(f.billing.publicDeliverables('fictional-hackathon-workspace',hackathon.id),[]);
    assert.deepEqual(f.billing.publicDeliverables('demo',hackathon.id),[]);
  }finally{f.close();}
});

test('changing a released deliverable URL clears its release; a label-only edit keeps it',async()=>{
  const f=fixture();try{
    const invoice=createInvoice(f.store,workspace,invoiceInput,when());
    await livePay(f.store,f.ledger,workspace,invoice);
    const deliverable=f.billing.createDeliverable(workspace,{invoiceId:invoice.id,label:SECRET_LABEL,url:SECRET_URL});
    f.billing.release(workspace,deliverable.id);
    assert.deepEqual(f.billing.publicDeliverables(workspace,invoice.id),[{label:SECRET_LABEL,url:SECRET_URL}]);
    const relabelled=f.billing.updateDeliverable(workspace,deliverable.id,{label:'Renamed fictional deliverable'});
    assert.equal(relabelled.released,true);
    assert.deepEqual(f.billing.publicDeliverables(workspace,invoice.id),[{label:'Renamed fictional deliverable',url:SECRET_URL}]);
    const redirected=f.billing.updateDeliverable(workspace,deliverable.id,{url:'https://files.fictional.example/replacement-blueprint.zip'});
    assert.equal(redirected.released,false);
    assert.deepEqual(f.billing.publicDeliverables(workspace,invoice.id),[]);
    f.billing.release(workspace,deliverable.id);
    assert.deepEqual(f.billing.publicDeliverables(workspace,invoice.id),[{label:'Renamed fictional deliverable',url:'https://files.fictional.example/replacement-blueprint.zip'}]);
  }finally{f.close();}
});

test('deleting planning rows preserves invoices, ledger entries and deliverables',async()=>{
  const f=fixture();try{
    const project=f.billing.createProject(workspace,SECRET_PROJECT),invoice=createInvoice(f.store,workspace,invoiceInput,when());
    await livePay(f.store,f.ledger,workspace,invoice);
    const milestone=f.billing.createMilestone(workspace,{label:'Fictional paid milestone',amount:125000,currency:'CAD',projectId:project.id,invoiceId:invoice.id});
    const deliverable=f.billing.createDeliverable(workspace,{invoiceId:invoice.id,label:SECRET_LABEL,url:SECRET_URL});
    // A project with milestones refuses deletion instead of cascading.
    assert.throws(()=>f.billing.deleteProject(workspace,project.id),(error:unknown)=>error instanceof DomainError&&error.status===409);
    f.billing.deleteMilestone(workspace,milestone.id);
    assert.equal(f.store.getInvoice(invoice.id,workspace)!.id,invoice.id);
    assert.equal(f.ledger.read(workspace,invoice.id).entries.filter(entry=>entry.kind==='payment').length,1);
    assert.equal(f.billing.overview(workspace).deliverables.length,1);
    assert.throws(()=>f.billing.milestone(workspace,milestone.id),(error:unknown)=>error instanceof DomainError&&error.status===404);
    // With no milestones left, the empty project can be deleted.
    f.billing.deleteProject(workspace,project.id);
    assert.equal(f.billing.overview(workspace).projects.length,0);
    // The deliverable is unaffected until its own explicit delete.
    f.billing.deleteDeliverable(workspace,deliverable.id);
    assert.equal(f.billing.overview(workspace).deliverables.length,0);
    assert.deepEqual(f.billing.publicDeliverables(workspace,invoice.id),[]);
  }finally{f.close();}
});

test('milestone views enrich from the live ledger and never override authoritative totals',async()=>{
  const f=fixture();try{
    const invoice=createInvoice(f.store,workspace,invoiceInput,when());
    const project=f.billing.createProject(workspace,SECRET_PROJECT);
    const milestone=f.billing.createMilestone(workspace,{label:'Fictional planned milestone',amount:999000,currency:'CAD',projectId:project.id});
    f.billing.updateMilestone(workspace,milestone.id,{invoiceId:invoice.id});
    const before=f.billing.milestone(workspace,milestone.id);
    assert.equal(before.amount,999000);
    assert.equal(before.invoice?.effectiveTotal,125000);
    assert.equal(before.invoice?.state,'unpaid');
    assert.equal(before.invoice?.mode,'live');
    assert.equal(before.invoice?.number,invoice.number);
    assert.equal(before.invoice?.currency,'CAD');
    await livePay(f.store,f.ledger,workspace,invoice);
    const after=f.billing.milestone(workspace,milestone.id);
    assert.equal(after.invoice?.state,'paid');assert.equal(after.invoice?.paid,125000);assert.equal(after.invoice?.due,0);
    assert.equal(after.amount,999000);
    // Deliverable status is included with a live release-readiness view.
    const deliverable=f.billing.createDeliverable(workspace,{invoiceId:invoice.id,label:SECRET_LABEL,url:SECRET_URL});
    const overview=f.billing.overview(workspace);
    assert.equal(overview.projects[0].milestones[0].deliverables[0].id,deliverable.id);
    assert.equal(overview.projects[0].milestones[0].deliverables[0].released,false);
    assert.equal(overview.projects[0].milestones[0].deliverables[0].releaseReady,true);
    assert.equal(overview.deliverables[0].releaseReady,true);
  }finally{f.close();}
});

test('billing modules never fetch outbound and keep URLs out of audit text',async()=>{
  const f=fixture();try{
    for(const file of ['server/billing-records.ts','server/billing-router.ts']){
      const source=readFileSync(new URL('../'+file,import.meta.url),'utf8');
      assert(!/fetch\(|node:http|https\.request|axios|XMLHttpRequest/.test(source),`${file} must not perform outbound requests`);
    }
    const invoice=createInvoice(f.store,workspace,invoiceInput,when());
    await livePay(f.store,f.ledger,workspace,invoice);
    const deliverable=f.billing.createDeliverable(workspace,{invoiceId:invoice.id,label:SECRET_LABEL,url:SECRET_URL});
    f.billing.release(workspace,deliverable.id);
    f.billing.updateDeliverable(workspace,deliverable.id,{url:'https://files.fictional.example/changed-destination.zip'});
    f.billing.unrelease(workspace,deliverable.id);
    const audits=JSON.stringify(f.store.audits(workspace,true));
    assert(!audits.includes('files.fictional.example'),`URL leaked into audits: ${audits}`);
    assert(!audits.includes(SECRET_URL));
  }finally{f.close();}
});

test('service boundaries enforce the same label amount and HTTPS link rules as the router',()=>{
 const f=fixture();try{
  const invoice=createInvoice(f.store,workspace,invoiceInput,when());
  for(const name of ['', 'x'.repeat(241),'bad\nname'])assert.throws(()=>f.billing.createProject(workspace,name),{status:400});
  for(const amount of [0,1.5,1_000_000_001])assert.throws(()=>f.billing.createMilestone(workspace,{label:'Fictional plan',amount,currency:'CAD'}),{status:400});
  for(const url of ['javascript:alert(1)','data:text/html,fictional','http://files.example.invalid','https://user:password@files.example.invalid'])assert.throws(()=>f.billing.createDeliverable(workspace,{invoiceId:invoice.id,label:'Fictional file',url}),{status:400});
  const deliverable=f.billing.createDeliverable(workspace,{invoiceId:invoice.id,label:'Fictional file',url:SECRET_URL});
  assert.throws(()=>f.billing.updateDeliverable(workspace,deliverable.id,{url:'javascript:alert(1)'}),{status:400});
  assert.throws(()=>f.billing.updateDeliverable(workspace,deliverable.id,{label:' '}),{status:400});
  assert.equal(f.billing.overview(workspace).projects.length,0);assert.equal(f.billing.overview(workspace).deliverables.length,1);
 }finally{f.close();}
});

test('a forged live entry with mismatched invoice or receipt amounts and currency cannot unlock delivery',()=>{
 for(const change of ['entry-currency','receipt-currency','receipt-amount']){
  const f=fixture();try{
   const invoice=createInvoice(f.store,workspace,invoiceInput,when()),id=randomUUID();
   const entry={id,kind:'payment',amount:invoice.total,currency:change==='entry-currency'?'USD':'CAD',createdAt:when().toISOString(),method:'bank',verification:'manual',receipt:{number:'FICTIONAL-RECEIPT',issuedAt:when().toISOString(),mode:'live',method:'bank',amount:change==='receipt-amount'?1:invoice.total,currency:change==='receipt-currency'?'USD':'CAD',invoiceNumber:invoice.number,title:invoice.title,customerName:invoice.customerName}};
   f.store.db.prepare('INSERT INTO invoice_ledger_entries(id,workspace,invoice_id,receiving_id,receipt_token,data) VALUES(?,?,?,?,?,?)').run(id,workspace,invoice.id,'fictional-forged-'+id,null,f.store.encode(entry,'invoice_ledger_entries',id,workspace));
   const deliverable=f.billing.createDeliverable(workspace,{invoiceId:invoice.id,label:SECRET_LABEL,url:SECRET_URL});f.billing.release(workspace,deliverable.id);
   assert.equal(f.ledger.balance(invoice,workspace).state,'paid');
   assert.deepEqual(f.billing.publicDeliverables(workspace,invoice.id),[]);
   assert.equal(f.billing.overview(workspace).deliverables[0].releaseReady,false);
  }finally{f.close();}
 }
});

test('label-only billing edits leave audit records and project delete does not suggest an unavailable move',()=>{
 const f=fixture();try{
  const invoice=createInvoice(f.store,workspace,invoiceInput,when()),project=f.billing.createProject(workspace,'Fictional audit project');
  const milestone=f.billing.createMilestone(workspace,{label:'Fictional stage',amount:100,currency:'CAD',projectId:project.id});
  const deliverable=f.billing.createDeliverable(workspace,{invoiceId:invoice.id,label:'Fictional file',url:SECRET_URL});
  const before=f.store.audits(workspace,true).length;
  f.billing.updateMilestone(workspace,milestone.id,{label:'Fictional new stage'});f.billing.updateDeliverable(workspace,deliverable.id,{label:'Fictional new file'});
  assert.equal(f.store.audits(workspace,true).length,before+2);
  assert.ok(!JSON.stringify(f.store.audits(workspace,true)).includes(SECRET_URL));
  assert.throws(()=>f.billing.deleteProject(workspace,project.id),(error:unknown)=>error instanceof DomainError&&error.status===409&&/Delete them first/.test(error.message)&&!/move/.test(error.message));
 }finally{f.close();}
});
