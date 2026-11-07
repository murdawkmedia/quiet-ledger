# Cashu recovery module provenance

Copied-byte hashes and the exact modifications made when the qualified core was
moved into public application source on 2026-11-06. The frozen qualification
artifact set (not part of this public repository) was not modified; its hashes
match the integration handoff and the table below.

## Initial production-core import (historical baseline)

| File | Bytes | SHA-256 | Qualification manifest hash |
| --- | --- | --- | --- |
| `cashu-journal.mjs` | 37264 | `8e1fbe10ea7fd06c965a264f046468cb7ca0a83f057ff21aaee9b9d6a16f667e` | match |
| `cashu-recovery.mjs` | 36428 | `70a9718e80256036730a70af267619f0975343e3b38593fa1216282e04c9ed61` | match |

The initial import preserved those bytes. The current core includes the reviewed
application corrections below; the preceding table records the historical
qualification snapshot rather than the current file hashes. Both modules import
only Node built-ins and each other;
the SDK is injected by the caller, so public runtime source has no private
qualification path. The pinned qualification SDK was
`@cashu/cashu-ts@4.13.0` from the isolated qualification install (Node
`v26.13.0`); that absolute path appears only in local qualification evidence,
never in source.

## Test copies (import-specifier modifications only)

The retained 33 crypto checks are copied into `tests/cashu/native/`. Their test
bodies are unchanged; only import specifiers were rewritten so the public
source imports the standard SDK package and `server/cashu/` copies.

| File | Copy SHA-256 | Frozen SHA-256 | Modification |
| --- | --- | --- | --- |
| `tests/cashu/native/native.test.mjs` | `8d6f3bf046b89c6fb1e803657e5f23c4139629649810b3deab0128ef89093386` | `8c51576129a0cc624bb70628d2d56ef8f23359a7a5b4474da71229fc9965ce7e` | `./cashu-*` → `../../../server/cashu/*`; `./fixtures.mjs` → `../fixtures.mjs` (static and dynamic imports) |
| `tests/cashu/native/journal.test.mjs` | `707d74b718248d37b0e2c8d2085a11c92ae3f83491a54ddc14f441f7eddf09ac` | `dcdebe3af8f0ca34297cfe5715feed9532dc33b49a21dcf062eba926944a356f` | same import rewrite |
| `tests/cashu/native/adversarial.test.mjs` | `15cecb3f94481fa3cc849a1df72a4a9e73de9d8650bf5c92a0721ca4377389c5` | `399e374d3b4e5530783ef67286dd6b6b80f1e92b5484b48f96391776b766d61d` | same import rewrite |
| `tests/cashu/fixtures.mjs` | `7a45de5de578e9fc1ae291e13c3c4f883365c387b56dccb50d79d88db334c9d4` | `962c1e6624d6efdae8564ee8e0950b5b32ea817213747036a40d1b109055118e` | absolute private SDK path → `@cashu/cashu-ts`; core import → `../../server/cashu/`; added the public-source adaptation note |

`tests/cashu/fixtures.mjs` stays test-only and must never be imported by
application runtime. It uses only published NUT-00/NUT-12 test vectors and a
controlled in-memory mint. No wallet seed, funded mint, real network or
customer data is present.

## Public additions (not from the frozen core)

`paths.mjs`, `profile.mjs`, `transport.mjs`, `runtime.mjs`, `backup.mjs`,
`index.mjs`, their `.d.mts` declarations, `ops/cashu-recovery.mjs`, the new
`tests/cashu/*.test.mjs` files, the process phases, the runner and
`docs/CASHU-RECOVERY.md` are new application code. They never generate wallet
material, never choose a mint, never create a public route and never credit an
invoice. Exact hashes for these files are recorded in the integration handoff.

## Current reviewed application core

- `cashu-journal.mjs`: 40234 bytes, SHA-256 `8d5f929d455ea6175eec1ac4dce89fe0cb9192841758eb047247a0b77cdee2a6`.
- `cashu-recovery.mjs`: 37088 bytes, SHA-256 `6bdd3160007702a65eb8f2ef499bdccf3cd1dbf879f167b035b20cddf37622f9`.

The application adds a bounded explicit operator restore budget (default 3,
range 1..100), a journal-level operation lease across recovery objects, validation
of the first restore payload against committed outputs, an 8 KiB state-witness
bound, and distinct invalid-data versus unavailable/network observations. The
original preparation, request, proof reservation and append-only result remain
unchanged. Eight review probes plus the retained 33 tests cover these changes.
Public declarations and protected profile loading expose the budget; inspection
rejects an uninitialized journal. Test copies of the additional probes rewrite
imports to the standard SDK and public module paths, and remain test-only.

The packaged-backup review added a pre-existing key-marker guard before any
initializing constructor, full sealed-payload authentication during backup and
restore, and a domain-separated keyed backup manifest. The source journal
format and original committed requests are unchanged. Additional backup probes
cover empty/unrelated files, fabricated manifests, rewritten digests, corrupted
sealed records, finalized history and count mismatches.

The final packaged review also requires explicit restore apply, checks all 16
trigger definitions against the constructor’s shared SQL before opening a
journal, and verifies exact snapshot bytes again before restore publication.
The constructor SQL is unchanged; its trigger declarations now share one
constant with read-only validation. Four trigger-drift cases and the CLI gate
assertion cover the changes.
