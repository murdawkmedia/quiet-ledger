# Run your own Quiet Ledger

The encrypted account edition runs on your own computer or server without a
Quiet Ledger subscription, Cloudflare account or vendor login. It serves the
browser app, passkey/Nostr account API and invoice checkout at one origin. The
operator controls the database, encryption keys and backups. The operator can
read financial records; storage encryption is not zero knowledge.

The older owner-token development mode on port 4317 remains separate. Use the
setup below for private account storage. Keep state outside the source checkout,
Git repositories and any personal notes vault. No real accounts or invoices are
copied into a fresh installation.

## One computer: localhost

Use Node 26 and the repository's locked dependencies. From the source root:

```sh
npm ci
npm run build
node scripts/setup-selfhost.mjs
node scripts/setup-selfhost.mjs --start
```

Open **http://localhost:4417** in the browser on that computer. HTTP localhost is
a browser secure context, so WebAuthn passkeys and WebCrypto work without a local
TLS certificate. Use the exact configured origin rather than switching between
localhost and its IP address. Firefox needs an enabled passkey provider such as
Bitwarden, and creation must follow a user click.

The default private installation is `~/.local/share/quiet-ledger-local`. It holds
`data`, `backups` and `secrets` directories with mode 0700 and three independent
0600 key files. `runtime.env` contains file paths rather than key values. The
setup command refuses foreign directories, linked paths, exposed keys and changes
to an existing installation's origin or demo setting. Repeating it validates and
preserves the existing keys and data. It does not migrate the old prototype.

Choose another empty private directory with `--directory /absolute/private/path`.
An installation is bound to its source path; keep that path stable for upgrades.
The launcher reads only its owned runtime configuration and basic process settings,
so inherited owner/provider credentials do not leak into new account storage.

Local HTTP startup refuses a public network bind. For access from other devices,
use a stable HTTPS origin and a reverse proxy you operate. Do not expose the
localhost HTTP listener directly to a LAN or the Internet.

## Optional fictional hackathon demo

A normal installation starts with no accounts, seed invoices or enabled public
demo. To create a separate demo installation explicitly:

```sh
node scripts/setup-selfhost.mjs --directory /absolute/private/demo --demo
node scripts/setup-selfhost.mjs --directory /absolute/private/demo --start
```

The demo account is for fictional data and simulated payment activity. Demo
identities are separate from personal account credentials and source-maintainer
Nostr keys. Agent/model and relay configuration remain explicit choices; enabling
the demo does not authorize a payment or an external message. Plain checkout
works without Marmot. Browser MLS state remains on that participant's device.

## HTTPS with Docker and your own Caddy

The standalone Docker image includes the built frontend. It does not need an
existing Cloudflare or shared front-door network. Create a distinct installation
with an HTTPS origin before starting Compose:

```sh
node scripts/setup-selfhost.mjs --directory /absolute/private/https-demo --origin https://localhost:4443

docker compose --env-file /absolute/private/https-demo/runtime.env -f ops/compose.selfhost.yml config --quiet
docker compose --env-file /absolute/private/https-demo/runtime.env -f ops/compose.selfhost.yml up --build -d
```

Open https://localhost:4443. Caddy uses a private local certificate authority for
localhost. Import its public root certificate into the test browser's trust store
before using passkeys; the HTTP localhost route above avoids that step. Never
copy the CA's private key into the browser or source tree.

The app runs as the installing user's UID/GID with a read-only image, writable
private data/backup mounts and read-only secrets. Only Caddy exposes a host port,
which defaults to loopback. Caddy's certificate state uses separate Docker volumes.
There is no cloud deployment or public DNS change in these commands.

For a domain you own, choose its exact `https://ledger.example.com` origin during
setup. Set these environment variables when invoking the same Compose commands:

```sh
export QUIET_LEDGER_SITE_ADDRESS=https://ledger.example.com
export QUIET_LEDGER_BIND_ADDRESS=0.0.0.0
export QUIET_LEDGER_HTTPS_PORT=443
```

Point the domain to your server and permit the HTTPS certificate challenge needed
by your Caddy configuration. The provided Compose publishes HTTPS on 443 only;
use the TLS-ALPN challenge or configure your own DNS challenge adapter. The app
stays on the private container network. Incoming proxy gate and client-IP headers
are replaced in the frontend process; rate limits use the actual socket peer.
Behind a reverse proxy, clients therefore share that peer's IP rate limit.

Changing the origin of an existing account install requires an explicit migration
plan because passkey relying-party identity, origin validation and saved client
state depend on it. Creating a different directory does not move old accounts.

## Backup and recovery

The storage key decrypts database records. The independent backup key encrypts
backup archives. Keep both keys and the proxy secret privately backed up outside
the server and source repository. Losing the storage key makes a restored database
unreadable. Keeping only a database or only a backup key is insufficient.

The existing backup tool accepts private absolute key paths. For the Node install:

```sh
node --env-file=/absolute/private/install/runtime.env --import tsx ops/backup.ts backup
node --env-file=/absolute/private/install/runtime.env --import tsx ops/backup.ts verify /absolute/private/install/backups/quiet-ledger-TIMESTAMP-ID.qlb
mkdir -m 700 /absolute/private/recovery
RESTORE_DB_PATH=/absolute/private/recovery/ledger.sqlite node --env-file=/absolute/private/install/runtime.env --import tsx ops/backup.ts restore /absolute/private/install/backups/quiet-ledger-TIMESTAMP-ID.qlb
```

Backup prints a generated archive basename; use that exact file for verify and
restore. The restore database file must not exist; its parent directory must
already be privately owned with mode 0700, outside the source tree. Inspect
the command's result before connecting a restored installation. The returned
`sha256` and `bytes` describe the restored database; `archiveSha256` identifies
the original encrypted archive. Backup and verify preserve the archived snapshot.

Restore deliberately removes persistent Email gateway identities, SDK/group state,
writer leases and pairing settings from the new database, and cancels prepared
email confirmations. It reports `communicationsReset: true` when this changes
archived state. Every gateway starts disabled and requires explicit pairing with
a newly generated gateway key and fresh room membership. Existing invoices,
accounts, clients, thread history, mailbox records, source deduplication and email
delivery records remain retained and encrypted. Unknown SMTP submissions remain
unknown; check the mailbox and reconcile them before any new explicit send.
The source database and encrypted archive are unchanged. Legacy backups without
gateway state restore unchanged database bytes.

Before cutting over, stop the old app and all workers that use its database or
gateway identity, and prevent them from restarting. Do not run the recovered
installation alongside the old sender. Confirm account access and financial
records, then explicitly reconnect each wanted Email gateway. Accept the new
invitation and complete pairing in White Noise; retire the old gateway room and
review its old identity on every participating device. Old pairing codes and
email confirmations cannot authorize sends through the replacement gateway.
Clearing only a process lock or stopping the old process does not make an older
SDK ratchet current; requiring fresh identity and membership is a precaution
against sender-state rollback, not a cryptographic audit claim. Ordinary restarts
retain the existing gateway identity and pairing.

A server backup does not recover participant browser Marmot/MLS keys or state.
Browser identity-only recovery is separate: it recovers the messaging identity,
not a current group ratchet or authorization to resume old memberships. Keep the
old browser/device closed during replacement and establish fresh memberships
where state is lost or stale. Store recovery material in an encrypted offline
location with access appropriate to your records.

For the container edition, invoke `node ops/backup.js` inside the app with the same
subcommands and mounted `/state/backups` paths. The keys are already passed by
file path. Do not print key contents or put them in shell arguments.

## Updates and current limits

Stop the local process, preserve a verified encrypted backup and all three keys,
update the source at the same path, rebuild, and run setup with `--start` again.
For Docker, rebuild and recreate the app using the same private mounts. Confirm
signup/sign-in, existing invoices and checkout after an update. Do not overwrite
an installation to recover from a failed upgrade or assume arbitrary downgrades
are supported.

Receiving connections belong to each account. Availability depends on the actual
provider and its supported credentials. Mainnet receive/proof adapters do not
make outgoing bill payments or fiat payouts live; those executions remain
simulated. No customer credential, wallet, external relay or model provider is
configured automatically by the private installation.
