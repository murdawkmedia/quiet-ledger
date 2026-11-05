import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import {createRecordCodec} from './record-codec.js';
import type { AuditEvent, Invoice, Payout, Receipt } from '../shared/contracts.js';

export class DomainError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface StoredSession { role: 'demo' | 'owner'; workspace: string; accountId?:string; hackathonDemo?:boolean; csrf: string; expires: string }
function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new DomainError(400, 'Request nesting exceeds the supported depth.');
  if (Array.isArray(value)) return `[${value.map(data => canonical(data, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, data]) => `${JSON.stringify(key)}:${canonical(data, depth + 1)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class Store {
  db: DatabaseSync;
  private closed = false;
  private codec:ReturnType<typeof createRecordCodec>;
  readonly encrypted:boolean;
  readonly limits:{invoicesPerWorkspace:number;receiveRequestsPerInvoice:number;idempotencyPerScope:number};
  private indexKey?:Buffer;
  constructor(path: string,options:{encryptionKey?:Buffer;limits?:{invoicesPerWorkspace?:number;receiveRequestsPerInvoice?:number;idempotencyPerScope?:number}}={}) {
    this.codec=createRecordCodec(options.encryptionKey);this.encrypted=options.encryptionKey!==undefined;this.indexKey=options.encryptionKey?Buffer.from(options.encryptionKey):undefined;
    const bounded=(value:number|undefined,fallback:number)=>{if(value===undefined)return this.encrypted?fallback:Infinity;if(!Number.isSafeInteger(value)||value<1||value>100000)throw new Error('Invalid hosted record limit.');return value;};
    this.limits={invoicesPerWorkspace:bounded(options.limits?.invoicesPerWorkspace,500),receiveRequestsPerInvoice:bounded(options.limits?.receiveRequestsPerInvoice,20),idempotencyPerScope:bounded(options.limits?.idempotencyPerScope,2000)};
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, token TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS invoice_workspace ON invoices(workspace);
      CREATE TABLE IF NOT EXISTS receipts (token TEXT PRIMARY KEY, invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payouts (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, invoice_id TEXT NOT NULL REFERENCES invoices(id), data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS payout_workspace ON payouts(workspace);
      CREATE TABLE IF NOT EXISTS audits (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency (scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, response TEXT NOT NULL, PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS revoked_invoice_links(invoice_id TEXT PRIMARY KEY REFERENCES invoices(id),workspace TEXT NOT NULL,revoked_at TEXT NOT NULL);
    `);
    if(this.encrypted){const pageSize=Number(this.db.prepare('PRAGMA page_size').get()!.page_size);this.db.exec(`PRAGMA max_page_count=${Math.floor(64*1024*1024/pageSize)};PRAGMA wal_autocheckpoint=256;PRAGMA journal_size_limit=8388608;`);}
    try{
      const marker=this.db.prepare("SELECT value FROM meta WHERE key='encrypted-storage-v1'").get();
      if(marker){if(!this.encrypted||this.decode<any>(marker.value,'meta','encrypted-storage-v1').version!==1)throw new Error();}
      else if(this.encrypted){
        const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='meta' AND name NOT LIKE 'sqlite_%'").all();
        if(tables.some(row=>this.db.prepare('SELECT 1 FROM "'+String(row.name).replaceAll('"','""')+'" LIMIT 1').get()))throw new Error();
        this.db.prepare("INSERT INTO meta(key,value) VALUES('encrypted-storage-v1',?)").run(this.encode({version:1},'meta','encrypted-storage-v1'));
      }
    }catch{this.db.close();throw new Error('Encrypted database verification failed. Use the correct private key and a fresh hosted database.');}
  }
  assertWriteBudget(){if(this.encrypted){const bytes=Number(this.db.prepare('PRAGMA page_count').get()!.page_count)*Number(this.db.prepare('PRAGMA page_size').get()!.page_size);if(bytes>=52*1024*1024)throw new DomainError(503,'This hosted beta has reached its storage budget. Existing records remain available.');}}
  encode(value:unknown,table:string,id:string,workspace='system'):string{return this.codec.encode(value,{table,id,workspace});}
  decode<T=any>(value:unknown,table:string,id:string,workspace='system'):T{return this.codec.decode<T>(value,{table,id,workspace});}
  indexValue(namespace:string,value:string):string{return this.indexKey?createHmac('sha256',this.indexKey).update(namespace+'\0'+value).digest('hex'):value;}
  tokenIndex(value:string):string{return this.indexValue('bearer-token',value);}
  invoiceWorkspace(id:string):string {const row=this.db.prepare('SELECT workspace FROM invoices WHERE id=?').get(id);if(!row)throw new DomainError(404,'Invoice not found.');return String(row.workspace);}
  linksRevoked(id:string):boolean{return Boolean(this.db.prepare('SELECT 1 FROM revoked_invoice_links WHERE invoice_id=?').get(id));}
  revokeInvoiceLinks(id:string,workspace:string,now:string){if(!this.getInvoice(id,workspace))throw new DomainError(404,'Invoice not found.');this.db.prepare('INSERT OR IGNORE INTO revoked_invoice_links(invoice_id,workspace,revoked_at) VALUES(?,?,?)').run(id,workspace,now);return {revoked:true};}
  retryKeyForResource(scope:string,id:string):string|undefined {
    const rows=this.db.prepare('SELECT key,response FROM idempotency WHERE scope=? ORDER BY rowid DESC').all(scope);
    return rows.find(row=>this.decode<any>(row.response,'idempotency',scope+':'+String(row.key),scope)?.id===id)?.key as string|undefined;
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
  transaction<T>(fn: () => T): T {
    // Nested synchronous operations share the outer atomic commit/rollback.
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  idempotent<T>(scope: string, key: string | undefined, body: unknown, status: number, fn: () => T): { status: number; body: T } {
    if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new DomainError(400, 'A valid Idempotency-Key header is required.');
    return this.transaction(() => {
      const fingerprint = this.indexValue('idempotency-fingerprint',hash(canonical(body)));
      const previous = this.db.prepare('SELECT * FROM idempotency WHERE scope=? AND key=?').get(scope, key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new DomainError(409, 'This idempotency key was already used for a different request.');
        return { status: Number(previous.status), body: this.decode<T>(previous.response,'idempotency',scope+':'+key,scope) };
      }
      if(Number(this.db.prepare('SELECT COUNT(*) as n FROM idempotency WHERE scope=?').get(scope)!.n)>=this.limits.idempotencyPerScope)throw new DomainError(429,'This workspace has reached its saved-operation limit. Existing retry outcomes remain available.');
      this.assertWriteBudget();
      const value = fn();
      this.db.prepare('INSERT INTO idempotency(scope,key,fingerprint,status,response) VALUES(?,?,?,?,?)').run(scope, key, fingerprint, status, this.encode(value,'idempotency',scope+':'+key,scope));
      return { status, body: value };
    });
  }
  listInvoices(workspace: string): Invoice[] {
    return this.db.prepare('SELECT id,data FROM invoices WHERE workspace=? ORDER BY rowid DESC').all(workspace).map(row => this.decode(row.data,'invoices',String(row.id),workspace));
  }
  getInvoice(id: string, workspace?: string): Invoice | undefined {
    const row = workspace ? this.db.prepare('SELECT id,workspace,data FROM invoices WHERE id=? AND workspace=?').get(id, workspace) : this.db.prepare('SELECT id,workspace,data FROM invoices WHERE id=?').get(id);
    return row ? this.decode(row.data,'invoices',String(row.id),String(row.workspace)) : undefined;
  }
  getCheckout(token: string): { invoice: Invoice; workspace: string } | undefined {
    const row = this.db.prepare('SELECT id,data,workspace FROM invoices WHERE token=?').get(this.tokenIndex(token));
    if(row&&this.linksRevoked(String(row.id)))return undefined;
    return row ? { invoice: this.decode(row.data,'invoices',String(row.id),String(row.workspace)), workspace: String(row.workspace) } : undefined;
  }
  addInvoice(workspace: string, invoice: Invoice) {
    if(Number(this.db.prepare('SELECT COUNT(*) as n FROM invoices WHERE workspace=?').get(workspace)!.n)>=this.limits.invoicesPerWorkspace)throw new DomainError(429,'This workspace has reached its invoice limit.');
    this.assertWriteBudget();
    this.db.prepare('INSERT INTO invoices(id,workspace,token,data) VALUES(?,?,?,?)').run(invoice.id, workspace, this.tokenIndex(invoice.token), this.encode(invoice,'invoices',invoice.id,workspace));
  }
  saveInvoice(invoice: Invoice) { this.db.prepare('UPDATE invoices SET data=? WHERE id=?').run(this.encode(invoice,'invoices',invoice.id,this.invoiceWorkspace(invoice.id)), invoice.id); }
  addReceipt(token: string, invoiceId: string, receipt: Receipt) {
    this.db.prepare('INSERT INTO receipts(token,invoice_id,data) VALUES(?,?,?)').run(this.tokenIndex(token), invoiceId, this.encode(receipt,'receipts',invoiceId,this.invoiceWorkspace(invoiceId)));
  }
  getReceipt(token: string): { invoice: Invoice; receipt: Receipt } | undefined {
    const row = this.db.prepare('SELECT invoice_id,data FROM receipts WHERE token=?').get(this.tokenIndex(token));
    if (!row) return undefined;
    if(this.linksRevoked(String(row.invoice_id)))return undefined;
    const invoice = this.getInvoice(String(row.invoice_id));
    return invoice ? { invoice, receipt: this.decode(row.data,'receipts',String(row.invoice_id),this.invoiceWorkspace(String(row.invoice_id))) } : undefined;
  }
  listPayouts(workspace: string): Payout[] {
    return this.db.prepare('SELECT id,data FROM payouts WHERE workspace=? ORDER BY rowid DESC').all(workspace).map(row => this.decode(row.data,'payouts',String(row.id),workspace));
  }
  getPayout(id: string, workspace: string): Payout | undefined {
    const row = this.db.prepare('SELECT id,data FROM payouts WHERE id=? AND workspace=?').get(id, workspace);
    return row ? this.decode(row.data,'payouts',String(row.id),workspace) : undefined;
  }
  addPayout(workspace: string, payout: Payout) {
    this.db.prepare('INSERT INTO payouts(id,workspace,invoice_id,data) VALUES(?,?,?,?)').run(payout.id, workspace, payout.invoiceId, this.encode(payout,'payouts',payout.id,workspace));
  }
  savePayout(payout: Payout) { this.db.prepare('UPDATE payouts SET data=? WHERE id=?').run(this.encode(payout,'payouts',payout.id,this.invoiceWorkspace(payout.invoiceId)), payout.id); }
  audit(workspace: string, action: string, description: string, createdAt: string) {
    const item: AuditEvent = { id: randomUUID(), action, description, createdAt };
    this.db.prepare('INSERT INTO audits(id,workspace,created_at,data) VALUES(?,?,?,?)').run(item.id, workspace, createdAt, this.encode(item,'audits',item.id,workspace));
  }
  audits(workspace: string, complete = false): AuditEvent[] {
    const query = 'SELECT id,data FROM audits WHERE workspace=? ORDER BY rowid DESC' + (complete ? '' : ' LIMIT 200');
    return this.db.prepare(query).all(workspace).map(row => this.decode(row.data,'audits',String(row.id),workspace));
  }
  session(token: string): StoredSession | undefined {
    const row = this.db.prepare('SELECT data FROM sessions WHERE token_hash=?').get(hash(token));
    return row ? this.decode(row.data,'sessions',hash(token)) : undefined;
  }
  saveSession(token: string, session: StoredSession) { this.db.prepare('INSERT INTO sessions(token_hash,data) VALUES(?,?)').run(hash(token), this.encode(session,'sessions',hash(token))); }
  removeExpiredSessions(now: string) {
    if(!this.encrypted){this.db.prepare("DELETE FROM sessions WHERE json_extract(data,'$.expires')<=?").run(now);return;}
    for(const row of this.db.prepare('SELECT token_hash,data FROM sessions').all())if(this.decode<StoredSession>(row.data,'sessions',String(row.token_hash)).expires<=now)this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(row.token_hash);
  }
  removeSession(token: string) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token)); }
  isDemoSeeded() { return Boolean(this.db.prepare("SELECT key FROM meta WHERE key='demo-seeded'").get()); }
  markDemoSeeded() { this.db.prepare("INSERT INTO meta(key,value) VALUES('demo-seeded','1')").run(); }
}
