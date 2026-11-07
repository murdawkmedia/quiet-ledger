# Deposits, credits and invoice balances

An issued invoice keeps its original total. Open its **Invoice ledger** from the
invoice list to see paid value, credit notes, amount due and any overpayment.
Financial entries are encrypted and append-only. An invoice correction is never
recorded as a transfer of funds.

For a method-priced invoice with a confirmed payer agreement, the agreement's
**effective total** — not the issued total — is the authoritative settlement
target: paid, credited, due and overpaid are all measured against it, and
`balance.effectiveTotal` exposes it to API/MCP callers. The issued subtotal, tax
and total stay immutable; method discount, premium and tax adjustment appear
separately. Until the payer confirms a price, receiving, credits, payment
reports and settlement fail closed with no agreement.

## Request a deposit or installment

Choose a configured live method and enter the requested amount in the invoice's
currency. For CAD12.00 enter12.00 in the browser or1200 through the API; KRW uses
whole won. Omit API `amount` to request the current remaining balance. The server
rejects zero, fractional minor units and amounts above due before allocation.

Open the saved receiving page and share it with the client. It keeps the exact
amount, destination and quote even after the balance changes. The provider must
independently verify each payment. Each installment receives its own receipt;
reloading or checking again does not allocate value twice. Subsequent payments
use a new request for the remaining balance. The original invoice total stays.
A request saved with an agreement keeps that exact `agreementId`, method and
frozen amount across retries and recovery; installments on an agreed invoice
prorate its CAD/satoshi references by `amount / effectiveTotal` and are limited
by the current effective due.

Already allocated requests can still receive funds after another payment or a
credit. Verified excess value is retained as overpayment for review. The ledger
does not automatically refund or spend it. Payments seen after the earlier native
invoice/outer quote expiry still require the existing owner review.

## Correct or void

A credit note reduces the unpaid balance with a required reason. It does not
increase paid value or create a payment receipt. Credits currently apply only up
to the unpaid balance; a refund or credit of previously paid funds requires its
own future workflow. Mixed payment/credit history shows both amounts.

Void is available for unpaid invoices and retains the original document/history.
Existing live unpaid or uncertain receiving requests block void, including expired
requests: this application cannot cancel those remote requests. Reconcile them
first. A void cannot cancel an actual provider invoice, undo a payment or create
a receipt. Simulation records cannot use these owner financial mutations.

## Reports and compatibility

**Records → Export invoice CSV** includes original total, effective total,
pricing method, original/effective tax, method discount, premium and signed tax
adjustment, paid, credited, due, overpaid, state and currency with exact
decimals. It excludes wallet secrets, checkout tokens and guessed exchange
rates. It is an invoice-balance report, not a complete tax/cost-basis ledger or
bank statement. Spreadsheet formula prefixes are escaped; the signed method tax
adjustment keeps its leading minus as an ordinary numeric amount. The preview
validator accepts both this format and the older 13-column header. JSON evidence
(schemaVersion 2) lists individual payment amounts, method rules and the full
agreement with provenance.

Old single-receipt invoices retain their original CAD valuation and payment
provenance when another outstanding request is paid. Their receipt rows stay
unchanged. New request admission can close at the hosted storage budget while
existing verified requests use reserved capacity, subject to the database hard
limit. Unknown creation responses retain their request identity through retries. New
installment receipts use the encrypted ledger and retain revocable individual
links. API/MCP callers should use `balance` for collection state; the legacy
invoice `status` remains open/paid. A fully credited or void invoice may retain
legacy open status while its authoritative balance prevents new collection.

Saved clients, email and Marmot conversations continue to use the same invoice.
Demo payments remain simulation-only. Actual wallet/provider connection and
funded acceptance remain separate from the controlled fixture tests. Native Cashu
receiving and automatic outgoing execution are not added by this ledger phase.


## Currency reporting

Dashboard and Records show invoice balances in each original currency, with live
and simulation rows separate. Issued is the sum of original invoice totals;
effective is the sum of confirmed method-price targets, and the method discount,
premium and tax adjustment columns report the signed agreement adjustments.
Payment value is the invoice amount allocated by its receipts; it is not a wallet
asset balance. Credits reduce unpaid due. Voided balance is the remaining amount
retired by voiding, after any credits. Overpaid value remains a separate column.
KRW uses whole won; no amount is converted using a guessed exchange rate.

JSON evidence includes the same `currencyBalances` and `valuation` metadata under
the existing `records:read` scope. The older `totals` CAD fields remain compatible.
`invoicedCad` is `reference_only`: unpaid foreign-currency invoices retain fixed
MVP reference conversions, and settled values can use saved receipt quotes.
`receivedCad` uses saved quotes or simulation values; it is not a current FX quote
or bank balance. `availableCad` and `spentCad` are simulation-only. The UI labels
these older owner values as CAD references and does not call their ratio collected.
