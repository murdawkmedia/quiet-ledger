import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app.js';

test('postfix review: shape-invalid private scenario fails safely and repairs without a restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'quiet-ledger-postfix-scenario-'));
  const privateScenarioPath = join(directory, 'synthetic-scenario.json');
  const ownerToken = 'synthetic-postfix-owner-token';
  const canary = 'SYNTHETIC_PRIVATE_SCENARIO_MUST_NOT_APPEAR_IN_ERRORS';
  const healthy = {
    title: 'Synthetic owner planning scenario', sourceDate: '2026-11-04', status: 'review', summary: 'Synthetic only.',
    metrics: [{ label: 'Fictional amount', amount: 123, currency: 'CAD', note: 'A synthetic metric.' }, { label: 'A value', value: 'Pending' }],
    obligations: [{ label: 'Fictional obligation', amount: 456, currency: 'USD', status: 'pending', note: 'Synthetic.' }],
    conditions: [{ label: 'Fictional condition', status: 'pending', note: 'Synthetic.' }],
    sources: ['Fictional test source'], notes: ['Fictional test note'],
  };
  const write = (value: unknown) => writeFileSync(privateScenarioPath, JSON.stringify(value), { mode: 0o600 });
  write(healthy);
  const app = createApp({ dbPath: ':memory:', ownerToken, privateScenarioPath });
  try {
    const owner = request.agent(app);
    await owner.post('/api/session/owner').send({ token: ownerToken }).expect(200);
    assert.deepEqual((await owner.get('/api/scenario').expect(200)).body.scenario, healthy);
    const invalidShapes = [
      ['metrics is a string', { metrics: canary }],
      ['metrics has a null entry', { metrics: [null] }],
      ['metric label is an object', { metrics: [{ label: { canary } }] }],
      ['metric value is an object', { metrics: [{ label: canary, value: {} }] }],
      ['metric currency cannot be formatted', { metrics: [{ label: canary, amount: 1, currency: 'INVALID_CURRENCY' }] }],
      ['obligations is a string', { obligations: canary }],
      ['obligation status is a number', { obligations: [{ label: canary, amount: 1, status: 7 }] }],
      ['conditions has a null entry', { conditions: [null] }],
      ['notes has an object entry', { notes: [{ canary }] }],
      ['summary is an object', { summary: { canary } }],
    ] as const;
    for (const [name, invalid] of invalidShapes) {
      await t.test(name, async () => {
        write({ ...healthy, ...invalid });
        const response = await owner.get('/api/scenario');
        assert.equal(response.status, 503, 'Invalid optional scenario fields must not reach render-time array, text or currency operations.');
        assert.deepEqual(Object.keys(response.body), ['error']);
        assert.equal(JSON.stringify(response.body).includes(canary), false);
        assert.equal(JSON.stringify(response.body).includes(privateScenarioPath), false);
        await owner.get('/api/health').expect(200);
        write(healthy);
        assert.deepEqual((await owner.get('/api/scenario').expect(200)).body.scenario, healthy);
      });
    }
    const demo = request.agent(app);
    await demo.post('/api/session/demo').send({}).expect(200);
    await demo.get('/api/scenario').expect(403);
  } finally { app.locals.close(); rmSync(directory, { recursive: true, force: true }); }
});
