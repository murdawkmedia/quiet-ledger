import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createBoundedHttpsTransport, CashuTransportError} from '../../server/cashu/transport.mjs';

const mint = 'https://quiet-ledger.invalid';
const endpoint = `${mint}/v1/restore`;
const body = {outputs: [{id: 'fixture-keyset', amount: '1', B_: '02' + '11'.repeat(32)}]};
const args = extra => ({method: 'POST', endpoint, requestBody: body, ...extra});
const jsonResponse = (value, init = {}) => new Response(JSON.stringify(value), {
  status: 200, headers: {'content-type': 'application/json'}, ...init,
});
const expectCode = (promise, expected) => assert.rejects(promise, error => {
  assert.equal(error instanceof CashuTransportError, true);
  assert.equal(error.code, expected);
  return true;
});

test('one bounded POST succeeds and the transport is single-use', async () => {
  const calls = [];
  const transport = createBoundedHttpsTransport({
    mintUrl: mint,
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      return jsonResponse({outputs: [], signatures: []});
    },
  });
  const value = await transport(args());
  assert.deepEqual(value, {outputs: [], signatures: []});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, endpoint);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.headers.authorization, undefined);
  await expectCode(transport(args()), 'TRANSPORT_REPLAY');
  assert.equal(calls.length, 1);
});

test('only exact recovery paths on the configured HTTPS origin are accepted', async () => {
  let calls = 0;
  const transport = () => createBoundedHttpsTransport({mintUrl: mint, fetchImpl: async () => {
    calls++; return jsonResponse({});
  }});
  await expectCode(transport()(args({endpoint: 'http://quiet-ledger.invalid/v1/restore'})), 'UNEXPECTED_ENDPOINT');
  await expectCode(transport()(args({endpoint: 'https://other.invalid/v1/restore'})), 'UNEXPECTED_ENDPOINT');
  await expectCode(transport()(args({endpoint: `${mint}/v1/mint`})), 'UNEXPECTED_ENDPOINT');
  await expectCode(transport()(args({endpoint: `${mint}/v1/restore?x=1`})), 'UNEXPECTED_ENDPOINT');
  await expectCode(transport()(args({endpoint: `${mint}/v1/restore/extra`})), 'UNEXPECTED_ENDPOINT');
  await expectCode(transport()(args({method: 'GET'})), 'UNEXPECTED_TRANSPORT');
  await expectCode(transport()(args({headers: {authorization: 'Bearer fictional'}})), 'UNSUPPORTED_HEADERS');
  assert.equal(calls, 0);
  assert.throws(() => createBoundedHttpsTransport({mintUrl: 'http://quiet-ledger.invalid'}), e => e.code === 'INVALID_MINT');
  assert.throws(() => createBoundedHttpsTransport({mintUrl: 'https://u:p@quiet-ledger.invalid'}), e => e.code === 'INVALID_MINT');
  assert.throws(() => createBoundedHttpsTransport({mintUrl: mint, timeoutMs: 10}), e => e.code === 'INVALID_TRANSPORT_CONFIG');
  assert.throws(() => createBoundedHttpsTransport({mintUrl: mint, maxResponseBytes: 10}), e => e.code === 'INVALID_TRANSPORT_CONFIG');
});

test('a configured mint prefix is preserved and other prefixes are refused', async () => {
  const prefixed = 'https://quiet-ledger.invalid/base';
  let seen;
  const transport = createBoundedHttpsTransport({mintUrl: prefixed, fetchImpl: async url => {
    seen = url; return jsonResponse({ok: true});
  }});
  await transport({method: 'POST', endpoint: `${prefixed}/v1/checkstate`, requestBody: {Ys: []}});
  assert.equal(seen, `${prefixed}/v1/checkstate`);
  await expectCode(createBoundedHttpsTransport({mintUrl: prefixed, fetchImpl: async () => jsonResponse({})})
    ({method: 'POST', endpoint: `${mint}/v1/checkstate`, requestBody: {Ys: []}}), 'UNEXPECTED_ENDPOINT');
});

test('responses are bounded and must be a direct JSON 200 response', async () => {
  const run = (fetchImpl, options = {}) => createBoundedHttpsTransport({mintUrl: mint, fetchImpl, ...options})(args());
  await expectCode(run(async () => new Response('nope', {status: 500, headers: {'content-type': 'application/json'}})), 'HTTP_STATUS');
  await expectCode(run(async () => new Response('moved', {status: 302, headers: {location: 'https://elsewhere.invalid'}})), 'HTTP_STATUS');
  await expectCode(run(async () => ({status: 200, redirected: true, headers: new Headers(), body: null})), 'REDIRECT_REFUSED');
  await expectCode(run(async () => new Response('{}', {status: 200, headers: {'content-type': 'text/html'}})), 'INVALID_CONTENT_TYPE');
  await expectCode(run(async () => new Response('{not json', {status: 200, headers: {'content-type': 'application/json'}})), 'INVALID_JSON');
  await expectCode(run(async () => new Response('[]', {status: 200, headers: {'content-type': 'application/json'}})), 'INVALID_JSON');
  await expectCode(run(async () => new Response('x'.repeat(4096), {
    status: 200, headers: {'content-type': 'application/json'},
  }), {maxResponseBytes: 1024}), 'RESPONSE_TOO_LARGE');
  await expectCode(run(async () => new Response(JSON.stringify({x: 'a'.repeat(600 * 1024)}), {
    status: 200, headers: {'content-type': 'application/json'},
  })), 'RESPONSE_TOO_LARGE');
  await expectCode(run(async () => { throw new Error('fictional network failure'); }), 'NETWORK_ERROR');
});

test('a non-cooperative transport still fails at the wall-clock deadline', async () => {
  const transport = createBoundedHttpsTransport({mintUrl: mint, timeoutMs: 1000, fetchImpl: () => new Promise(() => {})});
  const started = Date.now();
  await expectCode(transport(args()), 'REQUEST_TIMEOUT');
  const elapsed = Date.now() - started;
  assert.equal(elapsed >= 900, true);
  assert.equal(elapsed < 5000, true);
});

test('a stalled response body is cut off by the same deadline', async () => {
  const stream = new ReadableStream({start() { /* never enqueue or close */ }});
  const transport = createBoundedHttpsTransport({
    mintUrl: mint, timeoutMs: 1000,
    fetchImpl: async () => new Response(stream, {
      status: 200, headers: {'content-type': 'application/json'},
    }),
  });
  await expectCode(transport(args()), 'REQUEST_TIMEOUT');
});

test('oversized request bodies are refused before any transport call', async () => {
  let calls = 0;
  const transport = createBoundedHttpsTransport({mintUrl: mint, fetchImpl: async () => {
    calls++; return jsonResponse({});
  }});
  await expectCode(transport({method: 'POST', endpoint, requestBody: {x: 'a'.repeat(600 * 1024)}}), 'REQUEST_TOO_LARGE');
  assert.equal(calls, 0);
});
