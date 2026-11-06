import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {createApp} from '../server/app.js';
import {createInvoice, publicInvoice} from '../server/domain.js';
import {Store, DomainError} from '../server/store.js';
import {InvoiceTemplates} from '../server/invoice-templates.js';
import {HackathonDemo} from '../server/hackathon-demo.js';
import {DemoAgentAdmission} from '../server/demo-agent-admission.js';
import {currencyScale, formatInvoiceAmount, invoiceAllowsMethod, invoiceRequiresManualReport, parseInvoiceAmount} from '../shared/invoice-options.js';
import type {Currency} from '../shared/contracts.js';
import type {DemoCase} from '../shared/demo-agents.js';

const draft = {
  customerName: 'Fictional soak client', title: 'Fictional workshop recording', currency: 'CAD',
  items: [{description: 'Fictional recording service', quantity: 1, unitAmount: 10001}], taxBps: 500,
};

const now = new Date('2026-11-05T12:00:00.000Z');
const status = (expected: number) => (error: unknown) => error instanceof DomainError && error.status === expected;

test('explicit manual-bank allowlist requires merchant confirmation for the legacy transfer alias', async () => {
  const app = createApp({dbPath: ':memory:', ownerToken: 'fictional-soak-owner'});
  try {
    const merchant = request.agent(app);
    const login = await merchant.post('/api/session/owner').send({token: 'fictional-soak-owner'});
    const headers = {'X-CSRF-Token': login.body.csrfToken};
    const created = await merchant.post('/api/invoices').set(headers).set('Idempotency-Key', 'fictional-bank-alias')
      .send({...draft, acceptedMethods: ['bank']});
    assert.equal(created.status, 201);
    const claim = await request(app).post(`/api/checkout/${created.body.token}/pay`)
      .set('Idempotency-Key', 'fictional-bank-claim').send({method: 'bank_transfer'});
    assert.equal(claim.status, 200);
    assert.equal(claim.body.invoice.status, 'open');
    assert.equal(claim.body.report.status, 'reported');
    assert.equal(claim.body.receiptToken, undefined);
    const confirmed = await merchant.post(`/api/payment-reports/${claim.body.report.id}/confirm`)
      .set(headers).set('Idempotency-Key', 'fictional-bank-confirm').send({});
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.invoice.status, 'paid');
    assert.equal(confirmed.body.invoice.paymentMethod, 'bank_transfer');
  } finally {app.locals.close();}
});

test('unrestricted and explicit legacy bank-transfer invoices retain automatic simulation', async () => {
  const app = createApp({dbPath: ':memory:', ownerToken: 'fictional-soak-owner'});
  try {
    const merchant = request.agent(app);
    const login = await merchant.post('/api/session/owner').send({token: 'fictional-soak-owner'});
    for (const [index, extra] of [{}, {acceptedMethods: ['bank_transfer']}].entries()) {
      const created = await merchant.post('/api/invoices').set('X-CSRF-Token', login.body.csrfToken)
        .set('Idempotency-Key', `fictional-legacy-${index}`).send({...draft, ...extra});
      assert.equal(created.status, 201);
      const paid = await request(app).post(`/api/checkout/${created.body.token}/pay`)
        .set('Idempotency-Key', `fictional-legacy-pay-${index}`).send({method: 'bank_transfer'});
      assert.equal(paid.status, 200);
      assert.equal(paid.body.invoice.status, 'paid');
      const receipt = await request(app).get(`/api/receipts/${paid.body.receiptToken}`);
      assert.equal(receipt.status, 200);
      assert.equal(receipt.body.receipt.mode, 'simulation');
    }
  } finally {app.locals.close();}
});

test('all invoice currencies retain exact multi-line adjustments, tax and public terms', () => {
  const store = new Store(':memory:');
  try {
    for (const [currency, expectedCad] of [['CAD', 10348], ['USD', 14487], ['EUR', 15522], ['GBP', 18626], ['KRW', 1035]] as const) {
      const invoice = createInvoice(store, 'fictional-adjustments', {
        ...draft, currency, items: [{description: 'Three fictional sessions', quantity: 3, unitAmount: 3333}, {description: 'Two fictional units', quantity: 2, unitAmount: 1}],
        taxBps: 750, discountBps: 500, premiumBps: 125,
        issueDate: '2028-02-29', dueDate: '2028-03-01', acceptedMethods: ['card', 'bank'],
      }, now);
      assert.deepEqual([invoice.subtotal, invoice.discountAmount, invoice.premiumAmount, invoice.tax, invoice.total], [10001, 500, 125, 722, 10348]);
      assert.equal(invoice.totalCad, expectedCad);
      assert.equal(invoice.amountSats, expectedCad * 10);
      const published = publicInvoice(invoice);
      assert.equal(published.currency, currency);
      assert.deepEqual(published.acceptedMethods, ['card', 'bank']);
      assert.equal(published.issueDate, '2028-02-29');
      assert.equal(published.dueDate, '2028-03-01');
      assert.equal('token' in published, false);
      assert.equal('customerEmail' in published, false);
      assert.equal(store.getCheckout(invoice.token)?.invoice.total, 10348);
    }
  } finally {store.close();}
});

test('half-unit adjustments round independently before tax and do not erase other line items', () => {
  const store = new Store(':memory:');
  try {
    const invoice = createInvoice(store, 'fictional-half-units', {
      ...draft, items: [{description: 'Fictional unit', quantity: 1, unitAmount: 15}, {description: 'Included fictional item', quantity: 10000, unitAmount: 0}],
      discountBps: 5000, premiumBps: 5000, taxBps: 5000,
    }, now);
    assert.deepEqual([invoice.subtotal, invoice.discountAmount, invoice.premiumAmount, invoice.tax, invoice.total], [15, 8, 8, 8, 23]);
    assert.equal(invoice.items.length, 2);
  } finally {store.close();}
});

test('currency parsing preserves the supported maximum and refuses fractional won and malformed prices', () => {
  for (const currency of ['CAD', 'USD', 'EUR', 'GBP', 'KRW'] as const) {
    const scale = currencyScale(currency);
    assert.equal(parseInvoiceAmount(currency === 'KRW' ? '1000000000' : '10000000.00', currency), 1000000000);
    assert.equal(parseInvoiceAmount(currency === 'KRW' ? ' 15 ' : ' 0.15 ', currency), 15);
    assert.throws(() => parseInvoiceAmount(currency === 'KRW' ? '1000000001' : '10000000.01', currency), /range/);
    for (const price of ['', '-1', '+1', '1e2', '1,000', 'NaN', 'Infinity', '1.001', '0x10']) assert.throws(() => parseInvoiceAmount(price, currency), `${currency}: ${price}`);
    assert.equal(scale, currency === 'KRW' ? 1 : 100);
  }
  assert.throws(() => parseInvoiceAmount('1.00', 'KRW'), /whole-won/);
  assert.equal(formatInvoiceAmount(150001, 'CAD'), '$1,500.01');
  assert.match(formatInvoiceAmount(150001, 'KRW'), /150,001/);
});

test('calendar, adjustment and currency conversion caps reject without creating invoice or audit rows', () => {
  const store = new Store(':memory:');
  try {
    const invalid = [
      {issueDate: '2026-02-29'}, {dueDate: '2026-04-31'}, {issueDate: '2026-2-05'},
      {issueDate: '2026-11-06', dueDate: '2026-11-05'}, {discountBps: -1}, {premiumBps: 10001}, {taxBps: 0.5},
      {currency: 'JPY'}, {items: [{description: 'Fictional unit', quantity: 1.1, unitAmount: 100}]},
      {currency: 'USD', items: [{description: 'Fictional unit', quantity: 1, unitAmount: 714285715}], taxBps: 0},
      {currency: 'EUR', items: [{description: 'Fictional unit', quantity: 1, unitAmount: 666666667}], taxBps: 0},
      {currency: 'GBP', items: [{description: 'Fictional unit', quantity: 1, unitAmount: 555555556}], taxBps: 0},
      {currency: 'KRW', items: [{description: 'Fictional unit', quantity: 1, unitAmount: 4}], taxBps: 0},
      {discountBps: 10000},
    ];
    for (const extra of invalid) assert.throws(() => createInvoice(store, 'fictional-invalid', {...draft, ...extra}, now), status(400));
    assert.equal(store.listInvoices('fictional-invalid').length, 0);
    assert.equal(store.audits('fictional-invalid').length, 0);
    for (const [currency, unitAmount, totalCad] of [['CAD', 1000000000, 1000000000], ['USD', 714285714, 1000000000], ['EUR', 666666666, 999999999], ['GBP', 555555555, 999999999], ['KRW', 5, 1]] as const) {
      const invoice = createInvoice(store, 'fictional-boundary', {...draft, currency, taxBps: 0, items: [{description: 'Fictional boundary', quantity: 1, unitAmount}]}, now);
      assert.equal(invoice.totalCad, totalCad, currency);
    }
  } finally {store.close();}
});

test('method allowlists match legacy aliases in both directions without permitting unrelated methods', () => {
  for (const [canonical, legacy] of [['card', 'square'], ['bank', 'bank_transfer']] as const) {
    assert.equal(invoiceAllowsMethod({acceptedMethods: [canonical]}, legacy), true);
    assert.equal(invoiceAllowsMethod({acceptedMethods: [legacy]}, canonical), true);
    assert.equal(invoiceAllowsMethod({acceptedMethods: [canonical]}, 'bitcoin'), false);
  }
  assert.equal(invoiceAllowsMethod({}, 'bitcoin'), true);
  assert.equal(invoiceAllowsMethod({acceptedMethods: []}, 'bitcoin'), false);
});

test('manual-report decisions preserve explicit manual-bank terms and legacy automatic simulations', () => {
  assert.equal(invoiceRequiresManualReport({acceptedMethods: ['bank']}, 'bank_transfer'), true);
  assert.equal(invoiceRequiresManualReport({}, 'bank_transfer'), false);
  assert.equal(invoiceRequiresManualReport({acceptedMethods: ['bank_transfer']}, 'bank_transfer'), false);
  assert.equal(invoiceRequiresManualReport({acceptedMethods: ['bank', 'bank_transfer']}, 'bank_transfer'), false);
  for (const method of ['bank', 'cash', 'check', 'interac', 'ach', 'sepa', 'wire', 'gift_card', 'coupon', 'no_charge'] as const) assert.equal(invoiceRequiresManualReport({}, method), true, method);
  for (const method of ['bitcoin', 'lightning', 'card', 'square', 'cashu', 'ark'] as const) assert.equal(invoiceRequiresManualReport({}, method), false, method);
});

test('template updates and deletion preserve issued invoices and the other workspace at the limit', () => {
  const store = new Store(':memory:', {encryptionKey: Buffer.alloc(32, 62)});
  try {
    const templates = new InvoiceTemplates(store);
    const saved = templates.save('fictional-alpha', {label: 'Fictional recurring client', draft});
    const issued = createInvoice(store, 'fictional-alpha', saved.draft, now);
    const other = templates.save('fictional-beta', {label: 'Fictional independent client', draft: {...draft, currency: 'USD'}});
    const otherBytes = store.db.prepare('SELECT data FROM invoice_templates WHERE id=?').get(other.id)!.data;
    for (let index = 1; index < 32; index++) templates.save('fictional-alpha', {label: `Fictional template ${index}`, draft});
    assert.throws(() => templates.save('fictional-alpha', {label: 'Fictional overflow', draft}), status(429));
    const changed = templates.save('fictional-alpha', {id: saved.id, label: 'Fictional updated client', draft: {...draft, currency: 'KRW', taxBps: 0}});
    assert.equal(changed.draft.currency, 'KRW');
    assert.equal(templates.list('fictional-alpha').length, 32);
    assert.throws(() => templates.save('fictional-beta', {id: saved.id, label: 'Fictional override', draft}), status(404));
    assert.throws(() => templates.remove('fictional-beta', saved.id), status(404));
    assert.equal(store.db.prepare('SELECT data FROM invoice_templates WHERE id=?').get(other.id)!.data, otherBytes);
    templates.remove('fictional-alpha', saved.id);
    assert.equal(templates.list('fictional-alpha').length, 31);
    templates.save('fictional-alpha', {label: 'Fictional replacement', draft});
    assert.deepEqual(store.getInvoice(issued.id, 'fictional-alpha'), JSON.parse(JSON.stringify(issued)));
    assert.deepEqual(templates.list('fictional-beta'), [other]);
  } finally {store.close();}
});

test('new demo invoices preserve a ready team, historical receipts and trusted case versions', () => {
  const store = new Store(':memory:', {encryptionKey: Buffer.alloc(32, 63)});
  let clock = now;
  try {
    const demo = new HackathonDemo({store, now: () => clock});
    const visit = demo.start('marmot', 'fictional-lease-client');
    const paid = demo.simulatePayment(visit.workspace);
    const previousInvoiceBytes = store.db.prepare('SELECT data FROM invoices WHERE id=?').get(visit.invoiceId)!.data;
    const previousReceiptBytes = JSON.stringify(store.db.prepare('SELECT * FROM receipts').all());
    const snapshot = (workspace: string): DemoCase => {
      const {invoice, caseVersion} = demo.view(workspace);
      return {fictional: true, currency: invoice.currency, lineAmount: invoice.subtotal, tax: invoice.tax, total: invoice.total, status: invoice.status, settlementMode: 'simulation', receiptRecorded: Boolean(invoice.receiptToken), version: caseVersion, asOf: clock.toISOString()};
    };
    const admission = new DemoAgentAdmission({store, now: () => clock, getCase: snapshot});
    const lease = admission.start(visit.workspace, 'a'.repeat(64), visit.expiresAt);
    admission.setMembers(lease.id, [{role: 'client', name: 'Riley', pubkey: 'b'.repeat(64)}, {role: 'accountant', name: 'Jordan', pubkey: 'c'.repeat(64)}]);
    admission.connect(visit.workspace, 'd'.repeat(64), 'e'.repeat(64));
    const pending = admission.claim(lease.id, 'accountant', 'f'.repeat(64), lease.humanPubkey, lease.generation)!;
    assert.ok(pending);
    const active = admission.get(visit.workspace)!;
    const leaseBytes = store.db.prepare('SELECT data FROM demo_agent_leases WHERE id=?').get(lease.id)!.data;
    assert.equal(active.state, 'ready');
    const replacement = demo.create(visit.workspace, {...draft, currency: 'GBP' as Currency});
    assert.equal(replacement.caseVersion, paid.caseVersion + 1);
    assert.notEqual(replacement.invoice.id, visit.invoiceId);
    assert.equal(replacement.invoice.settlementMode, 'simulation');
    assert.deepEqual(admission.get(visit.workspace), active);
    assert.equal(store.db.prepare('SELECT data FROM demo_agent_leases WHERE id=?').get(lease.id)!.data, leaseBytes);
    assert.equal(store.db.prepare('SELECT data FROM invoices WHERE id=?').get(visit.invoiceId)!.data, previousInvoiceBytes);
    assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM receipts').all()), previousReceiptBytes);
    assert.equal(store.getReceipt(paid.invoice.receiptToken!)?.receipt.mode, 'simulation');
    assert.equal(store.listInvoices(visit.workspace).length, 2);

    admission.saveInference(pending, {intent: 'check-total', model: 'fictional-model', runtime: 'hermes'});
    const reply = admission.prepareReply(pending)!;
    assert.equal(reply.caseVersion, replacement.caseVersion);
    assert.match(reply.text, /GBP 105\.01/);
    const next = demo.create(visit.workspace, {...draft, currency: 'USD' as Currency});
    assert.equal(next.caseVersion, replacement.caseVersion + 1);
    assert.deepEqual(admission.prepareReply(pending), reply);

    const names = ['invoices', 'receipts', 'audits', 'hackathon_demo_workspaces', 'demo_agent_leases', 'demo_agent_turns'];
    const rows = () => names.map(name => JSON.stringify(store.db.prepare(`SELECT * FROM ${name}`).all()));
    const beforeFailure = rows();
    assert.throws(() => demo.create(visit.workspace, {...draft, taxBps: 0, discountBps: 5000, items: [{description: 'Oversized fictional invoice', quantity: 2, unitAmount: 1000000000}]}), status(400));
    assert.deepEqual(rows(), beforeFailure);
    assert.equal(demo.view(visit.workspace).caseVersion, next.caseVersion);
    assert.equal(admission.get(visit.workspace)?.state, 'ready');
  } finally {store.close();}
});

test('parallel demo retries issue once, enforce the visit cap and leave another visit unchanged', async () => {
  const origin = 'https://fictional-soak.example';
  const proxySecret = 'fictional-soak-proxy-' + 'x'.repeat(32);
  const app = createApp({dbPath: ':memory:', encryptionKey: Buffer.alloc(32, 64), now: () => now,
    hosted: {publicOrigin: origin, proxySecret, hackathonDemo: true, limits: {requestsPerMinute: 1000}}});
  const base = {Origin: origin, 'X-Quiet-Ledger-Proxy': proxySecret, 'X-Quiet-Ledger-Client-IP': '203.0.113.200'};
  try {
    const login = async () => {
      const response = await request(app).post('/api/session/hackathon-demo').set(base).send({password: 'marmot'});
      assert.equal(response.status, 200);
      return {...base, Cookie: response.headers['set-cookie'][0].split(';')[0], 'X-CSRF-Token': response.body.csrfToken};
    };
    const alpha = await login(), beta = await login();
    const otherBefore = await request(app).get('/api/hackathon-demo').set(beta);
    assert.equal(otherBefore.status, 200);
    const create = (key: string, body = draft) => request(app).post('/api/hackathon-demo/invoices').set(alpha).set('Idempotency-Key', key).send(body);
    const repeats = await Promise.all(Array.from({length: 6}, () => create('fictional-parallel-repeat')));
    for (const response of repeats) {
      assert.equal(response.status, 201);
      assert.deepEqual(response.body, repeats[0].body);
    }
    assert.equal(repeats[0].body.caseVersion, 2);
    const different = await create('fictional-parallel-repeat', {...draft, title: 'A different fictional request'});
    assert.equal(different.status, 409);
    const remaining = await Promise.all(Array.from({length: 12}, (_, index) => create(`fictional-parallel-new-${index}`)));
    assert.equal(remaining.filter(response => response.status === 201).length, 6);
    assert.equal(remaining.filter(response => response.status === 429).length, 6);
    const invoices = await request(app).get('/api/invoices').set(alpha);
    assert.equal(invoices.status, 200);
    assert.equal(invoices.body.invoices.length, 8);
    assert.equal(new Set(invoices.body.invoices.map((invoice: {number: string}) => invoice.number)).size, 8);
    const full = await request(app).get('/api/hackathon-demo').set(alpha);
    assert.equal(full.body.caseVersion, 8);
    const retryAtCap = await create('fictional-parallel-repeat');
    assert.equal(retryAtCap.status, 201);
    assert.deepEqual(retryAtCap.body, repeats[0].body);
    assert.deepEqual((await request(app).get('/api/hackathon-demo').set(alpha)).body, full.body);
    const payments = await Promise.all(Array.from({length: 4}, () => request(app).post('/api/hackathon-demo/simulate-payment').set(alpha).send({})));
    for (const response of payments) {
      assert.equal(response.status, 200);
      assert.equal(response.body.caseVersion, 9);
      assert.equal(response.body.invoice.status, 'paid');
      assert.equal(response.body.invoice.receiptToken, payments[0].body.invoice.receiptToken);
    }
    assert.deepEqual((await request(app).get('/api/hackathon-demo').set(beta)).body, otherBefore.body);
  } finally {app.locals.close();}
});
