# The Marmot demo team

Open Quiet Ledger, choose **Hackathon demo**, enter **marmot**, then **Talk to the
demo team**. Choose **Start the demo team**. No wallet, signer extension, White
Noise or other app is required. You are the merchant; Riley is Marmot Field Lab’s
fictional client and Jordan is its fictional accountant. Each has a separate
Marmot identity in the same three-member MLS room.

For a short walkthrough, choose **New demo invoice** first. Pick a reusable
client template, choose issue/due dates, select CAD, USD or KRW, and optionally
apply a discount and premium. Select the methods you want to accept. Save the
invoice to open the demo team with those exact current amounts. The fictional
starter invoice is CAD 125 with zero tax; every payment here is simulated.

A three-minute presentation can follow this sequence:

1. Enter **marmot**, create the invoice, and start the team.
2. Use the Riley scope prompt and Jordan total prompt to show the current case.
3. Use the Marmot privacy prompt to explain the three separate MLS identities.
4. Ask Jordan about recorded payment, choose **Simulate payment**, then ask again.
5. Reload to show persisted encrypted conversation state, then pause or reset.

The measured local rehearsal took about 62 seconds for invoice creation, native
team preparation and five actual Hermes replies. This is a measured example,
not a response-time guarantee: relay, model and hosting availability affect it.
No actual money moves. A failed model call appears visibly; there is no scripted
reply or paid-provider fallback.

Pause/resume controls inference. Reset retires this team and starts a new key/room
on the next start; it does not erase copies already received by participants.
Refreshing or reopening the page can reconnect the same browser identity while
its lease is valid. One team can be active on an instance at a time, for at most
ten minutes, within the visit’s two-hour lifetime. Six human rounds are allowed;
eight starts per visit limit repeated provisioning. A busy instance offers the
existing manual invoice conversation while another visitor uses the AI team.

## What actually runs

The browser uses Marmot TS 0.9.0 and holds its own human key/MLS state. Two isolated,
pinned wn-agent 0.14.0 native processes hold Riley’s and Jordan’s keys and receive
Welcomes from that human. A controller accepts only the authenticated human’s
explicit `Riley:`/`Jordan:` or `@Riley`/`@Jordan` messages. Agent messages cannot
trigger other agents. Per-connection lease identity, generation, expiry, pause,
quotas and signed-event replay checks protect the shared instance.

Actual pinned Hermes 0.22.5 AIAgent code performs inference in a separate restricted
container, with no tools, personal profiles, memory, shell, files, finance API or
MCP credentials. Each turn has a fresh request home and a bounded process lifetime.
Riley and Jordan have distinct personas. The model selects one of five typed
intents; the controller renders financial statements from the current verified
fictional case, including its version and timestamp. Model prose never changes
financial state. Pending replies retry the same versioned text/idempotency key.
Provider failure has no paid or scripted fallback and appears as a demo issue.

Transport is a standard NIP-01 WebSocket relay at this app’s origin. An unguessable,
per-lease capability is returned only to its authenticated demo visit and used by
all three participants. Cloudflare’s proxy adds a separate private backend gate;
it does not forward browser cookies or provider credentials into the relay.
Only bounded signed directory events and MLS ciphertext are stored there, with
at-rest encryption. Retired capabilities, sockets and relay rows are removed.
No third-party public relay receives the demo. The existing private-account
invoice conversation continues using its original private HTTP delivery.

## Privacy and proof limits

Use fictional information only. Agents, the hosting operator holding their keys,
and the configured AI provider can read messages the agents decrypt. This is not
a zero-knowledge AI service. Browser IndexedDB holds the human key, decrypted
history and MLS state without extra local encryption; clearing site data loses
access. There is no browser key backup/device transfer. Financial records remain
operator-readable even though database payloads are encrypted. Native key homes
use private filesystem permissions; protect the host disk as well.

White Noise joining remains optional and disabled until an actual native phone
join is qualified. Experimental SDK interoperability is not a production
cryptographic audit. No funded receiving/provider/payout acceptance follows from
this fictional demo.

## Run it yourself

Start with [SELF-HOSTING.md](SELF-HOSTING.md). The free account edition can run
without Cloudflare. Agent mode is an explicit optional configuration:

- `HOSTED_ACCOUNTS=true` and `HACKATHON_DEMO_ENABLED=true`;
- `DEMO_TEAM_ENABLED=true`, a private external `DEMO_TEAM_STATE_DIR`, and the pinned
  `MARMOT_AGENT_BINARY` path;
- `HERMES_DEMO_URL` pointing to the isolated private worker, plus a mode0600
  `HERMES_DEMO_TOKEN_FILE` shared only with that worker.

Build/run the worker using [agents/demo/README.md](../agents/demo/README.md), with
its own private service token and an explicitly selected provider credential.
Credentials stay outside source and are not sent to browser participants. The
hosted example is the generic hosted Compose example in ops/compose.demo-hosted.yml.
[DEMO-STATE-RECOVERY.md](DEMO-STATE-RECOVERY.md) describes the separate cold backup
for native keys/MLS; the online ledger backup does not contain browser keys or
native daemon homes. The free core is AGPL-3.0-or-later. Optional hosted subscription billing is not implemented.
