import {randomUUID, timingSafeEqual} from 'node:crypto';
import {Router, type Request, type Response} from 'express';
import {verifyEvent, type Event, type Filter} from 'nostr-tools';
import {z} from 'zod';
import {parse} from './domain.js';
import {DomainError, type Store, type StoredSession} from './store.js';
import type {Invoice} from '../shared/contracts.js';

export interface MarmotConversationsOptions {
  store: Store;
  now: () => Date;
  publicOrigin?: string;
  /** The parent validates session expiry and any hackathon-demo visit membership. */
  getSession: (req: Request, res: Response) => StoredSession | undefined;
  /** Denies expired/disabled demo workspaces on customer-token routes. */
  assertPublicWorkspace?: (workspace: string) => void;
  /** Classifies retained demo rows, including expired visits awaiting cleanup. */
  isDemoWorkspace?: (workspace: string) => boolean;
}
type Role = 'merchant' | 'customer';
type ConversationData = {version: 1; createdAt: string; merchantPubkey?: string; customerPubkey?: string};
type Room = {id: string; data: ConversationData};
type Access = {workspace: string; invoice: Invoice; role: Role; transportBase: string};
const kinds = new Set([30443, 1059, 445, 5, 10050]);
const hex = /^[0-9a-f]{64}$/;
const empty = z.object({}).strict();
const eventSchema = z.object({
  id: z.string().regex(hex), pubkey: z.string().regex(hex), sig: z.string().regex(/^[0-9a-f]{128}$/),
  created_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  kind: z.number().int().refine(value => kinds.has(value), 'Unsupported private event kind.'),
  tags: z.array(z.array(z.string().max(1024)).max(64)).max(64),
  content: z.string().max(24576),
}).strict();
const eventBody = z.object({event: eventSchema}).strict();
const queryBody = z.object({filters: z.array(z.record(z.string(), z.unknown())).min(1).max(8)}).strict();
function fail(status: number, message: string): never {throw new DomainError(status, message);}

function filtersFrom(body: unknown): Filter[] {
  const {filters} = parse(queryBody, body);
  for (const filter of filters) {
    for (const [key, value] of Object.entries(filter)) {
      if (['since', 'until', 'limit'].includes(key)) {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (key === 'limit' ? 1 : 0) || (key === 'limit' && value > 40)) fail(400, 'Invalid private event query bound.');
      } else if (['ids', 'authors', 'kinds'].includes(key) || /^#[a-zA-Z0-9]$/.test(key)) {
        if (!Array.isArray(value) || !value.length || value.length > 40) fail(400, 'Invalid private event query values.');
        for (const entry of value) {
          if (key === 'kinds' ? typeof entry !== 'number' || !kinds.has(entry) : typeof entry !== 'string' || (['ids', 'authors'].includes(key) ? !hex.test(entry) : !entry.length || entry.length > 1024)) fail(400, 'Invalid private event query value.');
        }
      } else fail(400, 'Unsupported private event query field.');
    }
    if (typeof filter.since === 'number' && typeof filter.until === 'number' && filter.since > filter.until) fail(400, 'Invalid private event time range.');
  }
  return filters as Filter[];
}
function matches(event: Event, filter: Filter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  return Object.entries(filter).every(([name, values]) => !name.startsWith('#') || event.tags.some(tag => tag[0] === name.slice(1) && (values as string[]).includes(tag[1])));
}

/** Private authenticated delivery only. This router never connects to a Nostr relay. */
export function createMarmotConversationsRouter(options: MarmotConversationsOptions): Router {
  const {store, now} = options;
  if (options.publicOrigin && new URL(options.publicOrigin).origin !== options.publicOrigin) throw new Error('Marmot delivery requires an exact public origin.');
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS marmot_conversations(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,invoice_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS marmot_events(conversation_id TEXT REFERENCES marmot_conversations(id),workspace TEXT,id TEXT,created_at INTEGER,kind INTEGER,data TEXT,PRIMARY KEY(conversation_id,id));
    CREATE INDEX IF NOT EXISTS marmot_event_workspace ON marmot_events(workspace);
  `);
  const router = Router();
  function access(req: Request, res: Response, customer: boolean): Access {
    res.set('Cache-Control', 'no-store');
    if (req.headers.authorization !== undefined || res.locals.apiAccess) fail(403, 'API bearer access cannot use private conversations.');
    if (Object.keys(req.query).length) fail(400, 'Private conversation URLs do not accept query parameters.');
    let invoice: Invoice | undefined, workspace: string, role: Role;
    if (customer) {
      const token = String(req.params.token ?? '');
      const found = /^[A-Za-z0-9_-]{43}$/.test(token) ? store.getCheckout(token) : undefined;
      if (!found) fail(404, 'Private invoice conversation not found.');
      options.assertPublicWorkspace?.(found.workspace);
      invoice = found.invoice; workspace = found.workspace; role = 'customer';
    } else {
      const session = options.getSession(req, res) as (StoredSession & {hackathonDemo?: boolean}) | undefined;
      if (!session || !Number.isFinite(Date.parse(session.expires)) || Date.parse(session.expires) <= now().getTime()) fail(401, 'Sign in to open a private conversation.');
      if (!(session.role === 'owner' || (session.role === 'demo' && session.hackathonDemo === true)) || typeof session.workspace !== 'string' || !session.workspace) fail(403, 'This session cannot use private conversations.');
      workspace = session.workspace; role = 'merchant';
      const id = String(req.params.id ?? '');
      invoice = /^[A-Za-z0-9_-]{1,128}$/.test(id) ? store.getInvoice(id, workspace) : undefined;
      if (!invoice) fail(404, 'Private invoice conversation not found.');
      if (req.method === 'POST') {
        const received = req.get('x-csrf-token');
        if (!received || typeof session.csrf !== 'string' || !session.csrf || received.length > 512 || Buffer.byteLength(received) !== Buffer.byteLength(session.csrf) || !timingSafeEqual(Buffer.from(received), Buffer.from(session.csrf))) fail(403, 'The session security token is missing or invalid.');
      }
    }
    if (req.method === 'POST') {
      const expected = options.publicOrigin ?? res.locals.publicOrigin ?? `${req.protocol}://${req.get('host')}`;
      if (req.get('origin') !== expected || req.get('sec-fetch-site') === 'cross-site') fail(403, 'Private conversation writes require the exact same origin.');
    }
    if (!store.encrypted) fail(503, 'Private conversations require encrypted server storage.');
    return {workspace, invoice: invoice!, role, transportBase: customer ? `/api/checkout/${encodeURIComponent(String(req.params.token))}/conversation` : `/api/invoices/${encodeURIComponent(invoice!.id)}/conversation`};
  }
  function readRoom(authorized: Access): Room | undefined {
    const row = store.db.prepare('SELECT id,data FROM marmot_conversations WHERE invoice_id=? AND workspace=?').get(authorized.invoice.id, authorized.workspace);
    return row ? {id: String(row.id), data: store.decode<ConversationData>(row.data, 'marmot_conversations', String(row.id), authorized.workspace)} : undefined;
  }
  function view(authorized: Access, room: Room) {
    const {number, title, customerName, currency, total, status, createdAt, settlementMode} = authorized.invoice;
    const peerPubkey = authorized.role === 'merchant' ? room.data.customerPubkey : room.data.merchantPubkey;
    return {conversation: {id: room.id, role: authorized.role, transportBase: authorized.transportBase, ...(peerPubkey ? {peerPubkey} : {})}, invoice: {number, title, customerName, currency, total, status, createdAt, ...(settlementMode ? {settlementMode} : {})}};
  }
  // The existing qlr:v1 AES-GCM encoding is base64url(ciphertext+12-byte nonce+
  // 16-byte tag); its ciphertext length equals the exact serialized event bytes.
  // This totals payload sizes without decrypting unrelated tenants' event data.
  const byteSum = 'COALESCE(SUM((length(data)-7)*3/4-28),0)';
  function acceptEvent(authorized: Access, room: Room, event: Event): boolean {
    return store.transaction(() => {
      // Re-read after acquiring SQLite's write lock so another process cannot
      // overwrite a peer binding made while this request waited for the lock.
      const current = readRoom(authorized);
      if (!current || current.id !== room.id) fail(404, 'Private conversation not found.');
      room.data = current.data;
      const bound = authorized.role === 'merchant' ? room.data.merchantPubkey : room.data.customerPubkey;
      const peer = authorized.role === 'merchant' ? room.data.customerPubkey : room.data.merchantPubkey;
      if (event.kind === 30443 && ((bound && bound !== event.pubkey) || peer === event.pubkey)) fail(409, 'This conversation is already bound to a different device messaging identity.');
      if ([5, 10050].includes(event.kind) && (!bound || bound !== event.pubkey)) fail(409, 'Publish this device messaging key package first.');
      if (event.kind === 1059) {
        if (authorized.role !== 'merchant') fail(403, 'Only the merchant can deliver a private Welcome.');
        const recipients = event.tags.filter(tag => tag[0] === 'p');
        if (!room.data.customerPubkey || recipients.length !== 1 || recipients[0][1] !== room.data.customerPubkey) fail(400, 'The encrypted Welcome must address this conversation customer.');
      }
      const existing = store.db.prepare('SELECT 1 FROM marmot_events WHERE conversation_id=? AND id=? AND workspace=?').get(room.id, event.id, authorized.workspace);
      if (existing) return true;
      // A previously accepted signed artifact stays retryable after a lost HTTP
      // acknowledgment, even when its original timestamp has aged out. Fresh
      // artifacts still obey the admission window; scoped role checks above
      // apply equally to duplicates.
      const time = Math.floor(now().getTime() / 1000);
      if (event.created_at < time - 72 * 3600 || event.created_at > time + 600) fail(400, 'Private event timestamp is outside the accepted window.');
      const bytes = Buffer.byteLength(JSON.stringify(event));
      const roomUsage = store.db.prepare(`SELECT COUNT(*) n,${byteSum} bytes FROM marmot_events WHERE conversation_id=?`).get(room.id)!;
      const workspaceBytes = Number(store.db.prepare(`SELECT ${byteSum} bytes FROM marmot_events WHERE workspace=?`).get(authorized.workspace)!.bytes);
      const globalBytes = Number(store.db.prepare(`SELECT ${byteSum} bytes FROM marmot_events`).get()!.bytes);
      const demo = options.isDemoWorkspace?.(authorized.workspace) === true;
      const partitionBytes = store.db.prepare(`SELECT workspace,${byteSum} bytes FROM marmot_events GROUP BY workspace`).all().reduce((total, row) => total + ((options.isDemoWorkspace?.(String(row.workspace)) === true) === demo ? Number(row.bytes) : 0), 0);
      if (Number(roomUsage.n) >= 128 || Number(roomUsage.bytes) + bytes > 512 * 1024 || workspaceBytes + bytes > 1024 * 1024 || globalBytes + bytes > 8 * 1024 * 1024 || partitionBytes + bytes > (demo ? 2 : 6) * 1024 * 1024) fail(429, 'This private messaging preview has reached its event storage limit. Existing messages remain available.');
      store.assertWriteBudget();
      if (event.kind === 30443 && !bound) {
        if (authorized.role === 'merchant') room.data.merchantPubkey = event.pubkey; else room.data.customerPubkey = event.pubkey;
        store.db.prepare('UPDATE marmot_conversations SET data=? WHERE id=? AND workspace=?').run(store.encode(room.data, 'marmot_conversations', room.id, authorized.workspace), room.id, authorized.workspace);
      }
      store.db.prepare('INSERT INTO marmot_events(conversation_id,workspace,id,created_at,kind,data) VALUES(?,?,?,?,?,?)').run(room.id, authorized.workspace, event.id, event.created_at, event.kind, store.encode(event, 'marmot_events', `${room.id}:${event.id}`, authorized.workspace));
      return false;
    });
  }
  for (const customer of [false, true]) {
    const path = customer ? '/api/checkout/:token/conversation' : '/api/invoices/:id/conversation';
    router.get(path, (req, res) => {const authorized = access(req, res, customer), room = readRoom(authorized); if (!room) fail(404, 'Private conversation has not started.'); res.json(view(authorized, room));});
    router.post(path, (req, res) => {
      const authorized = access(req, res, customer); parse(empty, req.body);
      const result = store.transaction(() => {
        const previous = readRoom(authorized); if (previous) return {room: previous, created: false};
        store.assertWriteBudget();
        const room: Room = {id: randomUUID(), data: {version: 1, createdAt: now().toISOString()}};
        store.db.prepare('INSERT INTO marmot_conversations(id,workspace,invoice_id,data) VALUES(?,?,?,?)').run(room.id, authorized.workspace, authorized.invoice.id, store.encode(room.data, 'marmot_conversations', room.id, authorized.workspace));
        return {room, created: true};
      });
      res.status(result.created ? 201 : 200).json(view(authorized, result.room));
    });
    router.post(`${path}/events`, (req, res) => {
      const authorized = access(req, res, customer), room = readRoom(authorized);
      if (!room) fail(404, 'Private conversation has not started.');
      const {event} = parse(eventBody, req.body);
      if (Buffer.byteLength(JSON.stringify(event)) > 24576) fail(413, 'Private messaging event is too large.');
      try {if (!verifyEvent(event)) fail(400, 'Private event signature is invalid.');} catch (error) {if (error instanceof DomainError) throw error; fail(400, 'Private event signature is invalid.');}
      const duplicate = acceptEvent(authorized, room, event);
      res.status(duplicate ? 200 : 201).json({ok: true, duplicate});
    });
    router.post(`${path}/query`, (req, res) => {
      const authorized = access(req, res, customer), room = readRoom(authorized);
      if (!room) fail(404, 'Private conversation has not started.');
      const filters = filtersFrom(req.body);
      const events = store.db.prepare('SELECT id,data FROM marmot_events WHERE conversation_id=? AND workspace=? ORDER BY created_at DESC,id ASC LIMIT 128').all(room.id, authorized.workspace).map(row => store.decode<Event>(row.data, 'marmot_events', `${room.id}:${String(row.id)}`, authorized.workspace));
      const result = new Map<string, Event>();
      for (const filter of filters) for (const event of events.filter(event => matches(event, filter)).slice(0, filter.limit ?? 40)) {if (result.size < 40) result.set(event.id, event);}
      res.json({events: [...result.values()]});
    });
  }
  return router;
}
