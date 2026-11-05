# The Marmot demo team

Open Quiet Ledger, choose **Hackathon demo**, enter **marmot**, then open the demo
conversation and choose **Start the demo team**. No wallet, signer extension,
White Noise or other app is required. Use fictional information only.

You are the merchant. Riley produces hands-on private-messaging workshops for
fictional Marmot Field Lab; Jordan keeps its scope and invoice wording clear.
Riley cares about useful footage and participant consent. Jordan has a dry sense
of humour and asks who reviews the work. Neither represents Marmot or White Noise.
They compose short replies using a shared business brief, distinct personas and
recent messages from the current conversation.

An optional [Codex subscription backend](CODEX-DEMO.md) runs Jordan on Luna Max.
Riley keeps Hermes. The footer identifies this selection; the default installation
continues using Hermes for both. A failed earlier turn cannot cancel a newer
question's waiting indicator. Encrypted queued sends retain their original ID
when retried, so a refresh can track the correct eventual reply.

**Riley** is the default direct conversation: you and Riley, two MLS members.
**Jordan** opens a separate two-member conversation. Choose **Group** explicitly
to create a three-member room. Switching or reloading preserves each room's own
history. Your messages stay as typed; the app adds no Riley/Jordan prefix.
Direct messages and their model context are never copied into the other rooms.
A colleague cannot see a direct conversation just because both work for the same
fictional company. Group messages normally reach both; an explicit human-written
`@Riley`, `@Jordan`, `Riley:` or `Jordan:` addresses one participant.

## A short presentation

1. Choose **New demo invoice**. Pick a reusable client template, issue/due dates,
   CAD, USD or KRW, optional discount/premium and accepted methods, then save.
2. Start Riley's conversation. Ask what the company does and how your filming,
   editing, website or workflow services could help. Continue with a follow-up.
3. Switch to Jordan and check the current invoice total and recorded status.
4. Choose **Simulate payment**, then ask Jordan again. Chat cannot settle invoices.
5. Open **Group** to bring both together; reload to show each room's persisted
   history. Ask about Marmot privacy only when you want that explanation.

The starter invoice is fictional CAD 125 with zero tax. Every payment in this
demo is simulated. Model/relay availability affects response time. Failed calls
appear visibly; there is no scripted failure response or paid-provider fallback.

Pause/resume controls the whole team's inference. Reset retires all its rooms and
starts new keys on the next start; it cannot erase copies already held by members.
One team can be active per instance for ten minutes, within the visit's two-hour
lifetime. Twelve human rounds are shared across all three rooms; eight starts per
visit limit repeated provisioning. A busy instance offers the existing manual
invoice conversation while another visitor uses the team. A legacy three-member
room stays a group; upgrading never silently labels it a private conversation.

## What actually runs

Marmot TS 0.9.0 holds the browser's human key and MLS state. Two pinned wn-agent
0.14.0 processes hold Riley's and Jordan's separate keys. A direct room admits
only its intended agent; the group admits both. Fresh one-use KeyPackages support
additional rooms. The controller verifies room membership, authenticated sender,
lease generation, expiry, pause, quotas and replay state. Agents never trigger
other agents. Each reply refers to its human message so a delayed reply cannot
finish an unrelated pending question.

Pinned Hermes 0.22.5 AIAgent runs in a restricted container with no tools, personal
profiles, memory, shell, file context, finance API or MCP credentials. Each turn
uses a fresh temporary home and bounded lifetime. At most eight earlier,
authenticated messages from this room enter its prompt, with character/byte limits.
Hermes returns a finite intent and short prose. Financial answers discard model
prose and render the latest verified case. Internal case version/time still guard
stale replies; they are not printed as repeated bubble introductions. No reply
changes financial state. Pending sends retry the same versioned idempotency key.

The same-origin NIP-01 WebSocket relay admits only registered room hashes through
a private per-lease capability. Cloudflare adds a separate backend gate without
forwarding browser cookies or provider credentials. The relay stores bounded
signed directory events and MLS ciphertext with at-rest encryption. Retired
capabilities, sockets and rows are removed. No public third-party relay receives
this demo. Ordinary private-account invoice conversations keep their existing
private HTTP transport.

## Privacy and setup

Agents, the operator holding their keys and the configured model provider can
read the messages those agents decrypt. This is not a zero-knowledge AI service.
Browser IndexedDB holds the human key, decrypted history and MLS state without
extra local encryption. Clearing site data loses access; browser key backup and
device transfer are not implemented. Financial records remain operator-readable
although their database payloads are encrypted. Protect the host disk too.

White Noise phone joining remains optional and disabled until an actual join is
qualified. Experimental SDK interoperability is not a cryptographic audit.
No funded receiving/provider/payout qualification follows from this demo.

Start with [SELF-HOSTING.md](SELF-HOSTING.md). Agent mode additionally requires
`HOSTED_ACCOUNTS=true`, `HACKATHON_DEMO_ENABLED=true`, `DEMO_TEAM_ENABLED=true`,
an external private `DEMO_TEAM_STATE_DIR`, the pinned `MARMOT_AGENT_BINARY`,
`HERMES_DEMO_URL` and a mode0600 `HERMES_DEMO_TOKEN_FILE`. See the
[worker setup](../agents/demo/README.md) and the generic hosted Compose example
in `ops/compose.demo-hosted.yml`. Credentials stay outside source and browsers.
[Native recovery](DEMO-STATE-RECOVERY.md) is separate from the ledger backup and
does not include browser keys. The free core is AGPL-3.0-or-later; optional hosted
subscription billing is not implemented.
