import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import type {Invoice,Receipt} from '../shared/contracts.js';
import type {InvoiceBalance,InvoiceLedgerEntry} from '../shared/invoice-ledger.js';
import {INVOICE_CURRENCIES} from '../shared/invoice-options.js';
import {PAYMENT_METHOD_IDS} from '../shared/payment-methods.js';
import {INVOICE_EVENT_TYPES,type InvoiceEvent,type InvoiceEventPage,type InvoiceEventType} from '../shared/invoice-events.js';
import {DomainError,Store} from './store.js';

const CURSOR_META_KEY='invoice-event-cursor-secret-v1';
const CURSOR_SECRET_BYTES=32;
const CURSOR_TEXT=/^v1\.(0|[1-9][0-9]{0,15})\.([0-9a-f]{64})$/;
const CURSOR_INPUT=/^[A-Za-z0-9_-]{1,512}$/;
const STORAGE_503='Invoice event storage is unavailable; the payment was not credited. Reconcile and retry.';
const READ_503='Invoice events are temporarily unavailable.';
const CURSOR_400='Invalid invoice event cursor.';
const LIMIT_400='Invoice event limit must be between 1 and 100.';

/**
 * Durable workspace-scoped invoice event journal. Rows are created only inside
 * InvoiceLedger.payment()'s transaction, so a live payment and its events
 * commit or roll back together. Storage is append-only and never pruned; each
 * row's payload is encrypted through Store with the workspace/table/id AAD, so
 * only the opaque id, workspace and sequence are readable at rest. Sequences
 * are per workspace; no global ordinal or cross-tenant identifier is exposed.
 * Cursors are HMAC-authenticated with a persisted random per-installation
 * secret, so both encrypted (hosted) and local installations reject forgeries;
 * the secret is never returned to any client.
 */
export class InvoiceEvents {
  private secretKey?:Buffer;
  constructor(private store:Store){
    store.db.exec(`CREATE TABLE IF NOT EXISTS invoice_events (
     id TEXT PRIMARY KEY,workspace TEXT NOT NULL,sequence INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(workspace,sequence));
     CREATE INDEX IF NOT EXISTS invoice_event_workspace_sequence ON invoice_events(workspace,sequence);
     CREATE TRIGGER IF NOT EXISTS invoice_event_no_update BEFORE UPDATE ON invoice_events BEGIN SELECT RAISE(ABORT,'Invoice events are append-only'); END;
     CREATE TRIGGER IF NOT EXISTS invoice_event_no_delete BEFORE DELETE ON invoice_events BEGIN SELECT RAISE(ABORT,'Invoice events are append-only'); END;
     CREATE TABLE IF NOT EXISTS invoice_event_heads (workspace TEXT PRIMARY KEY,last_sequence INTEGER NOT NULL);
    `);
  }

  /**
   * Append the events for one live ledger payment. Runs inside the payment
   * transaction, after the ledger entry insert, with the authoritative balance
   * before and after it. Simulation receipts append nothing; a genuine
   * unpaid/partial/credited-to-paid transition at the effective total is the only
   * invoice.paid source. Payment storage failures fail closed as 503 so the
   * whole payment rolls back and stays reconcilable.
   */
  appendReceipt(workspace:string,invoice:Invoice,entry:InvoiceLedgerEntry,receipt:Receipt,before:InvoiceBalance,after:InvoiceBalance):void{
    if(entry.kind!=='payment')throw new DomainError(400,'Only payment entries can record invoice events.');
    if(receipt.mode!=='live')return;
    if(!this.store.db.isTransaction)throw new DomainError(409,'Invoice events require the payment transaction.','EVENT_TRANSACTION_REQUIRED');
    if(entry.amount!==receipt.amount||entry.currency!==receipt.currency||entry.method!==receipt.method||entry.currency!==invoice.currency)throw new DomainError(400,'The payment entry, receipt and invoice disagree.');
    if(!entry.method||(entry.verification!=='provider'&&entry.verification!=='manual')||!PAYMENT_METHOD_IDS.includes(entry.method))throw new DomainError(400,'A live payment entry requires its method and verification.');
    if(!Number.isSafeInteger(entry.amount)||entry.amount<=0)throw new DomainError(400,'A live payment entry requires a positive integer amount.');
    const base={occurredAt:entry.createdAt,invoiceId:invoice.id,total:invoice.total,effectiveTotal:after.effectiveTotal,currency:invoice.currency,mode:'live' as const};
    const pending:InvoiceEvent[]=[
      {id:this.eventId(workspace,'payment.received',entry.id),seq:0,type:'payment.received',...base,payment:{amount:entry.amount,method:entry.method,verification:entry.verification}},
    ];
    if((before.state==='unpaid'||before.state==='partially_paid'||before.state==='credited')&&after.state==='paid'&&after.paid>=after.effectiveTotal)
      pending.push({id:this.eventId(workspace,'invoice.paid',entry.id+':'+invoice.id),seq:0,type:'invoice.paid',...base});
    this.write(workspace,pending);
  }

  /** One ascending, cursor-authenticated page of the workspace's own events. */
  page(workspace:string,limit:number,cursor?:string):InvoiceEventPage{
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new DomainError(400,LIMIT_400);
    const after=cursor===undefined?0:this.parseCursor(workspace,cursor);
    let rows:{id:unknown;sequence:unknown;data:unknown}[];
    try{
      rows=this.store.db.prepare('SELECT id,sequence,data FROM invoice_events WHERE workspace=? AND sequence>? ORDER BY sequence LIMIT ?').all(workspace,after,limit+1) as {id:unknown;sequence:unknown;data:unknown}[];
    }catch{throw new DomainError(503,READ_503);}
    const hasMore=rows.length>limit;
    const events=rows.slice(0,limit).map(row=>{
      let event:InvoiceEvent;
      try{event=this.store.decode<InvoiceEvent>(row.data,'invoice_events',String(row.id),workspace);}catch{throw new DomainError(503,READ_503);}
      this.assertIntact(event,String(row.id),Number(row.sequence));
      return event;
    });
    return {events,nextCursor:this.encodeCursor(workspace,events.length?events[events.length-1].seq:after),hasMore};
  }

  /** Stable per ledger entry and type: replay or restart reproduces the same id. */
  private eventId(workspace:string,type:InvoiceEventType,sourceId:string):string{
    return 'evt_'+createHash('sha256').update('invoice-event-v1\0'+workspace+'\0'+type+'\0'+sourceId).digest('hex').slice(0,32);
  }

  /** Insert inside the caller's transaction; any failure fails closed so the payment rolls back. */
  private write(workspace:string,events:InvoiceEvent[]):void{
    try{
      for(const template of events){
        const row=this.store.db.prepare('SELECT last_sequence AS n FROM invoice_event_heads WHERE workspace=?').get(workspace);
        const seq=Number(row?.n??0)+1;
        if(!Number.isSafeInteger(seq)||seq<1)throw new Error('Event sequence unavailable.');
        const event={...template,seq};
        this.store.db.prepare('INSERT INTO invoice_events(id,workspace,sequence,data) VALUES(?,?,?,?)').run(event.id,workspace,seq,this.store.encode(event,'invoice_events',event.id,workspace));
        this.store.db.prepare('INSERT INTO invoice_event_heads(workspace,last_sequence) VALUES(?,?) ON CONFLICT(workspace) DO UPDATE SET last_sequence=excluded.last_sequence').run(workspace,seq);
      }
    }catch(error){
      if(error instanceof DomainError)throw error;
      throw new DomainError(503,STORAGE_503);
    }
  }

  /** Tamper and corruption detection on read: decoded rows must match their stored identity and the payload contract. */
  private assertIntact(event:InvoiceEvent,id:string,seq:number):void{
    const fields=['id','seq','type','occurredAt','invoiceId','total','effectiveTotal','currency','mode','payment'];
    if(!event||typeof event!=='object'||Array.isArray(event)||Object.keys(event).some(key=>!fields.includes(key)))throw new DomainError(503,READ_503);
    const payment=event.payment;
    if(payment!==undefined&&(!payment||typeof payment!=='object'||Array.isArray(payment)||Object.keys(payment).some(key=>!['amount','method','verification'].includes(key))))throw new DomainError(503,READ_503);
    if(event.id!==id||!/^evt_[a-f0-9]{32}$/.test(event.id)||!Number.isSafeInteger(seq)||seq<1||event.seq!==seq||event.mode!=='live'||!INVOICE_EVENT_TYPES.includes(event.type)
      ||typeof event.invoiceId!=='string'||event.invoiceId.length<1||event.invoiceId.length>64
      ||typeof event.occurredAt!=='string'||event.occurredAt.length<1||event.occurredAt.length>64||!Number.isFinite(Date.parse(event.occurredAt))
      ||!Number.isSafeInteger(event.total)||event.total<1||!Number.isSafeInteger(event.effectiveTotal)||event.effectiveTotal<1
      ||!INVOICE_CURRENCIES.includes(event.currency)
      ||(event.type==='payment.received'&&(!payment||!Number.isSafeInteger(payment.amount)||payment.amount<1||!PAYMENT_METHOD_IDS.includes(payment.method)||!['provider','manual'].includes(payment.verification)))
      ||(event.type==='invoice.paid'&&payment!==undefined))
      throw new DomainError(503,READ_503);
  }

  private encodeCursor(workspace:string,seq:number):string{
    return Buffer.from(`v1.${seq}.${this.cursorMac(workspace,seq)}`,'utf8').toString('base64url');
  }
  /** Exact base64url, version, canonical sequence (including zero) and a timing-safe MAC over workspace/version/sequence. */
  private parseCursor(workspace:string,cursor:string):number{
    if(!CURSOR_INPUT.test(cursor))throw new DomainError(400,CURSOR_400);
    const decoded=Buffer.from(cursor,'base64url');
    if(decoded.toString('base64url')!==cursor)throw new DomainError(400,CURSOR_400);
    const match=CURSOR_TEXT.exec(decoded.toString('utf8'));
    if(!match)throw new DomainError(400,CURSOR_400);
    const seq=Number(match[1]);
    if(!Number.isSafeInteger(seq))throw new DomainError(400,CURSOR_400);
    if(!timingSafeEqual(Buffer.from(match[2],'hex'),Buffer.from(this.cursorMac(workspace,seq),'hex')))throw new DomainError(400,CURSOR_400);
    return seq;
  }
  private cursorMac(workspace:string,seq:number):string{
    return createHmac('sha256',this.cursorSecret()).update(`invoice-event-cursor\0v1\0${workspace}\0${seq}`).digest('hex');
  }
  /** Persisted random per-installation secret, encoded through Store; created once under a transaction. */
  private cursorSecret():Buffer{
    if(this.secretKey)return this.secretKey;
    try{
      const read=()=>this.store.db.prepare('SELECT value FROM meta WHERE key=?').get(CURSOR_META_KEY);
      let row=read();
      if(!row){
        this.store.transaction(()=>{
          if(!read())this.store.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(CURSOR_META_KEY,this.store.encode({secret:randomBytes(CURSOR_SECRET_BYTES).toString('base64url')},'meta',CURSOR_META_KEY));
        });
        row=read();
      }
      if(!row)throw new Error('Cursor secret unavailable.');
      const secret=Buffer.from(this.store.decode<{secret:string}>(row.value,'meta',CURSOR_META_KEY).secret,'base64url');
      if(secret.length!==CURSOR_SECRET_BYTES)throw new Error('Cursor secret unavailable.');
      this.secretKey=secret;
      return secret;
    }catch{throw new DomainError(503,READ_503);}
  }
}
