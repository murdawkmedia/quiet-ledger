import {
  MarmotClient, createApplicationMessageIntent, createChatRumor,
  deserializeApplicationData, getGroupMemberPubkeys,
  type GenericKeyValueStore, type MarmotGroup, type NostrNetworkInterface,
} from '@internet-privacy/marmot-ts';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type Filter } from 'nostr-tools';
import { v2 as nip44 } from 'nostr-tools/nip44';

/** The only application text admitted to this experimental messaging channel. */
export const MARMOT_MESSAGE_TEXT = {
  update: 'A private update is available. Review it in Quiet Ledger.',
  acknowledge: 'I acknowledge the private update.',
  review: 'Please review the details in Quiet Ledger.',
  'receipt-notice': 'A receipt is ready. Open it in Quiet Ledger.',
} as const;

export type MarmotMessageKind = keyof typeof MARMOT_MESSAGE_TEXT;
export type MarmotRole = 'merchant' | 'customer';
export interface MarmotMessage { id: string; kind: MarmotMessageKind; text: string; sender: string; createdAt: number; }
/** Same-origin, authenticated, room-scoped HTTP delivery. This does not open a relay connection. */
export interface MarmotTransport { publish(event: Event): Promise<void>; query(filters: Filter[]): Promise<Event[]>; }
export interface MarmotParticipant {
  readonly pubkey: string;
  ensureKeyPackage(): Promise<void>;
  createConversation(peerPubkey: string): Promise<void>;
  acceptInvitation(expectedPeerPubkey: string): Promise<boolean>;
  sync(): Promise<void>;
  send(kind: MarmotMessageKind): Promise<void>;
  messages(): MarmotMessage[];
  conversation(): { ready: boolean; peerPubkey?: string };
  dispose(): Promise<void>;
}
export interface MarmotParticipantOptions {
  /** Opaque account + device + room identifiers. Never reuse this across devices or accounts. */
  namespace: string;
  role: MarmotRole;
  network: MarmotTransport;
  storage?: GenericKeyValueStore<unknown>;
}

// A routing label required by SDK metadata validation. No WebSocket is opened,
// and neither a public relay nor an externally supplied relay URL is accepted.
const PRIVATE_ROUTE = 'wss://quiet-ledger.invalid/';
const GROUP_NAME = 'Quiet Ledger private conversation';
const ALLOWED_OUTER_KINDS = new Set([30443, 1059, 445, 5, 10050]);
const OPEN_NAMESPACES = new Set<string>();
const MAX_MESSAGES = 200;
const PUBKEY = /^[0-9a-f]{64}$/;
type ApplicationRumor = ReturnType<typeof createChatRumor>;
type StoredEnvelope = { event: Event; application?: ApplicationRumor };

function randomHex(length = 32): string {
  return [...crypto.getRandomValues(new Uint8Array(length))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function namespaceHash(namespace: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(namespace));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function scopedStore<T>(storage: GenericKeyValueStore<unknown>, prefix: string): GenericKeyValueStore<T> {
  const scope = `${prefix}:`;
  return {
    async getItem(key) { return await storage.getItem(`${scope}${key}`) as T | null; },
    async setItem(key, value) { await storage.setItem(`${scope}${key}`, value); return value; },
    removeItem: key => storage.removeItem(`${scope}${key}`),
    async clear() { for (const key of await storage.keys()) if (key.startsWith(scope)) await storage.removeItem(key); },
    async keys() { return (await storage.keys()).filter(key => key.startsWith(scope)).map(key => key.slice(scope.length)); },
  };
}

/** Structured-clone IndexedDB backend: MLS typed arrays/BigInts never become JSON. */
export async function createMarmotBrowserStore(): Promise<GenericKeyValueStore<unknown> & { close(): void }> {
  if (!globalThis.indexedDB) throw new Error('Private messaging needs browser IndexedDB storage.');
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('quiet-ledger-marmot-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('entries');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Private messaging storage could not open.'));
  });
  const run = <T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
    const transaction = database.transaction('entries', mode);
    const request = operation(transaction.objectStore('entries'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = transaction.onabort = () => reject(new Error('Private messaging storage operation failed.'));
  });
  return {
    async getItem(key) { return await run('readonly', store => store.get(key)) ?? null; },
    async setItem(key, value) { await run('readwrite', store => store.put(value, key)); return value; },
    async removeItem(key) { await run('readwrite', store => store.delete(key)); },
    async clear() { await run('readwrite', store => store.clear()); },
    async keys() { return (await run('readonly', store => store.getAllKeys())).map(String); },
    close() { database.close(); },
  };
}

/** A random browser installation label, independent from authentication/wallet keys. */
export async function getMarmotDeviceId(): Promise<string> {
  const storage = await createMarmotBrowserStore();
  try {
    const previous = await storage.getItem('browser-device-id');
    if (typeof previous === 'string' && PUBKEY.test(previous)) return previous;
    const id = randomHex();
    await storage.setItem('browser-device-id', id);
    return id;
  } finally { storage.close(); }
}

async function reserveNamespace(namespace: string): Promise<() => void> {
  if (OPEN_NAMESPACES.has(namespace)) throw new Error('This private conversation is already open on this device.');
  OPEN_NAMESPACES.add(namespace);
  let unlock: (() => void) | undefined;
  try {
    // A single MLS ratchet writer per device/account/role/room, including tabs.
    if (typeof navigator !== 'undefined' && navigator.locks) {
      unlock = await new Promise<() => void>((resolve, reject) => {
        void navigator.locks.request(`quiet-ledger-marmot:${namespace}`, { ifAvailable: true }, async lock => {
          if (!lock) { reject(new Error('This private conversation is already open in another tab.')); return; }
          await new Promise<void>(release => resolve(release));
        }).catch(reject);
      });
    }
    return () => { OPEN_NAMESPACES.delete(namespace); unlock?.(); };
  } catch (error) { OPEN_NAMESPACES.delete(namespace); throw error; }
}

function privateNetwork(
  transport: MarmotTransport,
  outbox: GenericKeyValueStore<StoredEnvelope>,
  currentApplication: () => ApplicationRumor | undefined,
  acknowledge: (application: ApplicationRumor) => Promise<void>,
): NostrNetworkInterface & { flushPending(): Promise<void> } {
  const assertRoute = (relays: string[]) => {
    if (!relays.length || relays.some(relay => relay !== PRIVATE_ROUTE)) throw new Error('External relay delivery is disabled.');
  };
  const network: NostrNetworkInterface & { flushPending(): Promise<void> } = {
    async publish(relays, event) {
      assertRoute(relays);
      if (!ALLOWED_OUTER_KINDS.has(event.kind) || new TextEncoder().encode(JSON.stringify(event)).length > 24576) {
        throw new Error('Private messaging event is outside the permitted delivery bounds.');
      }
      const previous = await outbox.getItem(event.id);
      const application = previous?.application ?? (event.kind === 445 ? currentApplication() : undefined);
      // Persist the signed ciphertext before the HTTP request. A lost response
      // retries these exact bytes, including across a page reload.
      await outbox.setItem(event.id, { event, ...(application ? { application } : {}) });
      await transport.publish(event);
      if (application) await acknowledge(application);
      await outbox.removeItem(event.id);
      return { [PRIVATE_ROUTE]: { from: PRIVATE_ROUTE, ok: true } };
    },
    async request(relays, filters) { assertRoute(relays); return transport.query(Array.isArray(filters) ? filters : [filters]); },
    subscription(relays, filters) {
      assertRoute(relays);
      // Explicit sync drives inbound events. No timer/socket/background network.
      void filters;
      return { subscribe() { return { unsubscribe() {} }; } };
    },
    async getUserInboxRelays() { return [PRIVATE_ROUTE]; },
    async flushPending() {
      for (const id of await outbox.keys()) {
        const pending = await outbox.getItem(id);
        if (pending) await network.publish([PRIVATE_ROUTE], pending.event);
      }
    },
  };
  return network;
}

/**
 * Experimental real Marmot/MLS session. App-generated throwaway messaging keys
 * and MLS state stay in this browser's scoped store; never import wallet keys.
 * The caller must dispose on account/room changes and logout. Clearing browser
 * data loses access; this module does not copy group state to another device.
 */
export async function createMarmotParticipant(options: MarmotParticipantOptions): Promise<MarmotParticipant> {
  if (!options.namespace || options.namespace.length > 512 || !['merchant', 'customer'].includes(options.role)) {
    throw new Error('Private messaging requires an isolated account/device/room namespace and role.');
  }
  const scope = `${await namespaceHash(options.namespace)}:${options.role}`;
  const release = await reserveNamespace(scope);
  const ownedStorage = options.storage ? undefined : await createMarmotBrowserStore().catch(error => { release(); throw error; });
  const storage = options.storage ?? ownedStorage!;
  let secret: Uint8Array | undefined;
  let client: MarmotClient | undefined;
  let group: MarmotGroup | undefined;
  let disposed = false;
  let queue: Promise<unknown> = Promise.resolve();
  try {
    const metadata = scopedStore<unknown>(storage, `${scope}:metadata`);
    const previousSecret = await metadata.getItem('messaging-key');
    if (previousSecret !== null && (!(previousSecret instanceof Uint8Array) || previousSecret.length !== 32)) {
      throw new Error('Private messaging identity storage is invalid.');
    }
    // Always own a separate byte buffer so disposal cannot zero a by-reference
    // GenericKeyValueStore's persisted identity.
    secret = previousSecret instanceof Uint8Array ? new Uint8Array(previousSecret) : generateSecretKey();
    if (previousSecret === null) await metadata.setItem('messaging-key', new Uint8Array(secret));
    const signingSecret = secret;
    const pubkey = getPublicKey(secret);
    const previousSlot = await metadata.getItem('key-package-slot');
    const clientId = typeof previousSlot === 'string' && PUBKEY.test(previousSlot) ? previousSlot : randomHex();
    if (!previousSlot) await metadata.setItem('key-package-slot', clientId);
    let activeApplication: ApplicationRumor | undefined;
    let acknowledgeApplication: (application: ApplicationRumor) => Promise<void> = async () => {};
    const network = privateNetwork(options.network, scopedStore(storage, `${scope}:outbox`), () => activeApplication, application => acknowledgeApplication(application));
    client = new MarmotClient({
      clientId, network,
      signer: {
        getPublicKey: () => pubkey,
        signEvent: draft => { if (disposed) throw new Error('Private messaging participant is disposed.'); return finalizeEvent(draft, signingSecret); },
        nip44: {
          encrypt: (peer, text) => nip44.encrypt(text, nip44.utils.getConversationKey(signingSecret, peer)),
          decrypt: (peer, ciphertext) => nip44.decrypt(ciphertext, nip44.utils.getConversationKey(signingSecret, peer)),
        },
      },
      groupStateStore: scopedStore(storage, `${scope}:groups`),
      keyPackageStore: scopedStore(storage, `${scope}:key-packages`),
      inviteStore: scopedStore(storage, `${scope}:invites`),
      ingestStateStore: scopedStore(storage, `${scope}:ingest`),
      rewindStore: scopedStore(storage, `${scope}:rewind`),
      removedMarkerStore: scopedStore(storage, `${scope}:removed`),
    });
    const sdk = client;
    const savedRoom = await metadata.getItem('conversation') as { groupId: string; peerPubkey: string } | null;
    let peerPubkey: string | undefined = savedRoom?.peerPubkey;
    const savedMessages = await metadata.getItem('messages');
    let history: MarmotMessage[] = Array.isArray(savedMessages) ? savedMessages.filter(value => value && typeof value === 'object' && 'kind' in value && Object.hasOwn(MARMOT_MESSAGE_TEXT, value.kind)).slice(-MAX_MESSAGES) as MarmotMessage[] : [];
    const addMessage = (rumor: ReturnType<typeof createChatRumor>) => {
      if (!group || rumor.kind !== 9 || ![pubkey, peerPubkey].includes(rumor.pubkey) || !getGroupMemberPubkeys(group.state).includes(rumor.pubkey)) return;
      const kind = (Object.keys(MARMOT_MESSAGE_TEXT) as MarmotMessageKind[]).find(key => MARMOT_MESSAGE_TEXT[key] === rumor.content);
      if (!kind || history.some(message => message.id === rumor.id)) return;
      history = [...history, { id: rumor.id, kind, text: MARMOT_MESSAGE_TEXT[kind], sender: rumor.pubkey, createdAt: rumor.created_at }].slice(-MAX_MESSAGES);
    };
    acknowledgeApplication = async application => {
      addMessage(application);
      await metadata.setItem('messages', history);
    };
    const listen = (current: MarmotGroup) => {
      current.on('applicationMessage', data => {
        try { addMessage(deserializeApplicationData(data)); } catch { /* Invalid application data never becomes UI text. */ }
      });
    };
    if (savedRoom) {
      group = await sdk.groups.get(savedRoom.groupId);
      listen(group);
    }
    const assertOpen = () => { if (disposed) throw new Error('Private messaging participant is disposed.'); };
    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = queue.then(() => { assertOpen(); return operation(); });
      queue = result.catch(() => {});
      return result;
    };
    const rememberGroup = async (current: MarmotGroup, peer: string) => {
      const members = getGroupMemberPubkeys(current.state);
      if (members.length !== 2 || !members.includes(pubkey) || !members.includes(peer) || current.groupData?.name !== GROUP_NAME || !current.relays?.length || current.relays.some(relay => relay !== PRIVATE_ROUTE)) {
        current.dispose();
        throw new Error('Private conversation membership or delivery route did not match.');
      }
      group = current; peerPubkey = peer; listen(current);
      await metadata.setItem('conversation', { groupId: current.idStr, peerPubkey: peer });
    };
    const sync = async () => {
      await network.flushPending();
      if (!group || !group.groupData?.nostrGroupId) return;
      const groupTag = [...group.groupData.nostrGroupId].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const events = await network.request([PRIVATE_ROUTE], [{ kinds: [445], '#h': [groupTag], limit: 40 }]);
      // Validate route selection locally as well as at the private HTTP boundary.
      const inRoom = events.filter(event => event.kind === 445 && event.tags.filter(tag => tag[0] === 'h').length === 1 && event.tags.some(tag => tag[0] === 'h' && tag[1] === groupTag));
      for await (const _result of group.ingest(inRoom)) { /* SDK verifies signatures, MLS group, sender and replay state. */ }
      await metadata.setItem('messages', history);
    };
    return {
      pubkey,
      ensureKeyPackage: () => serialize(async () => { await sdk.keyPackages.ensurePublished({ relays: [PRIVATE_ROUTE], client: 'Quiet Ledger experimental messaging' }); }),
      createConversation: peer => serialize(async () => {
        if (options.role !== 'merchant' || !PUBKEY.test(peer) || peer === pubkey) throw new Error('A merchant and a distinct customer messaging identity are required.');
        if (group) {
          if (peerPubkey !== peer) throw new Error('This private conversation is already bound to another participant.');
          await network.flushPending();
          return;
        }
        const candidates = await network.request([PRIVATE_ROUTE], [{ kinds: [30443], authors: [peer], limit: 10 }]);
        const keyPackage = candidates.filter(event => event.kind === 30443 && event.pubkey === peer).sort((a, b) => b.created_at - a.created_at)[0];
        if (!keyPackage) throw new Error('The customer has not published a private messaging key package yet.');
        const current = await sdk.groups.create(GROUP_NAME, { description: 'Generic private status updates only.', relays: [PRIVATE_ROUTE], adminPubkeys: [pubkey], invitees: [keyPackage] });
        await rememberGroup(current, peer);
        if (current.pendingWelcomes.length) throw new Error('The encrypted invitation could not be delivered. Retry this conversation.');
      }),
      acceptInvitation: expectedPeer => serialize(async () => {
        if (options.role !== 'customer' || !PUBKEY.test(expectedPeer) || expectedPeer === pubkey) throw new Error('A customer and an expected merchant messaging identity are required.');
        if (group) {
          if (peerPubkey !== expectedPeer) throw new Error('This private conversation is already bound to another participant.');
          return true;
        }
        const wraps = await network.request([PRIVATE_ROUTE], [{ kinds: [1059], '#p': [pubkey], limit: 40 }]);
        for (const event of wraps) if (event.kind === 1059) await sdk.invites.ingestEvent(event);
        await sdk.invites.decryptGiftWraps();
        for (const invite of await sdk.invites.getUnread()) {
          if (invite.pubkey !== expectedPeer) continue;
          const preview = await sdk.previewWelcome(invite);
          if (!preview.group || preview.group.name !== GROUP_NAME || preview.group.relays.some(relay => relay !== PRIVATE_ROUTE) || !preview.group.adminPubkeys.includes(expectedPeer)) continue;
          const joined = await sdk.joinGroupFromWelcome({ welcomeRumor: invite });
          await rememberGroup(joined.group, expectedPeer);
          await sdk.invites.markAsRead(invite.id);
          await sync();
          return true;
        }
        return false;
      }),
      sync: () => serialize(sync),
      send: kind => serialize(async () => {
        if (!Object.hasOwn(MARMOT_MESSAGE_TEXT, kind)) throw new Error('Only preset private message kinds are permitted.');
        if (!group || !peerPubkey) throw new Error('Establish a private conversation first.');
        await sync();
        const rumor = createChatRumor({ pubkey, content: MARMOT_MESSAGE_TEXT[kind], tags: [['nonce', randomHex(16)]] });
        activeApplication = rumor;
        try { await sdk.groups.send(group.id, createApplicationMessageIntent(rumor)); }
        finally { activeApplication = undefined; }
        addMessage(rumor);
        await metadata.setItem('messages', history);
      }),
      messages() { assertOpen(); return history.map(message => ({ ...message })); },
      conversation() { assertOpen(); return { ready: !!group, ...(peerPubkey ? { peerPubkey } : {}) }; },
      async dispose() {
        if (disposed) return;
        disposed = true;
        // Stop outbound SDK timers immediately, then settle the serialized work.
        for (const current of sdk.groups.loaded) current.dispose();
        await queue.catch(() => {});
        sdk.groups.removeAllListeners(); sdk.invites.removeAllListeners(); sdk.keyPackages.removeAllListeners();
        signingSecret.fill(0);
        history = [];
        ownedStorage?.close();
        release();
      },
    };
  } catch (error) {
    disposed = true;
    for (const current of client?.groups.loaded ?? []) current.dispose();
    secret?.fill(0); ownedStorage?.close(); release();
    throw error;
  }
}
