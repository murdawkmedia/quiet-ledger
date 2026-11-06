import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {HackathonDemo} from '../server/hackathon-demo.js';
import {InvoiceTemplates} from '../server/invoice-templates.js';
import {DemoAgentAdmission} from '../server/demo-agent-admission.js';
import {DomainError, Store, hash, type StoredSession} from '../server/store.js';

const initialTime = new Date('2026-11-05T12:00:00.000Z');
const hour = 60 * 60 * 1000, day = 24 * hour;
const fictionalDraft = {customerName: 'Fictional returning client', title: 'Saved fictional workshop', currency: 'CAD', items: [{description: 'Fictional editing', quantity: 1, unitAmount: 22000}]};
function setup() {
  const store = new Store(':memory:', {encryptionKey: Buffer.alloc(32, 61)});
  let clock = initialTime;
  const demo = new HackathonDemo({store, now: () => clock});
  return {store, demo, advance(ms: number) {clock = new Date(clock.getTime() + ms);}, now: () => clock};
}
const status = (expected: number) => (error: unknown) => error instanceof DomainError && error.status === expected;
const session = (visit: {workspace: string; accountId: string; sessionExpiresAt: string}): StoredSession => ({role: 'demo', workspace: visit.workspace, accountId: visit.accountId, hackathonDemo: true, csrf: 'fictional-csrf', expires: visit.sessionExpiresAt});

test('a saved demo has fixed thirty-day retention and a separate two-hour sign-in', () => {
  const f = setup();
  try {
    const visit = f.demo.start('marmot', 'fictional-client');
    assert.equal(visit.expiresAt, '2026-12-05T12:00:00.000Z');
    assert.equal(visit.sessionExpiresAt, '2026-11-05T14:00:00.000Z');
    assert.match(visit.resumeToken!, /^[A-Za-z0-9_-]{43}$/);
    const raw = String(f.store.db.prepare('SELECT data FROM hackathon_demo_workspaces WHERE id=?').get(visit.workspace)!.data);
    assert.ok(!raw.includes(visit.resumeToken!));
    const saved = f.store.decode(raw, 'hackathon_demo_workspaces', visit.workspace, visit.workspace);
    assert.equal(saved.resumeTokenHash, hash(visit.resumeToken!));
    assert.equal(saved.resumeToken, undefined);
    const signedIn = session(visit);
    f.advance(2 * hour);
    assert.equal(f.demo.sessionValid(signedIn), false);
    assert.equal(f.demo.hasWorkspace(visit.workspace), true);
    assert.equal(f.demo.view(visit.workspace).invoice.id, visit.invoiceId);
  } finally {f.store.close();}
});

test('returning after logout and database reopen retains invoices templates and simulated receipts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quiet-ledger-fictional-saved-demo-'));
  const path = join(dir, 'fictional.sqlite'), key = Buffer.alloc(32, 62);
  let store = new Store(path, {encryptionKey: key});
  try {
    let demo = new HackathonDemo({store, now: () => initialTime});
    const visit = demo.start('marmot', 'fictional-client');
    assert.match(visit.resumeToken!, /^[A-Za-z0-9_-]{43}$/);
    const templates = new InvoiceTemplates(store);
    const template = templates.save(visit.workspace, {label: 'Fictional reusable workshop', draft: fictionalDraft});
    const created = demo.create(visit.workspace, fictionalDraft);
    const paid = demo.simulatePayment(visit.workspace);
    store.saveSession('fictional-session', session(visit));
    store.removeSession('fictional-session');
    const invoices = JSON.stringify(store.db.prepare('SELECT * FROM invoices WHERE workspace=?').all(visit.workspace));
    const receipts = JSON.stringify(store.db.prepare('SELECT * FROM receipts').all());
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.ok(!readFileSync(path).includes(Buffer.from(visit.resumeToken!)));
    store.close();
    store = new Store(path, {encryptionKey: key});
    const returnedAt = new Date(initialTime.getTime() + 3 * day);
    demo = new HackathonDemo({store, now: () => returnedAt});
    const resumed = demo.resume(visit.resumeToken);
    assert.equal(resumed.workspace, visit.workspace);
    assert.equal(resumed.accountId, visit.accountId);
    assert.equal(resumed.invoiceId, created.invoice.id);
    assert.equal(resumed.expiresAt, visit.expiresAt);
    assert.equal(resumed.sessionExpiresAt, new Date(returnedAt.getTime() + 2 * hour).toISOString());
    assert.equal(resumed.resumeToken, undefined);
    assert.equal(demo.view(resumed.workspace).caseVersion, paid.caseVersion);
    assert.equal(store.getReceipt(paid.invoice.receiptToken!)?.receipt.mode, 'simulation');
    assert.deepEqual(new InvoiceTemplates(store).list(resumed.workspace), [template]);
    assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM invoices WHERE workspace=?').all(visit.workspace)), invoices);
    assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM receipts').all()), receipts);
    assert.equal(store.session('fictional-session'), undefined);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally {store.close(); rmSync(dir, {recursive: true, force: true});}
});

test('password sign-in resumes only the browser capability and never accepts a workspace identifier', () => {
  const f = setup();
  try {
    const a = f.demo.start('marmot', 'fictional-a'), b = f.demo.start('marmot', 'fictional-b');
    assert.throws(() => f.demo.start('wrong', 'fictional-a', a.resumeToken), status(401));
    const resumed = f.demo.start('marmot', 'fictional-a', a.resumeToken);
    assert.equal(resumed.workspace, a.workspace);
    assert.notEqual(resumed.workspace, b.workspace);
    assert.equal(resumed.resumeToken, undefined);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM invoices').get()!.n, 2);
    for (const value of [undefined, null, '', a.workspace, a.accountId, {workspace: a.workspace}, a.resumeToken! + '=', ' '.repeat(43), randomBytes(32).toString('base64url')]) assert.throws(() => f.demo.resume(value), status(404));
    const fresh = f.demo.start('marmot', 'fictional-a', a.workspace);
    assert.notEqual(fresh.workspace, a.workspace);
    assert.notEqual(fresh.workspace, b.workspace);
    assert.match(fresh.resumeToken!, /^[A-Za-z0-9_-]{43}$/);
  } finally {f.store.close();}
});

test('remember promotes only a validated existing demo session while preserving all business bytes', () => {
  const f = setup();
  try {
    const visit = f.demo.start('marmot', 'fictional-client');
    const row = f.store.db.prepare('SELECT data FROM hackathon_demo_workspaces WHERE id=?').get(visit.workspace)!;
    const saved = f.store.decode(row.data, 'hackathon_demo_workspaces', visit.workspace, visit.workspace);
    const {resumeTokenHash: _hash, ...legacy} = saved;
    legacy.kind = 'quiet-ledger-hackathon-demo-v1';
    legacy.expiresAt = new Date(initialTime.getTime() + 2 * hour).toISOString();
    f.store.db.prepare('UPDATE hackathon_demo_workspaces SET expires_at=?,data=? WHERE id=?').run(legacy.expiresAt, f.store.encode(legacy, 'hackathon_demo_workspaces', visit.workspace, visit.workspace), visit.workspace);
    const signedIn = session({...visit, sessionExpiresAt: legacy.expiresAt});
    f.demo.simulatePayment(visit.workspace);
    const before = ['invoices', 'receipts', 'audits'].map(name => JSON.stringify(f.store.db.prepare(`SELECT * FROM ${name}`).all()));
    assert.equal(f.demo.sessionValid(signedIn), true);
    for (const invalid of [{...signedIn, role: 'owner' as const}, {...signedIn, hackathonDemo: false}, {...signedIn, accountId: 'fictional-other'}, {...signedIn, workspace: 'owner'}, {...signedIn, expires: initialTime.toISOString()}]) assert.throws(() => f.demo.remember(invalid), status(404));
    f.advance(hour);
    const remembered = f.demo.remember(signedIn);
    assert.equal(remembered.workspace, visit.workspace);
    assert.equal(remembered.invoiceId, visit.invoiceId);
    assert.equal(remembered.expiresAt, visit.expiresAt);
    assert.equal(f.demo.resume(remembered.resumeToken).workspace, visit.workspace);
    assert.deepEqual(['invoices', 'receipts', 'audits'].map(name => JSON.stringify(f.store.db.prepare(`SELECT * FROM ${name}`).all())), before);
    f.advance(hour);
    assert.equal(f.demo.sessionValid(signedIn), false);
    assert.throws(() => f.demo.remember(signedIn), status(404));
    assert.equal(f.demo.hasWorkspace(visit.workspace), true);
  } finally {f.store.close();}
});

test('a missing browser capability can be replaced by the same validated session without extending retention', () => {
  const f = setup();
  try {
    const visit = f.demo.start('marmot', 'fictional-client');
    f.advance(hour);
    const replacement = f.demo.remember(session(visit));
    assert.notEqual(replacement.resumeToken, visit.resumeToken);
    assert.equal(replacement.expiresAt, visit.expiresAt);
    assert.throws(() => f.demo.resume(visit.resumeToken), status(404));
    assert.equal(f.demo.resume(replacement.resumeToken).workspace, visit.workspace);
  } finally {f.store.close();}
});

test('legacy two-hour records remain compatible and expire without deleting saved visits', () => {
  const f = setup();
  try {
    const legacyVisit = f.demo.start('marmot', 'fictional-legacy'), savedVisit = f.demo.start('marmot', 'fictional-saved');
    const row = f.store.db.prepare('SELECT data FROM hackathon_demo_workspaces WHERE id=?').get(legacyVisit.workspace)!;
    const data = f.store.decode(row.data, 'hackathon_demo_workspaces', legacyVisit.workspace, legacyVisit.workspace);
    const {resumeTokenHash: _hash, ...legacy} = data;
    legacy.kind = 'quiet-ledger-hackathon-demo-v1';
    legacy.expiresAt = legacyVisit.sessionExpiresAt;
    const encoded = f.store.encode(legacy, 'hackathon_demo_workspaces', legacyVisit.workspace, legacyVisit.workspace);
    f.store.db.prepare('UPDATE hackathon_demo_workspaces SET expires_at=?,data=? WHERE id=?').run(legacy.expiresAt, encoded, legacyVisit.workspace);
    const restarted = new HackathonDemo({store: f.store, now: f.now});
    assert.equal(restarted.view(legacyVisit.workspace).invoice.id, legacyVisit.invoiceId);
    assert.equal(f.store.db.prepare('SELECT data FROM hackathon_demo_workspaces WHERE id=?').get(legacyVisit.workspace)!.data, encoded);
    assert.throws(() => restarted.resume(legacyVisit.resumeToken), status(404));
    const retainedInvoices = JSON.stringify(f.store.db.prepare('SELECT * FROM invoices WHERE workspace=?').all(savedVisit.workspace));
    f.advance(2 * hour);
    assert.equal(restarted.hasWorkspace(legacyVisit.workspace), false);
    assert.throws(() => restarted.remember(session(legacyVisit)), status(404));
    restarted.start('marmot', 'fictional-new');
    assert.equal(f.store.db.prepare('SELECT data FROM hackathon_demo_workspaces WHERE id=?').get(legacyVisit.workspace)!.data, encoded);
    assert.equal(restarted.resume(savedVisit.resumeToken).workspace, savedVisit.workspace);
    assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM invoices WHERE workspace=?').all(savedVisit.workspace)), retainedInvoices);
  } finally {f.store.close();}
});

test('resume and capability replacement fail closed when the service clock fails', () => {
  const f = setup();
  try {
    const visit = f.demo.start('marmot', 'fictional-client');
    const before = f.store.db.prepare('SELECT data FROM hackathon_demo_workspaces WHERE id=?').get(visit.workspace)!.data;
    const failed = new HackathonDemo({store: f.store, now: () => new Date(Number.NaN)});
    assert.throws(() => failed.resume(visit.resumeToken), status(503));
    assert.throws(() => failed.remember(session(visit)), status(503));
    assert.equal(f.store.db.prepare('SELECT data FROM hackathon_demo_workspaces WHERE id=?').get(visit.workspace)!.data, before);
    assert.equal(f.demo.resume(visit.resumeToken).workspace, visit.workspace);
  } finally {f.store.close();}
});

test('retention is fixed, cannot be prolonged by resuming, and bounds the last session', () => {
  const f = setup();
  try {
    const visit = f.demo.start('marmot', 'fictional-client');
    f.advance(30 * day - hour);
    const last = f.demo.resume(visit.resumeToken);
    assert.equal(last.expiresAt, visit.expiresAt);
    assert.equal(last.sessionExpiresAt, visit.expiresAt);
    f.advance(hour);
    assert.throws(() => f.demo.resume(visit.resumeToken), status(404));
    assert.equal(f.demo.hasWorkspace(visit.workspace), false);
    assert.throws(() => f.demo.view(visit.workspace), status(404));
  } finally {f.store.close();}
});

test('saved visits retain bounded capacity across restart and a full registry can still resume', () => {
  const f = setup();
  try {
    const visits = Array.from({length: 256}, (_, i) => f.demo.start('marmot', `fictional-client-${i}`));
    const before = JSON.stringify(f.store.db.prepare('SELECT * FROM invoices').all());
    const restarted = new HackathonDemo({store: f.store, now: f.now});
    assert.throws(() => restarted.start('marmot', 'fictional-overflow'), status(503));
    const resumed = restarted.start('marmot', 'fictional-returning', visits[0].resumeToken);
    assert.equal(resumed.workspace, visits[0].workspace);
    assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM invoices').all()), before);
    f.advance(30 * day);
    assert.doesNotThrow(() => restarted.start('marmot', 'fictional-after-retention'));
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM hackathon_demo_workspaces').get()!.n, 1);
    assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {f.store.close();}
});

test('saved-visit retention does not extend the twelve-round ten-minute agent lease', () => {
  const f = setup();
  try {
    const visit = f.demo.start('marmot', 'fictional-client');
    const admission = new DemoAgentAdmission({store: f.store, now: f.now, getCase: () => ({fictional: true, currency: 'CAD', lineAmount: 12500, tax: 0, total: 12500, discountAmount: 0, premiumAmount: 0, invoiceNumber: 'FICTIONAL-1', title: 'Fictional workshop', status: 'open', settlementMode: 'simulation', receiptRecorded: false, version: 1, asOf: f.now().toISOString()})});
    const lease = admission.start(visit.workspace, '1'.repeat(64), visit.expiresAt);
    assert.equal(lease.expiresAt, new Date(initialTime.getTime() + 10 * 60 * 1000).toISOString());
    assert.equal(lease.roundsRemaining, 12);
    f.advance(10 * 60 * 1000);
    assert.equal(admission.get(visit.workspace)?.state, 'expired');
    assert.equal(f.demo.resume(visit.resumeToken).workspace, visit.workspace);
  } finally {f.store.close();}
});
