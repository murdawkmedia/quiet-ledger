import {invoiceAllowsMethod} from '../shared/invoice-options.js';
import { randomBytes,randomUUID } from 'node:crypto';
import { createSquareSandboxClient,listSquareSandboxLocations,assertSquarePayment } from '../integrations/square.js';
import type { HttpFetch } from '../integrations/http.js';
import type { Currency,SquareTestCheckout,SquareSandboxView } from '../shared/contracts.js';
import { Store,DomainError } from './store.js';
import {MethodPriceAgreements} from './method-pricing.js';

export interface SquareSandboxOptions { token:string; locationId?:string; fetcher?:HttpFetch }
interface StoredCheckout extends SquareTestCheckout { invoiceId:string; locationId:string; providerKey:string; orderId?:string; linkId?:string; paymentId?:string; agreementId?:string }
type Connection={id:string;currency:'CAD'|'USD';verifiedAt:string};

export class SquareSandbox {
  private connection:Connection|null=null;
  private inFlight=new Map<string,Promise<StoredCheckout>>();
  private cooldown=new Map<string,number>();
  private pricing:MethodPriceAgreements;
  constructor(private store:Store,private options:SquareSandboxOptions|undefined,private now:()=>Date,pricing?:MethodPriceAgreements){
    this.pricing=pricing??new MethodPriceAgreements(store);
    store.db.exec(`CREATE TABLE IF NOT EXISTS square_test_checkouts (
      id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id),
      token TEXT NOT NULL UNIQUE,order_id TEXT UNIQUE,payment_id TEXT UNIQUE,data TEXT NOT NULL
    )`);
  }
  /**
   * A method-priced invoice can open a separate sandbox test only after a card
   * agreement exists and the whole effective total is due. Validated before any
   * outbound connect() call and again inside the saved intent transaction.
   */
  private requireAgreement(invoiceId:string):{amount:number;agreementId?:string}{
    const invoice=this.store.getInvoice(invoiceId,'owner');if(!invoice)throw new DomainError(404,'Owner invoice not found.');
    if(!invoice.methodPricing?.length)return {amount:invoice.total};
    const agreement=this.pricing.forInvoice('owner',invoiceId);
    if(!agreement)throw new DomainError(409,'Confirm a card method price before opening this sandbox test.','METHOD_AGREEMENT_REQUIRED');
    if(agreement.method!=='card')throw new DomainError(409,'This sandbox test requires the confirmed card method price.','METHOD_AGREEMENT_MISMATCH');
    // The whole effective total must still be due: no payment, credit or void entry.
    if(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='invoice_ledger_entries'").get()&&this.store.db.prepare('SELECT 1 FROM invoice_ledger_entries WHERE invoice_id=? LIMIT 1').get(invoiceId))throw new DomainError(409,'This sandbox test requires the whole effective invoice total to be due.');
    return {amount:agreement.effectiveTotal,agreementId:agreement.id};
  }
  private view(record:StoredCheckout):SquareTestCheckout {
    const {id,token,invoiceNumber,amount,currency,mode,status,createdAt,url,receipt}=record;
    return {id,token,invoiceNumber,amount,currency,mode,status,createdAt,...(url?{url}:{}),...(receipt?{receipt}:{})};
  }
  status():SquareSandboxView {
    const records=this.store.db.prepare('SELECT id,data FROM square_test_checkouts ORDER BY rowid DESC LIMIT 50').all();
    return {environment:'sandbox',configured:Boolean(this.options),connection:this.connection?{currency:this.connection.currency,verifiedAt:this.connection.verifiedAt}:null,checkouts:records.map(row=>{const record:StoredCheckout=this.store.decode<StoredCheckout>(row.data,'square_test_checkouts',String(row.id),'owner');return {...this.view(record),invoiceId:record.invoiceId};})};
  }
  private configured():SquareSandboxOptions {
    if(!this.options)throw new DomainError(503,'Square sandbox credentials are not configured. The simulation remains available.');
    return this.options;
  }
  async connect(){
    const options=this.configured();
    let locations;
    try{locations=await listSquareSandboxLocations(options.token,options.fetcher);}
    catch{throw new DomainError(502,'Square sandbox could not verify the credential. Check the private test configuration and try again.');}
    const candidates=options.locationId?locations.filter(x=>x.id===options.locationId):locations.filter(x=>x.currency==='CAD');
    const eligible=candidates.length?candidates:options.locationId?[]:locations;
    if(eligible.length!==1)throw new DomainError(503,'Choose one active CAD/USD sandbox location using SQUARE_SANDBOX_LOCATION_ID.');
    this.connection={...eligible[0],verifiedAt:this.now().toISOString()};
    return {currency:this.connection.currency,verifiedAt:this.connection.verifiedAt};
  }
  private record(id:string):StoredCheckout {
    const row=this.store.db.prepare('SELECT id,data FROM square_test_checkouts WHERE id=?').get(id);
    if(!row)throw new DomainError(404,'Square test checkout not found.');
    return this.store.decode<StoredCheckout>(row.data,'square_test_checkouts',String(row.id),'owner');
  }
  private save(record:StoredCheckout){
    this.store.db.prepare('UPDATE square_test_checkouts SET order_id=?,payment_id=?,data=? WHERE id=?').run(record.orderId??null,record.paymentId??null,this.store.encode(record,'square_test_checkouts',record.id,'owner'),record.id);
  }
  private client(record:StoredCheckout){
    const options=this.configured();
    return createSquareSandboxClient({token:options.token,locationId:record.locationId,locationCurrency:record.currency,fetcher:options.fetcher});
  }
  private async exclusive(id:string,action:()=>Promise<StoredCheckout>):Promise<StoredCheckout>{
    const current=this.inFlight.get(id);
    if(current){await current;return this.exclusive(id,action);}
    const pending=action();this.inFlight.set(id,pending);
    try{return await pending;}finally{if(this.inFlight.get(id)===pending)this.inFlight.delete(id);}
  }
  async create(invoiceId:string,key:string|undefined){
    // Validate retry semantics before any outbound call. The intent's provider
    // key survives an uncertain response and never depends on a browser retry.
    if(!key||!/^[A-Za-z0-9._:-]{1,128}$/.test(key))throw new DomainError(400,'A valid Idempotency-Key header is required.');
    this.configured();
    const selected=this.store.getInvoice(invoiceId,'owner');if(selected&&!invoiceAllowsMethod(selected,'card'))throw new DomainError(400,'This payment method is not accepted for this invoice.');
    // Fail closed on a missing card agreement before any sandbox connection work. A
    // nonexistent invoice stays 404 inside the idempotent scope so a reused key with a
    // changed body still conflicts (409) before any lookup-based failure.
    if(selected)this.requireAgreement(invoiceId);
    if(!this.connection)await this.connect();
    const intent=this.store.idempotent('square-test-intent',key,{invoiceId},201,()=>{
      const row=this.store.db.prepare('SELECT id,data FROM square_test_checkouts WHERE invoice_id=?').get(invoiceId);
      if(row)return this.store.decode<StoredCheckout>(row.data,'square_test_checkouts',String(row.id),'owner') as StoredCheckout;
      const invoice=this.store.getInvoice(invoiceId,'owner');
      if(!invoice)throw new DomainError(404,'Owner invoice not found.');
      if(invoice.status!=='open')throw new DomainError(409,'Choose an open invoice for this separate sandbox test.');
      if(invoice.currency!=='CAD'&&invoice.currency!=='USD')throw new DomainError(409,'Square sandbox supports CAD or USD invoices here.');
      if(invoice.currency!==this.connection!.currency)throw new DomainError(409,'Invoice currency must match the verified Square sandbox location.');
      // Recheck the card agreement and use the whole effective total inside the transaction.
      const priced=this.requireAgreement(invoiceId);
      const record:StoredCheckout={id:randomUUID(),token:randomBytes(32).toString('base64url'),invoiceId,invoiceNumber:invoice.number,amount:priced.amount,currency:invoice.currency,locationId:this.connection!.id,providerKey:randomUUID(),mode:'square_sandbox',status:'creation_pending',createdAt:this.now().toISOString(),...(priced.agreementId?{agreementId:priced.agreementId}:{})};
      this.store.db.prepare('INSERT INTO square_test_checkouts(id,invoice_id,token,data) VALUES(?,?,?,?)').run(record.id,invoiceId,this.store.tokenIndex(record.token),this.store.encode(record,'square_test_checkouts',record.id,'owner'));
      return record;
    }).body;
    const created=await this.exclusive(intent.id,async()=>{
      const record=this.record(intent.id);if(record.status!=='creation_pending')return record;
      try{
        const link=await this.client(record).createPaymentLink({amount:record.amount,currency:record.currency,title:'Quiet Ledger sandbox test',idempotencyKey:record.providerKey});
        return this.store.transaction(()=>{
          const current=this.record(record.id);
          if(current.status!=='creation_pending')return current;
          current.url=link.url;current.orderId=link.orderId;current.linkId=link.id;current.status='awaiting_payment';this.save(current);return current;
        });
      }catch{throw new DomainError(502,'Square test checkout is awaiting recovery. Retry this invoice; its saved request key will be reused.');}
    });
    return this.view(created);
  }
  publicView(token:string){
    const row=this.store.db.prepare('SELECT id,data FROM square_test_checkouts WHERE token=?').get(this.store.tokenIndex(token));
    if(!row)throw new DomainError(404,'Square test checkout not found.');
    return this.view(this.store.decode<StoredCheckout>(row.data,'square_test_checkouts',String(row.id),'owner'));
  }
  async checkPublic(token:string){
    const record=this.publicView(token);
    const last=this.cooldown.get(record.id)??0;
    if(record.status==='paid'||Date.now()-last<3000)return record;
    if(this.cooldown.size>=1000)this.cooldown.delete(this.cooldown.keys().next().value!);
    this.cooldown.set(record.id,Date.now());
    return this.reconcile(record.id);
  }
  async reconcile(id:string){
    const result=await this.exclusive(id,async()=>{
      const record=this.record(id);
      if(record.status==='paid')return record;
      if(!record.orderId)throw new DomainError(409,'Recover checkout creation before checking its payment.');
      const client=this.client(record);let order:any,payment:any;
      try{order=await client.getOrder(record.orderId);}catch{throw new DomainError(502,'Square sandbox payment readback is unavailable. The test remains unpaid.');}
      if(order?.id!==record.orderId||order.location_id!==record.locationId||order.total_money?.amount!==record.amount||order.total_money?.currency!==record.currency)throw new DomainError(409,'Square order does not match this exact sandbox invoice.');
      if(!order.tenders?.length)return record;
      if(!Array.isArray(order.tenders)||order.tenders.length!==1)throw new DomainError(409,'Multiple or invalid Square tenders require manual review.');
      const tender=order.tenders[0];
      if(!tender||typeof tender!=='object'||Array.isArray(tender))throw new DomainError(409,'Square tender is invalid and requires manual review.');
      const paymentId=tender.payment_id??tender.id;
      if(typeof paymentId!=='string'||!paymentId||paymentId.length>200)throw new DomainError(409,'Square tender has no valid payment reference.');
      try{payment=await client.getPayment(paymentId);}catch{throw new DomainError(502,'Square sandbox payment readback is unavailable. The test remains unpaid.');}
      if(payment?.status!=='COMPLETED')return record;
      try{assertSquarePayment(payment,{orderId:record.orderId,locationId:record.locationId,amount:record.amount,currency:record.currency});}
      catch{throw new DomainError(409,'Square payment does not match this exact sandbox invoice.');}
      const refund=payment.refunded_money;
      if(payment.id!==paymentId||(refund!==undefined&&(!refund||typeof refund!=='object'||!Number.isSafeInteger(refund.amount)||refund.amount!==0||refund.currency!==record.currency)))throw new DomainError(409,'Refunded or mismatched Square payment requires review.');
      return this.store.transaction(()=>{
        const current=this.record(id);if(current.status==='paid')return current;
        if(this.store.db.prepare('SELECT id FROM square_test_checkouts WHERE payment_id=? AND id<>?').get(paymentId,id))throw new DomainError(409,'Square payment is already bound to another test invoice.');
        current.status='paid';current.paymentId=paymentId;current.receipt={number:`SQTEST-${current.id.slice(0,8).toUpperCase()}`,mode:'square_sandbox',amount:current.amount,currency:current.currency,invoiceNumber:current.invoiceNumber,verifiedAt:this.now().toISOString()};
        this.save(current);return current;
      });
    });
    return this.view(result);
  }
}
