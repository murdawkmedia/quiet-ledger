import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { createApp } from '../server/app.js';

const ownerToken = 'synthetic-recovery-owner-token';
const invoiceInput = {
  customerName: 'Synthetic recovery customer', customerEmail: 'recovery@example.invalid',
  title: 'Synthetic recovery invoice', currency: 'CAD',
  items: [{ description: 'Synthetic service', quantity: 1, unitAmount: 125 }],
};

async function ephemeralPort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function runtime(directory: string, port: number, preload?: string) {
  const args = ['--import', 'tsx'];
  if (preload) args.push('--import', `data:text/javascript,${encodeURIComponent(preload)}`);
  args.push('server/index.ts');
  const child = spawn(process.execPath, args, {
    cwd: resolve('.'),
    env: { PATH: process.env.PATH, NODE_ENV: 'production', DATA_DIR: directory, HOST: '127.0.0.1', PORT: String(port),
      ...(preload ? { SQUARE_SANDBOX_TOKEN_FILE: join(directory, 'synthetic-square-token') } : {}) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  const events: unknown[] = [];
  child.stdout!.on('data', value => { output += String(value); });
  child.stderr!.on('data', value => { output += String(value); });
  child.on('message', message => { events.push(message); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, exit, events, output: () => output };
}

async function until(predicate: () => boolean, description: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await once(child, 'exit');
}

// Boundary cases must be rejected at configuration time: /api/session/owner
// accepts at most 256 characters, so a larger configured value cannot sign in.
test('recovery regression: unusable owner-token configuration is rejected before opening storage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiet-recovery-config-'));
  let app: ReturnType<typeof createApp> | undefined;
  try {
    const dbPath = join(directory, 'ledger.sqlite');
    assert.throws(() => { app = createApp({ dbPath, ownerToken: 'X'.repeat(257) }); }, /owner token/i);
    assert.equal(existsSync(dbPath), false);
  } finally { app?.locals.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('recovery: malformed owner scenario returns a sanitized error and recovers after the file is repaired', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiet-recovery-scenario-'));
  const privateScenarioPath = join(directory, 'synthetic-scenario.json');
  const privateCanary = 'SYNTHETIC_FILE_CONTENT_MUST_NOT_APPEAR_IN_ERROR';
  writeFileSync(privateScenarioPath, `${privateCanary}{`, { mode: 0o600 });
  const app = createApp({ dbPath: ':memory:', ownerToken, privateScenarioPath });
  try {
    const owner = request.agent(app);
    await owner.post('/api/session/owner').send({ token: ownerToken }).expect(200);
    const error = await owner.get('/api/scenario').expect(503);
    assert.deepEqual(Object.keys(error.body), ['error']);
    assert.ok(!JSON.stringify(error.body).includes(privateCanary));
    assert.ok(!JSON.stringify(error.body).includes(privateScenarioPath));
    await owner.get('/api/health').expect(200);
    writeFileSync(privateScenarioPath, JSON.stringify({ title: 'Repaired synthetic snapshot' }), { mode: 0o600 });
    const repaired = await owner.get('/api/scenario').expect(200);
    assert.equal(repaired.body.scenario.title, 'Repaired synthetic snapshot');
  } finally { app.locals.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('recovery regression: creating a session prunes only expired persisted sessions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiet-recovery-sessions-'));
  const dbPath = join(directory, 'ledger.sqlite');
  let current = new Date('2026-11-04T00:00:00.000Z');
  let app = createApp({ dbPath, ownerToken, now: () => current });
  try {
    for (let index = 0; index < 20; index++) await request(app).post('/api/session/owner').send({ token: ownerToken }).expect(200);
    current = new Date('2026-11-04T12:00:00.000Z');
    const active = await request(app).post('/api/session/demo').send({}).expect(200);
    const cookie = String(active.headers['set-cookie'][0]).split(';')[0];
    app.locals.close();
    current = new Date('2026-11-05T00:00:00.001Z');
    app = createApp({ dbPath, ownerToken, now: () => current });
    await request(app).post('/api/session/owner').send({ token: ownerToken }).expect(200);
    const stillActive = await request(app).get('/api/session').set('Cookie', cookie).expect(200);
    assert.equal(stillActive.body.role, 'demo');
    const inspection = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const sessions = inspection.prepare('SELECT data FROM sessions').all().map(row => JSON.parse(String(row.data)));
      assert.equal(sessions.filter(session => Date.parse(session.expires) <= current.getTime()).length, 0);
      assert.equal(sessions.length, 2, 'Keep the still-valid session and newly established session.');
    } finally { inspection.close(); }
  } finally { app.locals.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('recovery: real SIGTERM drains an in-flight synthetic provider request before closing SQLite, then resumes its records', { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiet-recovery-lifecycle-'));
  writeFileSync(join(directory, 'synthetic-square-token'), 'synthetic-square-token\n', { mode: 0o600 });
  const preload = `
    process.on('SIGTERM', () => process.send?.('synthetic-shutdown-observed'));
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith('/locations')) return Response.json({ locations: [{ id: 'synthetic-location', status: 'ACTIVE', currency: 'CAD' }] });
      if (String(url).endsWith('/payment-links')) {
        process.send?.('synthetic-provider-started');
        await new Promise(resolve => process.once('message', resolve));
        process.channel?.unref();
        return Response.json({ payment_link: { id: 'synthetic-link', order_id: 'synthetic-order', url: 'https://sandbox.square.link/u/synthetic' } });
      }
      throw new Error('Unexpected outbound request in isolated lifecycle test');
    };
    process.channel?.unref();
  `;
  let first: ReturnType<typeof runtime> | undefined;
  let second: ReturnType<typeof runtime> | undefined;
  try {
    const port = await ephemeralPort();
    const base = `http://127.0.0.1:${port}`;
    first = runtime(directory, port, preload);
    await until(() => first!.output().includes('Quiet Ledger ready at') || first!.child.exitCode !== null, 'first process readiness');
    assert.equal(first.child.exitCode, null, first.output());
    const generatedToken = readFileSync(join(directory, 'owner-token'), 'utf8').trim();
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, 'owner-token')).mode & 0o777, 0o600);
    assert.equal(statSync(join(directory, 'ledger.sqlite')).mode & 0o777, 0o600);
    assert.ok(!first.output().includes(generatedToken));
    const login = await fetch(`${base}/api/session/owner`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: generatedToken }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const session = await login.json() as { csrfToken: string };
    const headers = { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': 'synthetic-shutdown-invoice' };
    const invoiceResponse = await fetch(`${base}/api/invoices`, { method: 'POST', headers, body: JSON.stringify(invoiceInput) });
    assert.equal(invoiceResponse.status, 201);
    const invoice = await invoiceResponse.json() as { id: string };
    const pending = fetch(`${base}/api/square-sandbox/checkouts`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'synthetic-shutdown-checkout' }, body: JSON.stringify({ invoiceId: invoice.id }) });
    // Attach rejection handling before waiting so failed startup/shutdown cannot
    // produce an unhandled promise rejection in the test runner.
    void pending.catch(() => {});
    await until(() => first!.events.includes('synthetic-provider-started'), 'synthetic provider barrier');
    first.child.kill('SIGTERM');
    await until(() => first!.events.includes('synthetic-shutdown-observed'), 'SIGTERM handler entry');
    assert.equal(first.child.exitCode, null, 'The blocked request must keep the process alive during drain.');
    first.child.send('release-synthetic-provider');
    const response = await pending;
    assert.equal(response.status, 201);
    const created = await response.json() as { checkout: { id: string; status: string } };
    assert.equal(created.checkout.status, 'awaiting_payment');
    assert.deepEqual(await first.exit, { code: 0, signal: null });

    second = runtime(directory, port, preload);
    await until(() => second!.output().includes('Quiet Ledger ready at') || second!.child.exitCode !== null, 'second process readiness');
    assert.equal(second.child.exitCode, null, second.output());
    assert.equal(readFileSync(join(directory, 'owner-token'), 'utf8').trim(), generatedToken);
    const state = await fetch(`${base}/api/square-sandbox`, { headers: { Cookie: cookie } });
    assert.equal(state.status, 200, 'The valid session survives a clean restart.');
    const saved = await state.json() as { checkouts: { id: string; status: string }[] };
    assert.equal(saved.checkouts.length, 1);
    assert.equal(saved.checkouts[0].id, created.checkout.id);
    assert.equal(saved.checkouts[0].status, 'awaiting_payment');
    const inspection = new DatabaseSync(join(directory, 'ledger.sqlite'), { readOnly: true });
    try { assert.equal(inspection.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok'); }
    finally { inspection.close(); }
    second.child.kill('SIGTERM');
    assert.deepEqual(await second.exit, { code: 0, signal: null });
  } finally {
    if (first) await terminate(first.child);
    if (second) await terminate(second.child);
    rmSync(directory, { recursive: true, force: true });
  }
});
