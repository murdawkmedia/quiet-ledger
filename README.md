# Quiet Ledger

Private invoices, checkout and client conversations, with self-hosted accounts
and optional Bitcoin/fiat receiving connections.

The private pilot includes saved clients, billing snapshots, printable invoices,
direct Marmot messages and Gmail replies in invoice threads. An optional
persistent Email gateway lets an explicitly paired owner review and reply to
email from a Marmot client while the browser is closed. Ordinary private accounts
need no AI or model service. Start with [private invoices and conversations](docs/REAL-INVOICING.md).

This remains an experimental private pilot. Automated checks use fictional
records and controlled transports. They do not qualify installed White Noise
interoperability, an actual Gmail send/reply or funded payment acceptance.
A listed or connected provider does not establish funded acceptance. Outgoing
conversions and payouts remain simulated.

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
Hosted fictional preview: [Quiet Ledger](https://quiet-ledger-dyp.pages.dev).

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
fictional workspaces stay separate. The optional agent demo additionally requires
its pinned private Hermes worker and native Marmot runtime.

## Features and boundaries

- Private passkey/Nostr accounts, encrypted record payloads, scoped API and MCP.
- [Saved clients and invoice templates](docs/INVOICES.md), billing details captured
  at issue time, invoice/receipt printing, CAD/USD/KRW/EUR/GBP, discounts, premiums,
  accepted-method controls and private checkout links.
- Direct two-person Marmot rooms with explicit invitations, a separate messaging
  identity, a public-key QR and passphrase-encrypted browser storage.
- [Invoice email](docs/INVOICE-EMAIL.md), optional inbox reading, reviewed threaded
  replies and a separately paired Email gateway. Native chat, email submission
  and invoice payment have separate states.
- [Encrypted database backup and recovery](docs/SELF-HOSTING.md#backup-and-recovery).
  Browser identity backups require fresh chat membership after restore.

The server operator can decrypt stored financial records and bridged email.
Gmail can read email. Direct native messaging keys and state are encrypted in the
participating browser with its messaging passphrase; they are separate from
account authentication and wallet keys. The Email gateway is a visible server
participant with its own identity. It does not join native-only rooms by default.
The pinned Marmot SDK is experimental. These features have not received a formal
application cryptographic audit.

Receiving adapters require the user's own supported accounts/endpoints. Square,
bank and other provider availability varies; credentials are not included. No
wallet is selected automatically. Collateral observation is read-only and does
not establish ownership, encumbrance status or lending eligibility. Configure
your own receiving adapter and verify its actual account/network behavior before
relying on it for a client payment.

## Fictional demo

The public hackathon demo remains separate, with password `marmot`. Demo invoices
and templates stay saved for 30 days in the same browser's workspace. Use
**Demo invoices** to reopen earlier checkouts. Agent chats have a separate
ten-minute allowance; resetting the team keeps invoices.

Riley and Jordan simulate people for that demo. It has separate two-person rooms
and an explicit three-person group; production native rooms currently have two
members. See [the demo guide](docs/DEMO-TEAM.md) and optional
[Codex demo setup](docs/CODEX-DEMO.md). Its older browser messaging storage is
separate from the encrypted private messaging path and should contain fictional
data only. Agents and their model provider can read messages those agents decrypt.
The demo can preview email; it cannot connect a mailbox, send email or use the
private Email gateway.

## Verification

```sh
npm run build
npm test
npm run typecheck
npm run test:e2e
npx playwright test --config tests/invoice-editor-ui.config.ts
npx playwright test --config tests/client-threads-browser.config.ts
npx playwright test --config tests/production-messages-browser.config.ts
npx playwright test --config tests/email-inbox-browser.config.ts
python3 -m unittest discover -s tests -p 'test_*.py'
```

Native core tests exchange real MLS ciphertext between independent SDK peers.
The production messaging browser checks use two independent browser participants
with intercepted WSS relays. They do not test an installed White Noise client or
publish to public relays. Mail checks use controlled SMTP/IMAP transports.
Separately configured native/model demo acceptance tests remain opt-in. Keep test
snapshots, provider credentials, seeds, account records and browser profiles out
of Git.

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
