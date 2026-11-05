# Invoices and reusable client templates

Choose **New invoice**, fill in the client, and choose issue and due dates using
the date pickers. A due date cannot precede the issue date. CAD, USD, EUR and GBP
use two decimal places; KRW uses whole won. Choose the invoice currency explicitly.

Each line has a description, quantity and unit price. Discount and premium
percentages are separate optional invoice adjustments. They apply to the line
subtotal, and tax applies after those adjustments. The displayed breakdown and
server use the same exact integer calculation; invoices never hide a different
price behind a particular payment button.

Choose the payment methods you accept for that invoice. At least one method is
required. The server enforces the selection for checkout, receiving instructions
and settlement, even if a caller bypasses the browser. A selected method still
requires a suitable connected provider, supported currency and live/test mode.
No provider is connected or funded automatically.

To reuse a client’s normal invoice, choose **Save as template** and give it a
label. Select that template next time to fill the same client, terms, line items,
currency, adjustments and accepted methods. Update or delete saved templates
using the controls beside the picker. Check the dates before creating each new
invoice. Templates belong to the signed-in workspace and have encrypted server
payloads; they persist across logout and restart. The operator holding the
storage key can decrypt them.

The hackathon visit has a separate **New demo invoice** editor with fictional
examples. It does not create a real account or a funded payment. A running
Marmot team must be reset before changing its active invoice so replies never
refer to a replacement case mid-turn. Private accounts have their own invoice
and template records, separate from that visit.

Cookie-authenticated template endpoints are `GET/POST /api/invoice-templates` and
`DELETE /api/invoice-templates/:id`. Writes require CSRF and the exact configured
origin. They are not granted by an invoice API/MCP bearer key. See
[MCP and the versioned API](MCP.md) for invoice automation.
