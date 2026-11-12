import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from '../server/store.js';
import {InvoiceLedger} from '../server/invoice-ledger.js';
import {MethodPriceAgreements} from '../server/method-pricing.js';
import {CashuInvoiceIntake} from '../server/cashu/invoice-intake.js';
import type {TrustedCashuJournal} from '../server/cashu/invoice-intake.js';
import {CashuJournal} from '../server/cashu/cashu-journal.mjs';
import type {CashuResult,OutboxEvent} from '../server/cashu/cashu-journal.mjs';
import {classifyCashuIntake} from '../shared/cashu-receiving.js';
import type {CashuIntakeBindingFacts,CashuIntakeInvoiceFacts,CashuIntakeJournalFacts} from '../shared/cashu-receiving.js';
import type {Invoice} from '../shared/contracts.js';
// @ts-expect-error qualified test-only ESM fixture module ships without type declarations
import {sdk,mintUrl,makeKeyset,makePayerProofs,makeOutputs,createControlledMint,createRecovery} from './cashu/fixtures.mjs';
// @ts-expect-error qualified test-only ESM helper module ships without type declarations
import {assertSafePayload} from './cashu/helpers.mjs';

// Stage-1 Cashu invoice intake boundary. Every mint, keyset, proof, secret and
// account here is published fictional NUT-00/NUT-12 fixture material driven
// through the pinned @cashu/cashu-ts 4.13.0 SDK and the qualified encrypted
// CashuJournal. No network, wallet seed, funded mint, real ecash, provider,
// route or deployment is involved. This service is internal-only and cannot
// receive tokens from a user yet.

const TEST_BASE=process.env.CASHU_INTAKE_TEST_DIR??(existsSync('/tmp/opencode')?'/tmp/opencode':tmpdir());
const roots:string[]=[];
function makeRoot(){const root=mkdtempSync(join(TEST_BASE,'cashu-intake-'));roots.push(root);return root;}
after(()=>{for(const root of roots){try{rmSync(root,{recursive:true,force:true});}catch{}}});

let numberSeq=0;
function satInvoice(total:number,overrides:Partial<Invoice>={}):Invoice{
  return {id:randomUUID(),number:`QL-CASHU-${++numberSeq}`,token:randomBytes(24).toString('base64url'),title:'Fictional cashu workshop',
    customerName:'Fictional Studio',currency:'SAT',items:[{description:'Fictional service',quantity:1,unitAmount:total}],
    taxBps:0,subtotal:total,tax:0,total,amountSats:total,status:'open',createdAt:'2026-11-08T00:00:00.000Z',...overrides};
}

function context(alias='primary'){
  const root=makeRoot(),encryptionKey=randomBytes(32);
  const store=new Store(join(root,'app.sqlite'),{encryptionKey});
  assert.equal(store.encrypted,true);
  const journalPath=join(root,'journal.sqlite'),storageKey=randomBytes(32);
  const openJournal=()=>new CashuJournal(journalPath,storageKey,sdk);
  const openStore=()=>new Store(join(root,'app.sqlite'),{encryptionKey});
  const journal=openJournal();
  const agreements=new MethodPriceAgreements(store);
  const intake=new CashuInvoiceIntake(store,journal,{journalAlias:alias,agreements});
  const ledger=new InvoiceLedger(store,agreements);
  return {root,store,journal,intake,ledger,agreements,journalPath,storageKey,encryptionKey,openJournal,openStore,
    close(){try{journal.close();}finally{store.close();}}};
}

type Keyset=ReturnType<typeof makeKeyset>;
async function prepareOp(journal:CashuJournal,keyset:Keyset,operationId:string,invoiceId:string,
  {mint=mintUrl,amounts=[1,2],outputAmounts=[2,1],expectedAmount='3'}:{mint?:string;amounts?:number[];outputAmounts?:number[];expectedAmount?:string}={}){
  const recovery=createRecovery(journal,keyset,mint===mintUrl?{}:{mintUrl:mint});
  const controlled=createControlledMint(keyset);
  await recovery.prepare({operationId,invoiceId,inputs:makePayerProofs(keyset,amounts),outputs:makeOutputs(keyset,outputAmounts),expectedAmount});
  return {recovery,controlled};
}
async function driveOp(journal:CashuJournal,keyset:Keyset,operationId:string,invoiceId:string,options?:{mint?:string;amounts?:number[];outputAmounts?:number[];expectedAmount?:string},beforeSubmit?:()=>void){
  const {recovery,controlled}=await prepareOp(journal,keyset,operationId,invoiceId,options);
  beforeSubmit?.();
  const transport=(args:{method:string;endpoint:string;requestBody?:unknown})=>controlled.swap({method:args.method,endpoint:`${mintUrl}/v1/swap`,requestBody:args.requestBody});
  return recovery.submit(operationId,transport);
}
const zeroKeyset=()=>makeKeyset();
const feeKeyset=()=>makeKeyset({inputFeePpk:500});

function bindRequest(operationId:string,{netAmount='3',maxFee='0',mint=mintUrl,keysetId,unit='sat'}:{netAmount?:string;maxFee?:string;mint?:string;keysetId?:string;unit?:string}={}){
  return {operationId,mint,unit,keysetId:keysetId??zeroKeyset().id,netAmount,maxFee};
}

test('pure classification decides accepted_locked, rejected and unknown without ever implying paid',()=>{
  const binding:CashuIntakeBindingFacts={journalAlias:'primary',operationId:'op-1',workspace:'owner',invoiceId:'inv-1',method:'cashu',mint:'https://mint.example.invalid',unit:'sat',keysetId:'ks-1',netAmount:'3',maxFee:'1'};
  const result={operationId:'op-1',invoiceId:'inv-1',mint:'https://mint.example.invalid',unit:'sat',keysetId:'ks-1',amount:'3',fee:'1',proofCount:2};
  const outbox={operationId:'op-1',invoiceId:'inv-1',mint:'https://mint.example.invalid',unit:'sat',amount:'3',fee:'1',proofCount:2};
  const journal:CashuIntakeJournalFacts={state:'finalized',result,outboxEvent:outbox};
  const invoice:CashuIntakeInvoiceFacts={currency:'SAT',allowsCashu:true,dueSats:'3',agreement:null};
  const decide=(factsOverrides:Partial<CashuIntakeJournalFacts>,invoiceOverrides:Partial<CashuIntakeInvoiceFacts>={})=>
    classifyCashuIntake(binding,{...journal,...factsOverrides},{...invoice,...invoiceOverrides});
  const valid=new Set(['accepted_locked','rejected','unknown']);
  const check=(decision:{classification:string;reasons:string[]})=>{assert.ok(valid.has(decision.classification));assert.notEqual(decision.classification,'paid');return decision;};
  assert.deepEqual(check(decide({})),{classification:'accepted_locked',reasons:[]});
  assert.deepEqual(check(decide({state:'uncertain'})).reasons,['not_finalized']);
  assert.deepEqual(check(decide({state:'prepared'})).reasons,['not_finalized']);
  assert.deepEqual(check(decide({result:null})).reasons,['result_missing']);
  assert.deepEqual(check(decide({outboxEvent:null})).reasons,['outbox_missing']);
  assert.deepEqual(check(decide({outboxEvent:{...outbox,fee:'2'}})).reasons,['outbox_result_mismatch']);
  assert.deepEqual(check(decide({outboxEvent:{...outbox,proofCount:3}})).reasons,['outbox_result_mismatch']);
  assert.deepEqual(check(decide({result:{...result,operationId:'op-2'},outboxEvent:{...outbox,operationId:'op-2'}})).reasons,['operation_mismatch']);
  assert.deepEqual(check(decide({result:{...result,mint:'https://other.example.invalid'},outboxEvent:{...outbox,mint:'https://other.example.invalid'}})).reasons,['mint_mismatch']);
  assert.deepEqual(check(decide({result:{...result,unit:'msat'},outboxEvent:{...outbox,unit:'msat'}})).reasons,['unit_mismatch']);
  assert.deepEqual(check(decide({result:{...result,keysetId:'ks-2'}})).reasons,['keyset_mismatch']);
  assert.deepEqual(check(decide({result:{...result,amount:'4'},outboxEvent:{...outbox,amount:'4'}})).reasons,['net_amount_mismatch']);
  assert.deepEqual(check(decide({result:{...result,amount:'3.5'},outboxEvent:{...outbox,amount:'3.5'}})).reasons,['unsafe_amount']);
  assert.deepEqual(check(decide({result:{...result,amount:'9007199254740993'},outboxEvent:{...outbox,amount:'9007199254740993'}})).reasons,['unsafe_amount']);
  assert.deepEqual(check(decide({result:{...result,fee:'2'},outboxEvent:{...outbox,fee:'2'}})).reasons,['fee_exceeds_maximum']);
  assert.deepEqual(check(decide({}, {currency:'CAD'})).reasons,['currency_not_sat']);
  assert.deepEqual(check(decide({}, {allowsCashu:false})).reasons,['method_denied']);
  assert.deepEqual(check(decide({}, {dueSats:'2'})).reasons,['invoice_not_payable']);
  assert.deepEqual(check(decide({},{agreement:{id:'a-2',method:'cashu'}})).reasons,['agreement_mismatch']);
  const agreedBinding={...binding,agreementId:'a-1'};
  assert.deepEqual(check(classifyCashuIntake(agreedBinding,journal,{...invoice,agreement:{id:'a-1',method:'cashu'}})),{classification:'accepted_locked',reasons:[]});
  assert.deepEqual(classifyCashuIntake(agreedBinding,journal,{...invoice,agreement:{id:'a-1',method:'lightning'}}).reasons,['agreement_mismatch']);
  assert.deepEqual(classifyCashuIntake(agreedBinding,journal,invoice).reasons,['agreement_mismatch']);
  // The decision alone confers nothing: it is data, not a receipt or capability.
  assert.equal('receipt' in classifyCashuIntake(binding,journal,invoice),false);
});

test('bind requires an untouched prepared operation with exact frozen metadata',async()=>{
  const ctx=context();try{
    const keyset=zeroKeyset(),invoice=satInvoice(3);
    ctx.store.addInvoice('owner',invoice);
    const opId='fictional-bind-op-1';
    // No journal operation exists yet.
    assert.throws(()=>ctx.intake.bind('owner',invoice.id,bindRequest(opId)),/Cashu journal operation not found/);
    const {recovery,controlled}=await prepareOp(ctx.journal,keyset,opId,invoice.id);
    assert.equal(ctx.journal.get(opId)!.state,'prepared');
    // Scope and amount guards fire before any binding row is written.
    assert.throws(()=>ctx.intake.bind('owner',invoice.id,bindRequest(opId,{mint:'https://other-mint.invalid'})),/does not match the requested mint/);
    assert.throws(()=>ctx.intake.bind('owner',invoice.id,bindRequest(opId,{keysetId:'ffffffffffffffff'})),/does not match the requested mint/);
    assert.throws(()=>ctx.intake.bind('owner',invoice.id,bindRequest(opId,{unit:'msat'})),/sat-unit/);
    assert.throws(()=>ctx.intake.bind('owner',invoice.id,bindRequest(opId,{netAmount:'2'})),/net amount does not equal/);
    assert.throws(()=>ctx.intake.bind('owner',invoice.id,bindRequest(opId,{netAmount:'3.5'})),/whole-satoshi/);
    assert.throws(()=>ctx.intake.bind('owner',invoice.id,bindRequest(opId,{netAmount:'9007199254740993'})),/whole-satoshi/);
    assert.throws(()=>ctx.intake.bind('owner',invoice.id,bindRequest(opId,{netAmount:'0'})),/whole-satoshi/);
    // A fee-bearing operation refuses a zero maximum fee. Each extra
    // operation lives on its own fictional fixture mint: journal input
    // reservations are keyed by mint and Y=hash_to_curve(secret), and the
    // published fixture input secrets are fixed per amount.
    const feeSet=feeKeyset(),feeInvoice=satInvoice(2);
    ctx.store.addInvoice('owner',feeInvoice);
    const feeOp='fictional-bind-op-fee';
    await prepareOp(ctx.journal,feeSet,feeOp,feeInvoice.id,{mint:'https://fee-fixture.invalid',amounts:[1,2],outputAmounts:[2],expectedAmount:'2'});
    assert.equal(ctx.journal.get(feeOp)!.expectedFee,'1');
    assert.throws(()=>ctx.intake.bind('owner',feeInvoice.id,bindRequest(feeOp,{netAmount:'2',maxFee:'0',keysetId:feeSet.id,mint:'https://fee-fixture.invalid'})),/fee exceeds/);
    assert.doesNotThrow(()=>ctx.intake.bind('owner',feeInvoice.id,bindRequest(feeOp,{netAmount:'2',maxFee:'1',keysetId:feeSet.id,mint:'https://fee-fixture.invalid'})));
    // Invoice-side guards: currency, method, tenant and journal invoice tag.
    const cad=satInvoice(250,{currency:'CAD'});
    delete (cad as Partial<Invoice>).amountSats;cad.totalCad=250;
    ctx.store.addInvoice('owner',cad);
    await prepareOp(ctx.journal,keyset,'fictional-bind-op-cad',cad.id,{mint:'https://cad-fixture.invalid'});
    assert.throws(()=>ctx.intake.bind('owner',cad.id,bindRequest('fictional-bind-op-cad',{mint:'https://cad-fixture.invalid'})),/SAT-denominated/);
    const denied=satInvoice(3,{acceptedMethods:['lightning']});
    ctx.store.addInvoice('owner',denied);
    await prepareOp(ctx.journal,keyset,'fictional-bind-op-denied',denied.id,{mint:'https://denied-fixture.invalid'});
    assert.throws(()=>ctx.intake.bind('owner',denied.id,bindRequest('fictional-bind-op-denied',{mint:'https://denied-fixture.invalid'})),/not accepted for this invoice/);
    assert.throws(()=>ctx.intake.bind('tenant-b',invoice.id,bindRequest(opId)),/Invoice not found/);
    await prepareOp(ctx.journal,keyset,'fictional-bind-op-othertag','fictional-other-invoice',{mint:'https://othertag-fixture.invalid'});
    assert.throws(()=>ctx.intake.bind('owner',invoice.id,bindRequest('fictional-bind-op-othertag',{mint:'https://othertag-fixture.invalid'})),/tagged for a different invoice/);
    const over=satInvoice(3);
    ctx.store.addInvoice('owner',over);
    assert.throws(()=>ctx.intake.bind('owner',over.id,bindRequest(opId,{netAmount:'4'})),/exceeds the current unpaid/);
    // The untouched happy path binds.
    const bound=ctx.intake.bind('owner',invoice.id,bindRequest(opId));
    assert.equal(bound.operationId,opId);assert.equal(bound.workspace,'owner');assert.equal(bound.invoiceId,invoice.id);
    assert.equal(bound.method,'cashu');assert.equal(bound.mint,mintUrl);assert.equal(bound.unit,'sat');
    assert.equal(bound.netAmount,'3');assert.equal(bound.maxFee,'0');assert.equal(bound.agreementId,undefined);
    await recovery.submit(opId,(args:{method:string;endpoint:string;requestBody?:unknown})=>controlled.swap({method:args.method,endpoint:`${mintUrl}/v1/swap`,requestBody:args.requestBody}));
    assert.throws(()=>ctx.intake.bind('owner',invoice.id,bindRequest(opId)),/untouched prepared/);
  }finally{ctx.close();}
});

test('bind is idempotent for identical facts and permanently refuses rebinding',async()=>{
  const ctx=context();try{
    const keyset=zeroKeyset(),invoice=satInvoice(3),other=satInvoice(3);
    ctx.store.addInvoice('owner',invoice);ctx.store.addInvoice('owner',other);
    const opId='fictional-rebind-op-1';
    await prepareOp(ctx.journal,keyset,opId,invoice.id);
    const first=ctx.intake.bind('owner',invoice.id,bindRequest(opId));
    assert.deepEqual(ctx.intake.bind('owner',invoice.id,bindRequest(opId)),first);
    assert.throws(()=>ctx.intake.bind('owner',invoice.id,bindRequest(opId,{maxFee:'1'})),/already bound/);
    assert.throws(()=>ctx.intake.bind('owner',other.id,bindRequest(opId)),/already bound/);
    // A committed attempt is no longer untouched, so it can never be rebound.
    const mint=createControlledMint(keyset);
    const {recovery}=await prepareOp(ctx.journal,keyset,'fictional-rebind-op-2',invoice.id,{mint:'https://rebind-fixture.invalid'});
    ctx.intake.bind('owner',invoice.id,bindRequest('fictional-rebind-op-2',{mint:'https://rebind-fixture.invalid'}));
    await assert.rejects(()=>recovery.submit('fictional-rebind-op-2',async (args:{method:string;endpoint:string;requestBody?:unknown})=>{mint.swap({method:args.method,endpoint:`${mintUrl}/v1/swap`,requestBody:args.requestBody});throw new Error('FICTIONAL_LOST_RESPONSE');}),/FICTIONAL_LOST_RESPONSE/);
    assert.equal(ctx.journal.get('fictional-rebind-op-2')!.state,'uncertain');
    assert.throws(()=>ctx.intake.bind('owner',invoice.id,bindRequest('fictional-rebind-op-2',{mint:'https://rebind-fixture.invalid'})),/untouched prepared/);
  }finally{ctx.close();}
});

test('priced invoices require the exact cashu method agreement before binding',async()=>{
  const ctx=context();try{
    const keyset=zeroKeyset();
    const priced=satInvoice(4,{methodPricing:[{method:'cashu',discountBps:2500}]});
    ctx.store.addInvoice('owner',priced);
    const opId='fictional-priced-op-1';
    await prepareOp(ctx.journal,keyset,opId,priced.id);
    assert.throws(()=>ctx.intake.bind('owner',priced.id,bindRequest(opId)),/Confirm a payment-method price/);
    const offer=ctx.agreements.offers('owner',priced,()=>true).find(row=>row.method==='cashu')!;
    assert.equal(offer.effectiveTotal,3);
    ctx.agreements.confirm({checkoutToken:priced.token,method:'cashu',offerHash:offer.offerHash},'fictional-priced-key',()=>true);
    // A different locked method is refused: no new method after the price lock.
    const lightningLocked=satInvoice(4,{methodPricing:[{method:'lightning',discountBps:2500}]});
    ctx.store.addInvoice('owner',lightningLocked);
    const lightningOffer=ctx.agreements.offers('owner',lightningLocked,()=>true).find(row=>row.method==='lightning')!;
    ctx.agreements.confirm({checkoutToken:lightningLocked.token,method:'lightning',offerHash:lightningOffer.offerHash},'fictional-lightning-key',()=>true);
    const lightningOp='fictional-priced-op-lightning';
    await prepareOp(ctx.journal,keyset,lightningOp,lightningLocked.id,{mint:'https://lightning-fixture.invalid'});
    assert.throws(()=>ctx.intake.bind('owner',lightningLocked.id,bindRequest(lightningOp,{mint:'https://lightning-fixture.invalid'})),/does not match the confirmed method price/);
    // The cashu agreement binds at the effective total, not the issued total.
    const bound=ctx.intake.bind('owner',priced.id,bindRequest(opId));
    assert.ok(bound.agreementId);
    assert.throws(()=>ctx.intake.bind('owner',priced.id,bindRequest(opId,{netAmount:'4'})),/exceeds the current unpaid/);
    assert.doesNotThrow(()=>ctx.intake.bind('owner',priced.id,bindRequest(opId)));
  }finally{ctx.close();}
});

test('settle allocates once through the trusted journal with a truthful cashu receipt',async()=>{
  const ctx=context();try{
    const keyset=zeroKeyset(),invoice=satInvoice(3);
    ctx.store.addInvoice('owner',invoice);
    const opId='fictional-settle-op-1';
    await driveOp(ctx.journal,keyset,opId,invoice.id,undefined,()=>{ctx.intake.bind('owner',invoice.id,bindRequest(opId));});
    const settled=ctx.intake.settle('owner',opId);
    assert.equal(settled.classification,'accepted_locked');assert.deepEqual(settled.reasons,[]);
    assert.equal(settled.journalAck,'acked');
    assert.equal(ctx.journal.pending().length,0);
    assert.ok(settled.receipt);
    assert.equal(settled.receipt!.receiptNumber,`CASHU-${opId}`);
    assert.equal(settled.receipt!.amount,3);assert.equal(settled.receipt!.currency,'SAT');
    assert.equal(settled.receipt!.method,'cashu');assert.equal(settled.receipt!.mode,'live');
    assert.deepEqual(settled.receipt!.nativePayment,{asset:'cashu',atomicAmount:'3',network:mintUrl,paymentId:`cashu:primary:${opId}`,verification:'provider'});
    const view=ctx.ledger.read('owner',invoice.id);
    assert.deepEqual([view.balance.paid,view.balance.due,view.balance.state,view.balance.effectiveTotal,view.balance.total],[3,0,'paid',3,3]);
    assert.equal(view.entries.length,1);
    assert.equal(view.entries[0].kind,'payment');assert.equal(view.entries[0].method,'cashu');
    assert.equal(view.entries[0].verification,'provider');assert.equal(view.entries[0].amount,3);
    assert.equal(view.entries[0].receiptToken,settled.receipt!.receiptToken);
    const saved=ctx.store.getInvoice(invoice.id,'owner')!;
    assert.equal(saved.status,'paid');assert.equal(saved.settlementMode,'live');
    assert.equal(saved.paymentMethod,'cashu');assert.equal(saved.total,3);assert.equal(saved.amountSats,3);
    assert.equal(saved.totalCad,undefined);assert.ok(!('totalCad' in saved));assert.ok(saved.paidAt);
    assert.equal(saved.nativePayment!.paymentId,`cashu:primary:${opId}`);
    const publicReceipt=ctx.ledger.getReceipt(settled.receipt!.receiptToken)!;
    assert.equal(publicReceipt.receipt.mode,'live');assert.equal(publicReceipt.receipt.nativePayment!.asset,'cashu');
    // Idempotent replay: same receipt, still one entry.
    const replay=ctx.intake.settle('owner',opId);
    assert.deepEqual(replay.receipt,settled.receipt);
    assert.equal(ctx.ledger.read('owner',invoice.id).entries.length,1);
    // A fee-bearing operation settles its exact net whole satoshis.
    const feeSet=feeKeyset(),feeInvoice=satInvoice(2);
    ctx.store.addInvoice('owner',feeInvoice);
    const feeOp='fictional-settle-op-fee';
    await driveOp(ctx.journal,feeSet,feeOp,feeInvoice.id,{mint:'https://fee-fixture.invalid',amounts:[1,2],outputAmounts:[2],expectedAmount:'2'},()=>{ctx.intake.bind('owner',feeInvoice.id,bindRequest(feeOp,{netAmount:'2',maxFee:'1',keysetId:feeSet.id,mint:'https://fee-fixture.invalid'}));});
    const feeSettled=ctx.intake.settle('owner',feeOp);
    assert.equal(feeSettled.classification,'accepted_locked');
    assert.equal(ctx.ledger.read('owner',feeInvoice.id).balance.paid,2);
    assert.equal(feeSettled.receipt!.nativePayment!.atomicAmount,'2');
  }finally{ctx.close();}
});

test('crash between commit and ack replays after restart without double credit or a different receipt',async()=>{
  const ctx=context();try{
    const keyset=zeroKeyset(),invoice=satInvoice(3);
    ctx.store.addInvoice('owner',invoice);
    const opId='fictional-crash-op-1';
    await driveOp(ctx.journal,keyset,opId,invoice.id,undefined,()=>{ctx.intake.bind('owner',invoice.id,bindRequest(opId));});
    // Real-core journal with an injected acknowledgment failure after commit.
    const flaky:TrustedCashuJournal={get:id=>ctx.journal.get(id),savedResult:id=>ctx.journal.savedResult(id),
      pending:()=>ctx.journal.pending(),ack:()=>{throw new Error('FICTIONAL_ACK_FAILURE');}};
    const flakyIntake=new CashuInvoiceIntake(ctx.store,flaky,{journalAlias:'primary',agreements:ctx.agreements});
    const settled=flakyIntake.settle('owner',opId);
    assert.equal(settled.classification,'accepted_locked');assert.equal(settled.journalAck,'pending');
    assert.ok(settled.receipt);
    assert.equal(ctx.journal.pending().length,1);
    assert.equal(ctx.ledger.read('owner',invoice.id).entries.length,1);
    ctx.close();
    // Restart from the encrypted file with the same keys and journal alias.
    const store=ctx.openStore(),journal=ctx.openJournal();
    const agreements=new MethodPriceAgreements(store),ledger=new InvoiceLedger(store,agreements);
    const intake=new CashuInvoiceIntake(store,journal,{journalAlias:'primary',agreements});
    try{
      const replay=intake.settle('owner',opId);
      assert.equal(replay.classification,'accepted_locked');assert.equal(replay.journalAck,'acked');
      assert.deepEqual(replay.receipt,settled.receipt);
      assert.equal(journal.pending().length,0);
      assert.equal(ledger.read('owner',invoice.id).entries.length,1);
      assert.deepEqual([ledger.read('owner',invoice.id).balance.paid,ledger.read('owner',invoice.id).balance.state],[3,'paid']);
    }finally{journal.close();store.close();}
    assert.throws(()=>new Store(join(ctx.root,'app.sqlite'),{encryptionKey:randomBytes(32)}),/Encrypted database verification failed/);
  }finally{ctx.close();}
});

test('uncertain, prepared and UNSPENT operations stay uncredited and unacknowledged',async()=>{
  const ctx=context();try{
    const keyset=zeroKeyset(),invoice=satInvoice(3);
    ctx.store.addInvoice('owner',invoice);
    const opId='fictional-uncertain-op-1';
    const mint=createControlledMint(keyset);
    const {recovery}=await prepareOp(ctx.journal,keyset,opId,invoice.id);
    ctx.intake.bind('owner',invoice.id,bindRequest(opId));
    // Bound but never submitted: nothing to credit.
    const prepared=ctx.intake.settle('owner',opId);
    assert.equal(prepared.classification,'unknown');assert.deepEqual(prepared.reasons,['not_finalized']);
    assert.equal(ctx.ledger.read('owner',invoice.id).entries.length,0);
    await assert.rejects(()=>recovery.submit(opId,async (args:{method:string;endpoint:string;requestBody?:unknown})=>{mint.swap({method:args.method,endpoint:`${mintUrl}/v1/swap`,requestBody:args.requestBody});throw new Error('FICTIONAL_LOST_RESPONSE');}),/FICTIONAL_LOST_RESPONSE/);
    assert.equal(ctx.journal.get(opId)!.state,'uncertain');
    const uncertain=ctx.intake.settle('owner',opId);
    assert.equal(uncertain.classification,'unknown');assert.deepEqual(uncertain.reasons,['not_finalized']);
    assert.equal(uncertain.journalAck,'not_applicable');
    assert.equal(ctx.ledger.read('owner',invoice.id).entries.length,0);
    ctx.journal.observe(opId,'UNSPENT');
    const unspent=ctx.intake.settle('owner',opId);
    assert.equal(unspent.classification,'unknown');assert.deepEqual(unspent.reasons,['not_finalized']);
    assert.equal(ctx.ledger.read('owner',invoice.id).entries.length,0);
    assert.equal(ctx.journal.pending().length,0);
    const reviews=ctx.intake.reviewList('owner');
    assert.equal(reviews.length,1);
    assert.equal(reviews[0].classification,'unknown');assert.deepEqual(reviews[0].reasons,['not_finalized']);
    assert.equal(reviews[0].observed.state,'uncertain');
  }finally{ctx.close();}
});

test('no caller-supplied or already-acked outbox state can confer paid status',async()=>{
  const ctx=context();try{
    const keyset=zeroKeyset(),invoice=satInvoice(3);
    ctx.store.addInvoice('owner',invoice);
    const settledOp='fictional-outbox-op-1',strandedOp='fictional-outbox-op-2';
    await driveOp(ctx.journal,keyset,settledOp,invoice.id,undefined,()=>{ctx.intake.bind('owner',invoice.id,bindRequest(settledOp));});
    // A second finalized result exists, but its outbox was acknowledged outside
    // the application: the service cannot authenticate result and outbox, so it
    // stays uncredited regardless of what a caller asserts.
    await driveOp(ctx.journal,keyset,strandedOp,invoice.id,{mint:'https://second-fixture.invalid'},()=>{ctx.intake.bind('owner',invoice.id,bindRequest(strandedOp,{mint:'https://second-fixture.invalid'}));});
    assert.equal(ctx.intake.settle('owner',settledOp).classification,'accepted_locked');
    ctx.journal.ack(strandedOp);
    const stranded=ctx.intake.settle('owner',strandedOp);
    assert.equal(stranded.classification,'unknown');assert.deepEqual(stranded.reasons,['outbox_missing']);
    assert.equal(ctx.ledger.read('owner',invoice.id).entries.length,1);
    assert.equal(ctx.journal.counts().merchantProofs,4);
    const reviews=ctx.intake.reviewList('owner');
    assert.equal(reviews.length,1);assert.equal(reviews[0].classification,'unknown');
    assert.deepEqual(reviews[0].reasons,['outbox_missing']);
    assert.equal(reviews[0].observed.amount,'3');
  }finally{ctx.close();}
});

test('late and excess verified value stays reviewable without proofs, fiat value or total rewrites',async()=>{
  const ctx=context();try{
    const keyset=zeroKeyset(),invoice=satInvoice(3);
    ctx.store.addInvoice('owner',invoice);
    const firstOp='fictional-late-op-1',lateOp='fictional-late-op-2';
    await driveOp(ctx.journal,keyset,firstOp,invoice.id,undefined,()=>{ctx.intake.bind('owner',invoice.id,bindRequest(firstOp));});
    // Both operations were within the unpaid balance when bound.
    await driveOp(ctx.journal,keyset,lateOp,invoice.id,{mint:'https://second-fixture.invalid'},()=>{ctx.intake.bind('owner',invoice.id,bindRequest(lateOp,{mint:'https://second-fixture.invalid'}));});
    assert.equal(ctx.intake.settle('owner',firstOp).classification,'accepted_locked');
    const late=ctx.intake.settle('owner',lateOp);
    assert.equal(late.classification,'rejected');assert.deepEqual(late.reasons,['invoice_not_payable']);
    assert.equal(late.journalAck,'not_applicable');
    assert.equal(ctx.ledger.read('owner',invoice.id).entries.length,1);
    assert.equal(ctx.store.getInvoice(invoice.id,'owner')!.total,3);
    assert.equal(ctx.store.getInvoice(invoice.id,'owner')!.totalCad,undefined);
    // The verified value and its proofs remain preserved for reconciliation.
    assert.equal(ctx.journal.pending().length,1);
    assert.equal(ctx.journal.pending()[0].operationId,lateOp);
    // Each finalized operation preserves its two merchant proofs.
    assert.equal(ctx.journal.counts().merchantProofs,4);
    const reviews=ctx.intake.reviewList('owner');
    assert.equal(reviews.length,1);
    assert.equal(reviews[0].classification,'rejected');assert.deepEqual(reviews[0].reasons,['invoice_not_payable']);
    assert.equal(reviews[0].observed.amount,'3');assert.equal(reviews[0].observed.state,'finalized');
  }finally{ctx.close();}
});

test('hostile journal reads with mismatched results are rejected without credit',async()=>{
  const ctx=context();try{
    const keyset=zeroKeyset(),invoice=satInvoice(3);
    ctx.store.addInvoice('owner',invoice);
    const opId='fictional-hostile-op-1';
    const result=(await driveOp(ctx.journal,keyset,opId,invoice.id,undefined,()=>{ctx.intake.bind('owner',invoice.id,bindRequest(opId));})) as CashuResult;
    // Test double over the real finalized journal: only the read projection is
    // tampered. The real-core happy path is covered by the settle test above.
    const tamper=(mutateResult:(r:CashuResult)=>void,mutateOutbox:(e:OutboxEvent)=>void):TrustedCashuJournal=>({
      get:id=>ctx.journal.get(id),
      savedResult:id=>{const saved=ctx.journal.savedResult(id);if(!saved)return null;const copy=structuredClone(saved);mutateResult(copy);return copy;},
      pending:()=>ctx.journal.pending().map(event=>{const copy=structuredClone(event);mutateOutbox(copy);return copy;}),
      ack:id=>ctx.journal.ack(id),
    });
    const feeHostile=new CashuInvoiceIntake(ctx.store,tamper(r=>{r.fee='5';},e=>{e.fee='5';}),{journalAlias:'primary',agreements:ctx.agreements});
    const feeDecision=feeHostile.settle('owner',opId);
    assert.equal(feeDecision.classification,'rejected');assert.deepEqual(feeDecision.reasons,['fee_exceeds_maximum']);
    const mintHostile=new CashuInvoiceIntake(ctx.store,tamper(r=>{r.mint='https://hostile-mint.invalid';},e=>{e.mint='https://hostile-mint.invalid';}),{journalAlias:'primary',agreements:ctx.agreements});
    const mintDecision=mintHostile.settle('owner',opId);
    assert.equal(mintDecision.classification,'rejected');assert.deepEqual(mintDecision.reasons,['mint_mismatch']);
    assert.equal(ctx.ledger.read('owner',invoice.id).entries.length,0);
    // Nothing was acknowledged and the genuine result stays untouched.
    assert.equal(ctx.journal.pending().length,1);
    assert.equal(ctx.journal.savedResult(opId)!.fee,result.fee);
  }finally{ctx.close();}
});

test('the same operation or result cannot allocate to another tenant, invoice or journal alias',async()=>{
  const ctx=context();try{
    const keyset=zeroKeyset(),invoice=satInvoice(3),otherInvoice=satInvoice(3);
    ctx.store.addInvoice('owner',invoice);ctx.store.addInvoice('owner',otherInvoice);
    const tenantInvoice=satInvoice(3);
    ctx.store.addInvoice('tenant-b',tenantInvoice);
    const opId='fictional-duplicate-op-1';
    await driveOp(ctx.journal,keyset,opId,invoice.id,undefined,()=>{ctx.intake.bind('owner',invoice.id,bindRequest(opId));});
    assert.equal(ctx.intake.settle('owner',opId).classification,'accepted_locked');
    // Rebinding to another invoice is refused outright.
    assert.throws(()=>ctx.intake.bind('owner',otherInvoice.id,bindRequest(opId)),/untouched prepared/);
    // Another tenant sees an unbound operation and gains nothing.
    const tenantView=ctx.intake.settle('tenant-b',opId);
    assert.equal(tenantView.classification,'unknown');assert.deepEqual(tenantView.reasons,['unbound_operation']);
    assert.equal(tenantView.receipt,undefined);assert.equal(tenantView.invoiceId,undefined);
    assert.equal(ctx.ledger.read('owner',invoice.id).entries.length,1);
    assert.equal(ctx.ledger.read('tenant-b',tenantInvoice.id).entries.length,0);
    // Another journal alias over the same trusted journal has no binding.
    const otherAlias=new CashuInvoiceIntake(ctx.store,ctx.journal,{journalAlias:'other',agreements:ctx.agreements});
    assert.deepEqual(otherAlias.settle('owner',opId).reasons,['unbound_operation']);
    // The stable result identity is unique at the schema level.
    const allocation=ctx.store.db.prepare('SELECT binding_id,result_tag FROM cashu_intake_allocations WHERE operation_id=?').get(opId) as {binding_id:string;result_tag:string};
    assert.throws(()=>ctx.store.db.prepare('INSERT INTO cashu_intake_allocations(id,binding_id,journal_alias,operation_id,workspace,invoice_id,result_tag,receiving_id,data) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('fictional-duplicate-id',allocation.binding_id,'primary','fictional-other-op','owner',otherInvoice.id,allocation.result_tag,'fictional-duplicate-recv','{}'),/UNIQUE constraint failed/);
  }finally{ctx.close();}
});

test('application database and public results carry no bearer proof material',async()=>{
  const ctx=context();try{
    const keyset=zeroKeyset(),invoice=satInvoice(3);
    ctx.store.addInvoice('owner',invoice);
    const opId='fictional-secrets-op-1';
    const result=(await driveOp(ctx.journal,keyset,opId,invoice.id,undefined,()=>{ctx.intake.bind('owner',invoice.id,bindRequest(opId));})) as CashuResult;
    // Bind the second request before settlement; late value is reconciled, never retroactively bound.
    await driveOp(ctx.journal,keyset,'fictional-secrets-op-2',invoice.id,{mint:'https://second-fixture.invalid'},()=>{ctx.intake.bind('owner',invoice.id,bindRequest('fictional-secrets-op-2',{mint:'https://second-fixture.invalid'}));});
    const settled=ctx.intake.settle('owner',opId);
    ctx.intake.settle('owner','fictional-secrets-op-2');
    const secrets=[
      '407915bc212be61a77e3e6d2aeb4c727980bda51cd06a6afc29e2861768a7837',
      'fe15109314e61d7756b0f8ee0f23a624acaa3f4e042f61433c728c7057b931be',
      'd341ee4871f1f889041e63cf0d3823c713eea6aff01e80f1719f08f9e5be98f6',
      'f1aaf16c2239746f369572c0784d9dd3d032d952c2d992175873fb58fae31a60',
      ...result.proofs.map(proof=>proof.secret),
    ];
    // Views and public results stay clean of proof material.
    assertSafePayload(settled,{secrets});
    assertSafePayload(ctx.intake.reviewList('owner'),{secrets});
    assertSafePayload(ctx.ledger.read('owner',invoice.id),{secrets});
    assertSafePayload(ctx.ledger.getReceipt(settled.receipt!.receiptToken),{secrets});
    assertSafePayload(ctx.store.audits('owner',true),{secrets});
    // The encrypted application database bytes contain no plaintext secrets,
    // proof points, blinded messages or raw storage/encryption keys.
    const dbBytes=readFileSync(join(ctx.root,'app.sqlite'));
    const walPath=join(ctx.root,'app.sqlite-wal');
    const allBytes=[dbBytes,...(existsSync(walPath)?[readFileSync(walPath)]:[])];
    const points=[...result.proofs.map(proof=>proof.C),...result.proofs.flatMap(proof=>{
      const dleq=(proof as {dleq?:{e:string;s:string;r?:string}}).dleq;
      return dleq?[dleq.e,dleq.s,dleq.r??'']:[];
    })];
    const request=JSON.parse(ctx.journal.requestOf(opId)??'{}');
    const blinded=(request.outputs??[]).map((output:{B_:string})=>output.B_);
    for(const bytes of allBytes){
      for(const secret of secrets)assert.equal(bytes.includes(Buffer.from(secret,'utf8')),false,'app database leaked a fixture secret');
      for(const point of points)assert.equal(bytes.includes(Buffer.from(point,'utf8')),false,'app database leaked a proof point');
      for(const b of blinded)assert.equal(bytes.includes(Buffer.from(b,'utf8')),false,'app database leaked a blinded message');
      assert.equal(bytes.includes(ctx.storageKey),false,'app database leaked the journal storage key');
      assert.equal(bytes.includes(ctx.encryptionKey),false,'app database leaked the application encryption key');
    }
  }finally{ctx.close();}
});

test('restart rejects a wrong encryption key and preserves the encrypted ledger',async()=>{
  const ctx=context();try{
    const keyset=zeroKeyset(),invoice=satInvoice(3);
    ctx.store.addInvoice('owner',invoice);
    const opId='fictional-restart-op-1';
    await driveOp(ctx.journal,keyset,opId,invoice.id,undefined,()=>{ctx.intake.bind('owner',invoice.id,bindRequest(opId));});
    ctx.intake.settle('owner',opId);
    ctx.close();
    assert.throws(()=>new Store(join(ctx.root,'app.sqlite'),{encryptionKey:randomBytes(32)}),/Encrypted database verification failed/);
    const store=ctx.openStore();
    try{
      const ledger=new InvoiceLedger(store);
      assert.equal(ledger.read('owner',invoice.id).balance.paid,3);
    }finally{store.close();}
  }finally{ctx.close();}
});


test('regression: first binding refuses finalized and uncertain operations even when previously unbound',async()=>{
 const ctx=context();try{
  const keyset=zeroKeyset(),invoice=satInvoice(9);ctx.store.addInvoice('owner',invoice);
  const done='regression-already-finalized';await driveOp(ctx.journal,keyset,done,invoice.id);
  assert.throws(()=>ctx.intake.bind('owner',invoice.id,bindRequest(done)),{code:'CASHU_OPERATION_NOT_UNTOUCHED'});
  const uncertain='regression-already-uncertain',mint='https://regression-uncertain.invalid';
  const {recovery}=await prepareOp(ctx.journal,keyset,uncertain,invoice.id,{mint});
  await assert.rejects(()=>recovery.submit(uncertain,async()=>{throw new Error('FICTIONAL_UNCERTAIN');}),/FICTIONAL_UNCERTAIN/);
  assert.throws(()=>ctx.intake.bind('owner',invoice.id,bindRequest(uncertain,{mint})),{code:'CASHU_OPERATION_NOT_UNTOUCHED'});
  assert.equal(ctx.store.db.prepare('SELECT count(*) AS n FROM cashu_intake_bindings').get()!.n,0);
  assert.equal(ctx.journal.pending().length,1);
 }finally{ctx.close();}
});

test('regression: premium agreement uses effective due and a partial or paid invoice cannot overbind',async()=>{
 const ctx=context();try{
  const keyset=zeroKeyset(),invoice=satInvoice(2,{methodPricing:[{method:'cashu',premiumBps:5000}]});
  ctx.store.addInvoice('owner',invoice);
  const offer=ctx.agreements.offers('owner',invoice,()=>true).find(row=>row.method==='cashu')!;
  ctx.agreements.confirm({checkoutToken:invoice.token,method:'cashu',offerHash:offer.offerHash},'regression-premium',()=>true);
  assert.equal(ctx.ledger.balance(invoice,'owner').effectiveTotal,3);
  const op='regression-premium-operation';
  await driveOp(ctx.journal,keyset,op,invoice.id,undefined,()=>{ctx.intake.bind('owner',invoice.id,bindRequest(op));});
  assert.equal(ctx.intake.settle('owner',op).receipt!.amount,3);
  assert.equal(ctx.store.getInvoice(invoice.id,'owner')!.total,2);
  const paidOp='regression-paid-operation',paidMint='https://regression-paid.invalid';
  await prepareOp(ctx.journal,keyset,paidOp,invoice.id,{mint:paidMint});
  assert.throws(()=>ctx.intake.bind('owner',invoice.id,bindRequest(paidOp,{mint:paidMint})),{code:'CASHU_BIND_EXCEEDS_BALANCE'});
  const partial=satInvoice(5);ctx.store.addInvoice('owner',partial);
  const partialOp='regression-partial-first',partialMint='https://regression-partial-first.invalid';
  await driveOp(ctx.journal,keyset,partialOp,partial.id,{mint:partialMint},()=>{ctx.intake.bind('owner',partial.id,bindRequest(partialOp,{mint:partialMint}));});
  ctx.intake.settle('owner',partialOp);assert.equal(ctx.ledger.balance(partial,'owner').due,2);
  const overOp='regression-partial-overbind',overMint='https://regression-partial-overbind.invalid';
  await prepareOp(ctx.journal,keyset,overOp,partial.id,{mint:overMint});
  assert.throws(()=>ctx.intake.bind('owner',partial.id,bindRequest(overOp,{mint:overMint})),{code:'CASHU_BIND_EXCEEDS_BALANCE'});
 }finally{ctx.close();}
});

test('regression: classifier fails closed for missing or malformed invoice facts and wrong binding identity',()=>{
 const binding:CashuIntakeBindingFacts={journalAlias:'primary',operationId:'op',workspace:'owner',invoiceId:'invoice',method:'cashu',mint:mintUrl,unit:'sat',keysetId:'keyset',netAmount:'3',maxFee:'0'};
 const result={operationId:'op',invoiceId:'invoice',mint:mintUrl,unit:'sat',keysetId:'keyset',amount:'3',fee:'0',proofCount:2};
 const event={...result};const facts:CashuIntakeJournalFacts={state:'finalized',result,outboxEvent:event};
 const invoice:CashuIntakeInvoiceFacts={currency:'SAT',allowsCashu:true,dueSats:'3',agreement:null};
 const decide=(...args:unknown[])=>(classifyCashuIntake as (...args:any[])=>ReturnType<typeof classifyCashuIntake>)(...args);
 for(const badInvoice of [undefined,null,{...invoice,dueSats:'bad'},{...invoice,dueSats:'3.5'},{...invoice,dueSats:'9007199254740993'}]){
  assert.notEqual(decide(binding,facts,badInvoice).classification,'accepted_locked');
 }
 assert.notEqual(decide({...binding,unit:'msat'},{...facts,result:{...result,unit:'msat'},outboxEvent:{...event,unit:'msat'}},invoice).classification,'accepted_locked');
 assert.notEqual(decide({...binding,method:'lightning'},facts,invoice).classification,'accepted_locked');
 const wrong=decide(binding,{...facts,result:{...result,invoiceId:'other'},outboxEvent:{...event,invoiceId:'other'}},invoice);
 assert.equal(wrong.classification,'rejected');assert.ok(wrong.reasons.includes('invoice_mismatch'));
});

test('regression: binding and allocation rows cannot be updated or deleted',async()=>{
 const ctx=context();try{
  const invoice=satInvoice(3),op='regression-immutable-operation';ctx.store.addInvoice('owner',invoice);
  await driveOp(ctx.journal,zeroKeyset(),op,invoice.id,undefined,()=>{ctx.intake.bind('owner',invoice.id,bindRequest(op));});
  ctx.intake.settle('owner',op);
  for(const table of ['cashu_intake_bindings','cashu_intake_allocations']){
   assert.throws(()=>ctx.store.db.prepare(`UPDATE ${table} SET data=data WHERE operation_id=?`).run(op),/immutable|append-only/);
   assert.throws(()=>ctx.store.db.prepare(`DELETE FROM ${table} WHERE operation_id=?`).run(op),/immutable|append-only/);
  }
  assert.equal(ctx.ledger.read('owner',invoice.id).balance.paid,3);
 }finally{ctx.close();}
});

test('regression: a second alias cannot reserve the same prepared operation',async()=>{
 const ctx=context();try{
  const invoice=satInvoice(3),op='regression-alias-operation';ctx.store.addInvoice('owner',invoice);
  await prepareOp(ctx.journal,zeroKeyset(),op,invoice.id);
  ctx.intake.bind('owner',invoice.id,bindRequest(op));
  const alias=new CashuInvoiceIntake(ctx.store,ctx.journal,{journalAlias:'other'});
  assert.throws(()=>alias.bind('owner',invoice.id,bindRequest(op)),{code:'CASHU_OPERATION_ALREADY_BOUND'});
  assert.equal(ctx.store.db.prepare('SELECT count(*) AS n FROM cashu_intake_bindings').get()!.n,1);
 }finally{ctx.close();}
});

test('regression: reused result tag fails with a stable conflict before any second credit',async()=>{
 const ctx=context();try{
  const keyset=zeroKeyset(),first=satInvoice(3),second=satInvoice(3);ctx.store.addInvoice('owner',first);ctx.store.addInvoice('owner',second);
  const op1='regression-result-first',op2='regression-result-second',secondMint='https://regression-result-second.invalid';
  await driveOp(ctx.journal,keyset,op1,first.id,undefined,()=>{ctx.intake.bind('owner',first.id,bindRequest(op1));});
  await driveOp(ctx.journal,keyset,op2,second.id,{mint:secondMint},()=>{ctx.intake.bind('owner',second.id,bindRequest(op2,{mint:secondMint}));});
  const firstTag=ctx.journal.pending().find(event=>event.operationId===op1)!.resultTag;
  ctx.intake.settle('owner',op1);
  const repeated:TrustedCashuJournal={get:id=>ctx.journal.get(id),savedResult:id=>ctx.journal.savedResult(id),pending:()=>ctx.journal.pending().map(e=>e.operationId===op2?{...e,resultTag:firstTag}:e),ack:()=>{throw new Error('must not ack');}};
  const intake=new CashuInvoiceIntake(ctx.store,repeated,{journalAlias:'primary'});
  assert.throws(()=>intake.settle('owner',op2),{code:'CASHU_RESULT_ALREADY_ALLOCATED'});
  assert.equal(ctx.ledger.read('owner',second.id).balance.paid,0);
  assert.equal(ctx.journal.pending().length,1);
 }finally{ctx.close();}
});


test('regression: noncanonical or unbounded satoshi bind text is refused before any effect',async()=>{
 const ctx=context();try{
  const invoice=satInvoice(3),op='regression-canonical-amounts';ctx.store.addInvoice('owner',invoice);
  await prepareOp(ctx.journal,zeroKeyset(),op,invoice.id);
  for(const override of [{netAmount:'03'},{maxFee:'00'},{netAmount:'0'.repeat(100000)+'3'},{maxFee:'0'.repeat(100000)}]){
   assert.throws(()=>ctx.intake.bind('owner',invoice.id,bindRequest(op,override)),/whole-satoshi/);
  }
  assert.equal(ctx.intake.binding('owner',op),undefined);
  assert.equal(ctx.journal.get(op)!.state,'prepared');assert.equal(ctx.journal.get(op)!.attempts,0);
  assert.doesNotThrow(()=>ctx.intake.bind('owner',invoice.id,bindRequest(op)));
 }finally{ctx.close();}
});
