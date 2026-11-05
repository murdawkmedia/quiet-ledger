# Fictional demo inference workers

Riley (client) and Jordan (accountant) use the actual Hermes `AIAgent`, pinned to
the public 0.22.5 source commit
`bf0203a794a07aac3ff764972ab9087baa4e4f4e`. They compose short conversational replies about
the explicitly fictional Marmot Field Lab, using a shared company brief and
distinct personas. Quiet Ledger renders money and recorded status from the
latest trusted case. Model prose cannot change financial records.
Jordan can instead use the separate Codex subscription worker below; Riley's
Hermes runtime and configuration remain independent.

This service is inference only. The separate native MDK controller owns the two
Marmot identities, MLS messages, role admission, room leases and reply publishing.
It must recheck pause/reset/expiry and the case version after inference. Each
role/request gets a fresh temporary Hermes home. The controller may supply up to
eight recent authenticated messages from the same room as untrusted context;
no direct chat is shared into another room. Hermes loads no saved conversation.
There are no tools, file/context loading, memory, background review, personal
profiles, gateway connection, provider/account connectors or financial writes.

The configured cloud model sees the admitted fictional message, bounded same-room
context and case. Keep
the judge disclosure visible and ask visitors to use fictional data. Encrypted
Marmot transport does not make cloud inference local or hide relay metadata.

## Build and run in a container

Docker is the required filesystem boundary for the hosted Hermes worker. The image contains
only public code and hash-locked Python dependencies, without a personal Hermes
installation or native credential database. Its build context is this directory.
No secrets enter the image/build arguments. Source, base image and dependencies
are pinned; `setup-runtime.py` verifies the public source archive SHA256 before
extracting only the runtime packages.

Create a private state directory outside source and its repository ancestors.
Set `QUIET_LEDGER_PRIVATE_WORKSPACE_ROOT` to protect an additional non-Git
workspace boundary when needed. This creates a new service
credential if absent and prints only file pointers/public hashes:

```sh
python3 agents/demo/setup-runtime.py --state-root /absolute/private/quiet-ledger-hermes
```

Use an existing separately authorized model API key file, either a raw key or a
JSON object with a `key` string. Both secret files must be regular, nonsymlink,
mode 0600 and owned by the runtime uid 1000. Do not mount a whole credentials
directory. Set only file paths in the shell:

```sh
export QUIET_LEDGER_WORKER_TOKEN_HOST_FILE=/absolute/private/quiet-ledger-hermes/worker-token
export QUIET_LEDGER_MODEL_CREDENTIAL_HOST_FILE=/absolute/private/scoped-model-key
docker compose -f agents/demo/compose.demo.yml up --build -d
```

The compose file binds the host port to `127.0.0.1:4420`, runs uid 1000 with a
read-only root, drops all capabilities, limits memory/CPU/processes, and uses
bounded tmpfs state. Mount no private workspace, SSH/browser keys, Docker socket,
personal Hermes profile or real invoice data. Each request home is deleted on
completion or timeout. The backend's matching worker token belongs in its
private configuration; never expose the worker token or endpoint in browser JS.

The default free model is `glm-5.3-flash` at the configured Tokens for Friends
OpenAI-compatible endpoint. This uses the authorized scoped key; it neither
registers an identity nor invokes a paid fallback. Operators may configure an
explicit HTTPS OpenAI-compatible `/v1` endpoint/model with the corresponding
environment variables in the Dockerfile. For a local model, extend the endpoint
allowlist deliberately; this version requires HTTPS and has no silent fallback.

For private development, `setup-runtime.py --source-root /absolute/new/public-source`
downloads the same verified source without running the Hermes CLI or installers.
Install `requirements.lock.txt` into a new Python 3.14 venv, then run `worker.py`
using that venv and explicit `QUIET_LEDGER_HERMES_SOURCE`,
`QUIET_LEDGER_HERMES_STATE` (private mode 0700),
`QUIET_LEDGER_WORKER_TOKEN_FILE`, and `QUIET_LEDGER_MODEL_CREDENTIAL_FILE` paths.
The default listener remains loopback. Host development is suitable for harmless
fictional tests; use the container boundary for visitors.

## Jordan through a Codex subscription

`codex_worker.py` uses the installed native `codex app-server --listen stdio://`
with the operator's existing ChatGPT login. Jordan is fixed to `gpt-6-luna` with
reasoning effort `max`; no model, provider or API-key fallback is available. The
worker accepts only the fictional `accountant` role. It shares the exact company
brief, persona, rules, current case and bounded same-room history used by Hermes.

Run it on the machine that already owns the separately authorized native Codex
login. Do not mount or copy a personal Codex/auth directory into the app or its
container, run a login flow, or provide a model API credential file. Verify the
installed native version before operation; operators may pin an existing
executable with `QUIET_LEDGER_CODEX_BINARY`. This worker does not install or
update Codex. Create a private mode-0700 state directory outside source and its
repository/workspace ancestors, then set paths only:

```sh
export QUIET_LEDGER_WORKER_TOKEN_FILE=/absolute/private/demo-worker-token
export QUIET_LEDGER_CODEX_STATE=/absolute/private/demo-codex-state
python3 -I -B agents/demo/codex_worker.py
```

The existing private service token has the same owner, mode-0600 and nonsymlink
requirements as Hermes. The listener is restricted to `127.0.0.1`, default port
`4441`; `--port` can select another loopback port. Reach it from another host only
through an authenticated private transport. Its `/health` reports
`runtime:"codex"`, `model:"gpt-6-luna"`, `reasoningEffort:"max"` and configured
`ready:true` without calling the model. Subscription/login readiness is verified
on inference and failures are sanitized. App routing must explicitly select this
worker for Jordan; this process does not change the Hermes service.

Each request launches a new native process group in a fresh mode-0700 directory,
outside the vault. Its environment retains only `PATH`, `HOME`, locale and standard
TLS certificate paths; provider/API/MCP variables and `CODEX_HOME` are removed.
Native Codex alone accesses its canonical auth store. The wrapper reads only
native configuration to discover MCP server names, then explicitly disables each
server: an empty `mcp_servers` override alone merges existing definitions. Before
starting a model turn it verifies the effective feature/tool configuration, native
ChatGPT login type, empty MCP tools, exact model/provider/effort, read-only sandbox
and absence of loaded instruction files. Shell, execution, apps, delegation,
hooks, skill discovery, image viewing/generation, browser/computer use, plugins,
goals, sleep/tool suggestion, web search and project-document loading are disabled;
capability roots and dynamic tools are empty. Native image features are disabled
through `features.view_image` and `features.image_generation` and checked in the
effective configuration.

Native tool and approval requests are rejected, and unexpected tool items or
protocol events fail closed. Only a final agent message from the current thread
and turn can become a reply, through the existing strict JSON and financial-prose
validators. Partial prose, reasoning and account/token events are discarded, and
native stderr and HTTP access logs are suppressed. The wrapper does not log
prompts, replies, credentials or transcripts. The normal deadline is 27 seconds;
stdout is capped at two MiB, each line at 256 KiB and each session at 4096 events.
The process group is terminated and reaped and its fresh directory removed on
success, rejection or timeout. HTTP/authentication, quotas, cache and connection
limits are shared with Hermes. No model credential is returned to the app.

## HTTP contract

`GET /health` returns runtime, configured readiness, model, Hermes release/commit
and fictional-only mode. It does not call the model, check provider credit, or
return secrets. A provider failure is surfaced on the inference request.

`POST /infer` requires the exact `Authorization: Bearer <private service token>`
and `Content-Type: application/json`. The backend supplies this fixed case shape:

```json
{
  "role": "accountant",
  "text": "Jordan, can you check the fictional total?",
  "requestId": "room-generation:human-event:accountant",
  "case": {
    "fictional": true,
    "currency": "CAD",
    "lineAmount": 12500,
    "tax": 0,
    "total": 12500,
    "status": "open",
    "settlementMode": "simulation",
    "receiptRecorded": false,
    "version": 1,
    "asOf": "2026-11-05T12:00:00.000Z"
  }
}
```

The optional `history` field is an array of `{ "speaker": "human", "text": "..." }`
rows. Speakers are `human`, `client` or `accountant`; history is limited to eight
messages, a thousand characters each and six thousand total UTF-8 text bytes.
The controller supplies only authenticated, earlier messages from this room.

A response includes a model-composed `reply`, for example
`{"runtime":"hermes","model":"glm-5.3-flash","intent":"conversation","reply":"We run hands-on private-messaging workshops. Captioned walkthroughs would help people follow along. What kind of work do you enjoy?"}`.
Possible intents are `conversation`, `explain-scope`, `check-total`,
`request-review`, `explain-recorded-status` and `explain-marmot`. The worker
requires exactly an intent and reply from Hermes. Its explicit
`request_overrides.response_format` selects the provider's JSON-object mode;
prompt-only formatting is insufficient with the pinned Hermes base prompt. Prose is bounded to a thousand
characters and three thousand UTF-8 bytes, with at most a single question.
Nonfinancial prose rejects numeric digits, currency, payment/status assertions and
sender boilerplate. For arithmetic and recorded-status intents the app discards
model prose and renders the latest verified ledger facts. Unknown financial
terms fail visibly rather than becoming a trusted amount or a mutation. Status `paid` is accepted only with
`receiptRecorded:true`, still strictly in simulation. Unknown/extra fields,
invalid amounts/currencies, invalid dates and duplicate JSON keys are rejected.
Supported currencies are CAD, USD, KRW, EUR and GBP. Amounts are integer minor
units, with whole won for KRW. Optional `discountAmount`, `premiumAmount`,
`invoiceNumber` and `title` describe the actual current fictional invoice. The
validator enforces subtotal − discount + premium + tax = total, safe amount
bounds and a monotonic case version checked again before reply publishing.

Admission authenticates before reading/parsing a prompt. Limits: 16 KiB body,
1500 text characters, request ids of 1–160 alphanumeric/colon/underscore/hyphen
characters, one active request per role and two overall, 30 starts/minute,
12 HTTP connections, two Hermes iterations, at most 512 output tokens and a 30-second process deadline.
An identical role/request id/body returns its cached result for ten minutes;
changed content with the same id returns 409. The bounded 128-result cache stores
only a keyed fingerprint and validated reply. It is in memory; the native backend
must retain its own durable message/reply deduplication and visitor turn budget.

Failures return sanitized 400/401/409/413/415/429/502/504 errors. No canned or paid
fallback hides an unavailable model. Upstream stdout/stderr is discarded inside
the child before loading Hermes; no prompts, model prose or credentials are
logged. HTTP access logs are disabled.

## Verification

```sh
python3 -m unittest discover -s tests -p test_demo_agent_worker.py -v
python3 -m unittest discover -s tests -p test_codex_demo_worker.py -v
```

The tests use a fixture agent and cover authentication before inference, strict
fictional state, invalid model output, retry/idempotency/rate/concurrency, private
file permissions, bounded HTTP parsing/history, composed-reply validation, fresh financial rendering,
no-tool construction, child success/cleanup and hard timeout.
Real provider smoke tests are separate, use only fictional requests, and require
the explicitly authorized free provider credential. Do not run live tests as an
automatic unit-test side effect.
Codex tests use a fake native subprocess, including merged MCP configuration,
exact model/effort, API-login rejection, isolated environment and temporary
directory, final-message validation, protocol bounds and process-group cleanup.
Actual subscription acceptance is a separate fictional test against the existing
authorized native login.
