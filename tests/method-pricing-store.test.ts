import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {createInvoice} from '../server/domain.js';
import {InvoiceLedger} from '../server/invoice-ledger.js';
import {PaymentReports} from '../server/payment-reports.js';
import {SquareSandbox} from '../server/square-sandbox.js';
import {ReceivingService} from '../server/receiving-service.js';
import {MethodPriceAgreements} from '../server/method-pricing.js';
import type {MethodPricedInvoice,MethodPricingRule} from '../shared/method-pricing-types.js';

// Fictional test key, shared with tests/fixtures/method-pricing-worker.ts.
const FICTIONAL_KEY=Buffer.alloc(32,47);
const now=()=>new Date('2026-11-06T12:00:00Z');
const workspace='fictional-pricing-account';
const otherWorkspace='fictional-pricing-other';
const baseInput={customerName:'FICTIONAL PRICING CUSTOMER SENTINEL',title:'Fictional method-priced project',currency:'CAD',
  items:[{description:'Fictional labour',quantity:1,unitAmount:200000},{description:'Fictional flights',quantity:1,unitAmount:80000,kind:'expense'}],discountBps:500,taxBps:500};
const rules:MethodPricingRule[]=[{method:'lightning',discountBps:1000},{method:'card',premiumBps:200}];

function fixture(options:{workspace?:string;rules?:MethodPricingRule[]|false}={}){
  const dir=mkdtempSync(join(tmpdir(),'ql-method-pricing-')),path=join(dir,'store.sqlite');
  const store=new Store(path,{encryptionKey:FICTIONAL_KEY});
  const ledger=new InvoiceLedger(store);
  const receiving=new ReceivingService(store,[],async()=>({expectedAtomic:'1',source:'fictional test quote',observedAt:'2026-11-06T00:00:00Z'}),now);
  const square=new SquareSandbox(store,undefined,now);
  const reports=new PaymentReports(store);
  const pricing=new MethodPriceAgreements(store,now);
  const invoice=createInvoice(store,options.workspace??workspace,baseInput,now());
  const priced=(options.rules===false?{...invoice}:{...invoice,methodPricing:options.rules??rules}) as MethodPricedInvoice;
  store.saveInvoice(priced);
  return {store,ledger,receiving,square,reports,pricing,invoice:priced,dir,path};
}
function confirmInput(invoice:MethodPricedInvoice,method:string,offerHash:string){return {checkoutToken:invoice.token,method,offerHash};}
function insertReceivingRequest(store:Store,ws:string,invoiceId:string,overrides:Record<string,unknown>={}){
  const id=randomUUID(),token=randomUUID();
  const record={id,token,invoiceId,invoiceNumber:'QL-0001',method:'lightning',adapterId:'fictional-test',mode:'live',status:'awaiting_payment',amount:1000,currency:'CAD',expectedAtomic:'10000',
    createdAt:'2026-11-06T11:00:00Z',expiresAt:'2026-11-06T13:00:00Z',workspace:ws,
    context:{requestId:id,method:'lightning',amount:1000,currency:'CAD',expectedAtomic:'10000',idempotencyKey:id,createdAt:'2026-11-06T11:00:00Z',expiresAt:'2026-11-06T13:00:00Z',mode:'live'},
    quote:{expectedAtomic:'10000',source:'fictional test quote',observedAt:'2026-11-06T11:00:00Z'},...overrides};
  store.db.prepare('INSERT INTO receiving_requests(id,workspace,invoice_id,token,data) VALUES(?,?,?,?,?)').run(id,ws,invoiceId,store.tokenIndex(token),store.encode(record,'receiving_requests',id,ws));
}
function insertSquareCheckout(store:Store,invoiceId:string){
  const id=randomUUID(),token=randomUUID();
  store.db.prepare('INSERT INTO square_test_checkouts(id,invoice_id,token,data) VALUES(?,?,?,?)').run(id,invoiceId,store.tokenIndex(token),
    store.encode({id,token,invoiceId,invoiceNumber:'QL-0001',amount:283500,currency:'CAD',mode:'square_sandbox',status:'awaiting_payment',createdAt:'2026-11-06T11:00:00Z'},'square_test_checkouts',id,'owner'));
}
/** Legacy commitment rows exactly as pre-pricing data appears: the gated report/credit/settle
 *  paths now require the payer agreement first, so blocked states are inserted directly. */
function insertPaymentReport(store:Store,ws:string,invoiceId:string){
  const id=randomUUID();
  store.db.prepare('INSERT INTO payment_reports(id,workspace,invoice_id,method,data) VALUES(?,?,?,?,?)').run(id,ws,invoiceId,'cashu',
    store.encode({id,invoiceId,invoiceNumber:'QL-0001',method:'cashu',amount:283500,currency:'CAD',status:'reported',createdAt:'2026-11-06T11:30:00Z'},'payment_reports',id,ws));
}
function insertLedgerEntry(store:Store,ws:string,invoiceId:string,kind:'credit'|'void'){
  const id=randomUUID();
  store.db.prepare('INSERT INTO invoice_ledger_entries(id,workspace,invoice_id,receiving_id,receipt_token,data) VALUES(?,?,?,?,?,?)').run(id,ws,invoiceId,null,null,
    store.encode({id,kind,amount:100,currency:'CAD',createdAt:'2026-11-06T11:30:00Z',reason:'Fictional legacy adjustment'},'invoice_ledger_entries',id,ws));
}

test('server offers price payable methods and one explicit idempotent lock persists exact amounts',()=>{
  const f=fixture();try{
    const offers=Object.fromEntries(f.pricing.offers(workspace,f.invoice,method=>method==='card'||method==='lightning').map(offer=>[offer.method,offer]));
    assert.deepEqual(Object.keys(offers).sort(),['card','lightning']);
    const lightning=offers.lightning;
    assert.match(lightning.offerHash,/^[0-9a-f]{64}$/);
    assert.deepEqual([lightning.issuedTotal,lightning.discountAmount,lightning.effectiveTax,lightning.effectiveTotal,lightning.taxAdjustment,lightning.totalAdjustment,lightning.referenceTotalCad,lightning.referenceAmountSats],[283500,20000,12500,262500,-1000,-21000,262500,2625000]);
    assert.deepEqual([offers.card.premiumAmount,offers.card.effectiveTotal,offers.card.totalAdjustment],[4000,287700,4200]);
    const confirmed=f.pricing.confirm(confirmInput(f.invoice,'lightning',lightning.offerHash),'confirm-key-1',()=>true);
    const agreement=confirmed.agreement;
    assert.deepEqual([agreement.method,agreement.effectiveTotal,agreement.offerHash,agreement.confirmation],['lightning',262500,lightning.offerHash,'public_checkout_token']);
    // Public projection removes invoiceId and the labelled CAD reference, keeps the legacy satoshi reference.
    assert.equal('invoiceId' in agreement,false);assert.equal('referenceTotalCad' in agreement,false);assert.equal(agreement.referenceAmountSats,2625000);
    // The stored full agreement retains the private binding fields for owner reads.
    const saved=f.pricing.forInvoice(workspace,f.invoice.id)!;
    assert.deepEqual([saved.invoiceId,saved.referenceTotalCad,saved.effectiveTotal],[f.invoice.id,262500,262500]);
    // Same key and body replay byte-identically.
    const replay=f.pricing.confirm(confirmInput(f.invoice,'lightning',lightning.offerHash),'confirm-key-1',()=>true);
    assert.equal(JSON.stringify(replay),JSON.stringify(confirmed));
    // Altered body under the saved key and a second key racing the lock both return 409.
    assert.throws(()=>f.pricing.confirm(confirmInput(f.invoice,'card',offers.card.offerHash),'confirm-key-1',()=>true),{status:409});
    assert.throws(()=>f.pricing.confirm(confirmInput(f.invoice,'card',offers.card.offerHash),'confirm-key-2',()=>true),{status:409,code:'METHOD_AGREEMENT_LOCKED'});
    assert.deepEqual(f.pricing.offers(workspace,f.invoice,()=>true),[]);
    assert.equal(f.pricing.require(workspace,f.invoice)?.effectiveTotal,262500);
  }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('confirmation writes no payment credit or invoice mutation',()=>{
  const f=fixture();try{
    const offer=f.pricing.offers(workspace,f.invoice,()=>true).find(row=>row.method==='lightning')!;
    const before=JSON.stringify(f.store.db.prepare('SELECT id,workspace,token,data FROM invoices WHERE id=?').get(f.invoice.id));
    f.pricing.confirm(confirmInput(f.invoice,'lightning',offer.offerHash),'no-mutation-key',()=>true);
    assert.equal(JSON.stringify(f.store.db.prepare('SELECT id,workspace,token,data FROM invoices WHERE id=?').get(f.invoice.id)),before);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM invoice_ledger_entries').get()!.n,0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM receipts').get()!.n,0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM payouts').get()!.n,0);
    const events=f.store.audits(workspace).filter(event=>event.action==='invoice.method_price_confirmed');
    assert.equal(events.length,1);
    assert.ok(events[0].description.includes('QL-0001')&&events[0].description.includes('lightning')&&events[0].description.includes('262500'));
    assert.ok(!events[0].description.includes('SENTINEL'));
  }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('commitments prevent a late method agreement',()=>{
  const blockers:{name:string;setup:(f:ReturnType<typeof fixture>)=>void}[]=[
    {name:'saved receiving request',setup:f=>insertReceivingRequest(f.store,workspace,f.invoice.id)},
    {name:'expired receiving request',setup:f=>insertReceivingRequest(f.store,workspace,f.invoice.id,{status:'awaiting_payment',expiresAt:'2026-11-06T00:30:00Z'})},
    {name:'creation-uncertain receiving request',setup:f=>insertReceivingRequest(f.store,workspace,f.invoice.id,{status:'creation_pending',creationUncertain:true})},
    {name:'square test checkout',setup:f=>insertSquareCheckout(f.store,f.invoice.id)},
    {name:'manual payment report',setup:f=>{insertPaymentReport(f.store,workspace,f.invoice.id);}},
    {name:'ledger credit',setup:f=>{insertLedgerEntry(f.store,workspace,f.invoice.id,'credit');}},
    {name:'ledger void',setup:f=>{f.ledger.void(workspace,f.invoice.id,'Fictional cancellation',now());}},
    {name:'legacy simulated payment',setup:f=>{f.store.saveInvoice({...f.invoice,status:'paid',paymentMethod:'cashu',settlementMode:'simulation'});}},
  ];
  for(const blocker of blockers){
    const f=fixture();try{
      blocker.setup(f);
      const offer=f.pricing.offers(workspace,f.invoice,()=>true).find(row=>row.method==='lightning')!;
      assert.throws(()=>f.pricing.confirm(confirmInput(f.invoice,'lightning',offer.offerHash),'blocked-'+blocker.name.replace(/\W+/g,'-'),()=>true),{status:409,code:'METHOD_AGREEMENT_COMMITMENT_EXISTS'});
      assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM invoice_method_agreements').get()!.n,0);
    }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
  }
});

test('revoked checkout links cannot confirm or replay a saved agreement',()=>{
  const f=fixture();try{
    const offer=f.pricing.offers(workspace,f.invoice,()=>true).find(row=>row.method==='lightning')!;
    const confirmed=f.pricing.confirm(confirmInput(f.invoice,'lightning',offer.offerHash),'revoke-key',()=>true);
    f.store.revokeInvoiceLinks(f.invoice.id,workspace,now().toISOString());
    // Authorization precedes the saved-idempotency read: both replay and fresh keys fail.
    assert.throws(()=>f.pricing.confirm(confirmInput(f.invoice,'lightning',offer.offerHash),'revoke-key',()=>true),{status:404});
    assert.throws(()=>f.pricing.confirm(confirmInput(f.invoice,'lightning',offer.offerHash),'revoke-key-2',()=>true),{status:404});
    // Owner reads and the stored row survive revocation.
    assert.equal(f.pricing.forInvoice(workspace,f.invoice.id)?.effectiveTotal,confirmed.agreement.effectiveTotal);
  }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('agreements stay workspace-isolated and tokens never cross workspaces',()=>{
  const f=fixture();try{
    const other=createInvoice(f.store,otherWorkspace,baseInput,now());
    const otherPriced={...other,methodPricing:rules} as MethodPricedInvoice;
    f.store.saveInvoice(otherPriced);
    const otherOffer=f.pricing.offers(otherWorkspace,otherPriced,()=>true).find(row=>row.method==='card')!;
    f.pricing.confirm(confirmInput(otherPriced,'card',otherOffer.offerHash),'other-key',()=>true);
    // Neither workspace can read the other's agreement; require fails closed cross-workspace.
    assert.equal(f.pricing.forInvoice(otherWorkspace,f.invoice.id),undefined);
    assert.equal(f.pricing.forInvoice(workspace,otherPriced.id),undefined);
    assert.throws(()=>f.pricing.require(otherWorkspace,f.invoice),{status:409,code:'METHOD_AGREEMENT_REQUIRED'});
    // A foreign offer hash cannot lock another invoice through this checkout token.
    const ownOffer=f.pricing.offers(workspace,f.invoice,()=>true).find(row=>row.method==='lightning')!;
    assert.throws(()=>f.pricing.confirm(confirmInput(f.invoice,'lightning',otherOffer.offerHash),'cross-key',()=>true),{status:400});
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM invoice_method_agreements').get()!.n,1);
    f.pricing.confirm(confirmInput(f.invoice,'lightning',ownOffer.offerHash),'own-key',()=>true);
    assert.equal(f.pricing.forInvoice(workspace,f.invoice.id)!.method,'lightning');
    assert.equal(f.pricing.forInvoice(otherWorkspace,otherPriced.id)!.method,'card');
  }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('agreement rows are append-only and encrypted',()=>{
  const f=fixture();try{
    const offer=f.pricing.offers(workspace,f.invoice,()=>true).find(row=>row.method==='lightning')!;
    f.pricing.confirm(confirmInput(f.invoice,'lightning',offer.offerHash),'immutable-key',()=>true);
    const id=f.pricing.forInvoice(workspace,f.invoice.id)!.id;
    assert.throws(()=>f.store.db.prepare('UPDATE invoice_method_agreements SET data=? WHERE id=?').run('x',id));
    assert.throws(()=>f.store.db.prepare('DELETE FROM invoice_method_agreements WHERE id=?').run(id));
    const rows=JSON.stringify(f.store.db.prepare('SELECT * FROM invoice_method_agreements').all());
    assert.ok(!rows.includes('lightning'));assert.ok(!rows.includes('262500'));assert.ok(!rows.includes('SENTINEL'));
    assert.ok(String(f.store.db.prepare('SELECT data FROM invoice_method_agreements WHERE id=?').get(id)!.data).startsWith('qlr:v1:'));
    f.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const bytes=readFileSync(f.path);
    assert.ok(!bytes.includes(Buffer.from('lightning')));assert.ok(!bytes.includes(Buffer.from('262500')));assert.ok(!bytes.includes(Buffer.from('FICTIONAL PRICING CUSTOMER SENTINEL')));
  }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('saved agreements reject invoice binding changes and keep replay stability',()=>{
  const f=fixture();try{
    const offer=f.pricing.offers(workspace,f.invoice,()=>true).find(row=>row.method==='lightning')!;
    const confirmed=f.pricing.confirm(confirmInput(f.invoice,'lightning',offer.offerHash),'binding-key',()=>true);
    f.store.saveInvoice({...f.invoice,total:f.invoice.total+1});
    assert.throws(()=>f.pricing.forInvoice(workspace,f.invoice.id),{status:409,code:'METHOD_AGREEMENT_INCONSISTENT'});
    assert.throws(()=>f.pricing.require(workspace,f.invoice),{status:409,code:'METHOD_AGREEMENT_INCONSISTENT'});
    assert.throws(()=>f.pricing.offers(workspace,f.invoice,()=>true),{status:409});
    // A saved confirmation still replays its original response byte-identically.
    assert.equal(JSON.stringify(f.pricing.confirm(confirmInput(f.invoice,'lightning',offer.offerHash),'binding-key',()=>true)),JSON.stringify(confirmed));
  }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('payable-method gating and malformed confirmations write nothing',()=>{
  const f=fixture();try{
    const all=f.pricing.offers(workspace,f.invoice,()=>true);
    const lightning=all.find(row=>row.method==='lightning')!,card=all.find(row=>row.method==='card')!;
    const offers=f.pricing.offers(workspace,f.invoice,method=>method==='lightning');
    assert.deepEqual(offers.map(offer=>offer.method),['lightning']);
    assert.throws(()=>f.pricing.confirm(confirmInput(f.invoice,'card',card.offerHash),'payable-key',method=>method==='lightning'),{status:409,message:/not currently payable/});
    assert.throws(()=>f.pricing.confirm(confirmInput(f.invoice,'lightning','0'.repeat(64)),'payable-key',()=>true),{status:400});
    assert.throws(()=>f.pricing.confirm(confirmInput(f.invoice,'square',lightning.offerHash),'payable-key',()=>true),{status:400});
    assert.throws(()=>f.pricing.confirm(confirmInput(f.invoice,'bank',lightning.offerHash),'payable-key',()=>true),{status:400});
    assert.throws(()=>f.pricing.confirm(confirmInput(f.invoice,'lightning',lightning.offerHash),'bad key!',()=>true),{status:400});
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM invoice_method_agreements').get()!.n,0);
    f.pricing.confirm(confirmInput(f.invoice,'lightning',lightning.offerHash),'payable-key',()=>true);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM invoice_method_agreements').get()!.n,1);
  }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('invalid persisted rules and crafted snapshots fail closed',()=>{
  const f=fixture();try{
    const aliased={...f.invoice,methodPricing:[{method:'square' as never,discountBps:100}]} as MethodPricedInvoice;
    f.store.saveInvoice(aliased);
    assert.throws(()=>f.pricing.offers(workspace,aliased,()=>true),{status:409,message:/invalid/});
    assert.throws(()=>f.pricing.confirm(confirmInput(aliased,'lightning','1'.repeat(64)),'crafted-key',()=>true),{status:409});
    const mutated={...f.invoice,subtotal:f.invoice.subtotal+1};
    f.store.saveInvoice(mutated);
    assert.throws(()=>f.pricing.offers(workspace,mutated,()=>true),{status:409,message:/could not be computed/});
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM invoice_method_agreements').get()!.n,0);
  }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('require and assertCanConfirm separate legacy, priced and locked invoices',()=>{
  const f=fixture({rules:false});try{
    assert.equal(f.pricing.require(workspace,f.invoice),undefined);
    assert.deepEqual(f.pricing.offers(workspace,f.invoice,()=>true),[]);
    assert.throws(()=>f.pricing.assertCanConfirm(workspace,f.invoice.id),{status:400});
  }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
  const g=fixture();try{
    assert.throws(()=>g.pricing.require(workspace,g.invoice),{status:409,code:'METHOD_AGREEMENT_REQUIRED'});
    g.pricing.assertCanConfirm(workspace,g.invoice.id);
    const offer=g.pricing.offers(workspace,g.invoice,()=>true).find(row=>row.method==='lightning')!;
    g.pricing.confirm(confirmInput(g.invoice,'lightning',offer.offerHash),'state-key',()=>true);
    assert.throws(()=>g.pricing.assertCanConfirm(workspace,g.invoice.id),{status:409,code:'METHOD_AGREEMENT_LOCKED'});
  }finally{g.store.close();rmSync(g.dir,{recursive:true,force:true});}
});

test('saved confirmation responses survive a process restart',()=>{
  const f=fixture();try{
    const offer=f.pricing.offers(workspace,f.invoice,()=>true).find(row=>row.method==='lightning')!;
    const confirmed=f.pricing.confirm(confirmInput(f.invoice,'lightning',offer.offerHash),'restart-key',()=>true);
    f.store.close();
    const store=new Store(f.path,{encryptionKey:FICTIONAL_KEY});
    try{
      const pricing=new MethodPriceAgreements(store,now);
      assert.equal(JSON.stringify(pricing.confirm(confirmInput(f.invoice,'lightning',offer.offerHash),'restart-key',()=>true)),JSON.stringify(confirmed));
      assert.equal(pricing.forInvoice(workspace,f.invoice.id)?.effectiveTotal,262500);
    }finally{store.close();}
  }finally{rmSync(f.dir,{recursive:true,force:true});}
});

test('concurrent distinct confirmations cannot choose two methods',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ql-method-pricing-race-')),path=join(dir,'race.sqlite');
  const raceWorkspace='fictional-pricing-race';
  try{
    let invoice:MethodPricedInvoice,offerHashes:Record<string,string>,invoiceDataBefore:string;
    {
      const store=new Store(path,{encryptionKey:FICTIONAL_KEY});
      const ledger=new InvoiceLedger(store);
      const pricing=new MethodPriceAgreements(store,now);
      const created=createInvoice(store,raceWorkspace,baseInput,now());
      invoice={...created,methodPricing:rules} as MethodPricedInvoice;
      store.saveInvoice(invoice);
      offerHashes=Object.fromEntries(pricing.offers(raceWorkspace,invoice,()=>true).map(offer=>[offer.method,offer.offerHash]));
      invoiceDataBefore=String(store.db.prepare('SELECT data FROM invoices WHERE id=?').get(invoice.id)!.data);
      store.close();
    }
    const children=[0,1].map(()=>fork(new URL('./fixtures/method-pricing-worker.ts',import.meta.url),[path],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']}));
    try{
      await Promise.all(children.map(child=>new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('message',message=>{(message as {ready?:boolean}).ready?resolve():reject(new Error('Method pricing worker not ready.'));});})));
      const outcomes=await Promise.all(children.map((child,index)=>new Promise<{status:number;code?:string;method?:string}>((resolve,reject)=>{
        child.once('message',message=>{
          const outcome=message as {result?:{method:string};error?:string;status?:number;code?:string};
          if(outcome.result)resolve({status:201,method:outcome.result.method});
          else resolve({status:outcome.status??500,code:outcome.code,method:index===0?'lightning':'card'});
        });
        child.once('error',reject);
        const method=index===0?'lightning':'card';
        child.send({kind:'confirm',checkoutToken:invoice.token,method,offerHash:offerHashes[method],key:'method-pricing-race-'+index});
      })));
      assert.deepEqual(outcomes.map(outcome=>outcome.status).sort(),[201,409]);
      const winner=outcomes.find(outcome=>outcome.status===201)!,loser=outcomes.find(outcome=>outcome.status===409)!;
      assert.equal(loser.code,'METHOD_AGREEMENT_LOCKED');
      const store=new Store(path,{encryptionKey:FICTIONAL_KEY});
      try{
        const pricing=new MethodPriceAgreements(store,now);
        assert.equal(store.db.prepare('SELECT COUNT(*) n FROM invoice_method_agreements').get()!.n,1);
        const saved=pricing.forInvoice(raceWorkspace,invoice.id)!;
        assert.equal(saved.method,winner.method);
        assert.equal(saved.effectiveTotal,winner.method==='lightning'?262500:287700);
        assert.equal(store.db.prepare('SELECT COUNT(*) n FROM invoice_ledger_entries').get()!.n,0);
        assert.equal(store.db.prepare('SELECT COUNT(*) n FROM receipts').get()!.n,0);
        assert.equal(String(store.db.prepare('SELECT data FROM invoices WHERE id=?').get(invoice.id)!.data),invoiceDataBefore);
        assert.equal(store.audits(raceWorkspace).filter(event=>event.action==='invoice.method_price_confirmed').length,1);
      }finally{store.close();}
    }finally{for(const child of children)if(child.connected)child.kill();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('accepted methods without an extra rule retain a confirmable base-price offer',()=>{
 const f=fixture({rules:[{method:'lightning',discountBps:1000}]});try{
  const invoice={...f.invoice,acceptedMethods:['lightning','card'] as const};f.store.saveInvoice({...invoice,acceptedMethods:[...invoice.acceptedMethods]});
  const offers=f.pricing.offers(workspace,{...invoice,acceptedMethods:[...invoice.acceptedMethods]},()=>true);
  assert.deepEqual(offers.map(offer=>offer.method).sort(),['card','lightning']);const base=offers.find(offer=>offer.method==='card')!;assert.equal(base.effectiveTotal,f.invoice.total);assert.equal(base.discountAmount,0);assert.equal(base.premiumAmount,0);
  const result=f.pricing.confirm(confirmInput(f.invoice,'card',base.offerHash),'fictional-base-price-choice',()=>true);assert.equal(result.agreement.method,'card');assert.equal(result.agreement.effectiveTotal,f.invoice.total);assert.equal(result.agreement.totalAdjustment,0);
 }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('saved agreement must bind its row invoice and agreement identifiers',()=>{
 const f=fixture();try{
  const offer=f.pricing.offers(workspace,f.invoice,()=>true).find(row=>row.method==='lightning')!;f.pricing.confirm(confirmInput(f.invoice,'lightning',offer.offerHash),'fictional-binding-origin',()=>true);const saved=f.pricing.forInvoice(workspace,f.invoice.id)!;
  const another=createInvoice(f.store,workspace,baseInput,now()),rowId=randomUUID();f.store.db.prepare('INSERT INTO invoice_method_agreements(id,workspace,invoice_id,data) VALUES(?,?,?,?)').run(rowId,workspace,another.id,f.store.encode({...saved,id:rowId},'invoice_method_agreements',rowId,workspace));
  assert.throws(()=>f.pricing.forInvoice(workspace,another.id),{status:409,code:'METHOD_AGREEMENT_INCONSISTENT'});
 }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});
