# Method-specific invoice prices

Optional method pricing is integrated across invoice creation, public checkout,
receiving, ledger, reporting, CSV and API/MCP read interfaces. The payer confirms
one method and price before requesting payment. Automated qualification uses
fictional providers; it does not establish funded provider acceptance.

## Issued totals and eligible lines

An invoice may omit `methodPricing` for the existing behavior, or contain
optional canonical-method discount/premium rules. A method rule is additional
to the invoice's ordinary discount and premium; it does not overwrite them.
Rules use the same adjustment-eligible line base. Excluded expenses remain in
the issued subtotal and tax, and an explicit `adjustmentEligible` choice
overrides the line kind.

The original issued subtotal, tax and total stay immutable. An offer or saved
agreement separately shows its method-only discount, premium, adjusted
subtotal, effective tax and effective total. A discount is not a financial
credit and a premium is not a payment.

The editor calculates previews through the shared pricing function and stores
rules in the ordinary draft. Saved templates and recurring review retain their
rules, existing line choices, payment terms and dates. Unsaved currency or
accepted-method changes remove rules that are no longer compatible; SAT is
never converted from another currency. Rule fields are absent from legacy
request bodies until at least one rule is added.

Method-priced creation is disabled in the fictional hackathon editor for this
v1 slice. Existing unpriced demo invoices and simulation behavior are
unchanged, and no retention or settlement exception is added.

## Payer confirmation

For a method-priced invoice, the server-controlled checkout response provides
zero or more `pricingOffers`. While confirmation is pending, `payment` may be
`null`; the browser does not synthesize a request or use caller-entered prices.

The payer selects one complete server offer, sees its final price, and then
explicitly confirms it:

```text
POST /api/checkout/:token/method-agreement
Idempotency-Key: <saved key for this exact operation>

{"method":"lightning","offerHash":"<exact server offer hash>"}
```

Confirmation locks one method and invoice-currency price. It creates no
payment, financial credit, paid receipt or optimistic paid state. The browser
enables later actions only after a fresh authoritative checkout read shows the
saved agreement. No offers, unavailable connections and expired links retain
an honest unavailable status without payment controls.

After confirmation or reload, offers for other methods disappear and an
agreement card on the invoice/printed view shows the immutable original and
effective prices. All subsequent public receiving requests and simulated pay
requests include `agreementId` and use the locked canonical method. Installment
amounts are limited by the current effective due. A fresh native quote and its
own expiry belong to each receiving request; the agreement is not an FX quote.

An HTTP 408, network failure or 5xx confirmation response keeps the exact token,
method, offer hash, body and idempotency key for deliberate retry. A delayed
result from another checkout token cannot complete the current token's
controls. Existing frozen receiving retries likewise preserve their agreement
ID, amount, method and key.

## Owner ledger and receiving

Owners direct the payer to public checkout instead of selecting a price for
them. Before confirmation, receiving and credit creation are blocked; an unpaid
invoice can still be voided under the existing rules. After confirmation,
owner receiving exposes only the locked method and sends the exact agreement
ID. The ledger presents original/effective totals and method adjustments apart
from its actual `payment`, `credit` and `void` entries.

Receipts and print views keep the actual receipt amount and immutable issued
total, with the agreement price and effective tax shown separately. Agreement
confirmation does not assert a payer or wallet identity. A Cashu wallet guide
on a Lightning request remains a Lightning flow and cannot select a Cashu
price or change the receipt's method.

## SAT and legacy flows

SAT rules use whole-satoshi integer amounts and Bitcoin-native or eligible
noncash methods only. They do not acquire fiat formatting, a CAD reference,
card/bank conversion, simulated CAD payout or foreign-exchange lookup.

Invoices without `methodPricing`, and receiving operations without an existing
`agreementId`, keep their legacy request-body shapes and behavior. The browser
adds `agreementId` only when a saved agreement exists.

## Fictional UI verification

The mocked browser suite binds APIs only on dedicated port 4355:

```sh
npx playwright test --config tests/method-pricing-ui.config.ts
```

It covers editor/templates/SAT, eligible-line previews, unknown retries,
server-offer confirmation and reload, cross-token isolation, exact
installments, wrong-method blocking, unavailable offers, escaped public/print
content, mobile keyboard use, owner receiving and ledger presentation. It uses
no account, provider, wallet, mail, funded payment or external network action.
Parent-led application integration, independent review and release acceptance
remain separate requirements.

The built-interface integration suite runs against the real application API and
database using a controlled synthetic receiving adapter:

```sh
npm run build
npx playwright test --config tests/method-pricing-live.config.ts
```

It checks eligible labour versus fixed flights, Lightning discounts, card
premiums, two installments, provider readback, receipts and CSV output. It also
checks whole-satoshi invoices. No real payment is performed.
