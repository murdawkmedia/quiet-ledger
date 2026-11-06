# Quiet Ledger at Nut November 2026

Quiet Ledger is an open-source, self-hostable invoicing workspace for creators
and small businesses. Our November focus is making Cashu useful for ordinary
invoices and, later, voluntary creator support.

This is work in progress. The existing Cashu checkout is a simulation, not token
redemption. No real Cashu receiving, minting, swapping or melting is implemented
in this baseline. Keep that distinction when evaluating the demo.

## What exists at entry

The application was built during November 2026. Implementation began November 4;
the first public release was November 5. Earlier material was an invoicing idea
and planning, not an earlier Quiet Ledger application. The public Git history
starts with `ad0ff396762cb35c3c600a3e1af5f317496e24d5` and records the subsequent
November changes. The registration baseline is
`2ecae36b2b1b7d887af4244bc238126a8c79ce9f`.

That baseline has private passkey/Nostr accounts, encrypted invoice records,
CAD/USD/KRW pricing, printable invoices, payment requests and receipts, API/MCP,
Marmot conversations and reviewed threaded email. Its Cashu catalog entry and
manual instructions do not establish ecash settlement. The live fictional demo
uses explicitly simulated payments. The newer private-account screens are in
source; their hosted frontend rollout is pending.

Existing configured Lightning adapters can verify their own invoices. A Cashu
wallet can use its mint to pay a Lightning invoice through
[NUT-05](https://cashubtc.github.io/nuts/05/). A Lightning receiver cannot establish
that the payer funded a payment with Cashu, so such a receipt stays Lightning.

## First implemented November slice

The [external-wallet guide](CASHU-WALLET.md) reuses the exact validated mainnet
Lightning invoice and amount, with copy and a locally generated QR. Supported
LND and automatically verifiable LNURL receivers advertise it on new requests.
Manual/test/review/expired requests do not. Opening the guide allocates nothing,
contacts no mint and cannot settle a payment. The original provider check still
produces one Lightning receipt after independent verification.

Controlled tests cover adapter validation, exact QR/copy, expiry, reload and
receipt provenance. Funded interoperability with an independently operated Cashu
wallet/mint remains pending. This is guidance to an external wallet, not a direct
ecash receiver. Hosted availability is a separate rollout step.

## Proposed November delivery

These are proposed milestones, not completed features or guarantees. Wallet
custody, recovery and transport decisions need review before implementation.

| Target | Work | Evidence needed |
| --- | --- | --- |
| November 6–12 | Clear external Cashu wallet handoff to an existing Lightning invoice | Exact invoice and amount; independent Lightning settlement; pending/failed payment issues no receipt; reload/retry gives one receipt. No payer proofs or spending keys reach the app server. |
| November 13–20 | Direct ecash requests for one explicitly selected mint and `sat` unit | NUT-18 request, merchant-browser receive/swap, exact fee treatment and a durable recovery journal. Wrong mint/unit/request, spent or overlapping proofs cannot settle. |
| November 21–26 | Recovery, independent wallet checks and an optional creator contribution page | Restart during a swap; exact retry/reconciliation; encrypted recovery; separate contribution records; a short reproducible demo. |
| November 27 | Final entry evidence | Link the actual November commit range, completed acceptance checks, known limits and final video before 23:59 UTC. |

The first useful option avoids introducing a spending wallet. Direct ecash is a
larger feature: it needs separate wallet keys and recoverable operations. Neither
path should reuse an account signer or Marmot identity as a wallet key.

## Direct ecash acceptance boundaries

[NUT-18](https://cashubtc.github.io/nuts/18/) describes interoperable payment
requests. Request amounts are net of input fees. A token balance or an
[NUT-07](https://cashubtc.github.io/nuts/07/) `UNSPENT` response alone is not a
settled payment. Receiving by [NUT-03 swap](https://cashubtc.github.io/nuts/03/)
invalidates the payer's original proofs and produces the receiver's new proofs.

The receive path must bind request, mint, unit and amount. It must reject reuse
of individual proofs, including overlapping proof sets and aliases for the same
mint. Inputs and output recovery material must be journaled before network work.
[NUT-19](https://cashubtc.github.io/nuts/19/) caching is optional and does not
replace an application recovery plan.

If wallet spend authority stays in the merchant browser, raw bearer proofs and
wallet secrets must not be placed in server-decryptable receiving records.
Standard NUT-18 transport and Marmot chat are different protocols. Encrypted
Nostr delivery or supported [NUT-11](https://cashubtc.github.io/nuts/11/) locking
needs its own interoperability and recovery checks. A browser assertion must not
be labelled independent provider verification.

## Creator support and prize fit

The [Nodesignal Value4Value track](https://nutnovember.org/tracks/value4value)
focuses on voluntary audience support for podcasts and other creators. Ordinary
service invoices alone do not deliver that flow. A credible extension would let
someone support a particular episode, video or creator page with Cashu and an
optional message, with its own contribution records. It would not manufacture a
paid service invoice or promise automatic payouts and revenue splits.

Design and overall prizes are reasonable targets after genuine Cashu behavior
is demonstrated. We are not claiming newcomer eligibility. No prize is assured.

## Verification and participation

The registration audit passed 58 existing controlled checks covering crypto
receiving, receiving review/quotes, idempotency and encrypted storage. Those
checks do not qualify real Cashu wallets, a live mint or funded payments.
The wider baseline also has service and browser regression coverage; see the
[private-pilot setup and limits](REAL-INVOICING.md).

Use fictional records and controlled transports first. Actual wallet connection,
funded mainnet tests and any outgoing payment require the owner's explicit
action. The server operator can decrypt financial records and bridged email;
that is distinct from any proposed browser-only wallet boundary.

[Nut November](https://nutnovember.org/) accepts contributions to existing
projects and unfinished work. Its form asks contributors to identify what
existed before November 1 and what changed in November. This document and the
Git history should be updated with actual outcomes throughout the event.
