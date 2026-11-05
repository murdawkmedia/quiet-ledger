# Fictional Hermes demo workers

Riley (client) and Jordan (accountant) use the actual Hermes `AIAgent`, pinned to
the public 0.22.5 source commit
`bf0203a794a07aac3ff764972ab9087baa4e4f4e`. They select a typed reply intent for
a bounded fictional Marmot Field Lab invoice. Quiet Ledger renders money and status from the
latest trusted case; model prose never becomes a financial record or a reply.

This service is inference only. The separate native MDK controller owns the two
Marmot identities, MLS messages, role admission, room leases and reply publishing.
It must recheck pause/reset/expiry and the case version after inference. Each
role/request gets a fresh temporary Hermes home and empty conversation history.
There are no tools, file/context loading, memory, background review, personal
profiles, gateway connection, provider/account connectors or financial writes.

The configured cloud model sees the admitted fictional message and case. Keep
the judge disclosure visible and ask visitors to use fictional data. Encrypted
Marmot transport does not make cloud inference local or hide relay metadata.

## Build and run in a container

Docker is the required filesystem boundary for a hosted demo. The image contains
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

## HTTP contract

`GET /health` returns runtime, configured readiness, model, pinned release/commit
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

The response is `{"runtime":"hermes","model":"glm-5.3-flash","intent":"check-total"}`.
Only `explain-scope`, `check-total`, `request-review`,
`explain-recorded-status`, and `explain-marmot` are possible. Status `paid` is accepted only with
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
12 HTTP connections, two Hermes iterations and a 30-second process deadline.
An identical role/request id/body returns its cached result for ten minutes;
changed content with the same id returns 409. The bounded 128-result cache stores
only a keyed fingerprint and typed result. It is in memory; the native backend
must retain its own durable message/reply deduplication and visitor turn budget.

Failures return sanitized 400/401/409/413/415/429/502/504 errors. No canned or paid
fallback hides an unavailable model. Upstream stdout/stderr is discarded inside
the child before loading Hermes; no prompts, model prose or credentials are
logged. HTTP access logs are disabled.

## Verification

```sh
python3 -m unittest discover -s tests -p test_demo_agent_worker.py -v
```

The tests use a fixture agent and cover authentication before inference, strict
fictional state, invalid model output, retry/idempotency/rate/concurrency, private
file permissions, bounded HTTP parsing, no-tool construction and hard timeout.
Real provider smoke tests are separate, use only fictional requests, and require
the explicitly authorized free provider credential. Do not run live tests as an
automatic unit-test side effect.
