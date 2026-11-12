# Merchant workflows: projects, milestone invoices and paid-gated deliverables

This guide walks the owner through the billing surface added in the merchant
receiving stage. Everything here happens inside your private owner workspace;
demo visitors and scoped API keys never reach it. All records are encrypted
workspace data, and no workflow below sends an email, contacts a provider or
moves funds by itself.

## 1. Plan the work: projects and milestones

Open **Billing** in the owner workspace.

1. Under *Projects*, type a **New project name** (for example `Studio retainer · Q4`) and choose **Add project**.
2. In *Milestones*, enter a **Milestone label**, a **Planned amount** in the chosen currency, and the project it belongs to, then choose **Add milestone**.

Milestones can also live without a project. Planning records are notes only:
they never issue an invoice, hold money or reserve payment. You can rename a
milestone, relink or unlink its invoice, or delete a milestone at any time —
deleting a project works only while it has no milestones, and deleting a
milestone never deletes an issued invoice, its receipts or its deliverables.

## 2. Issue a milestone invoice

Each milestone row has a **Create invoice** button. It opens the ordinary
invoice editor with the milestone's label, currency and planned amount
prefilled, so the issued invoice stays the single source of truth for totals.

- Review or adjust the draft (customer, dates, taxes, accepted methods), then choose **Create invoice**.
- The invoice is issued with the normal idempotent retry rules, then linked to
  the milestone automatically. If linking fails, the issued invoice is still
  safe: the page keeps a **Retry link** button and never issues a second
  invoice.
- After creation you land back on **Billing**, with the milestone now showing
  its invoice number, state, effective total, due amount and mode.
- If the planned amount and the invoice's authoritative total later differ
  (method pricing, adjustments), the milestone shows a visible mismatch note —
  the invoice remains authoritative.

Use **Replace invoice** on a milestone to issue a fresh invoice for it; the
previous invoice stays untouched in your records.

## 3. Attach deliverables to an invoice

In the *Deliverables* section:

1. Pick the **Invoice** the deliverable belongs to.
2. Give it a **Deliverable label** the payer will recognize (for example `Final recording (MP4)`).
3. Paste the **Delivery link**. Only plain `https://` addresses are accepted.
4. Choose **Add deliverable**.

A new deliverable starts **Locked**. It stays invisible on the payer's
checkout — the link and its URL do not appear anywhere in the checkout page —
until both of these are true:

- the invoice is settled by an authoritative **live** payment at the effective
  method total (owner-confirmed manual receipts count; simulations, credits
  and demo workspaces never do), and
- you explicitly choose **Release**.

Editing the delivery URL clears the release on purpose: a changed destination
must be re-checked and released again before it reappears. Hiding a
deliverable again with **Unrelease** removes it from checkout immediately.

## 4. What the payer sees

On the public checkout link, once a verified live payment covers the invoice
and the deliverable is released, a *Your deliverables* section lists the
released links as plain anchors that open in a new tab. The checkout page
never fetches, proxies, previews or watermarks those destinations, and it is
the only place the link is shown: there is no invoice-UUID route, no API feed
and no receipt-page copy of the link. Revoking the invoice's links removes
the whole public checkout.

## 5. Honesty about forwarded links

Releasing a link is a hand-off, not DRM. Once a payer receives an external
HTTPS link, Quiet Ledger cannot retroactively revoke, watermark, expire or
access-control that destination. If forwarding is a concern, use expiring or
signed links hosted on your own infrastructure; Quiet Ledger only gates the
display of the link inside its own checkout.

## Limits to remember

- Billing screens, routes and the `/api/billing` surface are owner-browser
  only; demo sessions and scoped API keys are refused.
- Deliverables unlock from **live receipt-backed** value only: simulated
  payments, credit notes and demo workspaces keep every link hidden.
- A partial live payment below the effective method total keeps links hidden;
  the gate opens at the payer-confirmed effective total.
