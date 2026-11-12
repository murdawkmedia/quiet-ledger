# Cashu invoice settlement intake (internal)

`CashuInvoiceIntake` connects one trusted receive journal to the application's
invoice ledger. It accepts SAT-denominated invoices only. It has no HTTP/MCP
route, public token input, wallet setup, seed generation, mint transport or
scheduled receiver. A user cannot receive ecash through this component yet.
Merchant custody, output/counter management and funded acceptance remain separate
configuration and acceptance gates. The Cashu-to-Lightning guide is unchanged.

## Binding before effect

`bind(workspace, invoiceId, request)` runs under the application's transaction:

- Resolve an existing invoice in the caller's private workspace.
- Require an untouched prepared journal operation: no prior attempt, no saved
  request hash, and no uncertain/finalized state. There is no late-binding path.
- Freeze the exact operation/invoice, mint, sat unit, keyset, net amount, maximum
  fee and confirmed Cashu method agreement, if any.
- Accept a positive whole-satoshi amount no larger than the authoritative current
  unpaid balance. A method premium can increase that target; a discount reduces
  it. The original issued total is never rewritten.
- Permanently bind an operation ID once across all aliases within this Store.
  Identical retries are allowed only while the operation remains untouched.

An unbound operation which already reached a mint stays outside this allocation
path. Its proofs and pending outbox remain in the journal for explicit operator
reconciliation; this service does not retrospectively assign them to an invoice.

## Trusted settlement and replay

`settle(workspace, operationId)` reads the result and matching pending outbox
from the configured trusted journal. A caller cannot submit its own event or
proof object to this method. The pure `classifyCashuIntake` contract requires
valid invoice facts and checks invoice identity, amount, fee, method and unit.
Its states are `accepted_locked`, `rejected` and `unknown`; none is a receipt.

For a matching finalized operation, the service rechecks current invoice facts
inside one application transaction, appends a live Cashu ledger payment, saves
its stable receipt/allocation identity and updates invoice state. Only after
that commit does it acknowledge the journal. A crash or acknowledgment failure
leaves the committed receipt reusable on restart without a second credit.

Binding/allocation rows have immutable SQL triggers. Unique operation/result
indices prevent duplicates within the application Store. Reusing an allocated
result under another binding fails with `CASHU_RESULT_ALREADY_ALLOCATED` before
another credit; a different alias cannot reserve an already-bound operation.

Another request may settle first after both were validly bound. Late/excess
verified value then remains in an encrypted review record and the unacknowledged
journal, with proofs preserved. It does not overwrite the invoice total or
silently vanish. `reviewList(workspace)` lists these uncredited observations;
`binding(workspace, operationId)` returns only the caller's binding.

## Trust and operating limits

The constructor is an internal dependency-injection boundary, not an untrusted
provider API. A trusted journal reader must use the existing authenticated,
qualified journal/recovery code and correct keys. Arbitrary code supplied as
`TrustedCashuJournal` can fabricate read results and must never originate from
payer input, tenant JSON, public callbacks or external adapters.

Use one journal with one application Store and one stable alias. Operation IDs
must be unique across that Store. An alias is an operator label, not a
cryptographic wallet identity. The journal result tag is keyed by the journal's
key, and deduplication is scoped to this Store. Running restored journal copies
against independent application databases is not coordinated or qualified.
Choosing a real custody architecture must settle that ownership and restore
contract before activating a receiver. No cross-installation exactly-once claim
is made by these tests.

SAT settlement does not create a CAD reference or fiat conversion. Payments use
`cashu` provenance; the existing external-wallet Lightning handoff still yields
a Lightning receipt. Proofs, blinded outputs and wallet/storage keys stay in the
private journal, outside application views, audits and ledger payloads. The
application Store must be encrypted in hosted use.

## Internal API

```ts
const intake = new CashuInvoiceIntake(store, trustedJournal, {
  journalAlias: 'primary', // stable, one journal -> one Store/alias
  agreements,             // optional existing MethodPriceAgreements
  now,                    // optional clock
});
intake.bind(workspace, invoiceId, {
  operationId, mint, unit: 'sat', keysetId, netAmount, maxFee,
});
intake.settle(workspace, operationId);
intake.binding(workspace, operationId);
intake.reviewList(workspace);
```

Bind/settle must be called by the authorized private runtime after the merchant
custody gate; nothing mounts or enables them automatically. Errors are bounded
`DomainError`s with stable codes and do not echo bearer proofs or key material.

## Verification

`tests/cashu-invoice-intake.test.ts` uses the pinned cashu-ts 4.13 SDK, published
fictional NUT-00/NUT-12 material and a controlled mint. It covers pre-effect
binding, premiums/discounts/remaining due, missing and malformed invoice facts,
immutable rows, exact result/invoice matching, alias/result conflicts, restart
and commit-before-ack replay, late-result preservation and proof redaction.
These are controlled cryptographic fixtures, not independently funded acceptance.

```sh
node --max-old-space-size=512 --import tsx --test tests/cashu-invoice-intake.test.ts
```
