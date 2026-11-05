import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import request from 'supertest';
import { createApp } from '../server/app.js';
import type { Invoice, Payout } from '../shared/contracts.js';

const ownerToken = 'adversarial-ledger-fictional-owner-token';
const fixedTime = new Date('2026-11-04T12:00:00Z');
const invoiceInput = {
  customerName: 'Fictional ledger customer', title: 'Synthetic financial invariant', currency: 'CAD',
  items: [{ description: 'Fictional service', quantity: 1, unitAmount: 10_000 }], taxBps: 0,
};

function setup(now: () => Date = () => fixedTime) {
  const dir = mkdtempSync(join(tmpdir(), 'quiet-ledger-adversarial-'));
  const dbPath = join(dir, 'ledger.sqlite');
  const apps: ReturnType<typeof createApp>[] = [];
  const open = () => {
    const app = createApp({ dbPath, ownerToken, now });
    apps.push(app);
    return app;
  };
  const app = open();
  return { app, dbPath, open, cleanup() { for (const current of apps) current.locals.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function login(app: ReturnType<typeof createApp>, role: 'owner' | 'demo' = 'owner') {
  const agent = request.agent(app);
  const session = await agent.post(`/api/session/${role}`).send(role === 'owner' ? { token: ownerToken } : {}).expect(200);
  return { agent, csrf: session.body.csrfToken as string };
}
type User = Awaited<ReturnType<typeof login>>;
function post(user: User, path: string, key: string = randomUUID(), body: unknown = {}) {
  return user.agent.post(path).set('X-CSRF-Token', user.csrf).set('Idempotency-Key', key).send(body as object);
}
async function issue(user: User, unitAmount = 10_000): Promise<Invoice> {
  return (await post(user, '/api/invoices', randomUUID(), { ...invoiceInput, items: [{ ...invoiceInput.items[0], unitAmount }] }).expect(201)).body;
}
function pay(app: ReturnType<typeof createApp>, invoice: Invoice, key: string = randomUUID(), method = 'cashu') {
  return request(app).post(`/api/checkout/${invoice.token}/pay`).set('Idempotency-Key', key).send({ method });
}
function quoteInput(invoice: Invoice, amount: number) {
  return { invoiceId: invoice.id, provider: 'bullbitcoin', destinationType: 'bank', recipientLabel: 'Fictional destination', amount };
}
async function quote(user: User, invoice: Invoice, amount: number): Promise<Payout> {
  return (await post(user, '/api/payouts/quote', randomUUID(), quoteInput(invoice, amount)).expect(201)).body;
}

test('evidence export retains the complete ledger audit history beyond the dashboard window', async () => {
  const s = setup();
  try {
    const owner = await login(s.app);
    const first = await issue(owner, 1);
    for (let index = 1; index < 205; index++) await issue(owner, 1);
    const result = await owner.agent.get('/api/evidence/export').expect(200);
    assert.equal(result.body.invoices.length, 205);
    assert.equal(result.body.activity.length, 205, 'A complete financial evidence export must retain every audit event, including events older than the dashboard window.');
    assert.equal(new Set(result.body.activity.map((event: { id: string }) => event.id)).size, 205);
    assert.ok(result.body.activity.some((event: { description: string }) => event.description.startsWith(`${first.number} issued`)));
    assert.equal((await owner.agent.get('/api/dashboard').expect(200)).body.activity.length, 200);
  } finally { s.cleanup(); }
});

test('invoice rounding and supported limits match an independent integer oracle without partial writes', async () => {
  const s = setup();
  try {
    const owner = await login(s.app);
    const examples = [
      { currency: 'CAD', quantity: 1, unitAmount: 1, taxBps: 4999 },
      { currency: 'CAD', quantity: 1, unitAmount: 1, taxBps: 5000 },
      { currency: 'CAD', quantity: 3, unitAmount: 3, taxBps: 5000 },
      { currency: 'USD', quantity: 1, unitAmount: 1, taxBps: 0 },
      { currency: 'USD', quantity: 1, unitAmount: 2, taxBps: 0 },
      { currency: 'USD', quantity: 1, unitAmount: 714285714, taxBps: 0 },
      { currency: 'CAD', quantity: 10000, unitAmount: 50000, taxBps: 10000 },
      { currency: 'CAD', quantity: 1, unitAmount: 1000000000, taxBps: 0 },
    ];
    for (const example of examples) {
      const subtotal = BigInt(example.quantity) * BigInt(example.unitAmount);
      const tax = (subtotal * BigInt(example.taxBps) + 5000n) / 10000n;
      const total = subtotal + tax;
      const cad = example.currency === 'USD' ? (total * 14n + 5n) / 10n : total;
      const input = { ...invoiceInput, currency: example.currency, taxBps: example.taxBps, items: [{ ...invoiceInput.items[0], quantity: example.quantity, unitAmount: example.unitAmount }] };
      const result = await post(owner, '/api/invoices', randomUUID(), input).expect(201);
      assert.deepEqual([result.body.subtotal, result.body.tax, result.body.total, result.body.totalCad, result.body.amountSats], [Number(subtotal), Number(tax), Number(total), Number(cad), Number(cad * 10n)]);
    }
    const before = (await owner.agent.get('/api/evidence/export').expect(200)).body;
    const unsupported = [
      { currency: 'USD', unitAmount: 714285715, quantity: 1, taxBps: 0 },
      { currency: 'CAD', unitAmount: 1000000000, quantity: 10000, taxBps: 10000 },
      { currency: 'CAD', unitAmount: 0, quantity: 1, taxBps: 0 },
      { currency: 'CAD', unitAmount: 1, quantity: 1.5, taxBps: 0 },
      { currency: 'CAD', unitAmount: Number.MAX_SAFE_INTEGER, quantity: 1, taxBps: 0 },
    ];
    for (const example of unsupported) {
      const input = { ...invoiceInput, currency: example.currency, taxBps: example.taxBps, items: [{ ...invoiceInput.items[0], quantity: example.quantity, unitAmount: example.unitAmount }] };
      await post(owner, '/api/invoices', randomUUID(), input).expect(400);
    }
    const after = (await owner.agent.get('/api/evidence/export').expect(200)).body;
    assert.deepEqual(after.invoices, before.invoices);
    assert.deepEqual(after.activity, before.activity);
    assert.deepEqual(after.payments, []);
  } finally { s.cleanup(); }
});

test('failed financial requests leave their retry keys usable after the prerequisite is corrected', async () => {
  const s = setup();
  try {
    const owner = await login(s.app);
    const invoice = await issue(owner, 1055);
    const body = quoteInput(invoice, 1000);
    await post(owner, '/api/payouts/quote', 'retry-after-payment', body).expect(409);
    const payment = await pay(s.app, invoice, 'once-after-failed-quote').expect(200);
    const result = await post(owner, '/api/payouts/quote', 'retry-after-payment', body).expect(201);
    assert.equal(result.body.totalDebit, 1055);
    const unpaid = await issue(owner, 1055);
    const second = await pay(s.app, unpaid, 'once-after-failed-quote').expect(409);
    assert.match(second.body.error, /different request/i);
    assert.equal((await owner.agent.get(`/api/invoices/${unpaid.id}`).expect(200)).body.status, 'open');
    assert.equal((await request(s.app).get(`/api/receipts/${payment.body.receiptToken}`).expect(200)).body.receipt.amount, 1055);
    const after = (await owner.agent.get('/api/evidence/export').expect(200)).body;
    assert.equal(after.payments.length, 1);
    assert.equal(after.payouts.length, 1);
  } finally { s.cleanup(); }
});

test('fee boundaries consume exact balances and every settled payout state keeps the reservation', async () => {
  let current = fixedTime;
  const s = setup(() => current);
  try {
    const owner = await login(s.app);
    for (const amount of [1, 199, 200, 201, 999, 1000, 1001]) {
      const fee = 50 + Number((BigInt(amount) + 199n) / 200n);
      const invoice = await issue(owner, amount + fee);
      await pay(s.app, invoice).expect(200);
      const first = await quote(owner, invoice, amount);
      const competing = await quote(owner, invoice, amount);
      assert.deepEqual([first.fee, first.totalDebit, first.netAmount], [fee, amount + fee, amount]);
      const before = (await owner.agent.get('/api/dashboard').expect(200)).body.totals;
      await post(owner, `/api/payouts/${first.id}/approve`).expect(200);
      const reserved = (await owner.agent.get('/api/dashboard').expect(200)).body.totals;
      assert.equal(before.availableCad - reserved.availableCad, amount + fee);
      await post(owner, `/api/payouts/${competing.id}/approve`).expect(409);
      for (const status of ['provider_processing', 'provider_reported_paid', 'received', 'received']) {
        const transition = await post(owner, `/api/payouts/${first.id}/advance`).expect(200);
        assert.equal(transition.body.status, status);
        assert.deepEqual((await owner.agent.get('/api/dashboard').expect(200)).body.totals, reserved);
      }
      await post(owner, '/api/payouts/quote', randomUUID(), quoteInput(invoice, 1)).expect(409);
      current = new Date(current.getTime() + 6 * 60_000);
      assert.equal((await post(owner, `/api/payouts/${first.id}/approve`).expect(200)).body.status, 'received');
    }
    const totals = (await owner.agent.get('/api/dashboard').expect(200)).body.totals;
    assert.equal(totals.availableCad, 0);
    assert.equal(totals.receivedCad, totals.spentCad);
  } finally { s.cleanup(); }
});

test('a quote expires at its exact deadline and failed approval leaves no reservation', async () => {
  let current = fixedTime;
  const s = setup(() => current);
  try {
    const owner = await login(s.app);
    const invoice = await issue(owner, 1055);
    await pay(s.app, invoice).expect(200);
    const expired = await quote(owner, invoice, 1000);
    await post(owner, `/api/payouts/${expired.id}/advance`, 'advance-unapproved').expect(409);
    current = new Date(expired.expiresAt);
    await post(owner, `/api/payouts/${expired.id}/approve`, 'expired-approval').expect(409);
    assert.equal((await owner.agent.get('/api/dashboard').expect(200)).body.totals.availableCad, 1055);
    const fresh = await quote(owner, invoice, 1000);
    await post(owner, `/api/payouts/${fresh.id}/approve`, 'expired-approval').expect(200);
    const all = (await owner.agent.get('/api/payouts').expect(200)).body.payouts;
    assert.equal(all.find((payout: Payout) => payout.id === expired.id).status, 'quoted');
    assert.equal(all.find((payout: Payout) => payout.id === fresh.id).status, 'funding_pending');
    assert.equal((await owner.agent.get('/api/dashboard').expect(200)).body.totals.availableCad, 0);
  } finally { s.cleanup(); }
});

test('restart and out-of-order retries preserve exact original responses without rewinding financial state', async () => {
  const s = setup();
  try {
    const owner = await login(s.app);
    const originalInvoice = await post(owner, '/api/invoices', 'persistent-invoice', invoiceInput).expect(201);
    const invoice: Invoice = originalInvoice.body;
    const originalPayment = await pay(s.app, invoice, 'persistent-payment').expect(200);
    const originalQuote = await post(owner, '/api/payouts/quote', 'persistent-quote', quoteInput(invoice, 1000)).expect(201);
    const path = `/api/payouts/${originalQuote.body.id}`;
    const originalApproval = await post(owner, `${path}/approve`, 'persistent-approval').expect(200);
    const firstAdvance = await post(owner, `${path}/advance`, 'persistent-advance-1').expect(200);
    await post(owner, `${path}/advance`, 'persistent-advance-2').expect(200);
    await post(owner, `${path}/advance`, 'persistent-advance-3').expect(200);
    const before = (await owner.agent.get('/api/evidence/export').expect(200)).body;
    s.app.locals.close();
    const reopened = s.open();
    const user = await login(reopened);
    assert.deepEqual((await post(user, '/api/invoices', 'persistent-invoice', invoiceInput).expect(201)).body, originalInvoice.body);
    assert.deepEqual((await pay(reopened, invoice, 'persistent-payment').expect(200)).body, originalPayment.body);
    assert.deepEqual((await post(user, '/api/payouts/quote', 'persistent-quote', quoteInput(invoice, 1000)).expect(201)).body, originalQuote.body);
    assert.deepEqual((await post(user, `${path}/approve`, 'persistent-approval').expect(200)).body, originalApproval.body);
    assert.deepEqual((await post(user, `${path}/advance`, 'persistent-advance-1').expect(200)).body, firstAdvance.body);
    await post(user, '/api/invoices', 'persistent-invoice', { ...invoiceInput, currency: 'USD' }).expect(409);
    await pay(reopened, invoice, 'persistent-payment', 'square').expect(409);
    await post(user, '/api/payouts/quote', 'persistent-quote', quoteInput(invoice, 1001)).expect(409);
    const after = (await user.agent.get('/api/evidence/export').expect(200)).body;
    assert.deepEqual(after, before);
    assert.equal((await user.agent.get(`/api/invoices/${invoice.id}`).expect(200)).body.status, 'paid');
    assert.equal(after.payouts[0].status, 'received');
    assert.equal(after.payments.length, 1);
    assert.equal(after.activity.filter((event: { action: string }) => event.action === 'payment.received').length, 1);
  } finally { s.cleanup(); }
});

test('idempotency is insensitive to JSON key order while conflicts cannot mutate the ledger', async () => {
  const s = setup();
  try {
    const owner = await login(s.app);
    const original = await post(owner, '/api/invoices', 'canonical-invoice', invoiceInput).expect(201);
    const reordered = { taxBps: 0, items: [{ unitAmount: 10000, quantity: 1, description: 'Fictional service' }], currency: 'CAD', title: invoiceInput.title, customerName: invoiceInput.customerName };
    assert.deepEqual((await post(owner, '/api/invoices', 'canonical-invoice', reordered).expect(201)).body, original.body);
    const before = (await owner.agent.get('/api/evidence/export').expect(200)).body;
    for (const key of ['', 'not a valid key', 'x'.repeat(129)]) await post(owner, '/api/invoices', key, invoiceInput).expect(400);
    for (const changed of [{ ...invoiceInput, taxBps: 1 }, { ...invoiceInput, title: 'Conflicting obligation' }, { ...invoiceInput, items: [{ ...invoiceInput.items[0], quantity: 2 }] }]) {
      await post(owner, '/api/invoices', 'canonical-invoice', changed).expect(409);
    }
    assert.deepEqual((await owner.agent.get('/api/evidence/export').expect(200)).body, before);
  } finally { s.cleanup(); }
});

interface CompetingRequest { path: string; key: string; body: unknown; public?: boolean }
async function compete(dbPath: string, requests: CompetingRequest[]) {
  const source = `
    import {once} from 'node:events';
    process.send({booted:true});
    const [workerData]=await once(process,'message');
    try {
      const {createApp}=await import(workerData.appPath);
      const request=(await import('supertest')).default;
      const app=createApp({dbPath:workerData.dbPath,ownerToken:workerData.ownerToken,now:()=>new Date(workerData.now)});
      let outcome;
      try {
        const user=request.agent(app);
        const session=await user.post('/api/session/owner').send({token:workerData.ownerToken});
        if(session.status!==200)throw new Error('Synthetic process owner login failed');
        process.send({ready:true});
        await once(process,'message');
        const spec=workerData.request;
        let pending=(spec.public?request(app):user).post(spec.path).set('Idempotency-Key',spec.key);
        if(!spec.public)pending=pending.set('X-CSRF-Token',session.body.csrfToken);
        const result=await pending.send(spec.body);
        outcome={done:true,status:result.status,body:result.body};
      } finally {app.locals.close();}
      process.send({closed:true});
      process.send(outcome);
    }catch(error){process.send({failure:error.message});process.exitCode=1;}
    finally {process.disconnect();}
  `;
  const workers:ChildProcess[]=[];
  const readiness: Promise<void>[] = [];
  const exits:Promise<void>[]=[];
  const results: Promise<{ status: number; body: any }>[] = [];
  for (const spec of requests) {
    const worker=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source],{cwd:process.cwd(),env:{PATH:process.env.PATH,NODE_NO_WARNINGS:'1'},stdio:['ignore','ignore','pipe','ipc']});
    workers.push(worker);
    let ready!: () => void;
    let failedReady!: (error: Error) => void;
    let finish!: (value: { status: number; body: any }) => void;
    let failedResult!: (error: Error) => void;
    readiness.push(new Promise<void>((resolve, reject) => { ready = resolve; failedReady = reject; }));
    results.push(new Promise((resolve, reject) => { finish = resolve; failedResult = reject; }));
    const fail = (error: Error) => { failedReady(error); failedResult(error); };
    let storageClosed=false;
    worker.on('message', (message:any) => {
      if(message.booted)worker.send!({dbPath,ownerToken,now:fixedTime.toISOString(),request:spec,appPath:new URL('../server/app.ts',import.meta.url).href});
      if(message.closed)storageClosed=true;
      if(message.done&&!storageClosed)return fail(new Error('Synthetic worker reported completion before closing SQLite.'));
      if (message.failure) fail(new Error(message.failure));
      if (message.ready) ready();
      if (message.done) finish({ status: message.status, body: message.body });
    });
    worker.on('error', fail);
    const exited=new Promise<void>((resolve,reject)=>worker.once('exit',code=>{if(code!==0){const error=new Error(`Synthetic worker exited ${code}`);fail(error);reject(error);}else resolve();}));
    void exited.catch(()=>{});exits.push(exited);
  }
  const completion = Promise.all(results);
  // Attach a handler before startup completes so worker startup failures cannot become unhandled rejections.
  void completion.catch(() => {});
  try {
    await Promise.all(readiness);
    for (const worker of workers) worker.send!('start');
    const result=await completion;
    await Promise.all(exits);
    return result;
  } finally { await Promise.all(workers.filter(worker=>worker.exitCode===null&&worker.signalCode===null).map(worker=>new Promise<void>(resolve=>{worker.once('exit',()=>resolve());worker.kill('SIGTERM');}))); }
}

test('independent SQLite connections cannot double-spend competing payout approvals', { timeout: 30000 }, async () => {
  const s = setup();
  try {
    const owner = await login(s.app);
    const invoice = await issue(owner, 1055);
    await pay(s.app, invoice).expect(200);
    const quotes = await Promise.all([quote(owner, invoice, 1000), quote(owner, invoice, 1000)]);
    const attempts = await compete(s.dbPath, quotes.map((payout, index) => ({ path: `/api/payouts/${payout.id}/approve`, key: `competing-approval-${index}`, body: {} })));
    assert.deepEqual(attempts.map(result => result.status).sort(), [200, 409]);
    const dashboard = (await owner.agent.get('/api/dashboard').expect(200)).body;
    assert.equal(dashboard.totals.availableCad, 0);
    assert.equal(dashboard.totals.spentCad, 1055);
    assert.equal(dashboard.payouts.filter((payout: Payout) => payout.status === 'funding_pending').length, 1);
    assert.equal(dashboard.activity.filter((event: { action: string }) => event.action === 'payout.authorized').length, 1);
  } finally { s.cleanup(); }
});

test('independent connections settle an invoice once and bind a reused payment key to only one invoice', { timeout: 30000 }, async () => {
  const s = setup();
  try {
    const owner = await login(s.app);
    const invoice = await issue(owner);
    const attempts = await compete(s.dbPath, [0, 1, 2].map(index => ({ path: `/api/checkout/${invoice.token}/pay`, key: `competing-payment-${index}`, body: { method: 'cashu' }, public: true })));
    assert.deepEqual(attempts.map(result => result.status), [200, 200, 200]);
    assert.equal(new Set(attempts.map(result => result.body.receiptToken)).size, 1);
    assert.equal(attempts.filter(result => result.body.alreadyPaid === false).length, 1);
    const next = await issue(owner);
    const other = await issue(owner);
    const conflict = await compete(s.dbPath, [next, other].map(row => ({ path: `/api/checkout/${row.token}/pay`, key: 'same-payment-identifier', body: { method: 'cashu' }, public: true })));
    assert.deepEqual(conflict.map(result => result.status).sort(), [200, 409]);
    const exported = (await owner.agent.get('/api/evidence/export').expect(200)).body;
    assert.equal(exported.payments.length, 2);
    assert.equal(exported.activity.filter((event: { action: string }) => event.action === 'payment.received').length, 2);
  } finally { s.cleanup(); }
});
