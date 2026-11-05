import {receivingAdapterSupportsCurrency} from '../shared/receiving.js';
import {invoiceAllowsMethod} from '../shared/invoice-options.js';
import {randomUUID,randomBytes} from 'node:crypto';
import type {Invoice,Receipt} from '../shared/contracts.js';
import {methodInfo,type MethodId} from '../shared/payment-methods.js';
import type {ReceivingAdapter,ReceivingContext,ReceivingIntent,ReceivingObservation,ReceivingRecord} from '../shared/receiving.js';
import {Store,DomainError,hash} from './store.js';
import {publicInvoice} from './domain.js';

export interface ReceivingQuote {expectedAtomic:string;cadEquivalent:number;source:string;observedAt:string}
export type QuoteReceiving=(invoice:Invoice,method:MethodId,mode:'live'|'test')=>Promise<ReceivingQuote>;
interface Stored extends ReceivingRecord {workspace:string;context:ReceivingContext;quote:ReceivingQuote}
const keyValid=(key:string|undefined)=>Boolean(key&&/^[A-Za-z0-9._:-]{1,128}$/.test(key));
function safeIntent(intent:ReceivingIntent|undefined){if(!intent)return undefined;const {providerId,url,request,network,asset,instructions}=intent;return {providerId,url,request,network,asset,instructions};}
export class ReceivingService {
  private active=new Map<string,Promise<Stored>>();private cooldown=new Map<string,number>();
  constructor(private store:Store,readonly adapters:ReceivingAdapter[],private quote:QuoteReceiving,private now:()=>Date,private publicOrigin?:string){
    if(new Set(adapters.map(a=>a.id)).size!==adapters.length)throw new Error('Receiving adapter ids must be unique.');
    store.db.exec('CREATE TABLE IF NOT EXISTS receiving_requests(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,invoice_id TEXT NOT NULL REFERENCES invoices(id),token TEXT NOT NULL UNIQUE,allocation_key TEXT UNIQUE,payment_key TEXT UNIQUE,data TEXT NOT NULL)');
  }
  metadata(){return this.adapters.map(({id,methods,mode,walletOptionIds,label,supportedCurrencies,supportedCurrenciesByMethod})=>({id,methods,mode,walletOptionIds,...(label?{label}:{}),...(supportedCurrencies?{supportedCurrencies}:{}),...(supportedCurrenciesByMethod?{supportedCurrenciesByMethod}:{})}));}
  hasLive(){return this.adapters.some(adapter=>adapter.mode==='live');}
  private adapter(id:string){const adapter=this.adapters.find(a=>a.id===id);if(!adapter)throw new DomainError(503,'This receiving connection is not configured. Choose a configured wallet or provider.');return adapter;}
  private get(id:string,workspace?:string):Stored{
    const row=workspace?this.store.db.prepare('SELECT id,workspace,data FROM receiving_requests WHERE id=? AND workspace=?').get(id,workspace):this.store.db.prepare('SELECT id,workspace,data FROM receiving_requests WHERE id=?').get(id);
    if(!row)throw new DomainError(404,'Receive request not found.');return this.store.decode(row.data,'receiving_requests',String(row.id),String(row.workspace));
  }
  private allocationIndex(value:string,workspace:string){return this.store.indexValue('allocation',workspace==='owner'&&!this.store.encrypted?value:JSON.stringify([workspace,value]));}
  private save(record:Stored,paymentKey?:string){this.store.db.prepare('UPDATE receiving_requests SET allocation_key=?,payment_key=COALESCE(?,payment_key),data=? WHERE id=?').run(record.intent?.allocationKey?this.allocationIndex(record.intent.allocationKey,record.workspace):null,paymentKey??null,this.store.encode(record,'receiving_requests',record.id,record.workspace),record.id);}
  view(record:Stored,publicView=false){
    const {workspace:_workspace,context:_context,quote,invoiceId,...rest}=record;
    return {...rest,...(!publicView?{invoiceId}:{}),intent:safeIntent(record.intent),quote};
  }
  list(workspace='owner',limit=50,before=Number.MAX_SAFE_INTEGER){
    const rows=this.store.db.prepare('SELECT rowid,id,workspace,data FROM receiving_requests WHERE workspace=? AND rowid<? ORDER BY rowid DESC LIMIT ?').all(workspace,before,limit+1);
    const extra=rows.length>limit;const page=rows.slice(0,limit);
    return {requests:page.map(row=>this.view(this.store.decode(row.data,'receiving_requests',String(row.id),String(row.workspace)))),nextCursor:extra?Buffer.from(String(page.at(-1)!.rowid)).toString('base64url'):null};
  }
  read(id:string,workspace='owner'){return this.view(this.get(id,workspace));}
  async recover(id:string,workspace='owner'){
    const record=this.get(id,workspace);
    const key=this.store.retryKeyForResource(`receiving:${workspace}`,id);
    if(!key)throw new DomainError(409,'The original request identity is unavailable; manual reconciliation is required.');
    return this.create(workspace,{invoiceId:record.invoiceId,method:record.method,adapterId:record.adapterId},key);
  }
  publicRead(token:string){const row=this.store.db.prepare('SELECT id,workspace,invoice_id,data FROM receiving_requests WHERE token=?').get(this.store.tokenIndex(token));if(!row||this.store.linksRevoked(String(row.invoice_id)))throw new DomainError(404,'Receive request not found.');return this.view(this.store.decode(row.data,'receiving_requests',String(row.id),String(row.workspace)),true);}
  private async serial(id:string,operation:()=>Promise<Stored>):Promise<Stored>{
    const previous=this.active.get(id);if(previous){await previous.catch(()=>{});return this.serial(id,operation);}
    const pending=operation();this.active.set(id,pending);try{return await pending;}finally{if(this.active.get(id)===pending)this.active.delete(id);}
  }
  async create(workspace:string,input:{invoiceId:string;method:MethodId;adapterId:string},key:string|undefined){
    if(!keyValid(key))throw new DomainError(400,'A valid Idempotency-Key header is required.');
    const adapter=this.adapter(input.adapterId);if(!adapter.methods.includes(input.method))throw new DomainError(409,'This provider does not support the selected method.');
    const invoice=this.store.getInvoice(input.invoiceId,workspace);if(!invoice)throw new DomainError(404,'Invoice not found.');if(!invoiceAllowsMethod(invoice,input.method))throw new DomainError(400,'This payment method is not accepted for this invoice.');
    if(!receivingAdapterSupportsCurrency(adapter,invoice.currency,input.method))throw new DomainError(409,`This provider does not support ${invoice.currency} for the selected method. Choose a supported currency or another provider.`);
    const scope=`receiving:${workspace}`;
    const prior=this.store.db.prepare('SELECT response FROM idempotency WHERE scope=? AND key=?').get(scope,key!);
    let intent:Stored;
    if(prior){intent=this.store.idempotent(scope,key,input,201,()=>{throw new DomainError(409,'Saved receiving request unavailable.');}).body as Stored;}
    else{
      if(Number(this.store.db.prepare('SELECT COUNT(*) as n FROM receiving_requests WHERE invoice_id=? AND workspace=?').get(input.invoiceId,workspace)!.n)>=this.store.limits.receiveRequestsPerInvoice)throw new DomainError(429,'This invoice has reached its receiving-request limit. Reuse a saved request.');
      this.store.assertWriteBudget();
      if(invoice.status==='paid')throw new DomainError(409,'This invoice is already settled.');
      let quote:ReceivingQuote;try{quote=await this.quote(invoice,input.method,adapter.mode);}catch{throw new DomainError(503,'A current receiving quote is unavailable. No payment request was created.');}
      if(!/^[1-9]\d{0,20}$/.test(quote.expectedAtomic)||!Number.isSafeInteger(quote.cadEquivalent)||quote.cadEquivalent<0)throw new DomainError(503,'The receiving quote is invalid.');
      intent=this.store.idempotent(scope,key,input,201,()=>{
        if(Number(this.store.db.prepare('SELECT COUNT(*) as n FROM receiving_requests WHERE invoice_id=? AND workspace=?').get(input.invoiceId,workspace)!.n)>=this.store.limits.receiveRequestsPerInvoice)throw new DomainError(429,'This invoice has reached its receiving-request limit. Reuse a saved request.');
        const currentInvoice=this.store.getInvoice(input.invoiceId,workspace);if(!currentInvoice||currentInvoice.status==='paid')throw new DomainError(409,'Invoice state changed before request creation.');if(!invoiceAllowsMethod(currentInvoice,input.method))throw new DomainError(400,'This payment method is not accepted for this invoice.');
        const id=randomUUID(),createdAt=this.now().toISOString(),expiresAt=new Date(this.now().getTime()+(['fiat','noncash'].includes(methodInfo(input.method).settlement)?3600000:900000)).toISOString();
        const context:ReceivingContext={requestId:id,method:input.method,amount:invoice.total,currency:invoice.currency,expectedAtomic:quote.expectedAtomic,idempotencyKey:randomUUID(),createdAt,expiresAt,mode:adapter.mode};
        const record:Stored={id,token:randomBytes(32).toString('base64url'),workspace,invoiceId:invoice.id,invoiceNumber:invoice.number,method:input.method,adapterId:adapter.id,mode:adapter.mode,status:'creation_pending',amount:invoice.total,currency:invoice.currency,expectedAtomic:quote.expectedAtomic,createdAt,expiresAt,context,quote};
        if(this.publicOrigin)record.context.returnUrl=this.publicOrigin+'/receive/'+record.token;
        this.store.db.prepare('INSERT INTO receiving_requests(id,workspace,invoice_id,token,data) VALUES(?,?,?,?,?)').run(id,workspace,invoice.id,this.store.tokenIndex(record.token),this.store.encode(record,'receiving_requests',record.id,workspace));return record;
      }).body;
    }
    const record=await this.serial(intent.id,async()=>{
      const saved=this.get(intent.id,workspace);if(saved.status!=='creation_pending')return saved;
      if(Date.parse(saved.expiresAt)<=this.now().getTime())throw new DomainError(409,'This request expired before creation. Create a fresh request with a new retry key.');
      let result:ReceivingIntent;
      try{
        // Persist uncertainty before external work: a killed process cannot catch a timeout.
        const attempting=this.store.transaction(()=>{const current=this.get(saved.id);const recovering=Boolean(current.creationUncertain);current.creationUncertain=true;this.save(current);return {current,recovering};});
        if(attempting.recovering){
          if(adapter.recover)result=await adapter.recover(attempting.current.context);
          else if(adapter.creationRetrySafe)result=await adapter.create(attempting.current.context);
          else throw new DomainError(409,'Creation is uncertain. Recover the original provider request before creating another.');
        }else result=await adapter.create(attempting.current.context);
      }catch(error){
        if(error instanceof DomainError)throw error;
        const code=error&&typeof error==='object'&&'code'in error?String(error.code):'';
        if(code==='FIAT_CREATION_UNCERTAIN'||code==='LNURL_CREATION_UNCERTAIN')this.store.transaction(()=>{const current=this.get(saved.id);if(current.status==='creation_pending'){current.creationUncertain=true;this.save(current);}});
        throw new DomainError(saved.creationUncertain?409:502,'Receiving creation could not be completed. The saved request identity was retained; reconcile it before replacing it.');
      }
      if(!result||typeof result.providerId!=='string'||!result.providerId||result.providerId.length>4096)throw new DomainError(502,'The provider returned an invalid receiving intent.');
      return this.store.transaction(()=>{
        const current=this.get(saved.id);if(current.status!=='creation_pending')return current;
        if(result.allocationKey&&this.store.db.prepare('SELECT id FROM receiving_requests WHERE allocation_key=? AND id<>?').get(this.allocationIndex(result.allocationKey,current.workspace),current.id))throw new DomainError(409,'This receiving allocation is already assigned. Configure a fresh dedicated address or index.');
        current.intent=result;current.status='awaiting_payment';delete current.creationUncertain;this.save(current);return current;
      });
    });return this.view(record);
  }
  private commit(record:Stored,observation:Extract<ReceivingObservation,{status:'paid'}>,verification:'provider'|'manual'){
    if(observation.reference!==record.id||observation.amount!==record.amount||observation.currency!==record.currency||typeof observation.paymentId!=='string'||!observation.paymentId||observation.paymentId.length>4096)throw new DomainError(409,'Payment does not match the exact receiving request.');
    return this.store.transaction(()=>{
      const current=this.get(record.id);if(current.status==='paid')return current;
      const invoice=this.store.getInvoice(current.invoiceId,current.workspace);if(!invoice)throw new DomainError(404,'Invoice not found.');
      if(!invoiceAllowsMethod(invoice,current.method))throw new DomainError(400,'This payment method is not accepted for this invoice.');
      if(invoice.status==='paid'){current.reviewReason='This invoice was settled by another payment. Additional funds require review.';this.save(current);return current;}
      const identity=hash(`${current.intent?.asset??current.currency}:${current.intent?.network??current.currency}:${observation.paymentId}`);
      const paymentKey=this.store.indexValue('payment',current.workspace==='owner'&&!this.store.encrypted?identity:hash(`${current.workspace}:${current.adapterId}:${identity}`));
      if(this.store.db.prepare('SELECT id FROM receiving_requests WHERE payment_key=? AND id<>?').get(paymentKey,current.id))throw new DomainError(409,'This payment is already assigned to another receive request.');
      current.status='paid';delete current.reviewReason;const verifiedAt=this.now().toISOString();current.receipt={number:`PAY-${current.id}`,mode:current.mode,method:current.method,amount:current.amount,currency:current.currency,verifiedAt};
      this.save(current,paymentKey);
      if(verification==='manual')this.store.audit(current.workspace,'payment.manual_review',`${current.invoiceNumber}: owner reviewed the received payment; no automated bank or lender attestation.`,verifiedAt);
      if(current.mode==='live'){
        const receiptToken=randomBytes(32).toString('base64url');const nativePayment={asset:current.intent?.asset??current.currency,atomicAmount:current.expectedAtomic,network:current.intent?.network??'fiat',paymentId:observation.paymentId,verification};
        const receipt:Receipt={number:current.receipt.number,issuedAt:verifiedAt,mode:'live',method:current.method,amount:current.amount,currency:current.currency,invoiceNumber:invoice.number,title:invoice.title,customerName:invoice.customerName,nativePayment};
        this.store.addReceipt(receiptToken,invoice.id,receipt);this.store.saveInvoice({...invoice,status:'paid',settlementMode:'live',paidAt:verifiedAt,paymentMethod:current.method,receiptToken,totalCad:current.quote.cadEquivalent,nativePayment});
        this.store.audit(current.workspace,'payment.live_received',`${invoice.number}: live ${current.method} receipt recorded (${verification} verification).`,verifiedAt);
      }
      return current;
    });
  }
  async check(id:string,workspace='owner',evidence?:{transactionId?:string}){
    const saved=await this.serial(id,async()=>{
      const record=this.get(id,workspace);if(record.status==='paid')return record;if(!record.intent)throw new DomainError(409,'Recover receiving creation before checking payment.');
      let observation:ReceivingObservation;try{observation=await this.adapter(record.adapterId).check(record.context,record.intent,evidence);}catch{throw new DomainError(502,'Authoritative payment readback is unavailable. No receipt was issued.');}
      if(observation?.status==='paid'){
        if(Date.parse(record.expiresAt)<=this.now().getTime())return this.store.transaction(()=>{const current=this.get(id);if(current.status!=='paid'){current.reviewReason='A payment observed after quote expiry requires owner review.';this.save(current);}return current;});
        return this.commit(record,observation,'provider');
      }
      if(!observation||!['pending','review'].includes(observation.status))throw new DomainError(502,'Invalid payment readback.');
      // Provider diagnostic text never becomes public invoice content.
      record.reviewReason=observation.status==='review'?'This payment requires owner review before a receipt can be issued.':undefined;
      this.store.transaction(()=>{const current=this.get(id);if(current.status!=='paid'){current.reviewReason=record.reviewReason;this.save(current);}});return this.get(id);
    });return this.view(saved);
  }
  async checkPublic(token:string,evidence?:{transactionId?:string}){
    const publicRecord=this.publicRead(token);const record=this.get(publicRecord.id);
    if(record.status==='paid')return this.view(record,true);
    const last=this.cooldown.get(record.id)??0;if(Date.now()-last<3000)return this.view(record,true);
    if(this.cooldown.size>=1000)this.cooldown.delete(this.cooldown.keys().next().value!);this.cooldown.set(record.id,Date.now());
    await this.check(record.id,record.workspace,evidence);return this.view(this.get(record.id),true);
  }
  confirm(id:string,workspace:string,note:string,transactionId:string){
    if(!note.trim()||note.length>1000||!transactionId.trim()||transactionId.length>200)throw new DomainError(400,'A review note and unique received transaction reference are required.');
    const record=this.get(id,workspace);if(!record.intent)throw new DomainError(409,'Receiving intent is not available.');
    const settled=this.commit(record,{status:'paid',amount:record.amount,currency:record.currency,reference:record.id,paymentId:transactionId},'manual');
    return this.view(settled);
  }
}
