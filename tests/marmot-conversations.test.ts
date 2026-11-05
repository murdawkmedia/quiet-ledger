import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {finalizeEvent, generateSecretKey, getPublicKey, type Event} from 'nostr-tools';
import {createMarmotConversationsRouter} from '../server/marmot-conversations.js';
import {Store, DomainError, type StoredSession} from '../server/store.js';
import {createInvoice} from '../server/domain.js';
import {createMarmotParticipant, type MarmotTransport} from '../client/marmot-engine.js';

const origin = 'https://fictional-ledger.example';
const date = new Date('2026-11-05T12:00:00.000Z');
const timestamp = Math.floor(date.getTime() / 1000);
const merchantKey = generateSecretKey(), customerKey = generateSecretKey();
const merchantPubkey = getPublicKey(merchantKey), customerPubkey = getPublicKey(customerKey);
function signed(kind = 445, options: Partial<Event> = {}, secret = merchantKey): Event {
  return finalizeEvent({kind, content: 'fictional-opaque-ciphertext', tags: [['nonce', crypto.randomUUID()]], created_at: timestamp, ...options}, secret);
}
function setup(encrypted = true, fixtureDate = date) {
  let clock = fixtureDate;
  const store = new Store(':memory:', encrypted ? {encryptionKey: Buffer.alloc(32, 53)} : {});
  const invoice = (workspace: string) => createInvoice(store, workspace, {customerName: 'Fictional Customer', customerEmail: 'fictional@example.invalid', title: 'Fictional private invoice', currency: 'CAD', items: [{description: 'Fictional service', quantity: 1, unitAmount: 100}], note: 'PRIVATE NOTE MUST NOT APPEAR'}, date);
  const a = invoice('workspace-a'), b = invoice('workspace-b'), demo = invoice('workspace-demo');
  const sessions: Record<string, StoredSession & {hackathonDemo?: boolean}> = {
    a: {role: 'owner', workspace: 'workspace-a', csrf: 'fictional-csrf-a', expires: new Date(fixtureDate.getTime() + 3600000).toISOString()},
    b: {role: 'owner', workspace: 'workspace-b', csrf: 'fictional-csrf-b', expires: new Date(fixtureDate.getTime() + 3600000).toISOString()},
    demo: {role: 'demo', workspace: 'workspace-demo', csrf: 'fictional-csrf-demo', expires: new Date(fixtureDate.getTime() + 3600000).toISOString(), hackathonDemo: true},
    ordinaryDemo: {role: 'demo', workspace: 'workspace-demo', csrf: 'fictional-csrf-demo', expires: new Date(fixtureDate.getTime() + 3600000).toISOString()},
  };
  const disabledPublicWorkspaces = new Set<string>();
  const app = express(); app.use(express.json({limit: '64kb'}));
  app.use((req, res, next) => {if (req.get('X-Test-Api')) res.locals.apiAccess = {keyId: 'fictional-api-key'}; next();});
  app.use(createMarmotConversationsRouter({store, now: () => clock, publicOrigin: origin, getSession: (req: express.Request) => sessions[req.get('X-Test-Session') ?? ''], assertPublicWorkspace: (workspace: string) => {if (disabledPublicWorkspaces.has(workspace)) throw new DomainError(404, 'Fictional demo workspace expired.');}, isDemoWorkspace: workspace => workspace === 'workspace-demo' || workspace.startsWith('budget-demo-')}));
  app.use((_req, res) => res.status(404).json({error: 'Not found.'}));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {res.status(error instanceof DomainError ? error.status : 500).json({error: error instanceof DomainError ? error.message : 'Synthetic harness failure.'});});
  const ownerBase = `/api/invoices/${a.id}/conversation`, customerBase = `/api/checkout/${a.token}/conversation`;
  const call = (method: 'get' | 'post', path = ownerBase, who = 'a') => {
    let req = request(app)[method](path).set('Origin', origin);
    if (who) req = req.set('X-Test-Session', who).set('X-CSRF-Token', sessions[who]?.csrf ?? '');
    return req;
  };
  return {app, store, a, b, demo, sessions, disabledPublicWorkspaces, ownerBase, customerBase, call, setTime: (value: Date) => {clock = value;}, close: () => store.close()};
}

test('conversation rendezvous is invoice-scoped, idempotent and exposes only minimal public invoice context', async () => {
  const f = setup();
  try {
    assert.equal((await f.call('get')).status, 404);
    const created = await f.call('post').send({}); assert.equal(created.status, 201);
    const again = await f.call('post').send({}); assert.equal(again.status, 200);
    const customer = await f.call('post', f.customerBase, '').send({}); assert.equal(customer.status, 200);
    assert.equal(created.body.conversation.id, again.body.conversation.id);
    assert.equal(created.body.conversation.id, customer.body.conversation.id);
    assert.equal(created.body.conversation.role, 'merchant'); assert.equal(customer.body.conversation.role, 'customer');
    assert.equal(created.body.conversation.transportBase, f.ownerBase);
    assert.equal(customer.body.conversation.transportBase, f.customerBase);
    for (const body of [created.body, customer.body]) {
      assert.equal(body.invoice.title, f.a.title); assert.equal(body.invoice.total, f.a.total);
      for (const key of ['id', 'token', 'note', 'customerEmail', 'items', 'nativePayment']) assert.equal(body.invoice[key], undefined);
      assert(!JSON.stringify(body).includes(f.a.note!)); assert(!JSON.stringify(body).includes('workspace-a'));
    }
    assert.match(created.headers['cache-control'], /no-store/);
    assert.equal((await f.call('get', f.ownerBase, 'b')).status, 404);
    assert.equal((await f.call('get', `/api/checkout/${f.b.token}/conversation`, '')).status, 404);
    assert.equal((await f.call('post', `/api/invoices/${f.demo.id}/conversation`, 'demo').send({})).status, 201);
    assert.equal((await f.call('post', `/api/invoices/${f.demo.id}/conversation`, 'ordinaryDemo').send({})).status, 403);
  } finally {f.close();}
});

test('owner and customer writes require exact origin, owner CSRF and never accept API bearer access', async () => {
  const f = setup();
  try {
    assert.equal((await f.call('post').unset('X-Test-Session').send({})).status, 401);
    assert.equal((await f.call('post').unset('Origin').send({})).status, 403);
    assert.equal((await f.call('post').set('Origin', `${origin}/path`).send({})).status, 403);
    assert.equal((await f.call('post').set('Origin', 'https://foreign.example').send({})).status, 403);
    assert.equal((await f.call('post').unset('X-CSRF-Token').send({})).status, 403);
    assert.equal((await f.call('post').set('X-CSRF-Token', 'wrong').send({})).status, 403);
    assert.equal((await f.call('post', f.customerBase, '').unset('Origin').send({})).status, 403);
    assert.equal((await f.call('post').set('Authorization', 'Bearer fictional-api-token').send({})).status, 403);
    assert.equal((await f.call('get').set('X-Test-Api', '1')).status, 403);
    f.sessions.a.expires = date.toISOString(); assert.equal((await f.call('post').send({})).status, 401);
  } finally {f.close();}
  const plaintext = setup(false);
  try {assert.equal((await plaintext.call('post').send({})).status, 503);} finally {plaintext.close();}
});

test('signed events bind independent role identities, reject switching and constrain encrypted Welcome delivery', async () => {
  const f = setup();
  try {
    await f.call('post').send({});
    const merchant = signed(30443), customer = signed(30443, {}, customerKey);
    assert.equal((await f.call('post', `${f.ownerBase}/events`).send({event: merchant})).status, 201);
    assert.equal((await f.call('post', `${f.customerBase}/events`, '').send({event: customer})).status, 201);
    const repeated = await f.call('post', `${f.ownerBase}/events`).send({event: merchant}); assert.equal(repeated.status, 200); assert.equal(repeated.body.duplicate, true);
    assert.equal((await f.call('post', `${f.ownerBase}/events`).send({event: signed(30443, {}, generateSecretKey())})).status, 409);
    const metadata = await f.call('get'); assert.equal(metadata.body.conversation.peerPubkey, customerPubkey);
    assert.equal((await f.call('get', f.customerBase, '')).body.conversation.peerPubkey, merchantPubkey);
    assert.equal((await f.call('post', `${f.customerBase}/events`, '').send({event: signed(1059, {tags: [['p', merchantPubkey]]}, customerKey)})).status, 403);
    assert.equal((await f.call('post', `${f.ownerBase}/events`).send({event: signed(1059, {tags: [['p', merchantPubkey]]})})).status, 400);
    assert.equal((await f.call('post', `${f.ownerBase}/events`).send({event: signed(1059, {tags: [['p', customerPubkey]], created_at: timestamp - 72 * 3600}, generateSecretKey())})).status, 201);
    assert.equal((await f.call('post', `${f.ownerBase}/events`).send({event: signed(445, {tags: [['h', 'a'.repeat(64)]]}, generateSecretKey())})).status, 201);
    const raw = JSON.stringify(f.store.db.prepare('SELECT * FROM marmot_conversations').all()) + JSON.stringify(f.store.db.prepare('SELECT * FROM marmot_events').all());
    assert(!raw.includes(merchantPubkey)); assert(!raw.includes(customerPubkey)); assert(!raw.includes(merchant.content));
    assert(f.store.db.prepare('SELECT data FROM marmot_events').all().every(row => String(row.data).startsWith('qlr:v1:')));
  } finally {f.close();}
});

test('invalid signatures, malformed payloads, unsupported kinds, sizes and timestamps fail before storage', async () => {
  const f = setup();
  try {
    await f.call('post').send({});
    const event = signed();
    for (const invalid of [{...event, content: 'tampered'}, {...event, sig: '0'.repeat(128)}, {...event, extra: true}, signed(1), signed(445, {created_at: timestamp + 601}), signed(445, {created_at: timestamp - 72 * 3600 - 1})]) {
      assert.equal((await f.call('post', `${f.ownerBase}/events`).send({event: invalid})).status, 400);
    }
    assert.equal((await f.call('post', `${f.ownerBase}/events`).send({event, workspace: 'workspace-b'})).status, 400);
    assert.equal((await f.call('post', `${f.ownerBase}/events`).send({event: signed(445, {content: 'x'.repeat(24576)})})).status, 413);
    assert.equal((await f.call('post').send({invoiceId: f.b.id})).status, 400);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM marmot_events').get()!.n, 0);
  } finally {f.close();}
});

test('private queries support bounded Nostr filters and never cross room, workspace or revoked customer links', async () => {
  const f = setup();
  try {
    await f.call('post').send({});
    const event = signed(445, {tags: [['h', 'a'.repeat(64)]]});
    await f.call('post', `${f.ownerBase}/events`).send({event});
    const query = (filters: unknown) => f.call('post', `${f.customerBase}/query`, '').send({filters});
    const result = await query([{ids: [event.id], authors: [event.pubkey], kinds: [445], since: timestamp, until: timestamp, '#h': ['a'.repeat(64)], limit: 40}]);
    assert.equal(result.status, 200); assert.deepEqual(result.body.events, JSON.parse(JSON.stringify([event])));
    assert.deepEqual((await query([{'#h': ["' OR 1=1 --"]}])).body.events, []);
    for (const filters of [[], Array(9).fill({}), [{limit: 41}], [{limit: 0}], [{authors: ['not-a-key']}], [{kinds: [1]}], [{search: 'unsupported'}], [{since: -1}], [{since: timestamp + 1, until: timestamp}], [{'#h': 'wrong-shape'}]]) assert.equal((await query(filters)).status, 400);
    const other = `/api/invoices/${f.b.id}/conversation`; await f.call('post', other, 'b').send({});
    assert.deepEqual((await f.call('post', `${other}/query`, 'b').send({filters: [{kinds: [445]}]})).body.events, []);
    assert.equal((await f.call('post', `${f.ownerBase}/query`, 'b').send({filters: [{}]})).status, 404);
    f.store.revokeInvoiceLinks(f.a.id, 'workspace-a', date.toISOString());
    for (const suffix of ['', '/query', '/events']) {
      const response = suffix ? await f.call('post', `${f.customerBase}${suffix}`, '').send(suffix === '/query' ? {filters: [{}]} : {event}) : await f.call('get', f.customerBase, '');
      assert.equal(response.status, 404);
    }
    assert.equal((await f.call('get')).status, 200);
  } finally {f.close();}
});

test('expired or disabled public workspaces cannot rendezvous, publish or query through a still-valid checkout token', async () => {
  const f = setup();
  try {
    f.disabledPublicWorkspaces.add('workspace-a');
    assert.equal((await f.call('post', f.customerBase, '').send({})).status, 404);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM marmot_conversations').get()!.n, 0);
    await f.call('post').send({});
    assert.equal((await f.call('get', f.customerBase, '')).status, 404);
    assert.equal((await f.call('post', `${f.customerBase}/events`, '').send({event: signed()})).status, 404);
    assert.equal((await f.call('post', `${f.customerBase}/query`, '').send({filters: [{}]})).status, 404);
    assert.equal((await f.call('get')).status, 200);
  } finally {f.close();}
});

test('room count and raw payload quotas reject new writes but preserve duplicate retry access', async () => {
  const f = setup();
  try {
    await f.call('post').send({});
    let first: Event | undefined;
    for (let index = 0; index < 128; index++) {
      const event = signed(); first ??= event;
      assert.equal((await f.call('post', `${f.ownerBase}/events`).send({event})).status, 201);
    }
    assert.equal((await f.call('post', `${f.ownerBase}/events`).send({event: signed()})).status, 429);
    assert.equal((await f.call('post', `${f.ownerBase}/events`).send({event: first})).status, 200);
    const returned = await f.call('post', `${f.ownerBase}/query`).send({filters: Array(8).fill({limit: 40})});
    assert.equal(returned.body.events.length, 40);
  } finally {f.close();}
  const payload = setup();
  try {
    await payload.call('post').send({}); let acceptedBytes = 0, rejected = false;
    for (let index = 0; index < 24; index++) {
      const event = signed(445, {content: 'x'.repeat(24000)}), bytes = Buffer.byteLength(JSON.stringify(event));
      const response = await payload.call('post', `${payload.ownerBase}/events`).send({event});
      if (acceptedBytes + bytes > 512 * 1024) {assert.equal(response.status, 429); rejected = true; break;}
      assert.equal(response.status, 201); acceptedBytes += bytes;
    }
    assert(rejected);
  } finally {payload.close();}
});

test('two real Marmot clients complete key packages, Welcome and bidirectional MLS messaging through the private HTTP routes', async () => {
  const f = setup(true, new Date());
  const storageValues = new Map<string, unknown>();
  const storage = {async getItem(key: string) {return structuredClone(storageValues.get(key) ?? null);}, async setItem(key: string, value: unknown) {storageValues.set(key, structuredClone(value)); return value;}, async removeItem(key: string) {storageValues.delete(key);}, async clear() {storageValues.clear();}, async keys() {return [...storageValues.keys()];}};
  const transport = (base: string, who: string): MarmotTransport => ({
    async publish(event) {const response = await f.call('post', `${base}/events`, who).send({event}); assert(response.status < 300, response.body.error);},
    async query(filters) {const response = await f.call('post', `${base}/query`, who).send({filters}); assert.equal(response.status, 200, response.body.error); return response.body.events;},
  });
  await f.call('post').send({});
  const namespace = `fictional-http-${crypto.randomUUID()}`;
  const merchant = await createMarmotParticipant({namespace, role: 'merchant', storage, network: transport(f.ownerBase, 'a')});
  const customer = await createMarmotParticipant({namespace, role: 'customer', storage, network: transport(f.customerBase, '')});
  try {
    await merchant.ensureKeyPackage(); await customer.ensureKeyPackage();
    const metadata = await f.call('get'); assert.equal(metadata.body.conversation.peerPubkey, customer.pubkey);
    await merchant.createConversation(customer.pubkey); assert.equal(await customer.acceptInvitation(merchant.pubkey), true);
    await merchant.send('update'); await customer.sync();
    await customer.send('acknowledge'); await merchant.sync();
    assert.deepEqual(merchant.messages().map(message => message.kind), ['update', 'acknowledge']);
    assert.deepEqual(customer.messages().map(message => message.kind), ['update', 'acknowledge']);
    const kinds = f.store.db.prepare('SELECT DISTINCT kind FROM marmot_events ORDER BY kind').all().map(row => Number(row.kind));
    assert.deepEqual(kinds, [445, 1059, 30443]);
  } finally {await merchant.dispose(); await customer.dispose(); f.close();}
});

function fillEventBudget(store: Store, budget: number, prefix: string, fixedWorkspace?: string): Event {
  const prototype = signed(445, {content: 'x'.repeat(24000)});
  const bytes = Buffer.byteLength(JSON.stringify(prototype));
  // Legal-size signed fixture events, <512KiB/room and <1MiB/workspace. Direct
  // encrypted inserts establish the aggregate boundary without hundreds of HTTP
  // requests; the final accepted/rejected mutation always uses the real route.
  store.transaction(() => {
    for (let index = 0; (index + 1) * bytes <= budget; index++) {
      const workspace = fixedWorkspace ?? `${prefix}-${Math.floor(index / 40)}`;
      const roomId = `${prefix}-room-${Math.floor(index / 20)}`;
      store.db.prepare('INSERT OR IGNORE INTO marmot_conversations(id,workspace,invoice_id,data) VALUES(?,?,?,?)').run(roomId, workspace, `${roomId}-invoice`, store.encode({version: 1, createdAt: date.toISOString()}, 'marmot_conversations', roomId, workspace));
      const event = signed(445, {content: 'x'.repeat(24000)});
      assert.equal(Buffer.byteLength(JSON.stringify(event)), bytes);
      store.db.prepare('INSERT INTO marmot_events(conversation_id,workspace,id,created_at,kind,data) VALUES(?,?,?,?,?,?)').run(roomId, workspace, event.id, event.created_at, event.kind, store.encode(event, 'marmot_events', `${roomId}:${event.id}`, workspace));
    }
  });
  return prototype;
}

test('workspace quota and separate demo/real aggregate pools preserve capacity for the other audience', async () => {
  const workspace = setup();
  try {
    await workspace.call('post').send({});
    const event = fillEventBudget(workspace.store, 1024 * 1024, 'budget-workspace', 'workspace-a');
    assert.equal((await workspace.call('post', `${workspace.ownerBase}/events`).send({event})).status, 429);
  } finally {workspace.close();}
  const demoPool = setup();
  try {
    await demoPool.call('post').send({});
    const demoBase = `/api/invoices/${demoPool.demo.id}/conversation`;
    await demoPool.call('post', demoBase, 'demo').send({});
    const event = fillEventBudget(demoPool.store, 2 * 1024 * 1024, 'budget-demo');
    assert.equal((await demoPool.call('post', `${demoBase}/events`, 'demo').send({event})).status, 429);
    assert.equal((await demoPool.call('post', `${demoPool.ownerBase}/events`).send({event})).status, 201);
  } finally {demoPool.close();}
  const realPool = setup();
  try {
    await realPool.call('post').send({});
    const demoBase = `/api/invoices/${realPool.demo.id}/conversation`;
    await realPool.call('post', demoBase, 'demo').send({});
    const event = fillEventBudget(realPool.store, 6 * 1024 * 1024, 'budget-real');
    assert.equal((await realPool.call('post', `${realPool.ownerBase}/events`).send({event})).status, 429);
    assert.equal((await realPool.call('post', `${demoBase}/events`, 'demo').send({event})).status, 201);
  } finally {realPool.close();}
});

test('identity binding refreshes its snapshot under the transaction and preserves a concurrent peer binding', async () => {
  for (const competingRole of ['customerPubkey', 'merchantPubkey'] as const) {
    const f = setup();
    try {
      await f.call('post').send({});
      const originalTransaction = f.store.transaction.bind(f.store);
      const competingKey = competingRole === 'customerPubkey' ? customerPubkey : getPublicKey(generateSecretKey());
      f.store.transaction = operation => {
        f.store.transaction = originalTransaction;
        // Inject another writer's committed metadata between the route's
        // pre-transaction lookup and its acquisition of the write transaction.
        const row = f.store.db.prepare('SELECT id,data FROM marmot_conversations WHERE invoice_id=?').get(f.a.id)!;
        const data = f.store.decode<Record<string, unknown>>(row.data, 'marmot_conversations', String(row.id), 'workspace-a');
        data[competingRole] = competingKey;
        f.store.db.prepare('UPDATE marmot_conversations SET data=? WHERE id=?').run(f.store.encode(data, 'marmot_conversations', String(row.id), 'workspace-a'), row.id);
        return originalTransaction(operation);
      };
      const published = await f.call('post', `${f.ownerBase}/events`).send({event: signed(30443)});
      assert.equal(published.status, competingRole === 'customerPubkey' ? 201 : 409);
      if (competingRole === 'customerPubkey') assert.equal((await f.call('get')).body.conversation.peerPubkey, customerPubkey);
      else assert.equal((await f.call('get', f.customerBase, '')).body.conversation.peerPubkey, competingKey);
    } finally {f.close();}
  }
});

test('encrypted conversation and event rows reject ciphertext substitution between rooms and workspaces', async () => {
  const f = setup();
  try {
    const otherBase = `/api/invoices/${f.b.id}/conversation`;
    const a = await f.call('post').send({}), b = await f.call('post', otherBase, 'b').send({});
    const event = signed();
    await f.call('post', `${f.ownerBase}/events`).send({event});
    await f.call('post', `${otherBase}/events`, 'b').send({event});
    const ciphertext = f.store.db.prepare('SELECT data FROM marmot_events WHERE conversation_id=?').get(a.body.conversation.id)!.data;
    f.store.db.prepare('UPDATE marmot_events SET data=? WHERE conversation_id=?').run(ciphertext, b.body.conversation.id);
    const denied = await f.call('post', `${otherBase}/query`, 'b').send({filters: [{}]});
    assert.equal(denied.status, 500); assert.deepEqual(denied.body, {error: 'Synthetic harness failure.'});
    const roomCiphertext = f.store.db.prepare('SELECT data FROM marmot_conversations WHERE id=?').get(a.body.conversation.id)!.data;
    f.store.db.prepare('UPDATE marmot_conversations SET data=? WHERE id=?').run(roomCiphertext, b.body.conversation.id);
    assert.equal((await f.call('get', otherBase, 'b')).status, 500);
  } finally {f.close();}
});

test('an accepted signed event remains idempotently retryable after 72 hours while new old events and wrong-role retries are denied', async () => {
  const f = setup();
  try {
    await f.call('post').send({});
    await f.call('post', `${f.ownerBase}/events`).send({event: signed(30443)});
    await f.call('post', `${f.customerBase}/events`, '').send({event: signed(30443, {}, customerKey)});
    const message = signed(), welcome = signed(1059, {tags: [['p', customerPubkey]]}, generateSecretKey());
    assert.equal((await f.call('post', `${f.ownerBase}/events`).send({event: message})).status, 201);
    assert.equal((await f.call('post', `${f.ownerBase}/events`).send({event: welcome})).status, 201);
    f.setTime(new Date(date.getTime() + 73 * 3600000));
    f.sessions.a.expires = new Date(date.getTime() + 74 * 3600000).toISOString();
    const retry = await f.call('post', `${f.ownerBase}/events`).send({event: message});
    assert.equal(retry.status, 200); assert.equal(retry.body.duplicate, true);
    assert.equal((await f.call('post', `${f.ownerBase}/events`).send({event: welcome})).status, 200);
    assert.equal((await f.call('post', `${f.customerBase}/events`, '').send({event: welcome})).status, 403);
    assert.equal((await f.call('post', `${f.ownerBase}/events`).send({event: signed()})).status, 400);
    assert.equal((await f.call('post', `${f.ownerBase}/events`).send({event: {...message, content: 'tampered'}})).status, 400);
    assert.equal((await f.call('post', `${f.ownerBase}/events`).send({event: signed(445, {created_at: timestamp + 73 * 3600})})).status, 201);
  } finally {f.close();}
});
