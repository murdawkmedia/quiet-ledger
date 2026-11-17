# Receive Cashu ecash in your external wallet

Quiet Ledger can record Cashu ecash payments you receive in your own wallet.
This is the **external-wallet receiving** design: Quiet Ledger never takes
custody. It saves your wallet hosting choice, wallet label, one approved mint
and the nonsecret instructions that describe your existing outside-wallet
transfer channel, and it records a receipt only after you explicitly confirm.

Both wallet hosting choices are supported as explicit saved connections:

- **Self-hosted wallet (user-run)** — you run the receiving wallet yourself,
  alongside existing self-hosted receivers such as LND, Bark or LNURL.
- **Third-party wallet** — a wallet app or service you already use, such as
  Minibits.

Both choices use the exact same honest manual receiving and invoice flow, and
both carry the same explicit verification level: **manual owner confirmation**.
Choosing self-hosted never raises the verification level, never sets an
automatic paid flag, and is not advertised as an operational automatic Cashu
receiver. A separately qualified automatic receiver would be its own future
connection with its own acceptance.

This app never generates a wallet secret, never stores or ingests
`cashuA`/`cashuB` tokens or proofs, never connects a private wallet, and never
redeems, swaps, mints or melts ecash. Saving or checking the connection makes
**no network request** and never calls the mint.

## Set up the connection

Open **Connections** and choose **Cashu external wallet**. The form asks for:

- **Wallet hosting** — self-hosted wallet (user-run) or third-party wallet.
  This is a public custody label for the payer, not a wallet connection.
- **External wallet** — Minibits, Zeus or another compatible Cashu wallet.
  This is a label for the payer, not a wallet login.
- **Cashu mint** — exactly `https://mint.minibits.cash/Bitcoin` or
  `https://mint.coinos.io`. Payers must send on the same mint. Running your own
  mint URL is a separately named future capability and is deliberately not
  offered here.
- **Receiving instructions** — a plain description of how a payer transfers
  ecash to you through your existing wallet channel. These instructions are
  shown to the payer, so include only what you intend to share. Never paste a
  Cashu token, seed, private key or proof; token-shaped values are refused.

Saving returns **manual** status. It is saved receiving information, not a
wallet login and not a claim that receiving works. **Recheck connection**
repeats the same offline check; **Disconnect** removes the saved settings and
stops new receiving requests through the connection.

## Limits

- **Live SAT invoices only.** The required net value is the exact whole-satoshi
  invoice amount; there is no fiat conversion and no cross-mint swap.
- **One unique reference per receiving request.** The saved connection is
  reusable, but every receiving request gets its own invoice-bound payment
  reference. This is not a static one-address pool.
- **No scan-to-pay QR.** The payment page shows plain instructions only, because
  there is no Cashu payment request the app could encode.
- **Hosting is a label, not a verification level.** Self-hosted and third-party
  wallets both settle through your manual confirmation.
- Wallet and mint fees may apply. The payer must cover them so you receive the
  exact net sats shown.

## Receiving and confirming

1. The payer opens the invoice's live checkout, chooses **Cashu ecash**, and
   continues to a payment page showing your exact mint, the net sats, fee
   guidance and the unique payment reference.
2. The payer sends ecash from their own wallet on that mint, using your saved
   instructions, entirely outside Quiet Ledger.
3. **Check payment** on the payer page always returns *awaiting owner review*.
   Payer action or evidence alone never credits the invoice.
4. You confirm in **Payment methods** only after importing the received ecash
   into your external wallet and verifying it is **spendable there** — not
   merely inspecting a token. Enter the unique received transaction reference
   and a verification note, then confirm.

Use a nonsecret reference that is unique across your Cashu receiving connections.
Changing the wallet hosting choice does not make the same transfer reusable.
Token-shaped values are refused in connection labels and settings, payment
checks, and confirmation references and notes. Do not enter wallet secrets in
any field.

The receipt records the **Cashu ecash** method, the wallet hosting choice in its
provenance, and **independent owner review** verification. It is not Lightning,
not a provider readback and not automated mint verification, regardless of the
hosting choice. Confirming does not prove wallet ownership, absence of
encumbrances or lender acceptance.

## Relationship to the Lightning handoff

The separate [pay-from-a-Cashu-wallet guide](CASHU-WALLET.md) is unchanged: a
payer can still pay a verified Lightning invoice from their Cashu wallet, and
that receipt stays Lightning. External-wallet receiving is the manual ecash
alternative for SAT invoices; the two paths stay distinct.

## Boundaries

All automated coverage for this flow uses fictional fixtures. No real wallet,
mint, provider or funded payment is contacted, and no funded acceptance is
claimed anywhere in the app. Real sender/recipient interoperability with an
independently operated wallet and mint remains pending actual external wallet
availability. See the [November plan](NUT-NOVEMBER.md).
