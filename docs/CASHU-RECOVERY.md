# Cashu receive-journal recovery

Operator tooling for one **already existing** Cashu receive journal. It recovers
the merchant proofs for a receive operation whose original swap response was
lost, checks NUT-07 input state, and makes protected journal backups. It is not
a wallet, a custodian, a mint client, a receiving endpoint or an invoice
settlement path.

The application still has no native Cashu wallet, mint connection, automatic
worker or public Cashu HTTP/MCP route. Cashu remains a simulated checkout unless
a separate trusted receiving adapter is configured later. Nothing here marks an
invoice paid or credits an owner note.

## Requirements

The operator supplies all state. This tool never generates seeds, counters,
blinding factors, outputs, wallet keys or a mint choice.

1. An existing journal created by a trusted receiving writer.
2. A separate, owner-only `0600` file containing exactly 32 raw storage-key
   bytes. Key rotation/export is out of scope; keep the key apart from backups.
3. An owner-only `0600` JSON profile naming the exact HTTPS mint, one keyset,
   the `sat` unit, the keyset input fee and explicit mint metadata.

```json
{
  "format": "quiet-ledger-cashu-recovery-profile-v1",
  "journalPath": "/srv/quiet-ledger/private/cashu/journal.sqlite",
  "mint": "https://mint.example.test",
  "unit": "sat",
  "keyset": {
    "id": "009a1f293253e41e",
    "keys": {
      "1": "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "2": "02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    "input_fee_ppk": 0
  },
  "mintInfo": {"name": "Example mint", "version": "1", "nuts": {"7": {}, "9": {}}},
  "maxFee": null,
  "swapReplayPolicy": "none"
}
```

All profile fields are required except `format`, `maxFee` and
`swapReplayPolicy`; unknown fields are rejected. `unit` must be `sat`: no fiat
conversion is implied or performed. The journal directory, profile, key file
and backup directory must be owned by the operator, mode `0700`/`0600`, and
free of symlinks. The SDK re-derives the keyset id from the public keys, unit
and fee and refuses a mismatch.

## Commands

```sh
# Read-only; never contacts a mint.
node ops/cashu-recovery.mjs status --profile profile.json --storage-key key.bin
node ops/cashu-recovery.mjs inspect --profile profile.json --storage-key key.bin --operation op-123
node ops/cashu-recovery.mjs profile --profile profile.json

# Local preflight only; still no network.
node ops/cashu-recovery.mjs restore --profile profile.json --storage-key key.bin --operation op-123
node ops/cashu-recovery.mjs check   --profile profile.json --storage-key key.bin --operation op-123

# Explicit one-operation recovery. Requires --apply, the exact configured mint
# and bounded transport limits.
node ops/cashu-recovery.mjs restore --profile profile.json --storage-key key.bin \
  --operation op-123 --apply --mint https://mint.example.test
node ops/cashu-recovery.mjs check --profile profile.json --storage-key key.bin \
  --operation op-123 --apply --mint https://mint.example.test

# Protected local journal backup and restore.
node ops/cashu-recovery.mjs backup --profile profile.json --storage-key key.bin \
  --out /srv/quiet-ledger/private/cashu/backup-2026-11-06.sqlite --apply
node ops/cashu-recovery.mjs restore-backup --storage-key key.bin \
  --in /srv/quiet-ledger/private/cashu/backup-2026-11-06.sqlite \
  --out /srv/quiet-ledger/private/cashu/restored.sqlite --apply
```

`status` is the default command. Every command prints one JSON object. Failures
print only a stable `error.code`; proofs, secrets, blinding factors, request
bodies, mint responses and key values are never printed.

`restore` is the NUT-09 path: it asks the mint for the signatures of the
blinded outputs that were already persisted in the original committed request.
No new outputs or secrets are created, and there is no second swap. `check`
records NUT-07 observations only; states alone never settle the operation.
Only a complete, cryptographically valid NUT-09 response, unblinded through the
stored `OutputData` and verified with the SDK's NUT-12 verifier, may finalize an
operation. Failed attempts leave it `uncertain` for manual reconciliation, and
the journal defaults to three restore attempts. After transient failures, an operator can explicitly raise `restoreAttemptLimit` in the protected profile (up to 100) and reopen the same journal. This preserves the original payload and append-only attempt history; it does not reset attempts or create value.

## Network boundary

Recovery opens the journal with its cooperative exclusive writer lock, so stop
or pause the trusted receiving writer first. A second cooperating writer fails
closed with `SINGLE_WRITER`; do not disable the lock or copy a live database.

Only `POST` requests to `<mint>/v1/restore` (and `/v1/checkstate` for `check`)
on the exact configured HTTPS origin are allowed. Redirects are refused,
response status must be `200` with JSON, requests are limited to 512 KiB,
responses to the configured limit (default 256 KiB, maximum 1 MiB), and each
phase has a hard wall-clock deadline (default 15 s, maximum 30 s). One transport
instance performs exactly one request. Authorization headers are refused. DNS
resolution and TLS are the local network's responsibility; no proxy or custom
endpoint is supported.

## Backup and restore safety

A backup is an online-SQLite consistent snapshot of the encrypted-payload
journal plus a `0600` manifest (`<backup>.manifest.json`) containing the format,
timestamp, SHA-256, byte size, table counts and a keyed authentication tag.
No decrypted payload or storage key is exported. Neither file overwrites an
existing path.

Restore requires the separate storage key. It re-reads both files, checks the
snapshot hash and size, authenticates the manifest with the separate key, and
verifies SQLite integrity, every encrypted payload and the recorded counts on a
private temporary copy. It then atomically publishes
the destination without overwriting it. A wrong key, corrupt snapshot, tampered
or missing manifest, count mismatch or existing destination leaves the
destination absent. Existing hosted application backups do **not** cover this
external journal until the operator configures this command; there is no
automatic off-server replication or alerting.

## What is not implemented

- Merchant custody, wallet seeds, output generation, counters, token storage or
  mint selection.
- Native receiving, mint LUD-21/NUT-18 request issuance, or funded acceptance.
- Any public HTTP, MCP, API or worker route; any startup worker or wallet
  enablement.
- Invoice payment. The outbox event is bookkeeping-only and stays pending. A
  future receiving adapter must authenticate the tenant and record one verified
  payment per operation; it must not reuse the invoice owner-credit path. Do not
  wire `InvoiceLedger.credit` to Cashu events.
- Lightning→Cashu attribution. A Lightning receipt remains a Lightning receipt
  even if the payer used a Cashu wallet's melt flow.

NUT-09 retention, NUT-07 semantics, fees and real operator runbooks still need
funded, independently operated mint qualification. Published NUT-00/NUT-12
vectors and a controlled local mint are not funded acceptance.

## Verification

```sh
npm run test:cashu
```

This needs the pinned `@cashu/cashu-ts@4.13.0` dependency installed. The
orchestrator runs every test process with Node's permission model, denying
network and child processes, inside one fresh private run directory under the
50 GiB free-space floor. It runs 41 crypto and review checks (NUT-00/07/09/12
journal, restore, adversarial and retry/concurrency review), 52 recovery-tool checks (profile/path
validation, bounded mock HTTP, backups and wrong-key/corruption restore, safe
CLI output, lost-response recovery), a network/subprocess denial probe, and a
three-process lost-response → NUT-09 restore → single idempotent delivery
journey. No real mint, wallet, seed, customer data or funds are involved.


Inspection requires an existing initialized receive journal. Empty or unrelated
files are rejected without creating a journal, key marker or writer-lock file.
Mint profiles use canonical HTTPS URLs. Recovery objects sharing a journal hold
one local operation lease, and restored outputs must match the original request.
None of the commands initializes a merchant wallet or settles an invoice.

Backup and restore require a pre-existing journal key-check marker before the
journal is opened. Empty files, unrelated databases and self-consistent manifests
without the complete journal schema (including the exact 16 trigger definitions) and that marker are rejected; a manifest hash alone cannot authenticate a
journal. The storage key must then authenticate the existing marker before a
restored destination is published. Failed validation leaves the source unchanged.
Output is always JSON; the optional `--json` flag is a compatibility alias.

The manifest authentication is HMAC-SHA256 using a 32-byte HKDF-SHA256 key
derived from the storage key with empty salt and info
`quiet-ledger-cashu-backup-auth-v1`. It covers the UTF-8 JSON array of format,
createdAt, SHA-256, byte size and counts in this order: operations, reservations,
merchantProofs, results, outbox, observations. The lowercase hex tag is stored
as `authentication`. Unauthenticated manifests are rejected; this unreleased
format does not import older unsigned qualification artifacts. Authentication
detects modification, not deletion or rollback to an older valid backup. Keep
backup timestamps and independent recovery copies under operator control.

Restore also checks that validated snapshot bytes still match the authenticated
manifest before publishing. Missing or altered journal triggers are rejected;
the recovery tool does not repair schema drift. `restore-backup` requires
`--apply` before reading key or journal files.
