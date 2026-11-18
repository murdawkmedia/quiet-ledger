# Receive through Minibits, Zeus or another NWC wallet

Nostr Wallet Connect (NIP-47) lets Quiet Ledger create and check Lightning
invoices in an existing external wallet. Minibits and Zeus can use Cashu behind
that Lightning interface. The customer can pay from a different compatible
wallet or mint; their wallet handles any ecash-to-Lightning conversion.

The settlement observed by Quiet Ledger is **Lightning**. It does not verify
destination ecash proofs, select the receiver's mint remotely, hold bearer
tokens, or run a funded cross-mint swap broker. Set the preferred Cashu mint in
the receiving wallet. Existing same-mint manual ecash receiving stays separate.

## Connect your receiving wallet

1. In the wallet, create a dedicated NWC connection for this installation.
2. In Zeus, choose **Custom** and enable **Get info**, **Make invoice**, and
   **Lookup invoice**. Read Only cannot create invoices. Disable payment,
   signing, balance and history access. Enable its Cashu routing if desired.
3. Minibits currently advertises methods rather than proving per-method grants
   and uses connection spending budgets. Its URI can authorize more than this
   app uses. Restrict its budget; if it cannot issue a suitably restricted
   connection, use the existing Lightning Address option instead. A successful
   metadata check is not proof that the URI has no spending authority elsewhere.
4. Open **Connections → Minibits / Zeus / NWC wallet**, select the wallet label
   and paste the connection URI into **NWC receiving connection**.
5. Choose **Verify & save connection**. This authenticates receiving metadata
   and the mainnet network without creating an invoice. The saved connection
   survives sign-out and restart; the full URI is never returned in summaries.
6. Issue an invoice and choose this Lightning connection at checkout. Keep the
   wallet online and unlocked as its background-service rules require. Check
   the original payment before expiry.

The URI contains a dedicated application secret. It is not a seed phrase, but
it is still sensitive: this instance encrypts it on the server and its operator
can decrypt it. Never paste a wallet seed, wallet private key or bearer ecash.
This adapter only sends `get_info`, `make_invoice` and `lookup_invoice`; it has
no payment, signing, history or balance call.

## Payment and recovery behavior

Supported invoice currencies use the existing exact receiving quote; NWC
amounts are integer millisatoshis. Mainnet BOLT11 amount, payment hash, signed
response identity and original context must agree before any receipt is issued.
Fiat invoices retain their issued currency and amount in the ledger.

The original request is retained before contacting the wallet. If an invoice
response is lost, the app does not create a replacement automatically. Review
the original request in your wallet. After restart, a known saved invoice can
be checked again; an uncertain create without its original invoice cannot be
recreated safely. Repeated confirmed checks produce one ledger receipt.

Some wallet responses use transaction creation time as `settled_at`. Therefore
late checks fail closed into review; a claimed old timestamp is not sufficient
to prove an in-window payment. An offline wallet, timeout, mismatch, unknown
state or invalid proof never becomes a paid invoice.

Public WSS relays on port 443 are supported, with bounded requests and pinned
public DNS results. Multiple URI relays are validated, but only the first is
used; no automatic relay failover repeats invoice creation. Auth-required,
private/LAN and insecure relays are unsupported. NIP-44 is preferred after
signed capability discovery; signed legacy NIP-04 services remain compatible.

No hosted service fee is charged by this adapter. Wallet/mint/Lightning fees
may apply. A separate managed routing service would need its own fee quote,
custody and recovery design.

## Verification limits

Automated tests use controlled NWC services, real event signatures/encryption,
signed fictional invoices and encrypted application stores. They establish
protocol and application behavior, not funded acceptance on installed mobile
wallets. Complete a separately authorized small payment on the actual wallet
before relying on it for customer funds.
