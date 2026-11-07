import {randomUUID} from 'node:crypto';
import type {Invoice,Receipt} from '../shared/contracts.js';
import type {InvoiceBalance,InvoiceLedgerEntry,InvoiceLedgerView} from '../shared/invoice-ledger.js';
import {DomainError,Store} from './store.js';
import {MethodPriceAgreements} from './method-pricing.js';
import type {InvoiceMethodAgreement} from '../shared/method-pricing-types.js';

interface StoredEntry extends InvoiceLedgerEntry {receipt?:Receipt;cadEquivalent?:number}

/** Issued amounts stay in invoices; only new financial events are appended here. */
export class InvoiceLedger {
 readonly agreements:MethodPriceAgreements;
 constructor(private store:Store,agreements?:MethodPriceAgreements){
  this.agreements=agreements??new MethodPriceAgreements(store);
  store.db.exec(`CREATE TABLE IF NOT EXISTS invoice_ledger_entries (
   id TEXT PRIMARY KEY,workspace TEXT NOT NULL,invoice_id TEXT NOT NULL REFERENCES invoices(id),
   receiving_id TEXT UNIQUE,receipt_token TEXT UNIQUE,data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS invoice_ledger_invoice ON invoice_ledger_entries(workspace,invoice_id);
   CREATE TRIGGER IF NOT EXISTS invoice_ledger_no_update BEFORE UPDATE ON invoice_ledger_entries BEGIN SELECT RAISE(ABORT,'Invoice ledger entries are append-only'); END;
   CREATE TRIGGER IF NOT EXISTS invoice_ledger_no_delete BEFORE DELETE ON invoice_ledger_entries BEGIN SELECT RAISE(ABORT,'Invoice ledger entries are append-only'); END;
  `);
 }
 /** The one saved agreement for a priced invoice, read from its protected table; never a derived invoice field. */
 agreementFor(invoice:Invoice,workspace:string):InvoiceMethodAgreement|undefined{
  return invoice.methodPricing?.length?this.agreements.forInvoice(workspace,invoice.id):undefined;
 }
 private saved(invoice:Invoice,workspace:string):StoredEntry[]{
  return this.store.db.prepare('SELECT id,data FROM invoice_ledger_entries WHERE invoice_id=? AND workspace=? ORDER BY rowid').all(invoice.id,workspace).map(row=>this.store.decode<StoredEntry>(row.data,'invoice_ledger_entries',String(row.id),workspace));
 }
 private all(invoice:Invoice,workspace:string):StoredEntry[]{
  const entries=this.saved(invoice,workspace);
  const agreement=this.agreementFor(invoice,workspace);
  // Read old one-receipt records as events without rewriting any existing row.
  const old=this.store.db.prepare('SELECT token,data FROM receipts WHERE invoice_id=?').get(invoice.id);
  if(old){
   const receipt=this.store.decode<Receipt>(old.data,'receipts',invoice.id,workspace);
   entries.unshift({id:'legacy:'+invoice.id,kind:'payment',amount:receipt.amount,currency:receipt.currency,createdAt:receipt.issuedAt,method:receipt.method,
    ...(receipt.nativePayment?{verification:receipt.nativePayment.verification}:{}),receiptNumber:receipt.number,
    ...(invoice.receiptToken&&this.store.tokenIndex(invoice.receiptToken)===old.token?{receiptToken:invoice.receiptToken}:{}),receipt,cadEquivalent:agreement?.referenceTotalCad??invoice.totalCad});
  }else if(invoice.status==='paid'&&!entries.some(entry=>entry.kind==='payment')){
   entries.unshift({id:'legacy:'+invoice.id,kind:'payment',amount:agreement?.effectiveTotal??invoice.total,currency:invoice.currency,createdAt:invoice.paidAt??invoice.createdAt,method:invoice.paymentMethod,...(invoice.nativePayment?{verification:invoice.nativePayment.verification}:{}),...(invoice.receiptToken?{receiptToken:invoice.receiptToken}:{}),cadEquivalent:agreement?.referenceTotalCad??invoice.totalCad});
  }
  return entries;
 }
 /**
  * Authoritative balance. The settlement target is the agreement's effective total once
  * a payer confirmed a method price; paid, due, overpaid, credits and voids all use it.
  * The original issued total stays in `total` unchanged.
  */
 balance(invoice:Invoice,workspace=this.store.invoiceWorkspace(invoice.id)):InvoiceBalance {
  const entries=this.all(invoice,workspace),paid=entries.filter(e=>e.kind==='payment').reduce((sum,e)=>sum+e.amount,0),credited=entries.filter(e=>e.kind==='credit').reduce((sum,e)=>sum+e.amount,0),voided=entries.some(e=>e.kind==='void');
  if(!Number.isSafeInteger(paid)||!Number.isSafeInteger(credited))throw new DomainError(409,'Invoice balance exceeds the supported precision.');
  const target=this.agreementFor(invoice,workspace)?.effectiveTotal??invoice.total;
  const due=voided?0:Math.max(0,target-paid-credited),overpaid=Math.max(0,paid+credited-target);
  const state:InvoiceBalance['state']=voided?'void':paid>=target?'paid':due===0&&credited>0?'credited':paid>0?'partially_paid':'unpaid';
  return {total:invoice.total,effectiveTotal:target,paid,credited,due,overpaid,currency:invoice.currency,state,mode:invoice.settlementMode??(invoice.status==='paid'||workspace==='demo'?'simulation':'live')};
 }
 withBalance(invoice:Invoice,workspace=this.store.invoiceWorkspace(invoice.id)):Invoice {
  // Only the protected agreement table supplies priceAgreement; any derived field on the
  // stored row is replaced by the authoritative record (or removed when none exists).
  const agreement=this.agreementFor(invoice,workspace),{priceAgreement:_ignored,...rest}=invoice;
  return {...rest,...(agreement?{priceAgreement:agreement}:{}),balance:this.balance(invoice,workspace)};
 }
 read(workspace:string,id:string):InvoiceLedgerView {
  const invoice=this.store.getInvoice(id,workspace);if(!invoice)throw new DomainError(404,'Invoice not found.');
  const view=this.withBalance(invoice,workspace);
  const entries=this.all(invoice,workspace).map(({receipt:_receipt,cadEquivalent:_cadEquivalent,...entry})=>entry);
  return {invoice:view,balance:view.balance!,entries};
 }
 list(workspace:string){return this.store.listInvoices(workspace).map(invoice=>this.read(workspace,invoice.id));}
 private append(workspace:string,invoice:Invoice,entry:StoredEntry,receivingId?:string){
  // Existing verified payments use the reserved capacity; SQLite's hard cap remains.
  if(entry.kind!=='payment')this.store.assertWriteBudget();
  if(entry.kind!=='payment'&&Number(this.store.db.prepare('SELECT COUNT(*) AS n FROM invoice_ledger_entries WHERE invoice_id=? AND workspace=?').get(invoice.id,workspace)!.n)>=2000)throw new DomainError(429,'This invoice has reached its adjustment limit. Existing receiving requests remain reconcilable.');
  this.store.db.prepare('INSERT INTO invoice_ledger_entries(id,workspace,invoice_id,receiving_id,receipt_token,data) VALUES(?,?,?,?,?,?)').run(entry.id,workspace,invoice.id,receivingId??null,entry.receiptToken?this.store.tokenIndex(entry.receiptToken):null,this.store.encode(entry,'invoice_ledger_entries',entry.id,workspace));
 }
 credit(workspace:string,id:string,amount:number,reason:string,now:Date){
  return this.store.transaction(()=>{
   const invoice=this.store.getInvoice(id,workspace);if(!invoice)throw new DomainError(404,'Invoice not found.');
   // A base-price credit cannot strand an unpriceable method-priced balance.
   this.agreements.require(workspace,invoice);
   const view=this.read(workspace,id);
   if(!Number.isSafeInteger(amount)||amount<=0||!reason.trim()||reason.trim().length>1000)throw new DomainError(400,'A positive integer credit amount and reason are required.');
   if(view.balance.mode==='simulation'||view.balance.state==='void'||amount>view.balance.due)throw new DomainError(409,'Credit exceeds the current unpaid invoice balance.');
   this.append(workspace,view.invoice,{id:randomUUID(),kind:'credit',amount,currency:view.invoice.currency,reason:reason.trim(),createdAt:now.toISOString()});
   this.store.audit(workspace,'invoice.credited',`${view.invoice.number}: credit note recorded for ${amount} ${view.invoice.currency} minor units.`,now.toISOString());
   return this.read(workspace,id);
  });
 }
 void(workspace:string,id:string,reason:string,now:Date){
  return this.store.transaction(()=>{
   const view=this.read(workspace,id);if(!reason.trim()||reason.trim().length>1000)throw new DomainError(400,'A void reason is required.');
   if(view.balance.paid>0||view.balance.state==='void'||view.balance.mode==='simulation')throw new DomainError(409,'Only an unpaid invoice can be voided.');
   const requests=this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='receiving_requests'").get();
   if(requests&&this.store.db.prepare('SELECT id,data FROM receiving_requests WHERE invoice_id=? AND workspace=?').all(id,workspace).some(row=>{
    const request=this.store.decode<{mode:string;status:string}>(row.data,'receiving_requests',String(row.id),workspace);return request.mode==='live'&&request.status!=='paid';
   }))throw new DomainError(409,'An outstanding live receiving request must be reconciled before this invoice can be voided.');
   // Voiding an unpaid invoice keeps any agreement intact: the void amount uses the
   // effective target and the lock permanently blocks a later different choice.
   this.append(workspace,view.invoice,{id:randomUUID(),kind:'void',amount:view.balance.due,currency:view.invoice.currency,reason:reason.trim(),createdAt:now.toISOString()});
   this.store.audit(workspace,'invoice.voided',`${view.invoice.number}: unpaid invoice voided.`,now.toISOString());return this.read(workspace,id);
  });
 }
 payment(workspace:string,invoice:Invoice,receivingId:string,entry:InvoiceLedgerEntry,receipt:Receipt,cadEquivalent?:number){
  this.append(workspace,invoice,{...entry,receipt,cadEquivalent},receivingId);
 }
 receivedCad(invoice:Invoice,workspace:string){return this.all(invoice,workspace).filter(entry=>entry.kind==='payment').reduce((sum,entry)=>sum+(entry.cadEquivalent??0),0);}
 paymentRecords(invoice:Invoice,workspace:string){
  return this.all(invoice,workspace).filter(entry=>entry.kind==='payment').map(entry=>{
   const nativePayment=entry.receipt?.nativePayment??(entry.id.startsWith('legacy:')?invoice.nativePayment:undefined);
   return {invoiceNumber:invoice.number,method:entry.method,amount:entry.amount,currency:entry.currency,paidAt:entry.createdAt,mode:entry.receipt?.mode??invoice.settlementMode??'simulation',...(nativePayment?{nativePayment}:{})};
  });
 }
 getReceipt(token:string):{invoice:Invoice;receipt:Receipt}|undefined {
  const row=this.store.db.prepare('SELECT id,invoice_id,workspace,data FROM invoice_ledger_entries WHERE receipt_token=?').get(this.store.tokenIndex(token));
  if(!row||this.store.linksRevoked(String(row.invoice_id)))return undefined;
  const entry=this.store.decode<StoredEntry>(row.data,'invoice_ledger_entries',String(row.id),String(row.workspace)),invoice=this.store.getInvoice(String(row.invoice_id),String(row.workspace));
  return invoice&&entry.receipt?{invoice,receipt:entry.receipt}:undefined;
 }
}
