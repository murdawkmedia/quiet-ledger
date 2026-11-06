import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import type {Invoice} from '../shared/contracts.js';
import {createInvoice, settleInvoice} from './domain.js';
import {DomainError, type Store, type StoredSession} from './store.js';

export interface HackathonDemoOptions {store: Store; now?: () => Date}
export interface HackathonDemoVisit {accountId: string; workspace: string; expiresAt: string; invoiceId: string}
export interface HackathonDemoAccess extends HackathonDemoVisit {sessionExpiresAt: string; resumeToken?: string}
export interface HackathonDemoView {invoice: Invoice; checkoutToken: string; expiresAt: string;caseVersion:number}
type RecordData = HackathonDemoVisit & {kind: 'quiet-ledger-hackathon-demo-v1' | 'quiet-ledger-hackathon-demo-v2'; createdAt: string;caseVersion?:number; resumeTokenHash?: string};
type Window = {since: number; count: number};
type ClientBudget = {failures?: Window; starts?: Window};
const table = 'hackathon_demo_workspaces';
const sessionTtlMs = 2 * 60 * 60 * 1000;
const retentionMs = 30 * 24 * 60 * 60 * 1000;
const resumeCapability = /^[A-Za-z0-9_-]{43}$/;
const tokenHash = /^[0-9a-f]{64}$/;
const failureWindowMs = 10 * 60 * 1000;
const startWindowMs = 60 * 60 * 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = (value: string) => createHash('sha256').update(value).digest();
const missing = () => new DomainError(404, 'This demo visit is unavailable or expired. Start a fresh demo.');

/** Fictional, per-visitor demo records. This public password is not real-account authentication. */
export class HackathonDemo {
  private store: Store;
  private now: () => Date;
  private clients = new Map<string, ClientBudget>();
  constructor(options: HackathonDemoOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, data TEXT NOT NULL);`);
  }
  start(password: string, clientId: string, resumeToken?: unknown): HackathonDemoAccess {
    const now = this.now();
    const time = now.getTime();
    if (!Number.isFinite(time)) throw new DomainError(503, 'The demo is temporarily unavailable.');
    const budget = this.clientBudget(clientId, time);
    if ((budget.failures?.count ?? 0) >= 5 || (budget.starts?.count ?? 0) >= 8) throw new DomainError(429, 'This client has reached the demo visit limit. Try again later.');
    if (!timingSafeEqual(digest(typeof password === 'string' && password.length <= 128 ? password : ''), digest('marmot'))) {
      budget.failures ??= {since: time, count: 0};
      budget.failures.count++;
      throw new DomainError(401, 'The demo password was not accepted.');
    }
    const visit = this.store.transaction(() => {
      this.cleanupExpiredSessions(now.toISOString());
      if (resumeToken !== undefined) {
        try {return this.resume(resumeToken);}
        catch (error) {if (!(error instanceof DomainError) || error.status !== 404) throw error;}
      }
      this.cleanupExpired(now.toISOString());
      if (Number(this.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n) >= 256) throw new DomainError(503, 'All saved demo visits are currently in use. Return to your saved demo or try again after a visit expires.');
      this.store.assertWriteBudget();
      const workspace = randomUUID(), accountId = randomUUID();
      const invoice = createInvoice(this.store, workspace, {
        customerName: 'Marmot Field Lab (fictional)', title: 'Marmot workshop recording', currency: 'CAD',
        items: [{description: 'Fictional workshop recording and delivery', quantity: 1, unitAmount: 12500}], taxBps: 0,
        note: 'Fictional demonstration only. Payments and receipts are simulations; no money moves.',
      }, now);
      this.store.saveInvoice({...invoice, settlementMode: 'simulation'});
      const visit: HackathonDemoVisit = {workspace, accountId, invoiceId: invoice.id, expiresAt: new Date(time + retentionMs).toISOString()};
      const issuedToken = randomBytes(32).toString('base64url');
      const data: RecordData = {...visit, kind: 'quiet-ledger-hackathon-demo-v2', createdAt: now.toISOString(), resumeTokenHash: digest(issuedToken).toString('hex')};
      this.store.db.prepare(`INSERT INTO ${table}(id,account_id,expires_at,data) VALUES(?,?,?,?)`).run(workspace, accountId, visit.expiresAt, this.store.encode(data, table, workspace, workspace));
      return {...this.access(data, time), resumeToken: issuedToken};
    });
    budget.starts ??= {since: time, count: 0};
    budget.starts.count++;
    budget.failures = undefined;
    return visit;
  }
  private cleanupExpiredSessions(now:string) {
    for(const row of this.store.db.prepare('SELECT token_hash,data FROM sessions').all()){
      let session:StoredSession;
      try{session=this.store.decode(row.data,'sessions',String(row.token_hash));}catch{continue;}
      if(!session||session.role!=='demo'||session.hackathonDemo!==true||!(Date.parse(session.expires)<=Date.parse(now)))continue;
      const data=this.record(session.workspace);
      if(data&&data.accountId===session.accountId)this.store.db.prepare('DELETE FROM sessions WHERE token_hash=? AND data=?').run(String(row.token_hash),row.data);
    }
  }
  /** Only the opaque browser capability can recover a saved visit without a current session. */
  resume(resumeToken: unknown): HackathonDemoAccess {
    const time = this.now().getTime();
    if (!Number.isFinite(time)) throw new DomainError(503, 'The demo is temporarily unavailable.');
    if (typeof resumeToken !== 'string' || !resumeCapability.test(resumeToken)) throw missing();
    const supplied = digest(resumeToken);
    for (const row of this.store.db.prepare(`SELECT id FROM ${table} WHERE expires_at>?`).all(new Date(time).toISOString())) {
      const data = this.record(String(row.id));
      if (data?.kind === 'quiet-ledger-hackathon-demo-v2' && timingSafeEqual(supplied, Buffer.from(data.resumeTokenHash!, 'hex'))) {
        this.view(data.workspace);
        return this.access(data, time);
      }
    }
    throw missing();
  }
  /** Upgrade a still-authenticated legacy visit, or replace its lost capability, without touching invoices. */
  remember(session: StoredSession): HackathonDemoAccess {
    const time = this.now().getTime();
    if (!Number.isFinite(time)) throw new DomainError(503, 'The demo is temporarily unavailable.');
    return this.store.transaction(() => {
      if (!this.sessionValid(session)) throw missing();
      const data = this.record(session.workspace)!;
      this.view(data.workspace);
      this.store.assertWriteBudget();
      const resumeToken = randomBytes(32).toString('base64url');
      const next: RecordData = {...data, kind: 'quiet-ledger-hackathon-demo-v2', expiresAt: new Date(Date.parse(data.createdAt) + retentionMs).toISOString(), resumeTokenHash: digest(resumeToken).toString('hex')};
      this.store.db.prepare(`UPDATE ${table} SET expires_at=?,data=? WHERE id=? AND account_id=?`).run(next.expiresAt, this.store.encode(next, table, data.workspace, data.workspace), data.workspace, data.accountId);
      return {...this.access(next, time), resumeToken};
    });
  }
  private access(data: HackathonDemoVisit, now: number): HackathonDemoAccess {
    const {accountId, workspace, invoiceId, expiresAt} = data;
    return {accountId, workspace, invoiceId, expiresAt, sessionExpiresAt: new Date(Math.min(now + sessionTtlMs, Date.parse(expiresAt))).toISOString()};
  }
  private clientBudget(clientId: string, now: number): ClientBudget {
    for (const [key, value] of this.clients) {
      if (value.failures && value.failures.since + failureWindowMs <= now) value.failures = undefined;
      if (value.starts && value.starts.since + startWindowMs <= now) value.starts = undefined;
      if (!value.failures && !value.starts) this.clients.delete(key);
    }
    // Only the caller's trusted resolver supplies this identifier; never store raw addresses.
    const key = digest(typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 256 ? clientId : 'unknown-client').toString('hex');
    let budget = this.clients.get(key);
    if (!budget) {
      if (this.clients.size >= 2048) throw new DomainError(429, 'Demo visit requests are busy. Try again later.');
      budget = {};
      this.clients.set(key, budget);
    }
    return budget;
  }
  private record(workspace: string): RecordData | undefined {
    const row = this.store.db.prepare(`SELECT account_id,expires_at,data FROM ${table} WHERE id=?`).get(workspace);
    if (!row) return undefined;
    try {
      const data = this.store.decode<RecordData>(row.data, table, workspace, workspace);
      const legacy = data.kind === 'quiet-ledger-hackathon-demo-v1';
      if ((!legacy && (data.kind !== 'quiet-ledger-hackathon-demo-v2' || typeof data.resumeTokenHash !== 'string' || !tokenHash.test(data.resumeTokenHash))) || data.workspace !== workspace || !uuid.test(data.workspace) || !uuid.test(data.accountId) || !uuid.test(data.invoiceId) || data.accountId !== row.account_id || data.expiresAt !== row.expires_at || !Number.isFinite(Date.parse(data.createdAt)) || Date.parse(data.expiresAt) - Date.parse(data.createdAt) !== (legacy ? sessionTtlMs : retentionMs)) return undefined;
      return data;
    } catch {return undefined;}
  }
  hasWorkspace(workspace: string): boolean {
    const data = this.record(workspace);
    return Boolean(data && Date.parse(data.expiresAt) > this.now().getTime());
  }
  sessionValid(session: StoredSession & {hackathonDemo?: boolean}): boolean {
    const data = this.record(session.workspace), now = this.now().getTime();
    return Boolean(data && session.role === 'demo' && session.hackathonDemo === true && session.accountId === data.accountId && Date.parse(data.expiresAt) > now && Date.parse(session.expires) > now);
  }
  view(workspace: string): HackathonDemoView {
    const now = this.now().getTime();
    if (!Number.isFinite(now)) throw new DomainError(503, 'The demo is temporarily unavailable.');
    const data = this.record(workspace);
    if (!data || Date.parse(data.expiresAt) <= now) throw missing();
    const invoice = this.store.getInvoice(data.invoiceId, workspace);
    if (!invoice) throw missing();
    return {invoice, checkoutToken: invoice.token, expiresAt: data.expiresAt,caseVersion:data.caseVersion??(invoice.status==='paid'?2:1)};
  }
  create(workspace:string,body:unknown):HackathonDemoView {
    return this.store.transaction(()=>{
      const previous=this.view(workspace),data=this.record(workspace)!;
      if(this.store.listInvoices(workspace).length>=8)throw new DomainError(429,'This demo visit has reached its eight-invoice limit.');
      const invoice=createInvoice(this.store,workspace,body,this.now());
      // Agent snapshots validate every component, not only the discounted total.
      // Keep the whole demo creation transactional so a rejected case leaves no invoice or audit row.
      if([invoice.subtotal,invoice.discountAmount??0,invoice.premiumAmount??0,invoice.tax,invoice.total].some(value=>value>1000000000))throw new DomainError(400,'Demo invoice amounts must each stay within the supported demo range.');
      this.store.saveInvoice({...invoice,settlementMode:'simulation'});
      const next={...data,invoiceId:invoice.id,caseVersion:previous.caseVersion+1};this.store.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(this.store.encode(next,table,workspace,workspace),workspace);return this.view(workspace);
    });
  }
  simulatePayment(workspace: string): HackathonDemoView {
    return this.store.transaction(() => {
      const {invoice,caseVersion} = this.view(workspace);
      if (invoice.settlementMode !== 'simulation' || invoice.nativePayment) throw new DomainError(409, 'Only the fictional simulated invoice can use the demo payment action.');
      const method=invoice.acceptedMethods?.[0]??'cashu';
      settleInvoice(this.store, workspace, invoice, method, this.now());
      if(invoice.status!=='paid'){const data=this.record(workspace)!;const next={...data,caseVersion:caseVersion+1};this.store.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(this.store.encode(next,table,workspace,workspace),workspace);}
      return this.view(workspace);
    });
  }
  private cleanupExpired(now: string) {
    const expired = this.store.db.prepare(`SELECT id FROM ${table} WHERE expires_at<=?`).all(now)
      .map(row => this.record(String(row.id))).filter((data): data is RecordData => Boolean(data&&Date.parse(data.createdAt)+retentionMs<=Date.parse(now)));
    if (!expired.length) return;
    const owned = new Map(expired.map(data => [data.workspace, data.accountId]));
    for (const row of this.store.db.prepare('SELECT token_hash,data FROM sessions').all()) {
      let session: StoredSession & {hackathonDemo?: boolean};
      try {session = this.store.decode(row.data, 'sessions', String(row.token_hash));} catch {continue;}
      if (!session || typeof session !== 'object') continue;
      if (session.role === 'demo' && session.hackathonDemo === true && owned.get(session.workspace) === session.accountId && Date.parse(session.expires) <= Date.parse(now)) this.store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(String(row.token_hash));
    }
    // Known dependent tables only. Never sweep arbitrary tables or real account records.
    const optional = new Set(this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('marmot_events','marmot_conversations','receiving_requests','payment_reports','square_test_checkouts','account_connections','account_api_keys','demo_agent_turns','demo_agent_events','demo_agent_leases','invoice_templates')").all().map(row => String(row.name)));
    for (const data of expired) {
      const workspace = data.workspace;
      for (const name of ['invoice_templates','demo_agent_turns','demo_agent_events','demo_agent_leases','marmot_events', 'marmot_conversations', 'receiving_requests', 'payment_reports', 'account_connections', 'account_api_keys']) if (optional.has(name)) this.store.db.prepare(`DELETE FROM ${name} WHERE workspace=?`).run(workspace);
      if (optional.has('square_test_checkouts')) this.store.db.prepare('DELETE FROM square_test_checkouts WHERE invoice_id IN (SELECT id FROM invoices WHERE workspace=?)').run(workspace);
      this.store.db.prepare('DELETE FROM receipts WHERE invoice_id IN (SELECT id FROM invoices WHERE workspace=?)').run(workspace);
      this.store.db.prepare('DELETE FROM revoked_invoice_links WHERE workspace=?').run(workspace);
      this.store.db.prepare('DELETE FROM payouts WHERE workspace=?').run(workspace);
      this.store.db.prepare('DELETE FROM invoices WHERE workspace=?').run(workspace);
      this.store.db.prepare('DELETE FROM audits WHERE workspace=?').run(workspace);
      for (const prefix of ['demo-invoice','invoice-template','invoice', 'sample', 'quote', 'approve', 'advance', 'connections', 'receiving', 'receiving-confirm', 'report-confirm', 'revoke-links']) this.store.db.prepare('DELETE FROM idempotency WHERE scope=?').run(prefix + ':' + workspace);
      this.store.db.prepare(`DELETE FROM ${table} WHERE id=? AND account_id=? AND expires_at<=?`).run(workspace, data.accountId, now);
    }
  }
}
