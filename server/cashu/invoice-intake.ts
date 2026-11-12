/**
 * Internal Cashu invoice settlement boundary (stage 1).
 *
 * This service binds one untouched prepared CashuJournal operation to an existing
 * private workspace's SAT-denominated invoice, freezing the exact mint, unit,
 * keyset, net whole satoshis, maximum fee and any confirmed method agreement,
 * and later allocates exactly one ledger payment when the same trusted journal
 * holds a finalized result with a matching pending outbox event. It is an
 * internal service only: it mounts no route, exposes no public ecash input,
 * generates no wallet seed or custody, performs no network or mint operation,
 * and cannot receive tokens from a user yet. Choosing and connecting merchant
 * custody remains an explicit future gate.
 *
 * Binding must happen while the operation is untouched and prepared, before
 * any mint effect. A previously unbound uncertain/finalized operation cannot
 * be retroactively bound. Its proofs and outbox remain in the journal for
 * explicit reconciliation outside this allocation path.
 *
 * Invariants:
 *   * Only this service's trusted journal reader supplies results; no
 *     caller-supplied outbox or result object can confer paid status.
 *   * Allocation and the stable operation/result receipt identity commit in
 *     one application transaction; the journal is acknowledged only after
 *     that commit. A crash between commit and acknowledge replays without a
 *     second credit and returns the same receipt.
 *   * The same operation or result cannot allocate to another tenant,
 *     invoice or journal alias.
 *   * Uncertain, UNSPENT, unbound and mismatched records stay uncredited and
 *     unacknowledged. Late or excess verified value is preserved in an
 *     encrypted review state for reconciliation; proofs never leave the
 *     journal and the issued invoice total is never rewritten.
 *   * SAT only: no fiat conversion is invented and whole-satoshi precision is
 *     enforced. The pure classification never implies paid.
 */

import {randomBytes,randomUUID} from 'node:crypto';
import type {Invoice,Receipt} from '../../shared/contracts.js';
import type {InvoiceLedgerEntry} from '../../shared/invoice-ledger.js';
import {invoiceAllowsMethod} from '../../shared/invoice-options.js';
import {classifyCashuIntake} from '../../shared/cashu-receiving.js';
import type {CashuIntakeBindingFacts,CashuIntakeDecision,CashuIntakeInvoiceFacts,CashuIntakeJournalFacts,CashuIntakeReason} from '../../shared/cashu-receiving.js';
import {DomainError,Store} from '../store.js';
import {InvoiceLedger} from '../invoice-ledger.js';
import {MethodPriceAgreements} from '../method-pricing.js';
import type {CashuJournal,CashuResult,OutboxEvent} from './cashu-journal.mjs';

/** The only journal surface this service trusts for reads and acknowledgements. */
export type TrustedCashuJournal=Pick<CashuJournal,'get'|'savedResult'|'pending'|'ack'>;

export interface CashuIntakeBindRequest{
  operationId:string;
  mint:string;
  unit:string;
  keysetId:string;
  /** Whole satoshis the invoice may credit; decimal integer text or number. */
  netAmount:string|number;
  /** Maximum whole-satoshi mint fee; decimal integer text or number. */
  maxFee:string|number;
}

interface StoredBinding extends CashuIntakeBindingFacts{id:string;boundAt:string}

interface StoredAllocation{
  id:string;bindingId:string;journalAlias:string;operationId:string;workspace:string;invoiceId:string;
  resultTag:string;receivingId:string;netAmount:string;fee:string;mint:string;unit:string;keysetId:string;
  settlement:'swap'|'restore';proofCount:number;receiptToken:string;receiptNumber:string;allocatedAt:string;
}

interface StoredReview{
  id:string;journalAlias:string;operationId:string;workspace:string;invoiceId:string;
  classification:'rejected'|'unknown';reasons:CashuIntakeReason[];
  observed:{state:string;amount?:string;fee?:string;proofCount?:number;resultTag?:string;mint?:string;unit?:string;keysetId?:string};
  netAmount:string;maxFee:string;firstSeenAt:string;lastSeenAt:string;
}

export interface CashuIntakeBindingView{
  id:string;journalAlias:string;operationId:string;workspace:string;invoiceId:string;
  method:'cashu';mint:string;unit:string;keysetId:string;netAmount:string;maxFee:string;
  agreementId?:string;boundAt:string;
}

export interface CashuIntakeReceiptView{
  receiptNumber:string;receiptToken:string;amount:number;currency:'SAT';method:'cashu';mode:'live';
  nativePayment:{asset:'cashu';atomicAmount:string;network:string;paymentId:string;verification:'provider'};
  issuedAt:string;
}

export interface CashuIntakeSettlementView{
  journalAlias:string;operationId:string;workspace:string;
  /** Present only for a binding visible to the calling workspace. */
  invoiceId?:string;
  classification:CashuIntakeDecision['classification'];
  reasons:CashuIntakeReason[];
  journalAck:'acked'|'pending'|'not_applicable';
  receipt?:CashuIntakeReceiptView;
  allocation?:{id:string;resultTag:string;netAmount:string;fee:string;settlement:'swap'|'restore';proofCount:number;allocatedAt:string};
}

export interface CashuIntakeReviewView extends Omit<StoredReview,'id'>{}

function satoshiText(value:string|number,options:{allowZero?:boolean;label:string}):string{
  const text=typeof value==='number'?String(value):value;
  if(typeof text!=='string'||!/^(?:0|[1-9][0-9]{0,15})$/.test(text))throw new DomainError(400,`${options.label} must be a whole-satoshi amount.`);
  if(BigInt(text)>BigInt(Number.MAX_SAFE_INTEGER))throw new DomainError(400,`${options.label} exceeds the supported whole-satoshi precision.`);
  if(!options.allowZero&&BigInt(text)===0n)throw new DomainError(400,`${options.label} must be a positive whole-satoshi amount.`);
  return text;
}

function resultFacts(result:CashuResult){return {operationId:result.operationId,invoiceId:result.invoiceId,mint:result.mint,unit:result.unit,keysetId:result.keysetId,amount:result.amount,fee:result.fee,proofCount:result.proofs.length};}
function outboxFacts(event:OutboxEvent){return {operationId:event.operationId,invoiceId:event.invoiceId,mint:event.mint,unit:event.unit,amount:event.amount,fee:event.fee,proofCount:event.proofCount};}

/**
 * Internal Cashu settlement intake for one trusted journal instance. The
 * journalAlias is the stable trusted journal identity: the parent must keep
 * the alias-to-journal mapping stable across restarts, because bindings,
 * allocations and replay deduplication are keyed by it.
 */
export class CashuInvoiceIntake{
  private ledger:InvoiceLedger;
  constructor(private store:Store,private journal:TrustedCashuJournal,private config:{journalAlias:string;agreements?:MethodPriceAgreements;now?:()=>Date}){
    if(!/^[A-Za-z0-9._:-]{1,64}$/.test(config.journalAlias))throw new Error('journalAlias must be 1..64 [A-Za-z0-9._:-] characters');
    this.ledger=new InvoiceLedger(store,config.agreements);
    store.db.exec(`CREATE TABLE IF NOT EXISTS cashu_intake_bindings (
      id TEXT PRIMARY KEY,journal_alias TEXT NOT NULL,operation_id TEXT NOT NULL,
      workspace TEXT NOT NULL,invoice_id TEXT NOT NULL REFERENCES invoices(id),data TEXT NOT NULL,
      UNIQUE(journal_alias,operation_id));
      CREATE INDEX IF NOT EXISTS cashu_intake_binding_workspace ON cashu_intake_bindings(workspace,invoice_id);
      CREATE TABLE IF NOT EXISTS cashu_intake_allocations (
      id TEXT PRIMARY KEY,binding_id TEXT NOT NULL UNIQUE REFERENCES cashu_intake_bindings(id),
      journal_alias TEXT NOT NULL,operation_id TEXT NOT NULL,workspace TEXT NOT NULL,invoice_id TEXT NOT NULL,
      result_tag TEXT NOT NULL,receiving_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL,
      UNIQUE(journal_alias,operation_id),UNIQUE(result_tag));
      CREATE INDEX IF NOT EXISTS cashu_intake_allocation_workspace ON cashu_intake_allocations(workspace,invoice_id);
      CREATE TABLE IF NOT EXISTS cashu_intake_reviews (
      id TEXT PRIMARY KEY,journal_alias TEXT NOT NULL,operation_id TEXT NOT NULL,
      workspace TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(journal_alias,operation_id));
      CREATE INDEX IF NOT EXISTS cashu_intake_review_workspace ON cashu_intake_reviews(workspace);
      CREATE UNIQUE INDEX IF NOT EXISTS cashu_intake_operation_binding ON cashu_intake_bindings(operation_id);
      CREATE UNIQUE INDEX IF NOT EXISTS cashu_intake_operation_allocation ON cashu_intake_allocations(operation_id);
      CREATE TRIGGER IF NOT EXISTS cashu_intake_bindings_no_update BEFORE UPDATE ON cashu_intake_bindings BEGIN SELECT RAISE(ABORT,'Cashu bindings are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS cashu_intake_bindings_no_delete BEFORE DELETE ON cashu_intake_bindings BEGIN SELECT RAISE(ABORT,'Cashu bindings are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS cashu_intake_allocations_no_update BEFORE UPDATE ON cashu_intake_allocations BEGIN SELECT RAISE(ABORT,'Cashu allocations are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS cashu_intake_allocations_no_delete BEFORE DELETE ON cashu_intake_allocations BEGIN SELECT RAISE(ABORT,'Cashu allocations are append-only'); END;`);
  }

  private now(){return (this.config.now??(()=>new Date))();}

  /**
   * Bind a not-yet-bound journal operation to an invoice, freezing the exact
   * settlement metadata. A bound operation is frozen forever: while it is
   * still untouched an identical request replays idempotently, any other
   * request is refused, and once an attempt has begun the operation can
   * never be rebound.
   */
  bind(workspace:string,invoiceId:string,request:CashuIntakeBindRequest):CashuIntakeBindingView{
    if(typeof workspace!=='string'||!workspace)throw new DomainError(400,'A workspace is required.');
    if(typeof invoiceId!=='string'||!invoiceId)throw new DomainError(400,'An invoice id is required.');
    if(typeof request!=='object'||request===null)throw new DomainError(400,'A bind request is required.');
    if(typeof request.operationId!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(request.operationId))throw new DomainError(400,'A valid journal operation id is required.');
    return this.store.transaction(()=>{
    const globalBinding=this.store.db.prepare('SELECT journal_alias FROM cashu_intake_bindings WHERE operation_id=?').get(request.operationId);
    if(globalBinding&&globalBinding.journal_alias!==this.config.journalAlias)throw new DomainError(409,'This journal operation is already bound.','CASHU_OPERATION_ALREADY_BOUND');
    const operation=this.journal.get(request.operationId);
    if(!operation)throw new DomainError(404,'Cashu journal operation not found.');
    if(request.unit!=='sat')throw new DomainError(409,'This intake boundary accepts sat-unit Cashu operations only.','CASHU_UNIT_NOT_SAT');
    if(operation.mint!==request.mint||operation.unit!==request.unit||operation.keysetId!==request.keysetId)throw new DomainError(409,'The prepared operation does not match the requested mint, unit or keyset.','CASHU_OPERATION_SCOPE_MISMATCH');
    const netAmount=satoshiText(request.netAmount,{label:'netAmount'});
    const maxFee=satoshiText(request.maxFee,{allowZero:true,label:'maxFee'});
    // Every initial binding and replay must precede any attempt or mint effect.
    const existing=this.bindingRow(this.config.journalAlias,request.operationId);
    if(operation.state!=='prepared'||operation.requestHash!==null||operation.attempts!==0)throw new DomainError(409,'Only an untouched prepared journal operation can be bound.','CASHU_OPERATION_NOT_UNTOUCHED');
    const invoice=this.store.getInvoice(invoiceId,workspace);
    if(!invoice)throw new DomainError(404,'Invoice not found.');
    if(invoice.currency!=='SAT')throw new DomainError(409,'Cashu intake settles SAT-denominated invoices only; no fiat conversion exists.','CASHU_CURRENCY_NOT_SAT');
    if(!invoiceAllowsMethod(invoice,'cashu'))throw new DomainError(400,'This payment method is not accepted for this invoice.','METHOD_NOT_ACCEPTED');
    // Priced invoices require the exact saved agreement; a lock on another
    // method permanently refuses native Cashu for this invoice.
    const agreement=this.ledger.agreements.require(workspace,invoice);
    if(agreement&&agreement.method!=='cashu')throw new DomainError(409,'This payment method does not match the confirmed method price.','METHOD_AGREEMENT_MISMATCH');
    const balance=this.ledger.balance(invoice,workspace);
    if(balance.mode!=='live')throw new DomainError(409,'Live Cashu intake requires a live-settlement invoice.','CASHU_NOT_LIVE_INVOICE');
    if(balance.state==='void')throw new DomainError(409,'A voided invoice cannot receive payments.','INVOICE_VOID');
    // Bind only against the current effective unpaid balance. Another bound
    // request may later settle first; such late results stay in review.
    if(BigInt(netAmount)>BigInt(balance.due))throw new DomainError(409,'The bound amount exceeds the current unpaid invoice balance.','CASHU_BIND_EXCEEDS_BALANCE');
    if(BigInt(operation.expectedAmount)!==BigInt(netAmount))throw new DomainError(409,'The prepared operation net amount does not equal the bound whole-satoshi amount.','CASHU_NET_AMOUNT_MISMATCH');
    if(BigInt(operation.expectedFee)>BigInt(maxFee))throw new DomainError(409,'The prepared operation fee exceeds the configured maximum.','CASHU_FEE_EXCEEDS_MAXIMUM');
    if(existing){
      if(existing.workspace!==workspace||existing.invoiceId!==invoiceId||existing.mint!==request.mint||existing.unit!==request.unit
        ||existing.keysetId!==request.keysetId||existing.netAmount!==netAmount||existing.maxFee!==maxFee
        ||existing.agreementId!==(agreement?.id??undefined))
        throw new DomainError(409,'This journal operation is already bound.','CASHU_OPERATION_ALREADY_BOUND');
      return this.bindingView(existing);
    }
    if(operation.invoiceId!==invoiceId)throw new DomainError(409,'The prepared operation is tagged for a different invoice.','CASHU_OPERATION_INVOICE_MISMATCH');
    return this.store.transaction(()=>{
      const raced=this.bindingRow(this.config.journalAlias,request.operationId);
      if(raced){
        if(raced.workspace!==workspace||raced.invoiceId!==invoiceId||raced.mint!==request.mint||raced.unit!==request.unit
          ||raced.keysetId!==request.keysetId||raced.netAmount!==netAmount||raced.maxFee!==maxFee
          ||raced.agreementId!==(agreement?.id??undefined))
          throw new DomainError(409,'This journal operation is already bound.','CASHU_OPERATION_ALREADY_BOUND');
        return this.bindingView(raced);
      }
      this.store.assertWriteBudget();
      const binding:StoredBinding={id:randomUUID(),journalAlias:this.config.journalAlias,operationId:request.operationId,workspace,invoiceId,
        method:'cashu',mint:request.mint,unit:request.unit,keysetId:request.keysetId,netAmount,maxFee,
        ...(agreement?{agreementId:agreement.id}:{}),boundAt:this.now().toISOString()};
      this.store.db.prepare('INSERT INTO cashu_intake_bindings(id,journal_alias,operation_id,workspace,invoice_id,data) VALUES(?,?,?,?,?,?)')
        .run(binding.id,binding.journalAlias,binding.operationId,workspace,invoiceId,this.store.encode(binding,'cashu_intake_bindings',binding.id,workspace));
      this.store.audit(workspace,'cashu.intake_bound',`${invoice.number}: prepared Cashu operation ${request.operationId} bound for ${netAmount} sats (maximum fee ${maxFee}).`,binding.boundAt);
      return this.bindingView(binding);
    });
    });
  }

  /** The binding visible to one workspace, without proof material. */
  binding(workspace:string,operationId:string):CashuIntakeBindingView|undefined{
    const row=this.bindingRow(this.config.journalAlias,operationId);
    return row&&row.workspace===workspace?this.bindingView(row):undefined;
  }

  /**
   * Read the finalized result and matching pending outbox through the trusted
   * journal and, when the pure classification accepts the frozen binding,
   * allocate exactly one ledger payment. The journal is acknowledged only
   * after the application commit; replay returns the same receipt.
   */
  settle(workspace:string,operationId:string):CashuIntakeSettlementView{
    const binding=this.bindingRow(this.config.journalAlias,operationId);
    if(!binding||binding.workspace!==workspace)return{journalAlias:this.config.journalAlias,operationId,workspace,classification:'unknown',reasons:['unbound_operation'],journalAck:'not_applicable'};
    const operation=this.journal.get(operationId);
    const result=operation?this.journal.savedResult(operationId):null;
    const outboxEvent=operation?(this.journal.pending().find(event=>event.operationId===operationId)??null):null;
    const facts:CashuIntakeJournalFacts=operation
      ?{state:operation.state,result:result?resultFacts(result):null,outboxEvent:outboxEvent?outboxFacts(outboxEvent):null}
      :{state:'missing',result:null,outboxEvent:null};
    // Replay after a commit-before-ack crash: the saved allocation is
    // authoritative and returns the identical receipt without new credit.
    const existing=this.allocationRow(this.config.journalAlias,operationId);
    if(existing){
      const journalAck=this.ensureAck(operationId);
      return{journalAlias:this.config.journalAlias,operationId,workspace,invoiceId:binding.invoiceId,
        classification:'accepted_locked',reasons:[],journalAck,receipt:this.receiptView(existing),
        allocation:this.allocationView(existing)};
    }
    const decision=classifyCashuIntake(binding,facts,this.invoiceFacts(binding));
    if(decision.classification!=='accepted_locked'){
      this.recordReview(binding,decision,facts,outboxEvent);
      return{journalAlias:this.config.journalAlias,operationId,workspace,invoiceId:binding.invoiceId,
        classification:decision.classification,reasons:decision.reasons,journalAck:'not_applicable'};
    }
    const allocation=this.store.transaction(()=>{
      const raced=this.allocationRow(this.config.journalAlias,operationId);
      if(raced)return raced;
      if(this.store.db.prepare('SELECT 1 FROM cashu_intake_allocations WHERE result_tag=?').get(outboxEvent!.resultTag))throw new DomainError(409,'This Cashu result is already allocated.','CASHU_RESULT_ALREADY_ALLOCATED');
      // Re-derive the invoice facts inside the commit transaction; a state
      // change since the outer read fails closed without any credit.
      const fresh=classifyCashuIntake(binding,facts,this.invoiceFacts(binding));
      if(fresh.classification!=='accepted_locked')throw new DomainError(409,'The Cashu settlement no longer matches its bound invoice.','CASHU_INTAKE_NOT_ACCEPTED');
      const invoice=this.store.getInvoice(binding.invoiceId,binding.workspace);
      if(!invoice)throw new DomainError(404,'Invoice not found.');
      const paymentId=`cashu:${this.config.journalAlias}:${operationId}`;
      // Defense in depth: the same external settlement never credits twice.
      if(this.store.listInvoices(binding.workspace).some(item=>this.ledger.paymentRecords(item,binding.workspace)
        .some(payment=>payment.mode==='live'&&payment.nativePayment?.paymentId===paymentId)))
        throw new DomainError(409,'This Cashu settlement is already assigned to another invoice.','CASHU_PAYMENT_ALREADY_ASSIGNED');
      this.store.assertWriteBudget();
      const allocatedAt=this.now().toISOString();
      const receiptToken=randomBytes(32).toString('base64url');
      const receiptNumber=`CASHU-${operationId}`;
      const nativePayment={asset:'cashu',atomicAmount:binding.netAmount,network:binding.mint,paymentId,verification:'provider'} as const;
      const receipt:Receipt={number:receiptNumber,issuedAt:allocatedAt,mode:'live',method:'cashu',amount:Number(binding.netAmount),currency:'SAT',
        invoiceNumber:invoice.number,title:invoice.title,customerName:invoice.customerName,nativePayment};
      const receivingId=randomUUID();
      const entry:InvoiceLedgerEntry={id:randomUUID(),kind:'payment',amount:Number(binding.netAmount),currency:'SAT',createdAt:allocatedAt,
        method:'cashu',verification:'provider',receiptToken,receiptNumber};
      this.ledger.payment(binding.workspace,invoice,receivingId,entry,receipt);
      const allocation:StoredAllocation={id:entry.id,bindingId:binding.id,journalAlias:binding.journalAlias,operationId,workspace:binding.workspace,
        invoiceId:binding.invoiceId,resultTag:outboxEvent!.resultTag,receivingId,netAmount:binding.netAmount,fee:result!.fee,mint:binding.mint,
        unit:binding.unit,keysetId:binding.keysetId,settlement:result!.settlement,proofCount:result!.proofs.length,
        receiptToken,receiptNumber,allocatedAt};
      this.store.db.prepare('INSERT INTO cashu_intake_allocations(id,binding_id,journal_alias,operation_id,workspace,invoice_id,result_tag,receiving_id,data) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(allocation.id,allocation.bindingId,allocation.journalAlias,allocation.operationId,allocation.workspace,allocation.invoiceId,
          allocation.resultTag,allocation.receivingId,this.store.encode(allocation,'cashu_intake_allocations',allocation.id,binding.workspace));
      const balance=this.ledger.balance(invoice,binding.workspace);
      const legacyReceipt=this.store.db.prepare('SELECT 1 FROM receipts WHERE invoice_id=?').get(invoice.id);
      // SAT invoices keep no CAD reference: their totalCad stays absent and
      // the issued total is never rewritten.
      this.store.saveInvoice({...invoice,status:balance.state==='paid'?'paid':'open',settlementMode:'live',
        ...(legacyReceipt?{}:{...(balance.state==='paid'?{paidAt:allocatedAt}:{}),paymentMethod:'cashu',receiptToken,nativePayment})});
      this.store.audit(binding.workspace,'cashu.intake_settled',`${invoice.number}: live cashu receipt recorded (provider verification).`,allocatedAt);
      return allocation;
    });
    const journalAck=this.ensureAck(operationId);
    return{journalAlias:this.config.journalAlias,operationId,workspace,invoiceId:binding.invoiceId,
      classification:'accepted_locked',reasons:[],journalAck,receipt:this.receiptView(allocation),
      allocation:this.allocationView(allocation)};
  }

  /** Uncredited settlement attempts visible to one workspace, newest last. */
  reviewList(workspace:string):CashuIntakeReviewView[]{
    return this.store.db.prepare('SELECT id,data FROM cashu_intake_reviews WHERE workspace=? ORDER BY rowid').all(workspace)
      .map(row=>{const {id:_id,...view}=this.store.decode<StoredReview>(row.data,'cashu_intake_reviews',String(row.id),workspace);return view;});
  }

  private bindingRow(journalAlias:string,operationId:string):StoredBinding|undefined{
    const row=this.store.db.prepare('SELECT id,workspace,data FROM cashu_intake_bindings WHERE journal_alias=? AND operation_id=?').get(journalAlias,operationId);
    return row?this.store.decode<StoredBinding>(row.data,'cashu_intake_bindings',String(row.id),String(row.workspace)):undefined;
  }

  private allocationRow(journalAlias:string,operationId:string):StoredAllocation|undefined{
    const row=this.store.db.prepare('SELECT id,workspace,data FROM cashu_intake_allocations WHERE journal_alias=? AND operation_id=?').get(journalAlias,operationId);
    return row?this.store.decode<StoredAllocation>(row.data,'cashu_intake_allocations',String(row.id),String(row.workspace)):undefined;
  }

  private bindingView(binding:StoredBinding):CashuIntakeBindingView{
    const {id,journalAlias,operationId,workspace,invoiceId,method,mint,unit,keysetId,netAmount,maxFee,agreementId,boundAt}=binding;
    return {id,journalAlias,operationId,workspace,invoiceId,method,mint,unit,keysetId,netAmount,maxFee,...(agreementId?{agreementId}:{}),boundAt};
  }

  private receiptView(allocation:StoredAllocation):CashuIntakeReceiptView{
    return {receiptNumber:allocation.receiptNumber,receiptToken:allocation.receiptToken,amount:Number(allocation.netAmount),
      currency:'SAT',method:'cashu',mode:'live',
      nativePayment:{asset:'cashu',atomicAmount:allocation.netAmount,network:allocation.mint,
        paymentId:`cashu:${allocation.journalAlias}:${allocation.operationId}`,verification:'provider'},
      issuedAt:allocation.allocatedAt};
  }

  private allocationView(allocation:StoredAllocation):NonNullable<CashuIntakeSettlementView['allocation']>{
    return {id:allocation.id,resultTag:allocation.resultTag,netAmount:allocation.netAmount,fee:allocation.fee,
      settlement:allocation.settlement,proofCount:allocation.proofCount,allocatedAt:allocation.allocatedAt};
  }

  private invoiceFacts(binding:StoredBinding):CashuIntakeInvoiceFacts{
    const invoice=this.store.getInvoice(binding.invoiceId,binding.workspace);
    if(!invoice)return {currency:'',allowsCashu:false,dueSats:'0',agreement:null};
    const agreement=this.ledger.agreementFor(invoice,binding.workspace);
    return {currency:invoice.currency,allowsCashu:invoiceAllowsMethod(invoice,'cashu'),
      dueSats:String(this.ledger.balance(invoice,binding.workspace).due),
      agreement:agreement?{id:agreement.id,method:agreement.method}:null};
  }

  /** Acknowledge the journal after the application commit; a failure stays retryable. */
  private ensureAck(operationId:string):'acked'|'pending'{
    try{this.journal.ack(operationId);return 'acked';}
    catch{return 'pending';}
  }

  private recordReview(binding:StoredBinding,decision:CashuIntakeDecision,facts:CashuIntakeJournalFacts,outboxEvent:OutboxEvent|null):void{
    const now=this.now().toISOString();
    const observed:StoredReview['observed']={state:facts.state,
      ...(facts.result?{amount:facts.result.amount,fee:facts.result.fee,proofCount:facts.result.proofCount,
        mint:facts.result.mint,unit:facts.result.unit,keysetId:facts.result.keysetId}:{}),
      ...(outboxEvent?{resultTag:outboxEvent.resultTag}:{})};
    const review:StoredReview={id:randomUUID(),journalAlias:binding.journalAlias,operationId:binding.operationId,
      workspace:binding.workspace,invoiceId:binding.invoiceId,
      classification:decision.classification==='rejected'?'rejected':'unknown',reasons:decision.reasons,
      observed,netAmount:binding.netAmount,maxFee:binding.maxFee,firstSeenAt:now,lastSeenAt:now};
    this.store.transaction(()=>{
      const row=this.store.db.prepare('SELECT id,data FROM cashu_intake_reviews WHERE journal_alias=? AND operation_id=?')
        .get(binding.journalAlias,binding.operationId);
      if(row){
        const saved=this.store.decode<StoredReview>(row.data,'cashu_intake_reviews',String(row.id),binding.workspace);
        const updated:StoredReview={...saved,classification:review.classification,reasons:review.reasons,observed,lastSeenAt:now};
        this.store.db.prepare('UPDATE cashu_intake_reviews SET data=? WHERE id=?')
          .run(this.store.encode(updated,'cashu_intake_reviews',String(row.id),binding.workspace),String(row.id));
        return;
      }
      this.store.assertWriteBudget();
      this.store.db.prepare('INSERT INTO cashu_intake_reviews(id,journal_alias,operation_id,workspace,data) VALUES(?,?,?,?,?)')
        .run(review.id,review.journalAlias,review.operationId,review.workspace,
          this.store.encode(review,'cashu_intake_reviews',review.id,review.workspace));
    });
  }
}
