import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app.js';

const ownerToken = 'owner-only-test-secret';
const invoiceInput = { customerName: 'Maple Studio', title: 'Design work', currency: 'CAD', items: [{ description: 'Design', quantity: 2, unitAmount: 12500 }], taxBps: 500 };

function setup(options: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'quiet-ledger-test-'));
  const dbPath = join(dir, 'ledger.sqlite');
  const app = createApp({ dbPath, ownerToken, ...options });
  return { app, dir, dbPath, cleanup() { app.locals.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function login(app: ReturnType<typeof createApp>, role: 'owner' | 'demo' = 'demo') {
  const agent = request.agent(app);
  const result = await agent.post(`/api/session/${role}`).send(role === 'owner' ? { token: ownerToken } : {}).expect(200);
  return { agent, csrf: result.body.csrfToken as string };
}

async function createInvoice(app: ReturnType<typeof createApp>, user: Awaited<ReturnType<typeof login>>, input = invoiceInput) {
  return (await user.agent.post('/api/invoices').set('X-CSRF-Token', user.csrf).set('Idempotency-Key',randomUUID()).send(input).expect(201)).body;
}

function pay(app: ReturnType<typeof createApp>, invoice: { token: string }, key: string, method = 'cashu') {
  return request(app).post(`/api/checkout/${invoice.token}/pay`).set('Idempotency-Key', key).send({ method });
}

test('requires authenticated session and validates CSRF and browser origin', async () => {
  const s = setup();
  try {
    await request(s.app).get('/api/dashboard').expect(401);
    await request(s.app).post('/api/session/demo').set('Origin', 'https://evil.example').send({}).expect(403);
    const user = await login(s.app);
    await user.agent.post('/api/invoices').send(invoiceInput).expect(403);
    await user.agent.post('/api/invoices').set('X-CSRF-Token', user.csrf).set('Origin', 'https://evil.example').send(invoiceInput).expect(403);
    await request(s.app).post('/api/session/owner').send({ token: 'wrong' }).expect(401);
  } finally { s.cleanup(); }
});

test('calculates integer invoice totals and rejects invalid amounts', async () => {
  const s = setup();
  try {
    const user = await login(s.app);
    const invoice = await createInvoice(s.app, user);
    assert.equal(invoice.subtotal, 25000);
    assert.equal(invoice.tax, 1250);
    assert.equal(invoice.total, 26250);
    assert.equal(invoice.totalCad, 26250);
    assert.equal(invoice.status, 'open');
    for (const unitAmount of [-1, 1.2, Number.MAX_SAFE_INTEGER]) {
      await user.agent.post('/api/invoices').set('X-CSRF-Token', user.csrf).set('Idempotency-Key',randomUUID()).send({ ...invoiceInput, items: [{ description: 'Invalid', quantity: 1, unitAmount }] }).expect(400);
    }
  } finally { s.cleanup(); }
});

test('keeps owner invoices and private scenario outside demo workspace and public checkout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quiet-scenario-test-'));
  const scenario = join(dir, 'scenario.json');
  writeFileSync(scenario, JSON.stringify({ title: 'Private owner plan', metrics: [{ label: 'Synthetic private balance', amount: 9876543 }] }));
  const s = setup({ privateScenarioPath: scenario });
  try {
    const owner = await login(s.app, 'owner');
    const invoice = await createInvoice(s.app, owner);
    const demo = await login(s.app);
    await demo.agent.get(`/api/invoices/${invoice.id}`).expect(404);
    await demo.agent.get('/api/scenario').expect(403);
    const privateResult = await owner.agent.get('/api/scenario').expect(200);
    assert.equal(privateResult.body.scenario.title, 'Private owner plan');
    const checkout = await request(s.app).get(`/api/checkout/${invoice.token}`).expect(200);
    assert.equal(checkout.body.invoice.id, undefined);
    assert.equal(checkout.body.invoice.token, undefined);
    assert.equal(JSON.stringify(checkout.body).includes('9876543'), false);
    const exported = await owner.agent.get('/api/evidence/export').expect(200);
    assert.equal(exported.text.includes('9876543'), false);
    assert.equal(exported.text.includes(ownerToken), false);
    assert.equal(exported.text.includes(owner.csrf), false);
  } finally { s.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('pays once, preserves one receipt on retry and rejects cross-invoice reuse', async () => {
  const s = setup();
  try {
    const user = await login(s.app);
    const invoice = await createInvoice(s.app, user);
    const a = await pay(s.app, invoice, 'pay-once-key').expect(200);
    const b = await pay(s.app, invoice, 'pay-once-key').expect(200);
    assert.equal(a.body.receiptToken, b.body.receiptToken);
    const c = await pay(s.app, invoice, 'different-retry-key').expect(200);
    assert.equal(c.body.receiptToken, a.body.receiptToken);
    const receipt = await request(s.app).get(`/api/receipts/${a.body.receiptToken}`).expect(200);
    assert.equal(receipt.body.receipt.amount, invoice.total);
    assert.equal(receipt.body.receipt.mode, 'simulation');
    const other = await createInvoice(s.app, user);
    await pay(s.app, other, 'pay-once-key').expect(409);
    const dashboard = await user.agent.get('/api/dashboard').expect(200);
    assert.equal(dashboard.body.invoices.filter((x: { id: string; status: string }) => x.id === invoice.id && x.status === 'paid').length, 1);
  } finally { s.cleanup(); }
});

test('reconciles payout approval once and distinguishes sent from received', async () => {
  const s = setup();
  try {
    const user = await login(s.app);
    const invoice = await createInvoice(s.app, user);
    await pay(s.app, invoice, 'pay-for-payout').expect(200);
    const quote = await user.agent.post('/api/payouts/quote').set('X-CSRF-Token', user.csrf).set('Idempotency-Key', 'quote-first').send({ invoiceId: invoice.id, provider: 'bullbitcoin', destinationType: 'bill', recipientLabel: 'Demo utility', amount: 10000 }).expect(201);
    const before = await user.agent.get('/api/dashboard');
    const approved = await user.agent.post(`/api/payouts/${quote.body.id}/approve`).set('X-CSRF-Token', user.csrf).set('Idempotency-Key', 'approval-first').send({}).expect(200);
    assert.equal(approved.body.status, 'funding_pending');
    await user.agent.post(`/api/payouts/${quote.body.id}/approve`).set('X-CSRF-Token', user.csrf).set('Idempotency-Key', 'approval-first').send({}).expect(200);
    const after = await user.agent.get('/api/dashboard');
    assert.equal(before.body.totals.availableCad - after.body.totals.availableCad, quote.body.totalDebit);
    for (const [step, status] of [['a', 'provider_processing'], ['b', 'provider_reported_paid'], ['c', 'received']]) {
      const result = await user.agent.post(`/api/payouts/${quote.body.id}/advance`).set('X-CSRF-Token', user.csrf).set('Idempotency-Key', `advance-${step}`).send({}).expect(200);
      assert.equal(result.body.status, status);
      const retry = await user.agent.post(`/api/payouts/${quote.body.id}/advance`).set('X-CSRF-Token', user.csrf).set('Idempotency-Key', `advance-${step}`).send({}).expect(200);
      assert.equal(retry.body.status, status);
    }
  } finally { s.cleanup(); }
});

test('rejects overspend and expired quotes; Wise rejects crypto and bill destinations', async () => {
  let current = new Date('2026-11-04T12:00:00Z');
  const s = setup({ now: () => current });
  try {
    const user = await login(s.app);
    const invoice = await createInvoice(s.app, user);
    await pay(s.app, invoice, 'pay-balance').expect(200);
    const input = { invoiceId: invoice.id, provider: 'bullbitcoin', destinationType: 'bank', recipientLabel: 'Demo bank', amount: 20000 };
    const quote = await user.agent.post('/api/payouts/quote').set('X-CSRF-Token', user.csrf).set('Idempotency-Key', 'overspend-quote').send(input).expect(201);
    const second = await user.agent.post('/api/payouts/quote').set('X-CSRF-Token', user.csrf).set('Idempotency-Key', 'second-quote').send(input).expect(201);
    await user.agent.post(`/api/payouts/${quote.body.id}/approve`).set('X-CSRF-Token', user.csrf).set('Idempotency-Key', 'reserve-first').send({}).expect(200);
    await user.agent.post(`/api/payouts/${second.body.id}/approve`).set('X-CSRF-Token', user.csrf).set('Idempotency-Key', 'reserve-second').send({}).expect(409);
    await user.agent.post('/api/payouts/quote').set('X-CSRF-Token', user.csrf).set('Idempotency-Key', 'wise-crypto').send({ ...input, provider: 'wise', amount: 100 }).expect(400);
    current = new Date('2026-11-04T12:10:00Z');
    await user.agent.post(`/api/payouts/${second.body.id}/approve`).set('X-CSRF-Token', user.csrf).set('Idempotency-Key', 'expired-quote').send({}).expect(409);
    const fiat = await createInvoice(s.app, user);
    await pay(s.app, fiat, 'fiat-pay', 'square').expect(200);
    await user.agent.post('/api/payouts/quote').set('X-CSRF-Token', user.csrf).set('Idempotency-Key', 'wise-bill').send({ ...input, invoiceId: fiat.id, provider: 'wise', destinationType: 'bill', amount: 100 }).expect(400);
  } finally { s.cleanup(); }
});

test('persists paid invoices, receipts and payout reservations across a restart', async () => {
  const s = setup();
  try {
    const owner = await login(s.app, 'owner');
    const invoice = await createInvoice(s.app, owner);
    const paid = await pay(s.app, invoice, 'persistent-payment').expect(200);
    const quote = await owner.agent.post('/api/payouts/quote').set('X-CSRF-Token', owner.csrf).set('Idempotency-Key', 'persistent-quote').send({ invoiceId: invoice.id, provider: 'bullbitcoin', destinationType: 'bank', recipientLabel: 'Fictional business bank', amount: 10000 }).expect(201);
    await owner.agent.post(`/api/payouts/${quote.body.id}/approve`).set('X-CSRF-Token', owner.csrf).set('Idempotency-Key', 'persistent-approval').send({}).expect(200);
    const before = await owner.agent.get('/api/dashboard').expect(200);
    s.app.locals.close();
    const reopened = createApp({ dbPath: s.dbPath, ownerToken });
    const user = await login(reopened, 'owner');
    const result = await user.agent.get(`/api/invoices/${invoice.id}`).expect(200);
    assert.equal(result.body.status, 'paid');
    await request(reopened).get(`/api/receipts/${paid.body.receiptToken}`).expect(200);
    const after = await user.agent.get('/api/dashboard').expect(200);
    assert.equal(after.body.totals.availableCad, before.body.totals.availableCad);
    assert.equal(after.body.payouts[0].status, 'funding_pending');
    const retry = await user.agent.post(`/api/payouts/${quote.body.id}/approve`).set('X-CSRF-Token', user.csrf).set('Idempotency-Key', 'persistent-approval').send({}).expect(200);
    assert.equal(retry.body.status, 'funding_pending');
    reopened.locals.close();
  } finally { s.cleanup(); }
});

test('invoice creation and website checkout preserve idempotency without leaking workspace records', async () => {
  const s = setup();
  try {
    const owner = await login(s.app, 'owner');
    const first = await owner.agent.post('/api/invoices').set('X-CSRF-Token', owner.csrf).set('Idempotency-Key', 'issued-invoice-key').send(invoiceInput).expect(201);
    const retry = await owner.agent.post('/api/invoices').set('X-CSRF-Token', owner.csrf).set('Idempotency-Key', 'issued-invoice-key').send(invoiceInput).expect(201);
    assert.equal(first.body.id, retry.body.id);
    await owner.agent.post('/api/invoices').set('X-CSRF-Token', owner.csrf).set('Idempotency-Key', 'issued-invoice-key').send({ ...invoiceInput, title: 'Changed obligation' }).expect(409);
    const sample = await owner.agent.post('/api/sample-checkout').set('X-CSRF-Token', owner.csrf).set('Idempotency-Key', 'website-order-key').send({}).expect(201);
    const sampleRetry = await owner.agent.post('/api/sample-checkout').set('X-CSRF-Token', owner.csrf).set('Idempotency-Key', 'website-order-key').send({}).expect(201);
    assert.equal(sample.body.id, sampleRetry.body.id);
    const dashboard = await owner.agent.get('/api/dashboard').expect(200);
    assert.equal(dashboard.body.invoices.length, 2);
    const demo = await login(s.app);
    const other = await demo.agent.get('/api/dashboard').expect(200);
    assert.equal(other.body.invoices.some((row: { id: string }) => row.id === sample.body.id), false);
    await demo.agent.get(`/api/invoices/${sample.body.id}`).expect(404);
  } finally { s.cleanup(); }
});

test('public payment refuses unsafe request and cannot change an already-paid method', async () => {
  const s = setup();
  try {
    const user = await login(s.app);
    const invoice = await createInvoice(s.app, user);
    await request(s.app).post(`/api/checkout/${invoice.token}/pay`).send({ method: 'cashu' }).expect(400);
    await request(s.app).post(`/api/checkout/${invoice.token}/pay`).set('Idempotency-Key', 'unsafe-site').set('Origin', 'https://evil.example').send({ method: 'cashu' }).expect(403);
    await pay(s.app, invoice, 'settled-method', 'cashu').expect(200);
    const after = await pay(s.app, invoice, 'later-method', 'square').expect(200);
    assert.equal(after.body.invoice.paymentMethod, 'cashu');
    assert.equal(after.body.alreadyPaid, true);
    await pay(s.app, invoice, 'settled-method', 'square').expect(409);
    await request(s.app).get('/api/scenario').expect(401);
  } finally { s.cleanup(); }
});

test('fails closed if simulation is disabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quiet-disabled-test-'));
  try { assert.throws(() => createApp({ dbPath: join(dir, 'ledger.sqlite'), ownerToken, simulationOnly: false }), /simulation/i); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
