import {createHash,randomUUID} from 'node:crypto';
import {METHOD_DEFINITIONS,type MethodId} from '../shared/payment-methods.js';
import {calculateMethodPrice,canonicalMethodPriceOfferInput,parseMethodPricingRules} from '../shared/method-pricing.js';
import type {InvoiceMethodAgreement,MethodPriceAmounts,MethodPriceOffer,MethodPricedInvoice,MethodPricingRule,PublicMethodAgreement} from '../shared/method-pricing-types.js';
import {DomainError,Store,hash} from './store.js';
import {invoiceAllowsMethod,currencyAllowsMethod} from '../shared/invoice-options.js';

/**
 * Current payability of one canonical method on one invoice, read through an
 * explicit callback supplied by the caller (accepted methods, currency, live
 * adapters and simulation eligibility). The callback must be synchronous and
 * side-effect free: it is invoked inside the confirmation transaction.
 */
export type PayableMethodCallback=(method:MethodId)=>boolean;

/** Public confirmation response; also the exact body stored for idempotent replay. */
export interface MethodAgreementConfirmation {agreement:PublicMethodAgreement}

export interface ConfirmMethodAgreementInput {
  /** Active public checkout bearer token; the only payer authority for confirmation. */
  checkoutToken:string;
  /** Canonical method id; aliases are rejected. */
  method:string;
  /** Exact 64 lowercase hex offer hash previously served for this invoice and method. */
  offerHash:string;
}

/**
 * Encrypted append-only invoice method agreements: at most one per invoice,
 * confirmed only by the active public checkout token before any saved
 * idempotency read. The service never mutates invoices, ledger entries,
 * receipts or payouts, and never creates a payment or credit.
 */
export class MethodPriceAgreements {
  constructor(private store:Store,private now:()=>Date=()=>new Date()){
    // Real financial records: owner rows are unconditionally update/delete
    // blocked. No priced hackathon-demo support or retention is enabled by this
    // slice; a narrowly scoped fictional-demo carve-out remains a parent decision.
    store.db.exec(`CREATE TABLE IF NOT EXISTS invoice_method_agreements (
      id TEXT PRIMARY KEY,workspace TEXT NOT NULL,
      invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id),data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS invoice_method_agreement_workspace ON invoice_method_agreements(workspace, invoice_id);
      CREATE TRIGGER IF NOT EXISTS invoice_method_agreement_no_update BEFORE UPDATE ON invoice_method_agreements BEGIN SELECT RAISE(ABORT,'Invoice method agreements are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS invoice_method_agreement_no_delete BEFORE DELETE ON invoice_method_agreements BEGIN SELECT RAISE(ABORT,'Invoice method agreements are append-only'); END;`);
  }

  private table(name:string):boolean{
    return Boolean(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  }

  /**
   * Any prior financial commitment permanently blocks a later agreement:
   * receiving requests in any state (including expired and creation-uncertain),
   * Square sandbox checkouts, payment reports, ledger entries (payment, credit
   * or void), legacy receipts and legacy paid status.
   */
  commitmentsExist(workspace:string,invoiceId:string):boolean{
    const db=this.store.db;
    if(this.table('receiving_requests')&&db.prepare('SELECT 1 FROM receiving_requests WHERE invoice_id=? AND workspace=? LIMIT 1').get(invoiceId,workspace))return true;
    // square_test_checkouts has no workspace column: bind the row through its invoice.
    if(this.table('square_test_checkouts')&&db.prepare('SELECT 1 FROM square_test_checkouts s JOIN invoices i ON i.id=s.invoice_id WHERE s.invoice_id=? AND i.workspace=? LIMIT 1').get(invoiceId,workspace))return true;
    if(this.table('payment_reports')&&db.prepare('SELECT 1 FROM payment_reports WHERE invoice_id=? AND workspace=? LIMIT 1').get(invoiceId,workspace))return true;
    if(this.table('invoice_ledger_entries')&&db.prepare('SELECT 1 FROM invoice_ledger_entries WHERE invoice_id=? AND workspace=? LIMIT 1').get(invoiceId,workspace))return true;
    if(db.prepare('SELECT 1 FROM receipts r JOIN invoices i ON i.id=r.invoice_id WHERE r.invoice_id=? AND i.workspace=? LIMIT 1').get(invoiceId,workspace))return true;
    const invoice=this.store.getInvoice(invoiceId,workspace);
    return invoice?.status==='paid';
  }

  /**
   * The saved agreement for one invoice in one workspace, with its immutable
   * stored amounts. Fails closed when the stored issued snapshot no longer
   * binds to the invoice (workspace, currency or original totals).
   */
  forInvoice(workspace:string,invoiceId:string):InvoiceMethodAgreement|undefined{
    const row=this.store.db.prepare('SELECT id,data FROM invoice_method_agreements WHERE invoice_id=? AND workspace=?').get(invoiceId,workspace);
    if(!row)return undefined;
    const agreement=this.store.decode<InvoiceMethodAgreement>(row.data,'invoice_method_agreements',String(row.id),workspace);
    if(agreement.id!==String(row.id)||agreement.invoiceId!==invoiceId)throw new DomainError(409,'The saved agreement has an inconsistent record binding.','METHOD_AGREEMENT_INCONSISTENT');
    this.assertBinding(workspace,agreement);
    return agreement;
  }

  private assertBinding(workspace:string,agreement:InvoiceMethodAgreement){
    const invoice=this.store.getInvoice(agreement.invoiceId,workspace);
    if(!invoice||agreement.currency!==invoice.currency||agreement.issuedSubtotal!==invoice.subtotal||agreement.issuedTax!==invoice.tax
      ||agreement.issuedTotal!==invoice.total||agreement.issuedDiscountAmount!==(invoice.discountAmount??0)||agreement.issuedPremiumAmount!==(invoice.premiumAmount??0))
      throw new DomainError(409,'The saved method agreement no longer matches its invoice. Manual review is required.','METHOD_AGREEMENT_INCONSISTENT');
  }

  /**
   * Priced settlement paths must hold a lock first. Without rules the legacy
   * branch stays valid; with rules and no agreement this fails closed with
   * METHOD_AGREEMENT_REQUIRED.
   */
  require(workspace:string,invoice:MethodPricedInvoice):InvoiceMethodAgreement|undefined{
    if(!invoice.methodPricing?.length)return undefined;
    const agreement=this.forInvoice(workspace,invoice.id);
    if(!agreement)throw new DomainError(409,'Confirm a payment-method price before requesting or crediting this invoice.','METHOD_AGREEMENT_REQUIRED');
    return agreement;
  }

  /** Pre-flight check that confirmation is still possible, before any quote or provider work. */
  assertCanConfirm(workspace:string,invoiceId:string):void{
    const invoice=this.store.getInvoice(invoiceId,workspace) as MethodPricedInvoice|undefined;
    if(!invoice)throw new DomainError(404,'Invoice not found.');
    if(!invoice.methodPricing?.length)throw new DomainError(400,'This invoice has no method pricing.');
    if(this.forInvoice(workspace,invoiceId))throw new DomainError(409,'This invoice already has a confirmed method price.','METHOD_AGREEMENT_LOCKED');
    if(this.commitmentsExist(workspace,invoiceId))throw new DomainError(409,'A financial commitment already exists for this invoice.','METHOD_AGREEMENT_COMMITMENT_EXISTS');
  }

  private validatedRules(invoice:MethodPricedInvoice):MethodPricingRule[]{
    try{return parseMethodPricingRules(invoice.methodPricing,{currency:invoice.currency,acceptedMethods:invoice.acceptedMethods})??[];}
    catch{throw new DomainError(409,'The saved method pricing rules are invalid for this invoice.');}
  }

  private price(invoice:MethodPricedInvoice,rule:MethodPricingRule):MethodPriceAmounts{
    try{return calculateMethodPrice(invoice,rule);}
    catch{throw new DomainError(409,'The invoice method price could not be computed from its saved snapshot.');}
  }

  offerHash(invoiceId:string,method:MethodId,amounts:MethodPriceAmounts):string{
    return createHash('sha256').update(canonicalMethodPriceOfferInput(invoiceId,method,amounts)).digest('hex');
  }

  /** Server-recomputed offers for currently payable methods; empty without rules or after lock. */
  offers(workspace:string,invoice:MethodPricedInvoice,payable:PayableMethodCallback):MethodPriceOffer[]{
    if(this.forInvoice(workspace,invoice.id))return [];
    const rules=this.validatedRules(invoice);
    if(!rules.length)return [];
    const methods=[...rules.map(rule=>rule.method),...METHOD_DEFINITIONS.map(row=>row.id).filter(method=>!rules.some(rule=>rule.method===method))];
    return methods.filter(method=>invoiceAllowsMethod(invoice,method)&&currencyAllowsMethod(invoice.currency,method)&&payable(method)).map(method=>{
      const rule=rules.find(rule=>rule.method===method)??{method};
      const amounts=this.price(invoice,rule);
      return {...amounts,method:rule.method,offerHash:this.offerHash(invoice.id,rule.method,amounts)};
    });
  }

  /**
   * Confirm one server-computed offer with the active checkout bearer token.
   * Authorization of the token happens before any saved-idempotency read, so a
   * revoked link can never replay an earlier success. Agreement insert, audit
   * and response are atomic; same key/body replays byte-identically, an altered
   * body under a saved key returns 409 and a second key racing the one-agreement
   * guard returns 409 without a second lock.
   */
  confirm(input:ConfirmMethodAgreementInput,key:string|undefined,payable:PayableMethodCallback):MethodAgreementConfirmation{
    if(typeof input.method!=='string'||!METHOD_DEFINITIONS.some(definition=>definition.id===input.method))throw new DomainError(400,'Choose a canonical payment method.');
    if(typeof input.offerHash!=='string'||!/^[0-9a-f]{64}$/.test(input.offerHash))throw new DomainError(400,'An exact server offer hash is required.');
    const checkout=this.store.getCheckout(input.checkoutToken);
    if(!checkout)throw new DomainError(404,'Checkout not found.');
    const workspace=checkout.workspace;
    return this.store.idempotent('method-agreement:'+workspace,key,{checkout:hash(input.checkoutToken),method:input.method,offerHash:input.offerHash},201,()=>{
      const current=this.store.getCheckout(input.checkoutToken);
      if(!current)throw new DomainError(404,'Checkout not found.');
      const invoice=current.invoice as MethodPricedInvoice;
      const rules=this.validatedRules(invoice);
      if(!rules.length)throw new DomainError(400,'This invoice has no method pricing.');
      const method=input.method as MethodId;
      if(!invoiceAllowsMethod(invoice,method)||!currencyAllowsMethod(invoice.currency,method))throw new DomainError(400,'This payment method is not accepted for this invoice.');
      const rule=rules.find(entry=>entry.method===method)??{method};
      if(!payable(rule.method))throw new DomainError(409,'This payment method is not currently payable.');
      const amounts=this.price(invoice,rule);
      if(this.offerHash(invoice.id,rule.method,amounts)!==input.offerHash)throw new DomainError(400,'The offer no longer matches this invoice. Reload the checkout.');
      if(this.forInvoice(workspace,invoice.id))throw new DomainError(409,'This invoice already has a confirmed method price.','METHOD_AGREEMENT_LOCKED');
      if(this.commitmentsExist(workspace,invoice.id))throw new DomainError(409,'A financial commitment already exists for this invoice.','METHOD_AGREEMENT_COMMITMENT_EXISTS');
      const agreement:InvoiceMethodAgreement={id:randomUUID(),invoiceId:invoice.id,method:rule.method,offerHash:input.offerHash,confirmedAt:this.now().toISOString(),confirmation:'public_checkout_token',
        currency:amounts.currency,eligibleSubtotal:amounts.eligibleSubtotal,issuedSubtotal:amounts.issuedSubtotal,issuedDiscountAmount:amounts.issuedDiscountAmount,issuedPremiumAmount:amounts.issuedPremiumAmount,
        issuedTax:amounts.issuedTax,issuedTotal:amounts.issuedTotal,discountBps:amounts.discountBps,premiumBps:amounts.premiumBps,discountAmount:amounts.discountAmount,premiumAmount:amounts.premiumAmount,
        adjustedSubtotal:amounts.adjustedSubtotal,effectiveTax:amounts.effectiveTax,taxAdjustment:amounts.taxAdjustment,effectiveTotal:amounts.effectiveTotal,totalAdjustment:amounts.totalAdjustment,
        ...(amounts.referenceTotalCad!==undefined?{referenceTotalCad:amounts.referenceTotalCad}:{}),...(amounts.referenceAmountSats!==undefined?{referenceAmountSats:amounts.referenceAmountSats}:{})};
      this.store.db.prepare('INSERT INTO invoice_method_agreements(id,workspace,invoice_id,data) VALUES(?,?,?,?)').run(agreement.id,workspace,invoice.id,this.store.encode(agreement,'invoice_method_agreements',agreement.id,workspace));
      // No payer identity is asserted: invoice number, method and minor-unit totals only.
      this.store.audit(workspace,'invoice.method_price_confirmed',`${invoice.number}: payer confirmed ${agreement.method} pricing at ${agreement.effectiveTotal} ${agreement.currency} minor units (issued total ${agreement.issuedTotal}).`,this.now().toISOString());
      return {agreement:this.publicView(agreement)};
    }).body;
  }

  /** Public-safe projection: no invoiceId, no labelled CAD reference, no capability. */
  publicView(agreement:InvoiceMethodAgreement):PublicMethodAgreement{
    const {invoiceId:_invoiceId,referenceTotalCad:_referenceTotalCad,...safe}=agreement;
    return safe;
  }
}
