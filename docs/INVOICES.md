# Clients, invoices and reusable templates

Use a private account for the client book and invoice conversations. The
fictional demo remains separate. For email and Marmot setup, start with
[private invoices and conversations](REAL-INVOICING.md).

## Save client details

Open **Clients** to save a name, email, billing address, preferred currency,
optional Marmot public identity and private notes. Marmot fields accept an npub,
nprofile or hexadecimal public key. They store the normalized public key, not
profile relay hints. A saved identity is neither verification of the person nor
an accepted invitation. Email and Marmot remain distinct contact fields.

In **Create invoice**, choose a **Saved client** to fill its name, email, address
and preferred currency. Check the existing line prices; changing currency does
not convert them. Removing a saved client leaves issued invoices and history
intact. Private client notes are not invoice billing details.

## Create and print an invoice

Choose **New invoice**, fill in the client, and choose issue and due dates using
the date pickers. A due date cannot precede the issue date. CAD, USD, EUR and GBP
use two decimal places; KRW uses whole won. Choose the invoice currency explicitly.

Each line has a description, quantity, unit price and **Line type**. Service/labour
lines start with **Apply discounts and premiums** checked. Expense/reimbursement
lines start unchecked, so fixed costs such as flights keep their full price. You
can override the checkbox on either type of line.

Discount and premium percentages apply only to eligible lines. For example,
CAD 2,000 labour plus CAD 800 flights with a 5% discount on labour totals CAD 2,700
before tax: labour gets CAD 100 off and flights remain CAD 800. Tax still applies
to the adjusted invoice subtotal. The browser and server use the same integer
calculation. Saved templates and recurring snapshots retain each line's choices;
issued invoices retain their captured totals. Older lines without these fields
keep their original eligible behavior.

These controls set the invoice's agreed price. They do not automatically choose a
discount after a payer selects Bitcoin or another method at checkout. For a
Bitcoin-only offer, choose that invoice's accepted methods when preparing it.

Under **Billing details**, enter your business name, email, address, optional tax
registration number and the customer's billing address. A business name is
required when including billing details. Put only details intended for the payer
here: these fields appear on the checkout and printed invoice.

Creating an invoice captures its client, billing, terms, line items and totals.
Later client or template edits do not rewrite an issued document. Creating it
sends no email or Marmot message. Older invoices without billing fields still
open normally.

Open the invoice's checkout and choose **Print invoice**. Use the browser's print
dialog or its PDF option. A recorded payment has a separate receipt with
**Print receipt** and **Download receipt**. Live/provider-reviewed payments and
simulated records retain their mode labels; a printed receipt does not prove a
later bank credit. The email flow sends a link, not an attached PDF.

Choose the payment methods you accept for that invoice. At least one method is
required. The server enforces the selection for checkout, receiving instructions
and settlement, even if a caller bypasses the browser. A selected method still
requires a suitable connected provider, supported currency and live/test mode.
No provider is connected or funded automatically.

## Reuse a template

To reuse a client's normal invoice, choose **Save as new template** and give it a
label. Select that template next time to fill the same client, billing, terms,
line items, currency, adjustments and accepted methods. Update or delete saved
templates using the controls beside the picker. Check the dates before creating
each new invoice. Templates belong to the signed-in workspace and have encrypted
server payloads; they persist across logout and restart. The operator holding the
storage key can decrypt them.

## Keep the invoice conversation together

Choose **Thread** beside a private invoice to read its saved history. **Save
private note** writes only to your workspace. It does not send a message to a
client or mark the invoice paid.

Enable and initialize [Email inbox](INVOICE-EMAIL.md) before sending the initial
invoice with **Email**. Approved incoming replies can receive an explicit
previewed email response in **Reply by email**. The optional Email gateway on
the Thread page pairs a separate owner-only Marmot room for that invoice.

For a native client contact, open **Messages**, select the intended room and use
**Send invoice link**. Sharing an invoice is an explicit action; saving a public
key does not expose that client's other invoices. Production native rooms have
two members and are separate from email gateway rooms. See
[Marmot invitations](REAL-INVOICING.md#invite-a-marmot-contact).

Chat text, an email approval and a payer's claim of payment cannot settle an
invoice. Settlement requires the receiving provider's supported proof or the
owner's independent manual confirmation. Outgoing payouts remain simulated.

## Fictional demo and automation

The hackathon visit has a separate **New demo invoice** editor with fictional
examples. It does not create a real account or a funded payment. A running
Marmot team must be reset before changing its active invoice so replies never
refer to a replacement case mid-turn. Private accounts have their own invoice
and template records, separate from that visit.

Cookie-authenticated template endpoints are `GET/POST /api/invoice-templates` and
`DELETE /api/invoice-templates/:id`. Writes require CSRF and the exact configured
origin. They are not granted by an invoice API/MCP bearer key. Client records,
private thread notes and email/gateway controls likewise require the private
browser session. See [MCP and the versioned API](MCP.md) for invoice automation.


See [payment terms and repeat work](BUSINESS-TOOLS.md) for fixed/custom day terms,
relative templates, recurring drafts and owner statement/import previews.
