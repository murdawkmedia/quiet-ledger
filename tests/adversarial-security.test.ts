import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createLogger, createServer, isFileLoadingAllowed, resolveConfig, searchForWorkspaceRoot, type ViteDevServer } from 'vite';
import { createApp, type AppOptions } from '../server/app.js';

const ownerToken = 'synthetic-adversarial-owner-token';
const privateCanary = 'SYNTHETIC_OWNER_SCENARIO_CANARY';
const ownerInvoice = {
  customerName: 'Synthetic owner customer',
  customerEmail: 'owner-customer@example.invalid',
  title: 'Synthetic private owner invoice',
  currency: 'CAD',
  items: [{ description: 'Synthetic service', quantity: 1, unitAmount: 2_000 }],
  note: 'Synthetic customer-visible note',
};

function fixture(options: Partial<AppOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'quiet-adversarial-security-'));
  const privateScenarioPath = join(directory, 'synthetic-scenario.json');
  writeFileSync(privateScenarioPath, JSON.stringify({ title: privateCanary }), { mode: 0o600 });
  const app = createApp({ dbPath: ':memory:', ownerToken, privateScenarioPath, ...options });
  return { app, close: () => { app.locals.close(); rmSync(directory, { recursive: true, force: true }); } };
}

async function login(app: ReturnType<typeof createApp>, role: 'owner' | 'demo' = 'owner') {
  const agent = request.agent(app);
  const response = await agent.post(`/api/session/${role}`).send(role === 'owner' ? { token: ownerToken } : {}).expect(200);
  return { agent, csrf: String(response.body.csrfToken), cookie: String(response.headers['set-cookie'][0]).split(';')[0] };
}

async function issue(user: Awaited<ReturnType<typeof login>>) {
  const response = await user.agent.post('/api/invoices').set('X-CSRF-Token', user.csrf)
    .set('Idempotency-Key', randomUUID()).send(ownerInvoice).expect(201);
  return response.body;
}

test('security: owner, demo, public bearer and evidence export expose only their authorized fields', async () => {
  const s = fixture();
  try {
    const owner = await login(s.app);
    const invoice = await issue(owner);
    const scenario = await owner.agent.get('/api/scenario').expect(200);
    assert.equal(scenario.body.scenario.title, privateCanary);
    const demo = await login(s.app, 'demo');
    await request(s.app).get('/api/scenario').expect(401);
    await demo.agent.get('/api/scenario').expect(403);
    await demo.agent.get(`/api/invoices/${invoice.id}`).expect(404);
    const demoDashboard = await demo.agent.get('/api/dashboard').expect(200);
    const demoExport = await demo.agent.get('/api/evidence/export').expect(200);
    for (const result of [demoDashboard, demoExport]) {
      assert.ok(!JSON.stringify(result.body).includes(invoice.id));
      assert.ok(!JSON.stringify(result.body).includes(invoice.customerEmail));
      assert.ok(!JSON.stringify(result.body).includes(privateCanary));
    }
    const checkout = await request(s.app).get(`/api/checkout/${invoice.token}`).expect(200);
    assert.equal(checkout.body.invoice.customerName, ownerInvoice.customerName);
    assert.equal(checkout.body.invoice.note, ownerInvoice.note);
    for (const field of ['id', 'token', 'receiptToken', 'customerEmail', 'workspace', 'totalCad']) {
      assert.ok(!(field in checkout.body.invoice), `Public invoice exposed ${field}`);
    }
    const payment = await request(s.app).post(`/api/checkout/${invoice.token}/pay`)
      .set('Idempotency-Key', randomUUID()).send({ method: 'cashu' }).expect(200);
    const receipt = await request(s.app).get(`/api/receipts/${payment.body.receiptToken}`).expect(200);
    assert.ok(!JSON.stringify(receipt.body).includes(ownerInvoice.customerEmail));
    const exported = await owner.agent.get('/api/evidence/export').expect(200);
    for (const value of [invoice.token, payment.body.receiptToken, privateCanary, ownerToken, owner.csrf, owner.cookie.slice('ql_session='.length)]) {
      assert.ok(!JSON.stringify(exported.body).includes(value), 'Evidence export included an access token or private scenario');
    }
    assert.equal(exported.headers['cache-control'], 'no-store');
  } finally { s.close(); }
});

test('security: Origin and Fetch Metadata guards reject cross-origin browser mutations before changing state', async () => {
  const s = fixture();
  try {
    for (const path of ['/api/session/demo', '/api/session/owner']) {
      await request(s.app).post(path).set('Origin', 'https://attacker.invalid').send({ token: ownerToken }).expect(403);
      await request(s.app).post(path).set('Sec-Fetch-Site', 'cross-site').send({ token: ownerToken }).expect(403);
      await request(s.app).post(path).set('Origin', 'null').send({ token: ownerToken }).expect(403);
    }
    const owner = await login(s.app);
    const invoice = await issue(owner);
    await owner.agent.post('/api/invoices').set('Origin', 'https://attacker.invalid')
      .set('X-CSRF-Token', owner.csrf).set('Idempotency-Key', randomUUID()).send(ownerInvoice).expect(403);
    await request(s.app).post(`/api/checkout/${invoice.token}/pay`).set('Sec-Fetch-Site', 'cross-site')
      .set('Idempotency-Key', randomUUID()).send({ method: 'cashu' }).expect(403);
    assert.equal((await owner.agent.get(`/api/invoices/${invoice.id}`)).body.status, 'open');
    assert.equal((await owner.agent.get('/api/invoices')).body.invoices.length, 1);
  } finally { s.close(); }
});

test('security: CSRF tokens are session-bound, session replacement revokes old cookies and logout invalidates the current cookie', async () => {
  const s = fixture();
  try {
    const first = await login(s.app);
    const second = await login(s.app);
    await second.agent.post('/api/invoices').set('X-CSRF-Token', first.csrf)
      .set('Idempotency-Key', randomUUID()).send(ownerInvoice).expect(403);
    await second.agent.delete('/api/session').expect(403);
    await first.agent.post('/api/session/demo').send({}).expect(200);
    await request(s.app).get('/api/dashboard').set('Cookie', first.cookie).expect(401);
    await second.agent.delete('/api/session').set('X-CSRF-Token', second.csrf).expect(200);
    await request(s.app).get('/api/dashboard').set('Cookie', second.cookie).expect(401);
  } finally { s.close(); }
});

test('security: expired sessions fail closed and client-supplied forwarding headers cannot disable the login throttle', async () => {
  let current = new Date('2026-11-04T12:00:00.000Z');
  const s = fixture({ now: () => current });
  try {
    const owner = await login(s.app);
    current = new Date(current.getTime() + 86_400_001);
    await request(s.app).get('/api/dashboard').set('Cookie', owner.cookie).expect(401);
    const view = await request(s.app).get('/api/session').set('Cookie', owner.cookie).expect(200);
    assert.equal(view.body.authenticated, false);
    for (let attempt = 0; attempt < 8; attempt++) {
      await request(s.app).post('/api/session/owner').set('X-Forwarded-For', `192.0.2.${attempt + 1}`)
        .send({ token: 'wrong-synthetic-token' }).expect(401);
    }
    await request(s.app).post('/api/session/owner').set('X-Forwarded-For', '198.51.100.1')
      .send({ token: ownerToken }).expect(429);
    current = new Date(current.getTime() + 15 * 60_000 + 1);
    await request(s.app).post('/api/session/owner').send({ token: ownerToken }).expect(200);
  } finally { s.close(); }
});

test('security regression: loopback applications reject an attacker Host even when Origin matches that Host', async () => {
  const s = fixture();
  try {
    for (const role of ['demo', 'owner']) {
      const response = await request(s.app).post(`/api/session/${role}`).set('Host', 'attacker.invalid')
        .set('Origin', 'http://attacker.invalid').send(role === 'owner' ? { token: ownerToken } : {});
      assert.ok([400, 403, 421].includes(response.status), `Untrusted Host reached ${role} login with HTTP ${response.status}`);
      assert.equal(response.headers['set-cookie'], undefined);
    }
  } finally { s.close(); }
});

test('security: explicitly configured application hostnames support matching-origin login and reject other hosts', async () => {
  const s = fixture({ allowedHosts: ['127.0.0.1', 'qa.example.invalid'] });
  try {
    const normal = await login(s.app);
    await normal.agent.get('/api/dashboard').expect(200);
    const configured = await request(s.app).post('/api/session/demo').set('Host', 'qa.example.invalid:8080')
      .set('Origin', 'http://qa.example.invalid:8080').send({}).expect(200);
    assert.equal(configured.body.role, 'demo');
    await request(s.app).post('/api/session/demo').set('Host', 'qa.example.invalid:8080')
      .set('Origin', 'http://attacker.invalid:8080').send({}).expect(403);
    const other = await request(s.app).post('/api/session/demo').set('Host', 'other.example.invalid:8080')
      .set('Origin', 'http://other.example.invalid:8080').send({});
    assert.ok([400, 403, 421].includes(other.status));
  } finally { s.close(); }
});

test('security: forged cookies, checkout identifiers and SQL-looking bearer tokens fail without leaking private records', async () => {
  const s = fixture();
  try {
    const owner = await login(s.app);
    const invoice = await issue(owner);
    for (const cookie of ['ql_session=owner', `ql_session=${'A'.repeat(43)}`, 'ql_session=%00']) {
      await request(s.app).get('/api/dashboard').set('Cookie', cookie).expect(401);
    }
    for (const token of [invoice.id, 'QL-0001', "' OR 1=1--", '../scenario']) {
      const checkout = await request(s.app).get(`/api/checkout/${encodeURIComponent(token)}`).expect(404);
      assert.ok(!JSON.stringify(checkout.body).includes(privateCanary));
      await request(s.app).get(`/api/receipts/${encodeURIComponent(token)}`).expect(404);
      await request(s.app).get(`/api/square-test/${encodeURIComponent(token)}`).expect(404);
    }
  } finally { s.close(); }
});

test('security: a public payment retry key cannot return another checkout response or settle a second invoice', async () => {
  const s = fixture();
  try {
    const owner = await login(s.app);
    const first = await issue(owner);
    const second = await issue(owner);
    const key = randomUUID();
    const payment = await request(s.app).post(`/api/checkout/${first.token}/pay`)
      .set('Idempotency-Key', key).send({ method: 'cashu' }).expect(200);
    const conflict = await request(s.app).post(`/api/checkout/${second.token}/pay`)
      .set('Idempotency-Key', key).send({ method: 'cashu' }).expect(409);
    assert.ok(!JSON.stringify(conflict.body).includes(payment.body.receiptToken));
    assert.equal((await owner.agent.get(`/api/invoices/${second.id}`)).body.status, 'open');
  } finally { s.close(); }
});

test('security: malformed and oversized bodies return bounded JSON errors and leave issuance state unchanged', async () => {
  const s = fixture();
  try {
    const owner = await login(s.app);
    const before = (await owner.agent.get('/api/invoices')).body.invoices.length;
    for (const input of [null, [], {}, { ...ownerInvoice, owner: true }, { ...ownerInvoice, items: [{ description: 'Bad', quantity: -1, unitAmount: 1 }] }]) {
      await owner.agent.post('/api/invoices').set('X-CSRF-Token', owner.csrf)
        .set('Idempotency-Key', randomUUID()).send(JSON.stringify(input)).set('Content-Type', 'application/json').expect(400);
    }
    const malformed = await owner.agent.post('/api/invoices').set('Content-Type', 'application/json').send('{"title":').expect(400);
    const oversized = await owner.agent.post('/api/invoices').set('Content-Type', 'application/json')
      .send(JSON.stringify({ note: 'x'.repeat(50_000) })).expect(413);
    for (const response of [malformed, oversized]) {
      assert.deepEqual(Object.keys(response.body), ['error']);
      assert.ok(!response.text.includes('SyntaxError'));
      assert.ok(response.text.length < 200);
    }
    assert.equal((await owner.agent.get('/api/invoices')).body.invoices.length, before);
  } finally { s.close(); }
});

test('security regression: deeply nested JSON below the byte limit is a client error and does not poison the retry key', async () => {
  const s = fixture();
  try {
    const owner = await login(s.app);
    const key = randomUUID();
    const body = '{"unknown":' + '['.repeat(12_000) + '0' + ']'.repeat(12_000) + '}';
    assert.ok(Buffer.byteLength(body) < 48 * 1024);
    const invalid = await owner.agent.post('/api/invoices').set('X-CSRF-Token', owner.csrf)
      .set('Idempotency-Key', key).set('Content-Type', 'application/json').send(body);
    assert.equal(invalid.status, 400, 'Invalid nesting must be rejected before recursive request fingerprinting overflows');
    const valid = await owner.agent.post('/api/invoices').set('X-CSRF-Token', owner.csrf)
      .set('Idempotency-Key', key).send(ownerInvoice).expect(201);
    assert.equal(valid.body.title, ownerInvoice.title);
    assert.equal((await owner.agent.get('/api/invoices')).body.invoices.length, 1);
  } finally { s.close(); }
});

test('security: development filesystem policy denies configured private paths, database sidecars and secret filenames', async () => {
  const previous = { DATA_DIR: process.env.DATA_DIR, PRIVATE_SCENARIO_PATH: process.env.PRIVATE_SCENARIO_PATH, SQUARE_SANDBOX_TOKEN_FILE: process.env.SQUARE_SANDBOX_TOKEN_FILE };
  const directory = mkdtempSync(join(tmpdir(), 'quiet-adversarial-fs-'));
  try {
    process.env.DATA_DIR = join(directory, 'synthetic-runtime');
    process.env.PRIVATE_SCENARIO_PATH = join(directory, 'synthetic-scenario.json');
    process.env.SQUARE_SANDBOX_TOKEN_FILE = join(directory, 'synthetic-square-file');
    const config = await resolveConfig({ configFile: resolve('vite.config.ts'), configLoader: 'native', envDir: false }, 'serve');
    assert.equal(searchForWorkspaceRoot(resolve('client')), resolve('.'));
    for (const path of [
      join(process.env.DATA_DIR, 'arbitrary.json'), process.env.PRIVATE_SCENARIO_PATH, process.env.SQUARE_SANDBOX_TOKEN_FILE,
      resolve('.runtime/arbitrary.json'), resolve('private-data/arbitrary.json'), resolve('ledger.sqlite'),
      resolve('ledger.sqlite-wal'), resolve('ledger.sqlite-shm'), resolve('snapshot.db'), resolve('.env.synthetic'),
      resolve('tests/fixtures/synthetic-owner-token'), resolve('tests/fixtures/synthetic-sandbox-token'),
    ]) assert.equal(isFileLoadingAllowed(config, path), false, `Vite allowed private path ${path}`);
    assert.equal(isFileLoadingAllowed(config, resolve('server/app.ts')), true, 'Sanity check: development source policy is active');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('security: real Vite filesystem middleware denies runtime and scenario canaries even through raw imports', async () => {
  const previous = { DATA_DIR: process.env.DATA_DIR, PRIVATE_SCENARIO_PATH: process.env.PRIVATE_SCENARIO_PATH, SQUARE_SANDBOX_TOKEN_FILE: process.env.SQUARE_SANDBOX_TOKEN_FILE };
  const directory = mkdtempSync(join(tmpdir(), 'quiet-adversarial-vite-'));
  let vite: ViteDevServer | undefined;
  try {
    const runtime = join(directory, 'synthetic-runtime');
    const scenario = join(directory, 'synthetic-scenario.json');
    const credential = join(directory, 'synthetic-credential');
    mkdirSync(runtime);
    writeFileSync(join(runtime, 'canary.txt'), privateCanary);
    writeFileSync(scenario, JSON.stringify({ title: privateCanary }));
    writeFileSync(credential, privateCanary);
    writeFileSync(join(directory, 'control.txt'), 'SYNTHETIC_PUBLIC_CONTROL');
    process.env.DATA_DIR = runtime;
    process.env.PRIVATE_SCENARIO_PATH = scenario;
    process.env.SQUARE_SANDBOX_TOKEN_FILE = credential;
    vite = await createServer({
      root: resolve('client'), configFile: resolve('vite.config.ts'), configLoader: 'native', envDir: false,
      cacheDir: join(directory, 'cache'), customLogger: createLogger('silent'),
      server: { middlewareMode: true, hmr: false, watch: null, fs: { allow: [resolve('.'), directory] } },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    const control = await request(vite.middlewares).get('/@fs' + join(directory, 'control.txt')).timeout(4_000).expect(200);
    assert.equal(control.text, 'SYNTHETIC_PUBLIC_CONTROL');
    for (const file of [join(runtime, 'canary.txt'), scenario, credential]) {
      for (const suffix of ['', '?raw', '?import', '?url']) {
        const response = await request(vite.middlewares).get('/@fs' + file + suffix).timeout(4_000);
        assert.ok(!response.text.includes(privateCanary));
        // Vite may answer a non-code ?import with a URL descriptor; following that URL must remain denied.
        if (response.status === 200) {
          assert.equal(suffix, '?import');
          assert.ok(response.text.startsWith('export default "'));
          const direct = await request(vite.middlewares).get('/@fs' + file).timeout(4_000);
          assert.ok([403, 404].includes(direct.status));
          assert.ok(!direct.text.includes(privateCanary));
        } else assert.ok([403, 404].includes(response.status), `Private filesystem route returned HTTP ${response.status}`);
      }
    }
  } finally {
    await vite?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
