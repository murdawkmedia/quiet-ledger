# Billing projects & paid deliverable links

Billing planning is optional owner-side bookkeeping: projects, milestones with
planned amounts, and invoice-linked delivery destinations. It adds no escrow,
task platform, payout engine, custody, subscription, DRM or file hosting. The
issued invoice and its ledger stay authoritative; planned amounts are private
notes that never gate or rewrite money.

## Where it lives

The surface is owner-browser only. `billingRouter(store, billing, now)` mounts
at `/api/billing` behind the application's session, origin and CSRF checks;
API-key, demo and hackathon workspaces are refused before the request body is
parsed or any idempotent response is replayed. Every mutation runs through the
store's idempotency table (`billing:<workspace>` scope with an operation
discriminator) and the encrypted-write budget. `BillingRecords` is constructed
as `new BillingRecords(store, invoiceLedger, now)`; the parent may construct it
once and share that instance with the checkout extension.

Records are encrypted payloads (`store.encode`/`decode` with table/id/workspace
as additional authenticated data). Only opaque ids, workspace relationships and
timestamps sit outside the ciphertext: labels, planned amounts, URLs and the
release state are all encrypted at rest.

## Bounds and lifecycle

- 100 projects, 500 milestones and 1,000 deliverables per workspace, 20
  deliverables per invoice. Limits fail with 429 and never evict records.
- Deleting a project requires an empty milestone list (409 otherwise).
- Deleting a milestone never deletes invoices, receipts, ledger entries or
  deliverables; it only removes the planning note.
- Milestone labels and invoice links are editable; planned amounts and currency
  are immutable after creation to keep planning honest. Unlinking a milestone
  from an invoice (`invoiceId: null`) is supported.
- Every record change rechecks workspace ownership inside the write transaction
  and writes an audit entry. Idempotent replays and unchanged release states do
  not write duplicate audit entries.

## Delivery links and the paid gate

A deliverable is a label plus one HTTPS URL tied to one of the caller's
invoices. URLs are accepted only with the `https://` scheme, a parseable host,
no userinfo, no control characters and at most 2,000 characters. The
application never fetches, proxies, previews or iframes the destination; it
displays it as a plain link inside its own checkout.

Editing a URL clears the release flag atomically: approving the old
destination never silently approves a new one. Label-only edits keep it.

`publicDeliverables(workspace, invoiceId)` is the only payer-facing
projection, and it fails closed. It returns `[]` unless the workspace is a
real private workspace, checkout links are not revoked, the owner explicitly
released the link, the authoritative ledger state is `paid` in `live` mode,
and real live receipt-backed payment value (ledger payment entries with a live
receipt and provider or owner-manual verification) covers the invoice's
effective total. An invoice status flag, simulation, credit, self-report or
client-supplied mode is never payment evidence. The returned whitelist is
`{label, url}` — nothing else crosses to the payer side.

Releasing a deliverable never sends an email or message. The payer sees the
link on their existing checkout only while every gate condition holds.

## Forwarded links have no take-back

Once a payer receives an external HTTPS link, Quiet Ledger cannot retroactively
revoke, watermark, expire or access-control that destination. There is no DRM,
view-auth or download-count promise. Use expiring or signed links on your own
host if forwarding is a concern; this application only gates the display of the
link inside its own checkout.

## Owner screens

`BillingProjects` renders the planning surface and is exported for a parent
lazy mount at `/billing` (an optional `invoices` prop supplies the workspace
invoice list; otherwise it loads its own). `MilestoneInvoice({id, onCreated})`
wraps the existing immutable `InvoiceEditor` at
`/billing/milestones/:id/invoice`: the milestone's label, currency and planned
amount prefill a fresh draft keyed per milestone, the editor's frozen
idempotent `POST /api/invoices` retry issues the invoice, and a separate stable
link key then links it. If the link step fails, the issued invoice is preserved
and surfaced with an explicit retry that can never issue a second invoice; the
caller's `onCreated` should navigate away, mirroring the parent's other editor
mounts. There is no query-string or browser-storage prefill.

## API surface

| Method | Path | Effect |
|---|---|---|
| GET | `/api/billing/projects` | Whole owner projection (projects with nested milestones, loose milestones, flat deliverables) |
| POST | `/api/billing/projects` | Create a project (idempotent) |
| PATCH | `/api/billing/projects/:id` | Rename a project (idempotent) |
| DELETE | `/api/billing/projects/:id` | Delete an empty project (idempotent) |
| GET | `/api/billing/milestones/:id` | One milestone with invoice summary and deliverables |
| POST | `/api/billing/milestones` | Create a milestone (idempotent) |
| PATCH | `/api/billing/milestones/:id` | Rename and/or relink to an invoice (idempotent) |
| DELETE | `/api/billing/milestones/:id` | Delete the planning note only (idempotent) |
| POST | `/api/billing/deliverables` | Add a label + HTTPS URL to an invoice (idempotent) |
| PATCH | `/api/billing/deliverables/:id` | Change label or URL; a URL change clears release (idempotent) |
| DELETE | `/api/billing/deliverables/:id` | Remove the link (idempotent) |
| POST | `/api/billing/deliverables/:id/release` | Set the explicit release flag (idempotent) |
| POST | `/api/billing/deliverables/:id/unrelease` | Clear the release flag (idempotent) |

All mutation bodies are strict zod schemas (`shared/billing-records.ts`);
unknown keys are rejected. Amounts use the same integer minor-unit bounds as
invoice lines.


## Validation and uncertain saves

The service enforces the same label, integer amount and HTTPS destination rules
as the HTTP router. Delivery release counts only positive live receipt-backed
payments whose amount, currency, method and invoice identity match the ledger.
Malformed evidence cannot unlock a destination.

During the current signed-in visit, an uncertain planning save keeps its exact
idempotency key for a retry of the same action and fields. A definitive success
or validation refusal clears it. Keys and delivery URLs are not persisted in
browser storage. After leaving the page or signing in again, inspect existing
records before creating a replacement for an uncertain save.

The payer projection is internal: callers must supply the workspace and invoice
resolved from the existing private checkout token, never a user-supplied invoice
UUID alone. Once a permitted external link is revealed, Quiet Ledger cannot
revoke copies at that destination.
