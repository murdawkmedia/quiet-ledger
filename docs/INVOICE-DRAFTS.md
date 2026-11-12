# Saved invoice editor drafts (owner, private)

Monthly-invoicing pilot, November 2026. This note describes the private
server-side draft persistence for the invoice editor, the owner **Duplicate**
action, and the explicit carried-expense review. Everything here is
owner-only and workspace-scoped; demo and API-key sessions are rejected by
the routes.

## What a saved draft is

A saved draft is a strict, versioned copy of the raw editor strings — a
half-typed price or an unfinished date survives exactly as typed. Saving a
draft:

- allocates **no** invoice number, checkout token, receipt or outbound action;
- stores nothing in the browser (no localStorage) — records live in the
  encrypted workspace store, same as invoices and recurring drafts;
- is capped: 200 drafts per workspace, 40 lines, 8 method rules, 32 accepted
  methods, 16 384 bytes of canonical snapshot JSON.

The snapshot schema and limits live in `shared/invoice-editor-drafts.ts`
(`InvoiceEditorSnapshot`, `validateInvoiceEditorSnapshot`,
`INVOICE_EDITOR_DRAFTS_LIMITS`). The schema is strict: unknown fields are
rejected, and `version` must be `1`.

## Where it appears

- **Owner editor** (`/invoices/new`): autosaves about 1.2 s after you stop
  typing. After the first save the URL becomes `/drafts/<id>`, so a reload
  restores the draft exactly. The URL changes only after a confirmed save. A blank, untouched editor never creates a draft.
- **Saved drafts** (`/drafts`, owner-only nav item): lists drafts with status;
  unissued drafts can be discarded; issued drafts are immutable.
- **Reopen** (`/drafts/<id>`): restores the draft with autosave continuing on
  the same draft identity.
- **Duplicate** (row action on the invoice table, owner): opens
  `/invoices/new?duplicate=<invoice id>` and prefills a new editable draft.

## Saves, retries and conflicts

Saves use natural replay instead of client-generated idempotency keys:

- `PUT /api/invoice-drafts/:id` with `expectedRevision` (the revision the
  editor last saw).
- An exact retry — same content, `expectedRevision` equal to the current or
  immediately previous revision — replays the stored summary **without**
  advancing the revision.
- Any other stale write returns `409` and changes nothing.
- After an uncertain outcome (network error or 5xx) the client retries the
  exact same payload and revision with backoff, so a save that actually
  reached the server replays instead of conflicting.
- The status line in the editor never shows “saved” after a failed save:
  failures surface as “Draft not saved: …” (definite rejection) or “Draft save
  unresolved. Retrying the same draft…” (uncertain).

## Issuing (exactly once)

`POST /api/invoice-drafts/:id/issue` with `expectedRevision`, the reviewed
`invoice` and an `Idempotency-Key` header. The server:

1. checks the revision inside a transaction,
2. fingerprints the invoice input and records it in the workspace index
   (`invoice-draft-issued-input`), so the same content issues exactly once
   across keys,
3. creates the invoice and marks the draft issued, atomically.

Issued drafts cannot be edited, re-issued or discarded. An uncertain issue
outcome keeps the exact snapshot and key in the editor; the retry button
re-sends the identical operation.

## Carried-expense review

Expense lines copied from another source stay **marked** until the owner
acknowledges them:

- sources: a template applied in the owner editor, an issued invoice
  duplicated, a recurring draft opened for review (`markCarriedExpenses`);
- the review panel lists each carried expense; **Create invoice stays
  disabled** until the owner checks the acknowledgement;
- editing any carried expense line (or removing one) changes the content
  fingerprint and reopens the review;
- “Remove carried expenses” deletes the carried lines instead;
- the acknowledgement fingerprint is stored in the snapshot
  (`carriedExpenseAck`), so it survives reloads but never survives a content
  change. Manual fresh expenses the owner types are never marked.
- Demo invoices are exempt: the fictional workspace keeps its old behavior.

This is a deliberate review step, not a security boundary.

## Duplicating an issued invoice

The duplicate action copies customer, title, currency, lines (kinds and
eligibility), tax/discount/premium, accepted methods, method price rules,
terms, note and billing details. It never copies the invoice id, number,
token, status, receipts or balance. The issue date resets to today. A
relative due date (payment terms) is kept and recomputed from today; an
absolute due date is cleared with a notice asking the owner to choose terms
again. Carried expense lines stay marked for review.

## Routes

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/invoice-drafts` | list summaries (owner browser session) |
| GET | `/api/invoice-drafts/:id` | full draft incl. snapshot |
| PUT | `/api/invoice-drafts/:id` | save; `expectedRevision` + snapshot |
| DELETE | `/api/invoice-drafts/:id` | discard an unissued draft |
| POST | `/api/invoice-drafts/:id/issue` | issue exactly once; `Idempotency-Key` |

All draft routes require an owner browser session; mutations require CSRF. Anonymous,
demo and API-key callers get `403`. The service lives in
`server/invoice-drafts.ts` (mounted via `server/invoice-drafts-router.ts`).

## Tests

- `tests/invoice-drafts.test.ts`, `tests/invoice-drafts-api.test.ts` —
  service and app behavior (schema, replay, conflicts, caps, issue
  exactly-once, immutability, cross-workspace isolation).
- `tests/invoice-drafts-ui.spec.ts` (run with
  `npx playwright test --config tests/invoice-drafts-ui.config.ts`) —
  browser behavior with a route-mocked backend: autosave, reload restore,
  pristine drafts never saved, uncertain-save exact retry, conflict error,
  duplicate date reset, carried-expense ack/reset/remove, navigation guard,
  exactly-once issue retry, list discard and issued immutability.
- `tests/browser/invoice-drafts-live.spec.ts` (after `npm run build`, run
  `npx playwright test --config tests/invoice-drafts-live.config.ts`) — the
  built application against real Express routes and temporary SQLite: save,
  reload, issue, duplicate for the next month, remove carried expenses,
  recalculate Net 30, preserve the original invoice and review on mobile.
  All records are fictional; no payment or email is requested.

## Navigation and API boundary

Unsaved or uncertain work prompts before normal app navigation, reload and
browser Back/Forward within tracked app history. Declining Back/Forward restores
the previous history position without unmounting the editor. A draft save that
finishes after leaving never redirects a different editor.

## Known limits

- Saved drafts are browser-session-only. They are deliberately absent from the
  bearer/API-key routes described by the main OpenAPI document.
- Draft limits include retained issued drafts. Issued records remain immutable.
