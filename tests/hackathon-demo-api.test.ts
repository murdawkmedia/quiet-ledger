import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes, randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {Store} from '../server/store.js';
import {loadHostedRuntime} from '../server/hosted-runtime.js';

const origin = 'https://demo.example', secret = 'fictional-private-proxy-value-at-least-32-bytes', key = Buffer.alloc(32, 51);
const initialTime = new Date('2026-11-05T12:00:00.000Z');
const baseHeaders = {'x-quiet-ledger-proxy': secret, 'x-quiet-ledger-client-ip': '203.0.113.11', Origin: origin};
function setup(enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), 'quiet-ledger-fictional-demo-api-')), dbPath = join(dir, 'fictional.sqlite');
  let clock = initialTime;
  const app = createApp({dbPath, encryptionKey: key, hosted: {publicOrigin: origin, proxySecret: secret, hackathonDemo: enabled, limits: {requestsPerMinute: 1000}}, now: () => clock});
  const store = new Store(dbPath, {encryptionKey: key});
  const get = (path: string, headers: Record<string, string> = {}) => request(app).get(path).set({...baseHeaders, ...headers});
  const post = (path: string, body: object = {}, headers: Record<string, string> = {}) => request(app).post(path).set({...baseHeaders, ...headers}).send(body);
  async function login(client = '203.0.113.11') {
    const response = await post('/api/session/hackathon-demo', {password: 'marmot'}, {'x-quiet-ledger-client-ip': client});
    assert.equal(response.status, 200);
    const cookie = String(response.headers['set-cookie'][0]).split(';')[0];
    return {response, headers: {Cookie: cookie, 'X-CSRF-Token': response.body.csrfToken}};
  }
  return {app, store, dir, get, post, login, advance(ms: number) {clock = new Date(clock.getTime() + ms);}, close() {store.close(); app.locals.close(); rmSync(dir, {recursive: true, force: true});}};
}

test('hosted demo is opt-in and sign-in enforces trusted transport, origin, strict JSON and password', async () => {
  const disabled = setup(false);
  try {
    assert.equal((await disabled.get('/api/session')).body.demoAvailable, false);
    assert.equal((await disabled.get('/api/session')).body.marmotAvailable, true);
    assert.equal((await disabled.post('/api/session/hackathon-demo', {password: 'marmot'})).status, 404);
    assert.deepEqual((await disabled.get('/api/auth/config')).body.methods, ['passkey', 'nostr']);
  } finally {disabled.close();}
  const f = setup();
  try {
    assert.equal((await f.get('/api/session')).body.demoAvailable, true);
    assert.equal((await request(f.app).post('/api/session/hackathon-demo').send({password: 'marmot'})).status, 403);
    assert.equal((await f.post('/api/session/hackathon-demo', {password: 'marmot'}, {Origin: 'https://other.example'})).status, 403);
    assert.equal((await f.post('/api/session/hackathon-demo', {password: 'marmot'}, {'Sec-Fetch-Site': 'cross-site'})).status, 403);
    assert.equal((await f.post('/api/session/hackathon-demo', {password: 'wrong'})).status, 401);
    assert.equal((await f.post('/api/session/hackathon-demo', {password: 'marmot', workspace: 'owner'})).status, 400);
    assert.equal((await request(f.app).post('/api/session/hackathon-demo').set(baseHeaders).type('text').send('marmot')).status, 415);
    assert.equal((await f.post('/api/session/hackathon-demo', {password: 'marmot'}, {Authorization: 'Bearer fictional-untrusted-token-with-32-characters'})).status, 403);
    const a = await f.login();
    assert.equal(a.response.body.hackathonDemo, true);
    assert.equal(a.response.body.role, 'demo');
    assert.equal(a.response.body.privateScenarioAvailable, false);
    assert.match(String(a.response.headers['set-cookie'][0]), /HttpOnly/);
    assert.match(String(a.response.headers['set-cookie'][0]), /Secure/);
    assert.match(String(a.response.headers['set-cookie'][0]), /SameSite=Strict/);
    assert.match(String(a.response.headers['set-cookie'][0]), /Max-Age=7200/);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM auth_accounts').get()!.n, 0);
  } finally {f.close();}
});

test('demo view, simulation and public checkout stay isolated and expire together', async () => {
  const f = setup();
  try {
    assert.equal((await f.get('/api/hackathon-demo')).status, 401);
    const a = await f.login(), b = await f.login('203.0.113.12');
    const view = await f.get('/api/hackathon-demo', a.headers);
    assert.equal(view.status, 200);
    assert.equal(view.body.invoice.status, 'open');
    assert.equal((await f.get('/api/invoices/' + view.body.invoice.id, b.headers)).status, 404);
    const checkout = await f.get('/api/checkout/' + view.body.checkoutToken);
    assert.equal(checkout.status, 200);
    assert.equal(checkout.body.hackathonDemo, true);
    assert.equal(checkout.body.conversationAvailable, true);
    assert.deepEqual(checkout.body.adapters, []);
    assert.equal((await f.post('/api/hackathon-demo/simulate-payment', {}, {Cookie: a.headers.Cookie})).status, 403);
    assert.equal((await f.post('/api/hackathon-demo/simulate-payment', {}, {...a.headers, Origin: 'https://other.example'})).status, 403);
    const paid = await f.post('/api/hackathon-demo/simulate-payment', {}, a.headers);
    assert.equal(paid.status, 200);
    assert.equal(paid.body.invoice.settlementMode, 'simulation');
    assert.equal(paid.body.invoice.status, 'paid');
    assert.equal((await f.get('/api/receipts/' + paid.body.invoice.receiptToken)).body.receipt.mode, 'simulation');
    assert.equal((await f.get('/api/hackathon-demo', b.headers)).body.invoice.status, 'open');
    for (const suffix of ['/pay', '/receiving']) assert.equal((await f.post('/api/checkout/' + view.body.checkoutToken + suffix, {method: 'cashu', adapterId: 'owner-confirmed-manual'}, {'Idempotency-Key': randomUUID()})).status, 403);
    f.advance(2 * 60 * 60 * 1000);
    assert.equal((await f.get('/api/session', a.headers)).body.authenticated, false);
    assert.equal((await f.get('/api/hackathon-demo', a.headers)).status, 401);
    assert.equal((await f.get('/api/checkout/' + view.body.checkoutToken)).status, 404);
    assert.equal((await f.get('/api/receipts/' + paid.body.invoice.receiptToken)).status, 404);
  } finally {f.close();}
});

test('demo sessions cannot mutate financial records, providers, API keys or account credentials', async () => {
  const f = setup();
  try {
    const a = await f.login();
    const paths = ['/api/invoices', '/api/sample-checkout', '/api/payouts/quote', '/api/payouts/fictional/approve', '/api/payment-reports/fictional/confirm', '/api/receiving', '/api/account/connections', '/api/account/api-keys', '/api/auth/nostr/challenge', '/api/auth/passkey/options'];
    for (const path of paths) assert.equal((await f.post(path, {}, {...a.headers, 'Idempotency-Key': randomUUID()})).status, 403, path);
    for (const path of ['/api/auth/account', '/api/account/connections', '/api/account/api-keys', '/api/receiving', '/api/collateral', '/api/ark']) assert.equal((await f.get(path, a.headers)).status, 403, path);
    assert.equal((await f.get('/api/scenario', a.headers)).status, 404);
    assert.equal((await f.get('/api/payment-methods', a.headers)).body.adapters.length, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM invoices').get()!.n, 1);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM idempotency').get()!.n, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM auth_credentials').get()!.n, 0);
    assert.equal((await request(f.app).delete('/api/session').set({...baseHeaders, ...a.headers})).status, 200);
    assert.equal((await f.get('/api/session', a.headers)).body.authenticated, false);
  } finally {f.close();}
});

test('runtime feature flag is false by default and enabled only by the explicit true setting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quiet-ledger-fictional-demo-runtime-'));
  try {
    const storage = join(dir, 'storage'), proxy = join(dir, 'proxy');
    writeFileSync(storage, key.toString('base64url'), {mode: 0o600});
    writeFileSync(proxy, secret, {mode: 0o600});
    const env = {HOSTED_ACCOUNTS: 'true', PUBLIC_ORIGIN: origin, STORAGE_KEY_FILE: storage, PROXY_SHARED_SECRET_FILE: proxy};
    assert.equal(loadHostedRuntime(env)!.hosted.hackathonDemo, false);
    assert.equal(loadHostedRuntime({...env, HACKATHON_DEMO_ENABLED: 'true'})!.hosted.hackathonDemo, true);
    assert.equal(loadHostedRuntime({...env, HACKATHON_DEMO_ENABLED: 'false'})!.hosted.hackathonDemo, false);
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test('forged demo membership and owner-role upgrades are not accepted as hosted sessions', async () => {
  const f = setup();
  try {
    const a = await f.login();
    const original = f.store.session(a.headers.Cookie.slice('ql_session='.length))!;
    for (const [index, changed] of [{...original, role: 'owner' as const}, {...original, hackathonDemo: false}, {...original, accountId: randomUUID()}, {...original, workspace: randomUUID()}].entries()) {
      const value = randomBytes(32).toString('base64url');
      f.store.saveSession(value, changed);
      assert.equal((await f.get('/api/session', {Cookie: 'ql_session=' + value})).body.authenticated, false, String(index));
    }
    assert.equal((await f.get('/api/session', a.headers)).body.authenticated, true);
    for (const suffix of ['', '/events', '/query']) assert.equal((await f.post('/api/invoices/fictional/conversation' + suffix, {}, a.headers)).status, 404);
    for (const suffix of ['/delete', '/events/delete', '/query/extra']) assert.equal((await f.post('/api/invoices/fictional/conversation' + suffix, {}, a.headers)).status, 403);
  } finally {f.close();}
});

test('demo sign-in rotates its session and demo activity preserves existing real workspace bytes', async () => {
  const f = setup();
  try {
    const realToken = randomBytes(32).toString('base64url'), realWorkspace = randomUUID(), csrf = randomUUID();
    f.store.saveSession(realToken, {role: 'owner', workspace: realWorkspace, accountId: randomUUID(), csrf, expires: '2026-11-06T12:00:00.000Z'});
    const headers = {Cookie: 'ql_session=' + realToken, 'X-CSRF-Token': csrf};
    const realInvoice = await f.post('/api/invoices', {customerName: 'Unrelated fictional business', title: 'Keep this existing record', currency: 'CAD', items: [{description: 'Synthetic work', quantity: 1, unitAmount: 100}]}, {...headers, 'Idempotency-Key': randomUUID()});
    assert.equal(realInvoice.status, 201);
    const original = JSON.stringify(f.store.db.prepare('SELECT * FROM invoices WHERE workspace=?').all(realWorkspace));
    const a = await f.login();
    const fresh = await f.post('/api/session/hackathon-demo', {password: 'marmot'}, a.headers);
    assert.equal(fresh.status, 200);
    assert.equal((await f.get('/api/session', a.headers)).body.authenticated, false);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 2);
    assert.equal((await f.post('/api/checkout/' + realInvoice.body.token + '/pay', {method: 'cashu'}, {...a.headers, Cookie: String(fresh.headers['set-cookie'][0]).split(';')[0], 'Idempotency-Key': randomUUID()})).status, 403);
    const view = await f.get('/api/checkout/' + realInvoice.body.token);
    assert.equal(view.status, 200);
    assert.ok(!view.body.hackathonDemo);
    assert.ok(view.body.adapters.length > 0);
    assert.equal(view.body.conversationAvailable, true);
    assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM invoices WHERE workspace=?').all(realWorkspace)), original);
    assert.equal((await f.get('/api/invoices/' + realInvoice.body.id, headers)).body.status, 'open');
  } finally {f.close();}
});

test('turning the feature off preserves demo data while disabling its sessions and public links', async () => {
  const f = setup();
  let disabled: ReturnType<typeof createApp> | undefined;
  try {
    const a = await f.login();
    const view = (await f.get('/api/hackathon-demo', a.headers)).body;
    disabled = createApp({dbPath: join(f.dir, 'fictional.sqlite'), encryptionKey: key, hosted: {publicOrigin: origin, proxySecret: secret}, now: () => initialTime});
    assert.equal((await request(disabled).get('/api/session').set({...baseHeaders, ...a.headers})).body.authenticated, false);
    assert.equal((await request(disabled).get('/api/session').set(baseHeaders)).body.demoAvailable, false);
    assert.equal((await request(disabled).get('/api/checkout/' + view.checkoutToken).set(baseHeaders)).status, 404);
    assert.equal((await request(disabled).post('/api/checkout/' + view.checkoutToken + '/pay').set(baseHeaders).send({method: 'cashu'})).status, 403);
    assert.equal(f.store.getInvoice(view.invoice.id)?.status, 'open');
  } finally {disabled?.locals.close(); f.close();}
});

test('password rate limits use the trusted client identity and ignore forwarding-looking headers', async () => {
  const f = setup();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await f.post('/api/session/hackathon-demo', {password: 'wrong'})).status, 401);
    assert.equal((await f.post('/api/session/hackathon-demo', {password: 'marmot'}, {'X-Forwarded-For': '203.0.113.55'})).status, 429);
    assert.equal((await f.post('/api/session/hackathon-demo', {password: 'marmot'}, {'x-quiet-ledger-client-ip': '203.0.113.12'})).status, 200);
    f.advance(10 * 60 * 1000);
    assert.equal((await f.post('/api/session/hackathon-demo', {password: 'marmot'})).status, 200);
  } finally {f.close();}
});

test('local demo behavior remains available independently from the hosted hackathon feature', async () => {
  const app = createApp({dbPath: ':memory:', ownerToken: 'fictional-local-owner-token'});
  try {
    const login = await request(app).post('/api/session/demo').send({});
    assert.equal(login.status, 200);
    assert.equal(login.body.role, 'demo');
    assert.equal(login.body.authMode, 'local');
    assert.equal(login.body.demoAvailable, false);
    assert.ok(!login.body.hackathonDemo);
    assert.equal(login.body.marmotAvailable, undefined);
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    assert.equal((await request(app).get('/api/invoices').set('Cookie', cookie)).body.invoices.length, 4);
    assert.equal((await request(app).get('/api/hackathon-demo').set('Cookie', cookie)).status, 403);
  } finally {app.locals.close();}
});
