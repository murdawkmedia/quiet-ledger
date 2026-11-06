# Pay an invoice from your Cashu wallet

Quiet Ledger can guide your existing Cashu wallet to a live Lightning invoice.
The wallet pays Lightning through its mint. Quiet Ledger receives and verifies
Lightning; it never receives your ecash tokens or wallet keys.

## For the invoice owner

Connect a mainnet LND receiver or a Lightning Address/LNURL receiver that supports
automatic LUD21 settlement verification. Create a live Lightning receiving request
for your invoice and share its existing payment page. See [connections](CONNECTIONS.md).
The Cashu guidance appears only on newly created, validated requests that advertise
this capability. Earlier saved requests remain unchanged.

The guide is absent from simulation, test networks, manual instructions,
unverified LNURL receivers, expired requests and requests awaiting owner review.
It does not add a new accepted payment method or bypass the invoice's currency
and method restrictions. An invoice owner still needs a working receiver.

## For the payer

1. Open the invoice's live Lightning payment page. Check its amount and expiry.
2. Choose **Pay from a Cashu wallet**. Copy the Lightning invoice or scan its QR
   using your own compatible wallet's **Pay Lightning** flow.
3. Review the wallet's fees and total before confirming there. Wallet and mint
   availability, fees and payment recovery belong to your wallet.
4. Return to the same page and choose **Check payment**. A receipt appears only
   after the receiver independently verifies settlement.

The QR and copy contain the exact original Lightning request. Opening the guide
makes no mint connection, creates no extra invoice and performs no payment.
Quiet Ledger opens no wallet URI automatically. Never paste ecash tokens, seeds,
private keys or recovery words into a payment page.

## What the receipt means

The receipt says **Lightning**. Selecting the Cashu guide cannot prove the origin
of a Lightning payment, mark it paid or create a receipt. Pending payments remain
pending. Failed or expired payments need the existing verification/review flow;
ask the owner for a fresh request before sending to an expired invoice.

This release has controlled adapter, browser and end-to-end fixture tests. It has
not been qualified with a funded independently operated Cashu wallet/mint. It
implements no direct ecash receiving, minting, swapping, melting or token storage.
The [November plan](NUT-NOVEMBER.md) keeps direct ecash as a separate future design.
