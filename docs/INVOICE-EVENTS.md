# Durable invoice events

Stage 3 of the merchant receiving build: an encrypted, workspace-scoped,
append-only event journal that records real live payments inside the ledger
payment transaction, plus a read-only authenticated pull API for polling by
n8n/accounting. This is a pull interface only — there is no POST/ack route, no
webhook, no signing key and no outbound delivery. Simulation actions, credits,
voids and legacy records never emit events.

## Modules

- `shared/invoice-events.ts` — payload contract (`InvoiceEvent`,
  `InvoiceEventPage`, `INVOICE_EVENT_TYPES`). No runtime dependencies.
- `server/invoice-events.ts` — `InvoiceEvents` journal: append-only encrypted
  storage, per-workspace sequences, deterministic ids, cursor authentication.
- `server/invoice-events-router.ts` — `invoiceEventsRouter(events)` read-only
  Express router.
- `server/invoice-ledger.ts` — the narrow `payment()` hook (see below).

## Emission rules

`InvoiceLedger.payment()` wraps the ledger append, the before/after
authoritative balances and the event generation in one `Store.transaction()`
(nested calls reuse the caller's outer transaction, e.g.
`ReceivingService.commit()`):

1. Contradictory entries are rejected (400): the entry must be a `payment`
   whose amount, currency and method agree with the receipt and invoice
   currency.
2. Simulation receipts stay append-compatible with the existing internal API
   but emit zero events.
3. Every new live receipt emits exactly one `payment.received`.
4. `invoice.paid` is emitted only on a genuine
   unpaid/partially-paid/credited → paid transition where real payments reach the effective
   agreed total. Credit-assisted closure stays `credited`, never paid, and an
   overpayment may produce a later `payment.received` while `invoice.paid`
   remains a one-time threshold transition. Legacy synthesized paid entries
   cannot re-emit it.

Rows are written inside the payment transaction via
`InvoiceEvents.appendReceipt()`. A storage failure (for example `SQLITE_FULL`
or a full page budget) rolls the whole payment back with
`DomainError(503,'Invoice event storage is unavailable; the payment was not
credited. Reconcile and retry.')`; the receiving request stays uncredited and
reconcilable, and the next check retries the same identity. No receipt exists
without its events and no money is silently lost. Rows are never pruned,
acknowledged or evicted.

### Payload whitelist

```json
{
  "id": "evt_<32 hex, deterministic per ledger entry and type>",
  "seq": 1,
  "type": "payment.received | invoice.paid",
  "occurredAt": "<same instant as the ledger entry/receipt>",
  "invoiceId": "<opaque invoice UUID>",
  "total": 1000,
  "effectiveTotal": 950,
  "currency": "CAD",
  "mode": "live",
  "payment": { "amount": 300, "method": "lightning", "verification": "provider" }
}
```

Never included: invoice number/title, customer name/email/address/billing,
notes, checkout/receipt bearer tokens, provider payment ids, provider URLs or
instructions, wallet/seed/proof material. `invoiceId` is an internal UUID, not
a capability; `seq` is per workspace, so it exposes only the caller's own
count. Storage is `store.encode(event,'invoice_events',id,workspace)`
(AES-256-GCM with workspace/table/id AAD when encrypted); only the opaque id,
workspace and sequence are readable at rest, and `BEFORE UPDATE`/`BEFORE
DELETE` triggers abort mutations.

Deterministic ids (`evt_` + first 32 hex of SHA-256 over
`invoice-event-v1\0workspace\0type\0sourceId`, with `sourceId` = ledger entry
id, or entry id + `:` + invoice id for `invoice.paid`) make replay, restart
and multi-process retries reproduce the same identity; `PRIMARY KEY(id)` and
`UNIQUE(workspace,sequence)` reject duplicates. Sequences come from
`invoice_event_heads` in the same transaction, so rollback burns no number and
committed sequences stay contiguous.

## Pull API

The parent mounts the router after session/API-key middleware, for example:

```ts
app.use('/api', invoiceEventsRouter(invoiceLedger.events));
```

`GET /api/invoice-events?limit=<1..100>&cursor=<opaque>` (and
`/api/v1/invoice-events` through `createApiAccess`'s prefix normalization)
returns `200 {events:[...], nextCursor:string, hasMore:boolean}` in ascending
`seq` order with `Cache-Control: no-store`:

- `limit` defaults to 25, bounded 1..100; unknown, duplicated or malformed
  query parameters (including any `workspace` selector) return 400 for browser-session calls. Scoped API calls rejected by the bearer allowlist return 403 before the router.
- `nextCursor` is always present and usable — including on an empty page and
  on the terminal page — so polling can resume after every page. Reusing a
  cursor reads the same prefix of existing history; later appends appear
  after its watermark. Client acknowledgement is storing the cursor; there is
  no server mutation and no financial effect.
- The workspace comes only from `res.locals.session.workspace`; demo and
  hackathon sessions are refused (403), and API keys require the dedicated
  `events:read` scope (403 otherwise). There is deliberately no broader
  fallback such as `records:read`.
- Cursors are `base64url("v1.<seq>.<mac>")` where `mac` is HMAC-SHA256 over
  the workspace/version/sequence (including canonical sequence zero) using a
  persisted random per-installation secret stored once in the `meta` table
  through the Store codec. This authenticates cursors in both encrypted
  (hosted) and local unencrypted installations; the secret is never returned
  to any client. Validation requires the exact base64url charset, canonical
  re-encoding, version, a canonical safe-integer sequence and a timing-safe
  MAC compare. A foreign workspace's or another installation's cursor, or any
  forgery, is rejected with 400. Workspace scoping never depends on the
  cursor: reads always filter by the session workspace.
- Corrupt or tampered event rows, an unavailable cursor secret or storage
  failures produce safe bounded 503 errors; secret payloads are never logged.

## Honest scope

Events cover only new live payments recorded through
`InvoiceLedger.payment()` after this feature exists, and their genuine paid
transitions — including future Cashu stage-1 allocations, which use the same
method. They are not a complete history, not a replacement for the ledger or
`/api/evidence/export`, and never cover legacy, imported, simulated,
credit-assisted or Square-sandbox rows. Any backfill would need a separate
labelled, owner-reviewed provenance operation. Future signed push delivery
must reuse these durable events and get its own transport/security design.


## Internal writer and metadata limits

The event append operation requires an active payment transaction; direct calls
outside it return `EVENT_TRANSACTION_REQUIRED` without writing an event. A credit
alone never emits a payment or paid event. If a payment request was pending when
an owner credited the invoice, a later real payment reaching the full effective
target does emit `invoice.paid`; the ledger separately records any overpayment.

Event IDs are deterministic and can be correlated with plaintext ledger IDs by
an observer of database metadata. Amounts and customer fields remain encrypted;
this storage model does not promise to hide record existence or those links.
