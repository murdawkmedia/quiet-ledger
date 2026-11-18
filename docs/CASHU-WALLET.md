# Pay with Cashu and settle over Lightning

A payer can redeem ecash in the checkout browser to pay the merchant’s exact
Lightning invoice. The merchant can receive at a Lightning Address, Coinos,
LND or a saved NWC wallet. The mint handles the Cashu-to-Lightning conversion;
Quiet Ledger does not run a swap service or hold a merchant Cashu balance.

## In the checkout

1. Open a validated live Lightning request and choose **Pay with ecash here**.
2. Export an unlocked SAT token from your Cashu wallet. This version accepts
   `https://mint.minibits.cash/Bitcoin` and `https://mint.coinos.io` only. Tokens
   need valid DLEQ proofs; locked, unsupported or insufficient tokens are refused.
3. Paste the token into the masked field and review the invoice amount, input
   fee, Lightning fee reserve and maximum debit. Preparing obtains a quote; it
   does not spend. The whole supplied token enters the conversion, with unused
   value returned as ecash change. Prefer a small token close to the invoice value.
4. **Save private recovery file**, then explicitly confirm the quoted payment.
   This file contains spendable bearer proofs and output secrets. Keep it private.
5. Wait for the merchant’s independent Lightning check. Copy or download returned
   ecash change and import it into your wallet. Keep the recovery file until both
   settlement and change are resolved.

**Pay from a Cashu wallet** remains available if you prefer to scan/copy the
Lightning invoice and confirm in Minibits, Zeus or another compatible wallet.
That option does not import a token into this browser. Wallet and mint support,
fees and availability vary; no phone-wallet funded acceptance is claimed.

## Recovery and privacy

Before sending, the browser encrypts the original proofs, quote and blinded
change outputs in IndexedDB. Atomic proof/invoice reservations and a saved
attempted state prevent a second melt through reloads or competing tabs on this
browser profile. Nothing sends on mount, import or quote review. Clearing browser
storage, using another device or manually spending exported proofs defeats that
local coordination; do not try the same ecash in another place while unresolved.

A timeout is an unknown outcome. **Check saved payment and change** checks only
the original quote and, when necessary, restores its already-saved outputs using
[NUT-09](https://cashubtc.github.io/nuts/09/). It never sends another melt. Imported
recovery files permit checks only. Recovery remains visible after the merchant
receipt or invoice expiry. Payment can complete while change recovery remains
pending; the page keeps these states separate and retains known recovered change.
A quote still marked unpaid is not permission to start a second payment.

Bearer proofs and output secrets go directly from the browser to the selected
mint, never to the Quiet Ledger API. Local records are encrypted with a
browser-local key. A script running on this origin can still access them; this is
not protection against a compromised site or browser. Recovery/change downloads
are private bearer material, not encrypted account backups. Avoid shared browsers.
No wallet seed, NWC secret or Marmot identity is used to fund this conversion.

## Receipts and method pricing

The merchant’s backend verifies its original Lightning request before issuing a
receipt. A browser’s successful conversion claim cannot mark an invoice paid.
The receipt says **Lightning**; the browser separately shows Cashu conversion and
change status. This is [NUT-05](https://cashubtc.github.io/nuts/05/) melting with
[NUT-08](https://cashubtc.github.io/nuts/08/) change, not a native Cashu merchant
receipt. The invoice’s confirmed Lightning price and installment amount remain
authoritative. A Cashu-specific method discount does not apply to a Lightning
payment just because the payer used ecash.

Quiet Ledger adds no service fee. The input fee and mint Lightning reserve are
quoted separately before consent. An unknown or invalid change response preserves
recovery state; it cannot authorize a replacement payment.

## Verification and separate options

Controlled tests use real proof/DLEQ cryptography and a synthetic mint. Built-app
browser tests cover a 21-sat Lightning receipt, 10-sat change, a lost melt response,
reload and recovery without a second melt. No actual mint payment or independently
operated funded Minibits/Zeus wallet has been qualified by these tests.

Manual [external-wallet Cashu receiving](CASHU-EXTERNAL-WALLET.md) is a separate
option with an owner-confirmed Cashu receipt. The internal server-side
[recovery tooling](CASHU-RECOVERY.md) remains separate and does not manage these
browser operations. Merchant custody, seeds, liquidity and a paid hosted swap
router remain out of scope.
