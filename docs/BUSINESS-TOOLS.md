# Payment terms and repeat client work

## Calendar dates or a fixed number of days

The invoice editor offers a calendar due date, Due on receipt, Net30, Net60,
Net90 and a custom whole number of days from0to3650. Fixed terms count calendar
days after the issue date. Changing the issue date recalculates the due date;
manually choosing a due date switches to calendar mode. The server computes and
checks the final date too, including month/year/leap boundaries.

Custom payment terms are separate client-facing plain text. They appear in the
customer invoice, print view and invoice email preview/body. The older note field
keeps its existing privacy behavior; hosted checkout omits that owner note.
Templates preserve relative day terms. Applying a relative template starts from
today's issue date; reviewing a recurring draft keeps that draft's period date.
Issued invoices keep their original date/terms snapshot when templates change.
An uncertain create/issue response keeps the same body and retry key until resolved.

## Recurring drafts

Create a recurring plan from a saved invoice template. Choose the first issue
date, monthly recurrence or a fixed interval in days. Monthly plans preserve the
original day anchor: a31st plan clamps to the last day of February and returns to
the31st in March. An old absolute due date must be deliberately converted to a
number of days; it is never silently reused for new periods.

**Prepare due drafts** is a manual action through today or an earlier date.
There is no background invoicing, automatic email, payment attempt or charge.
Preparation saves at most24drafts per request; use another deliberate action if
more remain. Plans/drafts are private encrypted records. Pause prevents later
preparation without deleting earlier drafts. Existing beta limits are100plans
and500drafts per workspace.

Open **Review draft**, check its client/amounts/dates/terms, then create the invoice.
Preparation has no invoice number or customer checkout link. Issuance creates and
associates an invoice in one transaction. Retries, concurrent workers and new retry
keys cannot issue that same draft twice; changed details after issuance conflict.
No email is sent by this action. Use the invoice's separate reviewed email flow.

## Statements and CSV previews

**Statements & import** is available in a private owner browser workspace.
Select the exact invoices to include in a statement preview; names are not treated
as client identities. The preview contains their immutable issued details,
allocations/credits and original-currency balances with live/simulation separated.
Download or print it locally. It contains no checkout/receipt bearer tokens,
provider payment IDs, private owner notes or customer email addresses. It does not
create a public portal, share a statement or send email.

CSV preview accepts the app's invoice balance export header and at most200records,
32columns and16KiB UTF-8. Quoted commas/newlines/escaped quotes and a BOM are
supported. It checks currencies, dates, exact minor units, whole won and balance
consistency; labels existing invoice numbers, within-file duplicates, invalid rows
and new candidates. It does not evaluate formulas or follow URLs. This is a preview:
no invoices, payments or receipts are imported, changed or reconstructed.

New business-tool routes are owner-browser-only with the existing same-origin/CSRF
checks; API bearer tokens and demo workspaces cannot operate them. Invoice creation
through the existing API/MCP supports paymentTermDays and paymentTerms. Wallet
pairing, real mailbox setup, funded tests and direct Cashu custody remain separate.
