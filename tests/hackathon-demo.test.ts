import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store, DomainError, hash, type StoredSession} from '../server/store.js';
import {createInvoice} from '../server/domain.js';
import {HackathonDemo} from '../server/hackathon-demo.js';

const initialTime = new Date('2026-11-05T12:00:00.000Z');
function setup() {
  const store = new Store(':memory:', {encryptionKey: Buffer.alloc(32, 41)});
  let clock = initialTime;
  const demo = new HackathonDemo({store, now: () => clock});
  return {store, demo, advance: (ms: number) => {clock = new Date(clock.getTime() + ms);}};
}
function status(expected: number) {return (error: unknown) => error instanceof DomainError && error.status === expected;}

test('public demo password creates distinct fictional visits with no real account', () => {
  const f = setup();
  try {
    assert.throws(() => f.demo.start('wrong', 'fictional-client'), status(401));
    const a = f.demo.start('marmot', 'fictional-client');
    const b = f.demo.start('marmot', 'fictional-client');
    assert.notEqual(a.accountId, b.accountId);
    assert.notEqual(a.workspace, b.workspace);
    assert.notEqual(a.invoiceId, b.invoiceId);
    assert.equal(a.expiresAt, '2026-12-05T12:00:00.000Z');
    assert.equal(a.sessionExpiresAt, '2026-11-05T14:00:00.000Z');
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='auth_accounts'").get()!.n, 0);
    const view = f.demo.view(a.workspace);
    assert.equal(view.invoice.id, a.invoiceId);
    assert.equal(view.invoice.status, 'open');
    assert.equal(view.invoice.settlementMode, 'simulation');
    assert.match(view.invoice.note!, /fictional|simulation/i);
    assert.equal(f.store.getCheckout(view.checkoutToken)?.workspace, a.workspace);
    assert.equal(f.store.listInvoices('owner').length, 0);
    assert.equal(f.store.listInvoices('demo').length, 0);
  } finally {f.store.close();}
});

test('visit membership and session expiry gate every demo read and mutation', () => {
  const f = setup();
  try {
    const a = f.demo.start('marmot', 'fictional-client');
    const session = {role: 'demo', accountId: a.accountId, workspace: a.workspace, hackathonDemo: true, csrf: 'fictional-csrf', expires: a.sessionExpiresAt} satisfies StoredSession & {hackathonDemo: boolean};
    assert.equal(f.demo.hasWorkspace(a.workspace), true);
    assert.equal(f.demo.sessionValid(session), true);
    assert.equal(f.demo.sessionValid({...session, role: 'owner'}), false);
    assert.equal(f.demo.sessionValid({...session, accountId: 'another-account'}), false);
    assert.equal(f.demo.sessionValid({...session, workspace: 'owner'}), false);
    assert.equal(f.demo.sessionValid({...session, hackathonDemo: false}), false);
    assert.equal(f.demo.sessionValid({...session, expires: initialTime.toISOString()}), false);
    assert.throws(() => f.demo.view('owner'), status(404));
    assert.throws(() => f.demo.simulatePayment('demo'), status(404));
    f.advance(2 * 60 * 60 * 1000);
    assert.equal(f.demo.sessionValid(session), false);
    assert.equal(f.demo.hasWorkspace(a.workspace), true);
    f.advance((30 * 24 - 2) * 60 * 60 * 1000);
    assert.equal(f.demo.hasWorkspace(a.workspace), false);
    assert.equal(f.demo.sessionValid({...session, expires: '2026-11-06T12:00:00.000Z'}), false);
    assert.throws(() => f.demo.view(a.workspace), status(404));
    assert.throws(() => f.demo.simulatePayment(a.workspace), status(404));
  } finally {f.store.close();}
});

test('payment action creates one explicitly simulated receipt only in that visit', () => {
  const f = setup();
  try {
    const a = f.demo.start('marmot', 'fictional-client');
    const b = f.demo.start('marmot', 'fictional-client');
    assert.equal(f.demo.view(a.workspace).invoice.receiptToken, undefined);
    const paid = f.demo.simulatePayment(a.workspace);
    assert.equal(paid.invoice.status, 'paid');
    assert.equal(paid.invoice.settlementMode, 'simulation');
    assert.equal(paid.invoice.nativePayment, undefined);
    assert.equal(f.store.getReceipt(paid.invoice.receiptToken!)?.receipt.mode, 'simulation');
    assert.equal(f.demo.simulatePayment(a.workspace).invoice.receiptToken, paid.invoice.receiptToken);
    assert.equal(f.demo.view(b.workspace).invoice.status, 'open');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM receipts').get()!.n, 1);
  } finally {f.store.close();}
});

test('failed passwords and successful visit starts have separate bounded client windows', () => {
  const f = setup();
  try {
    for (let i = 0; i < 5; i++) assert.throws(() => f.demo.start('wrong', 'blocked-client'), status(401));
    assert.throws(() => f.demo.start('marmot', 'blocked-client'), status(429));
    assert.doesNotThrow(() => f.demo.start('marmot', 'another-client'));
    f.advance(10 * 60 * 1000);
    assert.doesNotThrow(() => f.demo.start('marmot', 'blocked-client'));
    for (let i = 0; i < 7; i++) f.demo.start('marmot', 'blocked-client');
    assert.throws(() => f.demo.start('marmot', 'blocked-client'), status(429));
    f.advance(60 * 60 * 1000);
    assert.doesNotThrow(() => f.demo.start('marmot', 'blocked-client'));
  } finally {f.store.close();}
});

test('many client identities cannot grow the attempt map without a fixed bound', () => {
  const f = setup();
  try {
    for (let i = 0; i < 2048; i++) assert.throws(() => f.demo.start('wrong', `fictional-client-${i}`), status(401));
    assert.throws(() => f.demo.start('wrong', 'overflow-client'), status(429));
    f.advance(10 * 60 * 1000);
    assert.throws(() => f.demo.start('wrong', 'overflow-client'), status(401));
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM invoices').get()!.n, 0);
  } finally {f.store.close();}
});

test('global visit capacity persists across service instances and expiry reclaims only owned demo rows', () => {
  const f = setup();
  try {
    const real = createInvoice(f.store, 'real-fictional-account', {customerName: 'Unrelated fictional business', title: 'Preserve this existing invoice', currency: 'CAD', items: [{description: 'Synthetic work', quantity: 1, unitAmount: 100}]}, initialTime);
    const visits = Array.from({length: 256}, (_, i) => f.demo.start('marmot', `fictional-client-${i}`));
    const a = visits[0];
    f.demo.simulatePayment(a.workspace);
    f.store.saveSession('expired-demo-session', {role: 'demo', workspace: a.workspace, accountId: a.accountId, hackathonDemo: true, csrf: 'fictional-demo', expires: a.expiresAt} as StoredSession);
    f.store.saveSession('expired-unrelated-session', {role: 'owner', workspace: 'real-fictional-account', csrf: 'fictional-owner', expires: a.expiresAt});
    f.store.idempotent('invoice:' + a.workspace, 'demo-key', {}, 201, () => ({id: a.invoiceId}));
    f.store.idempotent('invoice:' + a.workspace + '-other', 'other-key', {}, 201, () => ({id: real.id}));
    const originalRows = JSON.stringify(f.store.db.prepare('SELECT * FROM invoices WHERE workspace=?').all('real-fictional-account'));
    assert.throws(() => f.demo.start('marmot', 'capacity-client'), status(503));
    const restarted = new HackathonDemo({store: f.store, now: () => initialTime});
    assert.throws(() => restarted.start('marmot', 'capacity-client'), status(503));
    f.advance(30 * 24 * 60 * 60 * 1000);
    const fresh = f.demo.start('marmot', 'fresh-client');
    assert.equal(f.demo.hasWorkspace(fresh.workspace), true);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM hackathon_demo_workspaces').get()!.n, 1);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM invoices').get()!.n, 2);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM receipts').get()!.n, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM audits WHERE workspace=?').get(a.workspace)!.n, 0);
    assert.equal(f.store.session('expired-demo-session'), undefined);
    assert.ok(f.store.session('expired-unrelated-session'));
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM idempotency WHERE scope=?').get('invoice:' + a.workspace)!.n, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM idempotency WHERE scope=?').get('invoice:' + a.workspace + '-other')!.n, 1);
    assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM invoices WHERE workspace=?').all('real-fictional-account')), originalRows);
  } finally {f.store.close();}
});

test('demo data uses workspace-bound encryption including checkout bearer tokens', () => {
  const f = setup();
  try {
    const a = f.demo.start('marmot', 'fictional-client');
    const b = f.demo.start('marmot', 'fictional-client');
    const view = f.demo.view(a.workspace);
    const demoRow = f.store.db.prepare('SELECT data FROM hackathon_demo_workspaces WHERE id=?').get(a.workspace)!;
    const raw = JSON.stringify(f.store.db.prepare('SELECT * FROM hackathon_demo_workspaces').all()) + JSON.stringify(f.store.db.prepare('SELECT * FROM invoices').all());
    assert.ok(!raw.includes(view.invoice.title));
    assert.ok(!raw.includes(view.checkoutToken));
    assert.ok(!String(demoRow.data).includes(a.invoiceId));
    f.store.db.prepare('UPDATE hackathon_demo_workspaces SET data=? WHERE id=?').run(String(demoRow.data), b.workspace);
    assert.equal(f.demo.hasWorkspace(b.workspace), false);
    assert.throws(() => f.demo.view(b.workspace), status(404));
    assert.equal(f.demo.hasWorkspace(a.workspace), true);
  } finally {f.store.close();}
});

test('expiry cleanup respects Marmot foreign keys and leaves other conversation bytes unchanged', () => {
  const f = setup();
  try {
    f.store.db.exec(`
      CREATE TABLE marmot_conversations(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,invoice_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
      CREATE TABLE marmot_events(conversation_id TEXT NOT NULL REFERENCES marmot_conversations(id),workspace TEXT NOT NULL,id TEXT NOT NULL,created_at INTEGER NOT NULL,kind INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(conversation_id,id));
      CREATE TABLE receiving_requests(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,invoice_id TEXT NOT NULL REFERENCES invoices(id),data TEXT NOT NULL);
    `);
    const visit = f.demo.start('marmot', 'fictional-client');
    for (const [id, workspace, invoice] of [['demo-conversation', visit.workspace, visit.invoiceId], ['other-conversation', 'real-fictional-account', 'other-invoice']]) {
      f.store.db.prepare('INSERT INTO marmot_conversations VALUES(?,?,?,?)').run(id, workspace, invoice, f.store.encode({fictional: true}, 'marmot_conversations', id, workspace));
      f.store.db.prepare('INSERT INTO marmot_events VALUES(?,?,?,?,?,?)').run(id, workspace, 'fictional-event', 1, 445, f.store.encode({content: 'fictional encrypted event'}, 'marmot_events', 'fictional-event', workspace));
    }
    f.store.db.prepare('INSERT INTO receiving_requests VALUES(?,?,?,?)').run('demo-receiving', visit.workspace, visit.invoiceId, f.store.encode({fictional: true}, 'receiving_requests', 'demo-receiving', visit.workspace));
    f.store.revokeInvoiceLinks(visit.invoiceId, visit.workspace, initialTime.toISOString());
    const original = JSON.stringify(f.store.db.prepare('SELECT * FROM marmot_events WHERE workspace=?').all('real-fictional-account'));
    f.advance(30 * 24 * 60 * 60 * 1000);
    f.demo.start('marmot', 'fresh-client');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM marmot_conversations WHERE workspace=?').get(visit.workspace)!.n, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM marmot_events WHERE workspace=?').get(visit.workspace)!.n, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM receiving_requests').get()!.n, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM revoked_invoice_links').get()!.n, 0);
    assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM marmot_events WHERE workspace=?').all('real-fictional-account')), original);
    assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {f.store.close();}
});

test('visit creation is atomic and failed persistence does not consume the successful-start budget', () => {
  const f = setup();
  try {
    f.store.db.exec("CREATE TRIGGER fail_demo_insert BEFORE INSERT ON hackathon_demo_workspaces BEGIN SELECT RAISE(ABORT, 'FICTIONAL_TEST_FAILURE'); END;");
    for (let i = 0; i < 9; i++) assert.throws(() => f.demo.start('marmot', 'fictional-client'));
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM invoices').get()!.n, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM audits').get()!.n, 0);
    f.store.db.exec('DROP TRIGGER fail_demo_insert');
    assert.doesNotThrow(() => f.demo.start('marmot', 'fictional-client'));
  } finally {f.store.close();}
});

test('demo payment refuses invoice data marked as live or carrying native payment evidence', () => {
  const f = setup();
  try {
    const visit = f.demo.start('marmot', 'fictional-client');
    const original = f.demo.view(visit.workspace).invoice;
    f.store.saveInvoice({...original, settlementMode: 'live'});
    assert.throws(() => f.demo.simulatePayment(visit.workspace), status(409));
    f.store.saveInvoice({...original, nativePayment: {asset: 'BTC', atomicAmount: '1', network: 'bitcoin', paymentId: 'fictional-evidence', verification: 'manual'}});
    assert.throws(() => f.demo.simulatePayment(visit.workspace), status(409));
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM receipts').get()!.n, 0);
  } finally {f.store.close();}
});

test('encrypted demo workspaces survive database reopen without exposing invoice or token bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quiet-ledger-fictional-demo-'));
  const path = join(dir, 'fictional.sqlite'), key = Buffer.alloc(32, 42);
  let store = new Store(path, {encryptionKey: key});
  try {
    let demo = new HackathonDemo({store, now: () => initialTime});
    const visit = demo.start('marmot', 'fictional-client');
    const view = demo.simulatePayment(visit.workspace);
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const bytes = readFileSync(path);
    for (const value of [view.invoice.title, view.invoice.customerName, view.checkoutToken, view.invoice.receiptToken!]) assert.ok(!bytes.includes(Buffer.from(value)));
    store.close();
    store = new Store(path, {encryptionKey: key});
    demo = new HackathonDemo({store, now: () => initialTime});
    assert.equal(demo.view(visit.workspace).invoice.receiptToken, view.invoice.receiptToken);
    assert.equal(store.getReceipt(view.invoice.receiptToken!)?.receipt.mode, 'simulation');
    assert.equal(store.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally {store.close(); rmSync(dir, {recursive: true, force: true});}
});

test('cleanup skips malformed unrelated session payloads without deleting or blocking them', () => {
  const f = setup();
  try {
    f.demo.start('marmot', 'fictional-client');
    const id = hash('fictional-malformed-unrelated-session');
    const data = f.store.encode(null, 'sessions', id);
    f.store.db.prepare('INSERT INTO sessions(token_hash,data) VALUES(?,?)').run(id, data);
    f.advance(30 * 24 * 60 * 60 * 1000);
    assert.doesNotThrow(() => f.demo.start('marmot', 'fresh-client'));
    assert.equal(f.store.db.prepare('SELECT data FROM sessions WHERE token_hash=?').get(id)!.data, data);
  } finally {f.store.close();}
});

test('a failed clock cannot grant an otherwise expired demo view', () => {
  const f = setup();
  try {
    const visit = f.demo.start('marmot', 'fictional-client');
    const invalidClock = new HackathonDemo({store: f.store, now: () => new Date(Number.NaN)});
    assert.equal(invalidClock.hasWorkspace(visit.workspace), false);
    assert.throws(() => invalidClock.view(visit.workspace), status(503));
    assert.throws(() => invalidClock.simulatePayment(visit.workspace), status(503));
    assert.throws(() => invalidClock.start('marmot', 'fictional-client'), status(503));
  } finally {f.store.close();}
});

test('new demo invoices change the version and respect selected methods, retry-stable payment and visit limits',()=>{
 const f=setup();try{const visit=f.demo.start('marmot','fictional-new-invoice'),first=f.demo.view(visit.workspace);const body={customerName:'Marmot Field Lab (fictional)',title:'Fictional Marmot workshop recording',currency:'KRW',items:[{description:'Fictional workshop capture',quantity:1,unitAmount:150000}],discountBps:1000,premiumBps:600,acceptedMethods:['bitcoin']};
 const created=f.demo.create(visit.workspace,body);assert.equal(created.caseVersion,first.caseVersion+1);assert.equal(created.invoice.total,144000);assert.equal(created.invoice.settlementMode,'simulation');const paid=f.demo.simulatePayment(visit.workspace);assert.equal(paid.invoice.paymentMethod,'bitcoin');assert.equal(paid.caseVersion,created.caseVersion+1);assert.equal(f.demo.simulatePayment(visit.workspace).caseVersion,paid.caseVersion);for(let i=0;i<6;i++)f.demo.create(visit.workspace,body);assert.equal(f.store.listInvoices(visit.workspace).length,8);assert.throws(()=>f.demo.create(visit.workspace,body),status(429));
 }finally{f.store.close();}
});
