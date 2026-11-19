import {randomUUID} from 'node:crypto';
import {createInvoice} from './domain.js';
import {DomainError,type Store} from './store.js';
import type {ReceivingService} from './receiving-service.js';
import {sanitizeDemoLiveRequest,type DemoLivePaymentView} from '../shared/demo-live-payment.js';

/**
 * Deliberate real-payment sample for the fictional hackathon demo. Count Zapula's
 * existing Coinos receiver is used inside the demo visit; no separate private
 * login exists. One fixed 21-SAT live Lightning invoice is reserved per visit in
 * a separate internal live workspace bound to the demo visit, so the generic demo
 * cleanup can never purge real financial rows. Receiving-only: this class never
 * calls confirm, settleInvoice or any spend/send/withdraw route, and no automatic
 * outgoing payment exists anywhere.
 */
export interface DemoLivePaymentsOptions {
  store:Store;
  receiving:ReceivingService;
  adapterId:string;
  receiver:string;
  validVisit:(workspace:string)=>boolean;
  now?:()=>Date;
}

interface DemoLiveSampleMapping {kind:'quiet-ledger-demo-live-sample-v1';demoWorkspace:string;liveWorkspace:string;invoiceId:string;retryKey:string;createdAt:string}

const table='demo_live_payment_samples';
const cap=256;
const visitDenied=()=>new DomainError(403,'This demo visit is unavailable or expired. Start a fresh demo to use the real-payment sample.');
const invalidSample=()=>new DomainError(409,'The saved real-payment sample requires review. No replacement invoice was created.');
const identifier=/^[A-Za-z0-9._:-]{1,128}$/;

export class DemoLivePayments {
  private store:Store;
  private receiving:ReceivingService;
  private adapterId:string;
  private receiver:string;
  private validVisit:(workspace:string)=>boolean;
  private now:()=>Date;
  constructor(options:DemoLivePaymentsOptions) {
    this.store=options.store;
    this.receiving=options.receiving;
    this.adapterId=options.adapterId;
    this.receiver=options.receiver;
    this.validVisit=options.validVisit;
    this.now=options.now??(()=>new Date());
    const adapter=this.receiving.adapters.find(candidate=>candidate.id===this.adapterId);
    if(!adapter)throw new Error('The real-payment sample adapter is not configured.');
    if(adapter.mode!=='live')throw new Error('The real-payment sample adapter must be live mode.');
    if(!adapter.methods.includes('lightning'))throw new Error('The real-payment sample adapter must accept Lightning.');
    if(adapter.supportedCurrencies&&!adapter.supportedCurrencies.includes('SAT'))throw new Error('The real-payment sample adapter must support SAT.');
    const lightningCurrencies=adapter.supportedCurrenciesByMethod?.lightning;
    if(lightningCurrencies&&!lightningCurrencies.includes('SAT'))throw new Error('The real-payment sample adapter must support SAT for Lightning.');
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, demo_workspace TEXT NOT NULL UNIQUE, live_workspace TEXT NOT NULL UNIQUE, invoice_id TEXT NOT NULL, retry_key TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);`);
    for(const action of ['UPDATE','DELETE'])this.store.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'${table} rows are immutable'); END;`);
  }
  private assertVisit(workspace:string){if(typeof workspace!=='string'||!workspace||!this.validVisit(workspace))throw visitDenied();}
  private mapping(workspace:string):DemoLiveSampleMapping|undefined {
    const row=this.store.db.prepare(`SELECT * FROM ${table} WHERE demo_workspace=?`).get(workspace);
    if(!row)return undefined;
    try{
      // Keep the original authenticated context so existing reservations remain readable.
      // Every indexed identity must also match its authenticated payload.
      const decoded=this.store.decode<DemoLiveSampleMapping>(row.data,table,workspace,String(row.live_workspace));
      if(!decoded||decoded.kind!=='quiet-ledger-demo-live-sample-v1'||decoded.demoWorkspace!==workspace||decoded.demoWorkspace!==row.demo_workspace
        ||typeof decoded.liveWorkspace!=='string'||!identifier.test(decoded.liveWorkspace)||decoded.liveWorkspace===workspace||decoded.liveWorkspace!==row.live_workspace
        ||typeof decoded.invoiceId!=='string'||!identifier.test(decoded.invoiceId)||decoded.invoiceId!==row.invoice_id
        ||typeof decoded.retryKey!=='string'||!identifier.test(decoded.retryKey)||decoded.retryKey!==row.retry_key
        ||typeof decoded.createdAt!=='string'||!Number.isFinite(Date.parse(decoded.createdAt))||decoded.createdAt!==row.created_at)throw invalidSample();
      this.mappedInvoice(decoded);
      return decoded;
    }catch{throw invalidSample();}
  }
  private mappedInvoice(mapping:DemoLiveSampleMapping){
    const invoice=this.store.getInvoice(mapping.invoiceId,mapping.liveWorkspace);
    if(!invoice||invoice.currency!=='SAT'||invoice.total!==21||invoice.amountSats!==21||invoice.taxBps!==0||invoice.tax!==0
      ||invoice.settlementMode==='simulation'||invoice.acceptedMethods?.length!==1||invoice.acceptedMethods[0]!=='lightning')throw invalidSample();
    return invoice;
  }
  /** Only the original request in the mapped live workspace; never arbitrary ids. */
  private mappedRequest(mapping:DemoLiveSampleMapping){
    const invoice=this.mappedInvoice(mapping);
    const {requests,nextCursor}=this.receiving.list(mapping.liveWorkspace,2,undefined,mapping.invoiceId);
    if(requests.length>1||nextCursor)throw invalidSample();
    const record=requests[0];
    if(record){
      if(record.invoiceId!==mapping.invoiceId||record.adapterId!==this.adapterId||this.store.retryKeyForResource(`receiving:${mapping.liveWorkspace}`,record.id)!==mapping.retryKey)throw invalidSample();
      sanitizeDemoLiveRequest(record);
      if(record.status==='paid'&&(invoice.status!=='paid'||invoice.settlementMode!=='live'||invoice.nativePayment?.verification!=='provider'))throw invalidSample();
    }
    return record;
  }
  async detect(liveWorkspace:string,requestId:string):Promise<boolean>{
    const row=this.store.db.prepare(`SELECT demo_workspace FROM ${table} WHERE live_workspace=?`).get(liveWorkspace);
    if(!row)return false;
    const mapping=this.mapping(String(row.demo_workspace));
    if(mapping&&this.mappedRequest(mapping)?.id===requestId)await this.receiving.check(requestId,liveWorkspace);
    return true;
  }
  view(workspace:string):DemoLivePaymentView {
    this.assertVisit(workspace);
    const mapping=this.mapping(workspace);
    const record=mapping?this.mappedRequest(mapping):undefined;
    return {enabled:true,receiver:this.receiver,amountSats:21,rail:'lightning',...(record?{request:sanitizeDemoLiveRequest(record)}:{})};
  }
  async create(workspace:string,acknowledged:boolean,key:string):Promise<DemoLivePaymentView> {
    this.assertVisit(workspace);
    if(acknowledged!==true)throw new DomainError(400,'Acknowledge that this sample uses real funds before a real invoice is created.');
    if(typeof key!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(key))throw new DomainError(400,'A valid acknowledgement key is required.');
    // The client key is validated but never reused: the immutable server retryKey keeps
    // every retry, restart and different click key on one original request.
    const mapping=this.store.transaction<DemoLiveSampleMapping>(()=>{
      const existing=this.mapping(workspace);
      if(existing)return existing;
      if(Number(this.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n)>=cap)throw new DomainError(503,'The real-payment sample capacity is full. Existing samples stay available.');
      this.store.assertWriteBudget();
      const liveWorkspace=randomUUID();
      const invoice=createInvoice(this.store,liveWorkspace,{
        customerName:'Real-payment sample (voluntary visitor)',title:'Real Lightning sample',
        currency:'SAT',items:[{description:'Real 21-sat Lightning sample for the existing Coinos receiver',quantity:1,unitAmount:21}],
        taxBps:0,acceptedMethods:['lightning'],
        note:'Real funds: paying this invoice is voluntary and moves real money. The fictional demo stays simulated.',
      },this.now());
      const created=this.now().toISOString();
      const next:DemoLiveSampleMapping={kind:'quiet-ledger-demo-live-sample-v1',demoWorkspace:workspace,liveWorkspace,invoiceId:invoice.id,retryKey:`demo-live-${randomUUID()}`,createdAt:created};
      this.store.db.prepare(`INSERT INTO ${table}(id,demo_workspace,live_workspace,invoice_id,retry_key,created_at,data) VALUES(?,?,?,?,?,?,?)`)
        .run(randomUUID(),workspace,liveWorkspace,invoice.id,next.retryKey,created,this.store.encode(next,table,workspace,liveWorkspace));
      return next;
    });
    this.mappedRequest(mapping);
    // No external await happens inside the transaction above: the invoice and mapping are
    // committed first, and only then the existing receiving economics run.
    await this.receiving.create(mapping.liveWorkspace,{invoiceId:mapping.invoiceId,method:'lightning',adapterId:this.adapterId,amount:21},mapping.retryKey);
    return this.view(workspace);
  }
  async check(workspace:string):Promise<DemoLivePaymentView> {
    this.assertVisit(workspace);
    const mapping=this.mapping(workspace);
    if(!mapping)return {enabled:true,receiver:this.receiver,amountSats:21,rail:'lightning'};
    const record=this.mappedRequest(mapping);
    if(!record)return {enabled:true,receiver:this.receiver,amountSats:21,rail:'lightning'};
    // Provider-only authoritative readback; confirm and settleInvoice are never reachable here.
    await this.receiving.check(record.id,mapping.liveWorkspace);
    return this.view(workspace);
  }
}

export const demoLivePaymentTable=table;
export const demoLivePaymentCap=cap;
