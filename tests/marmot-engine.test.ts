import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeEvent, generateSecretKey, matchFilters, verifyEvent, type Event, type Filter } from 'nostr-tools';
import { createMarmotParticipant, MARMOT_MESSAGE_TEXT, type MarmotTransport } from '../client/marmot-engine.js';

class MemoryStore {
  private values = new Map<string, unknown>();
  async getItem(key: string): Promise<unknown | null> { return structuredClone(this.values.get(key) ?? null); }
  async setItem(key: string, value: unknown): Promise<unknown> { this.values.set(key, structuredClone(value)); return value; }
  async removeItem(key: string): Promise<void> { this.values.delete(key); }
  async clear(): Promise<void> { this.values.clear(); }
  async keys(): Promise<string[]> { return [...this.values.keys()]; }
}

function privateTransport(): MarmotTransport & { events: Event[]; additional: Event[] } {
  const events: Event[] = [];
  const additional: Event[] = [];
  return {
    events, additional,
    async publish(event) { if (!events.some(existing => existing.id === event.id)) events.push(structuredClone(event)); },
    async query(filters) { return [...events, ...additional].filter(event => matchFilters(filters as Filter[], event)); },
  };
}

test('real independent Marmot clients establish MLS membership and decrypt generic messages both ways', async t => {
  const network = privateTransport();
  const storage = new MemoryStore();
  const merchant = await createMarmotParticipant({ namespace: 'fictional-account/device-a/room-a', role: 'merchant', network, storage });
  const customer = await createMarmotParticipant({ namespace: 'fictional-account/device-b/room-a', role: 'customer', network, storage });
  try {
    assert.notEqual(merchant.pubkey, customer.pubkey);
    await customer.ensureKeyPackage();
    await merchant.createConversation(customer.pubkey);
    assert.equal(await customer.acceptInvitation(merchant.pubkey), true);
    await merchant.send('update');
    await customer.sync();
    assert.equal(customer.messages().at(-1)?.kind, 'update');
    assert.equal(customer.messages().at(-1)?.sender, merchant.pubkey);
    await customer.send('acknowledge');
    await merchant.sync();
    assert.equal(merchant.messages().at(-1)?.kind, 'acknowledge');
    assert(network.events.some(event => event.kind === 30443));
    assert(network.events.some(event => event.kind === 1059));
    assert(network.events.some(event => event.kind === 445));
    for (const text of Object.values(MARMOT_MESSAGE_TEXT)) assert(!JSON.stringify(network.events).includes(text));
    assert(!JSON.stringify(network.events).includes('fictional-account/device-a/room-a'));
    assert(network.events.every(event => [30443, 1059, 445, 5, 10050].includes(event.kind)));
    const sizes = Object.fromEntries([...new Set(network.events.map(event => event.kind))].map(kind => [kind, Math.max(...network.events.filter(event => event.kind === kind).map(event => Buffer.byteLength(JSON.stringify(event))))]));
    assert(Object.values(sizes).every(bytes => bytes <= 24576));
    t.diagnostic(`Fictional two-party maximum serialized event bytes by kind: ${JSON.stringify(sizes)}`);
    await assert.rejects(merchant.send('Invoice 100: pay $50' as never), /preset|message/i);
  } finally { await merchant.dispose(); await customer.dispose(); }
});

test('persisted local MLS state survives reload, rejects replay and stays isolated by namespace and role', async () => {
  const network = privateTransport();
  const storage = new MemoryStore();
  const namespace = 'fictional-account/device-c/room-b';
  let merchant = await createMarmotParticipant({ namespace, role: 'merchant', network, storage });
  let customer = await createMarmotParticipant({ namespace, role: 'customer', network, storage });
  try {
    await customer.ensureKeyPackage();
    await merchant.createConversation(customer.pubkey);
    await customer.acceptInvitation(merchant.pubkey);
    await merchant.send('receipt-notice');
    await customer.sync();
    const originalKey = customer.pubkey;
    const originalCount = customer.messages().length;
    await merchant.dispose(); await customer.dispose();
    merchant = await createMarmotParticipant({ namespace, role: 'merchant', network, storage });
    customer = await createMarmotParticipant({ namespace, role: 'customer', network, storage });
    assert.equal(customer.pubkey, originalKey);
    await customer.sync(); await customer.sync();
    assert.equal(customer.messages().length, originalCount);
    await merchant.send('update');
    await customer.sync();
    assert.equal(customer.messages().at(-1)?.kind, 'update');
    const stranger = await createMarmotParticipant({ namespace: 'other-account/device-c/room-b', role: 'customer', network, storage });
    try {
      assert.notEqual(stranger.pubkey, originalKey);
      assert.equal(await stranger.acceptInvitation(merchant.pubkey), false);
      assert.deepEqual(stranger.messages(), []);
    } finally { await stranger.dispose(); }
    await assert.rejects(createMarmotParticipant({ namespace, role: 'customer', network, storage }), /already open/i);
  } finally { await merchant.dispose(); await customer.dispose(); }
  await assert.rejects(customer.sync(), /disposed/i);
});

test('tampered envelopes and a valid message from another MLS group never reach conversation history', async () => {
  const network = privateTransport();
  const storage = new MemoryStore();
  const merchant = await createMarmotParticipant({ namespace: 'account/device-a/room-c', role: 'merchant', network, storage });
  const customer = await createMarmotParticipant({ namespace: 'account/device-b/room-c', role: 'customer', network, storage });
  const outsider = await createMarmotParticipant({ namespace: 'other/device-x/room-d', role: 'merchant', network, storage });
  const outsiderPeer = await createMarmotParticipant({ namespace: 'other/device-y/room-d', role: 'customer', network, storage });
  try {
    await customer.ensureKeyPackage();
    await merchant.createConversation(customer.pubkey);
    await customer.acceptInvitation(merchant.pubkey);
    await outsiderPeer.ensureKeyPackage();
    await outsider.createConversation(outsiderPeer.pubkey);
    await outsiderPeer.acceptInvitation(outsider.pubkey);
    await outsider.send('review');
    const foreign = network.events.filter(event => event.kind === 445).at(-1)!;
    await merchant.send('update');
    const legitimate = network.events.filter(event => event.kind === 445).at(-1)!;
    const tampered = { ...structuredClone(legitimate), content: `${legitimate.content.slice(0, -1)}!` };
    network.additional.push(tampered);
    const foreignInRoom = finalizeEvent({ kind: 445, content: foreign.content, tags: legitimate.tags, created_at: foreign.created_at }, generateSecretKey());
    const tamperedAndSigned = finalizeEvent({ kind: 445, content: tampered.content, tags: legitimate.tags, created_at: legitimate.created_at }, generateSecretKey());
    assert(verifyEvent(foreignInRoom)); assert(verifyEvent(tamperedAndSigned));
    network.additional.push(foreignInRoom, tamperedAndSigned);
    await customer.sync();
    assert.deepEqual(customer.messages().map(message => message.kind), ['update']);
    assert(!customer.messages().some(message => message.sender === outsider.pubkey));
  } finally {
    await merchant.dispose(); await customer.dispose(); await outsider.dispose(); await outsiderPeer.dispose();
  }
});

test('disposal never erases a persisted messaging identity even with the SDK memory store contract', async () => {
  // GenericKeyValueStore may return object references (the SDK memory backend does).
  const values = new Map<string, unknown>();
  const storage = {
    async getItem(key: string) { return values.get(key) ?? null; },
    async setItem(key: string, value: unknown) { values.set(key, value); return value; },
    async removeItem(key: string) { values.delete(key); },
    async clear() { values.clear(); },
    async keys() { return [...values.keys()]; },
  };
  const network = privateTransport();
  const options = { namespace: 'account/device-e/room-e', role: 'customer' as const, network, storage };
  const first = await createMarmotParticipant(options);
  const pubkey = first.pubkey;
  await first.dispose();
  const second = await createMarmotParticipant(options);
  try { assert.equal(second.pubkey, pubkey); } finally { await second.dispose(); }
});

test('failed Welcome delivery remains recoverable and rejected outbound messages never appear sent', async () => {
  const network = privateTransport();
  const storage = new MemoryStore();
  const originalPublish = network.publish.bind(network);
  let rejectWelcome = true;
  let rejectMessage = false;
  network.publish = async event => {
    if (rejectWelcome && event.kind === 1059) throw new Error('Fictional delivery offline');
    if (rejectMessage && event.kind === 445) throw new Error('Fictional delivery offline');
    await originalPublish(event);
  };
  const merchantOptions = { namespace: 'account/device-f/room-f', role: 'merchant' as const, network, storage };
  let merchant = await createMarmotParticipant(merchantOptions);
  const customer = await createMarmotParticipant({ namespace: 'account/device-g/room-f', role: 'customer', network, storage });
  try {
    await customer.ensureKeyPackage();
    await assert.rejects(merchant.createConversation(customer.pubkey), /invitation.*delivered/i);
    assert.equal(await customer.acceptInvitation(merchant.pubkey), false);
    await merchant.dispose();
    merchant = await createMarmotParticipant(merchantOptions);
    rejectWelcome = false;
    await merchant.createConversation(customer.pubkey);
    assert.equal(await customer.acceptInvitation(merchant.pubkey), true);
    rejectMessage = true;
    await assert.rejects(merchant.send('update'), /offline/);
    assert.deepEqual(merchant.messages(), []);
    rejectMessage = false;
    await merchant.send('review');
    await customer.sync();
    // Nostr timestamps have second precision; delivery within one second need not
    // sort causally. Both recovered and new messages must arrive exactly once.
    assert.deepEqual(customer.messages().map(message => message.kind).sort(), ['review', 'update']);
    assert.equal(new Set(customer.messages().map(message => message.id)).size, 2);
  } finally { await merchant.dispose(); await customer.dispose(); }
});

test('uncertain delivery retries the exact encrypted envelope after reload without duplicate messages', async () => {
  const network = privateTransport();
  const storage = new MemoryStore();
  const options = { namespace: 'account/device-h/room-h', role: 'merchant' as const, network, storage };
  let merchant = await createMarmotParticipant(options);
  const customer = await createMarmotParticipant({ ...options, namespace: 'account/device-i/room-h', role: 'customer' });
  const originalPublish = network.publish.bind(network);
  const attempts: string[] = [];
  let failAcknowledgment = true;
  network.publish = async event => {
    await originalPublish(event);
    if (event.kind === 445) {
      attempts.push(event.id);
      if (failAcknowledgment) throw new Error('Fictional acknowledgment interrupted');
    }
  };
  try {
    await customer.ensureKeyPackage();
    await merchant.createConversation(customer.pubkey);
    await customer.acceptInvitation(merchant.pubkey);
    await assert.rejects(merchant.send('update'), /interrupted/);
    await customer.sync();
    assert.equal(customer.messages().length, 1);
    await merchant.dispose();
    merchant = await createMarmotParticipant(options);
    failAcknowledgment = false;
    await merchant.sync();
    await customer.sync();
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0], attempts[1]);
    assert.deepEqual(merchant.messages().map(message => message.kind), ['update']);
    assert.equal(customer.messages().length, 1);
  } finally { await merchant.dispose(); await customer.dispose(); }
});
