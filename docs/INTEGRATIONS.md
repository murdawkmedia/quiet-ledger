# Integration contracts

Reviewed November 4, 2026 Edmonton / November 5 UTC. No financial credentials,
provider account or real transaction was used to implement or test these clients.

## Live receiving and wallet choice

See [Connections](CONNECTIONS.md) for available receiving adapters and saved
configuration, and [API/MCP](MCP.md) for Ark and collateral observations. Provider
fixtures verify contracts; no actual wallet/account acceptance is claimed.
Outgoing conversion/bill-payment integration remains assisted or simulated.

## Square sandbox receiving

`integrations/square.ts` fixes its host to `connect.squareupsandbox.com` and
pins Square API version `2026-09-16`. `createPaymentLink` uses a persistent
idempotency key, a configured location and integer money in that location's
currency. `getPayment` retrieves the payment, and `assertSquarePayment`
requires exact order, location, amount, currency and completed status.

`verifySquareSignature` validates HMAC-SHA256 over the configured notification
URL and raw body using a constant-time comparison. It is a library helper,
not a connected webhook endpoint. A future endpoint must deduplicate event ids
and retrieve the authoritative payment before recording value.

The owner-only `/square-sandbox` workspace now creates durable test checkout
intents from owner invoice snapshots. The app verifies a CAD/USD sandbox
location, persists one provider retry key before any request, and recovers the
same intent after timeouts or restarts. `/square-test/:token` is a separate public
test page. Payment polling derives the payment reference from the stored
order's tender, then validates Square's authoritative payment readback. It
rejects ambiguous tenders, mismatched bindings and refunded payments. Test
receipts never credit the original simulated invoice or payout balance.

Configure `SQUARE_SANDBOX_TOKEN_FILE` as an external private regular 0600 file;
optionally set `SQUARE_SANDBOX_LOCATION_ID`. Credentials remain server-side and
are denied by development asset routes. Square receives only a generic test
description and the exact amount/currency/location, never customer details,
invoice notes or private planning data.

Actual authenticated sandbox-account acceptance remains unqualified.
A fixture-tested connection does not establish funded provider acceptance.
HMAC helpers remain library code; no inbound webhook route is connected.

References:
- https://developer.squareup.com/reference/square/checkout-api/create-payment-link
- https://developer.squareup.com/reference/square/payments-api/get-payment
- https://developer.squareup.com/docs/webhooks/step3validate

## Wise ordinary-fiat business payouts

`integrations/wise.ts` fixes its host to `api.wise-sandbox.com/2026Q4` and
supports quote creation, idempotent transfer preparation and status readback.
It uses the merchant's own eligible business profile and rejects crypto-origin
requests. A prepared transfer is not a funded or delivered transfer. There is
no automatic funding method in this MVP.

Canadian business API-token capabilities are documented, but individual
account eligibility, recipient requirements, balance availability and payment
approval rules still need checking. Keep those controls intact.

Wise's crypto policy restricts P2P crypto proceeds and other crypto-related
activity. Do not assume RoboSats, Bull Bitcoin or another crypto provider can
fund a Wise route. Ordinary business fiat is the supported category here.

References:
- https://docs.wise.com/guides/developer/auth-and-security/personal-api-token
- https://docs.wise.com/api-reference/standard-transfer/transfercreate
- https://docs.wise.com/guides/product/send-money/funding/fund-from-balance
- https://wise.com/help/articles/2v3OMcg97Z7gObSifJbjsu/understanding-wises-position-on-cryptocurrency

## Bank of Canada reference data

`integrations/reference.ts` requests the public Valet USD/CAD observation feed,
preserves observation date and retrieval time, caches successful results, and
labels cached data stale after a failed refresh. It returns unavailable when
there is no cached observation. No made-up live rate is substituted.

- https://www.bankofcanada.ca/valet-api-how-to/
- https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1

## Assisted and research rails

Bull Bitcoin and Bitcoin Well publish Canadian conversion/bill-payment
services. Neither is connected to an execution API in this application.
Bull's inspected TypeScript SDK order helper only simulated a quote.
Bitcoin Well's account terms restrict unapproved automation and third-party
use. Supported account arrangements and Cashu-origin funding acceptance remain
unverified. A compatible mint could pay a provider Lightning invoice through
Cashu redemption, but this bridge is not implemented in the MVP.

Tangerine supports downloading bank transactions. No public developer
execution API was verified; this MVP neither logs into Tangerine nor imports
actual statements. Shakepay is a potential assisted business/Lightning/CAD
route; no supported public execution API was verified or connected.

RoboSats has a documented trade API, but trades involve counterparty review,
bonds, escrow and human verification of fiat receipt. Keep private access on
its official Tor route. This app does not create trades or release escrow.

References:
- https://www.bullbitcoin.com/sell
- https://github.com/SatoshiPortal/TS-SDK/blob/main/src/methods/orders.ts
- https://bitcoinwell.com/ca/spend-bitcoin
- https://bitcoinwell.com/ca/terms-of-service
- https://www.tangerine.ca/en/faq/how-do-i-download-transactions
- https://shakepay.com/business
- https://help.shakepay.com/en/articles/2711726-how-to-send-an-e-transfer-to-my-bank
- https://learn.robosats.org/docs/api/
- https://robosats.org/docs/access/

## Before actual funded acceptance

Choose one receiving method and one eligible payout path. Verify credentials
privately, stable request identifiers, quote and fee binding, provider source
acceptance, timeout reconciliation and independent recipient credit. Review
the concrete small transaction before execution. Add network-separated live
records, encryption/recovery and deployment controls before accepting customers.
