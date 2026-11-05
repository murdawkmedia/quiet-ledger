# Quiet Ledger

Private invoicing and checkout with optional Marmot conversations, self-hosted
accounts and Bitcoin/fiat provider connections.

This is an experimental application. It is suitable for fictional demonstrations
and evaluation. A provider being listed or connected does not establish funded
payment acceptance. Outgoing conversions and payouts remain simulated.

## Source and mirrors

Development is maintained through ngit and GitWorkshop. This GitHub repository
is an exact source mirror for browsing, cloning and collaboration. Release refs
are verified against the primary repository; the mirror contains the complete
reviewed application source, tests and setup documentation.

Primary: [GitWorkshop](https://gitworkshop.dev/npub17j3f7cuhcvjqnf7d80x6rt9hmkkhdguwg4l2th0h4qnhqketr63s6xakwv/git.shakespeare.diy/quiet-ledger).
Clone with the [ngit remote helper](https://ngit.dev/):

```sh
git clone nostr://npub17j3f7cuhcvjqnf7d80x6rt9hmkkhdguwg4l2th0h4qnhqketr63s6xakwv/git.shakespeare.diy/quiet-ledger
```

Mirror: [murdawkmedia/quiet-ledger](https://github.com/murdawkmedia/quiet-ledger).
Hosted preview: [Quiet Ledger](https://quiet-ledger-dyp.pages.dev).

## Run locally

Use Node 26 and npm. Install the locked dependencies, build, then create a private
account installation outside this repository:

```sh
npm ci
npm run build
node scripts/setup-selfhost.mjs --directory /absolute/private/quiet-ledger --start
```

The default local browser origin is http://localhost:4417. No accounts or provider
credentials are seeded. Sign up with a passkey or Nostr signer. The installer
creates independent storage, backup and proxy keys. Keep the keys private and
separate from encrypted backup archives. See [self-hosting](docs/SELF-HOSTING.md)
for Docker/Caddy HTTPS and [connections](docs/CONNECTIONS.md) for provider setup.

For a fictional hackathon visit, explicitly enable demo mode on a separate
installation with `--demo`; its public demo password is `marmot`. Real and
fictional workspaces stay separate. See [the demo guide](docs/DEMO-TEAM.md).
The optional agent demo additionally requires its pinned private Hermes worker
and native Marmot runtime; no model service is needed for ordinary invoicing.

## Features and boundaries

- Private passkey/Nostr accounts, encrypted record payloads, scoped API and MCP.
- [Reusable client invoice templates](docs/INVOICES.md), date pickers, CAD/USD/KRW/EUR/GBP,
  discounts, premiums, accepted-method controls, checkout links, records and exports.
- Optional per-invoice Marmot/MLS messaging and conversational fictional clients.
  The demo defaults to a two-member Riley chat, with a separate Jordan chat and
  an explicit three-member group. See [the demo guide](docs/DEMO-TEAM.md).
  Jordan can optionally use [Codex with the operator's subscription](docs/CODEX-DEMO.md),
  while Riley keeps the existing Hermes connection.
- Consistent encrypted database backups and a separate cold native-key backup.

The operator holding the storage key can decrypt financial records. Agents and
their configured model provider can read messages those agents decrypt. Browser
messaging keys and decrypted history are stored in IndexedDB without separate
local encryption; clearing site data loses access. The chosen Marmot SDK is
experimental, and the demo uses one restricted relay. This is not an application
cryptographic audit, anonymous banking service or custody system.

Receiving adapters require the user's own supported accounts/endpoints. Square,
bank and other provider availability varies; credentials are not included. No
wallet is selected automatically. Collateral observation is read-only and does
not establish ownership, encumbrance status or lending eligibility. White Noise
phone joining is optional and has not been qualified.

## Verification

```sh
npm run build
npm test
npm run typecheck
npm run test:e2e
npx playwright test --config tests/invoice-editor-ui.config.ts
python3 -m unittest discover -s tests -p 'test_*.py'
```

Native/model acceptance tests are opt-in and require separately configured,
private fictional runtime state. Keep test snapshots, provider credentials,
seeds, account records and browser profiles out of Git.

## Hosting and license

The self-hosted core is licensed under AGPL-3.0-or-later. Optional managed hosting
is a planned service operated by Murdawk Media; subscription billing is not
implemented. Self-hosting has no subscription check or mandatory Cloudflare
account. Infrastructure and optional external providers may have their own costs.
The app offers its source in every page footer. When hosting a modified fork,
set `VITE_SOURCE_URL` to your corresponding source before building and follow
the license’s source-distribution and network-use terms.

Copyright 2026 Murdawk Media. See [LICENSE](LICENSE), [third-party notices](NOTICE.md)
and [security guidance](SECURITY.md). The fictional Marmot Field Lab, Riley and
Jordan do not represent an affiliation with the Marmot or White Noise projects.
