# Demo agents through a Codex subscription

The optional accountant backend uses the native Codex app server with the
operator's existing ChatGPT sign-in. Jordan runs `gpt-6-luna` with reasoning
effort `max`. Riley defaults to the existing Hermes backend and can explicitly
use the same Codex worker. This is an
explicit fictional-demo option; ordinary invoice accounts do not gain an AI
connection. It uses the signed-in plan's usage limits, with no API-key fallback.

Codex app-server integration is documented by
[OpenAI](https://learn.chatgpt.com/docs/app-server). The qualified CLI version is
0.166.0. Catalog entries alone do not verify access: run a real, harmless turn
before a presentation. This backend checks the selected model, provider, effort
and ChatGPT account type and rejects a substituted model or API-key login.

## Run the worker

Sign in normally with native Codex on the worker host and verify
`codex login status`. Do not copy its authentication files to the application
server or place credentials in source. The wrapper never reads or supplies the
subscription tokens; native Codex manages them.

Create a private state directory outside the checkout and its parent vault.
Use the existing private demo service token, or generate an independent service
token using the worker setup guide. This token authenticates the app to the
worker; it is not an OpenAI credential. Keep its file private and owned by the
runtime user.

Set `QUIET_LEDGER_WORKER_TOKEN_FILE` and `QUIET_LEDGER_CODEX_STATE` to those paths.
Optionally set `QUIET_LEDGER_CODEX_BINARY` to an absolute, executable native Codex
path. Then run:

```sh
python3 -I -B agents/demo/codex_worker.py --host 127.0.0.1 --port 4441
```

The loopback-only health endpoint reports configuration readiness, supported
roles and the fixed model/effort; it does not verify quota or generate a response. Each admitted turn
uses a fresh ephemeral thread, the shared fictional brief/persona and bounded
history from its current room. No tools, MCP, apps, plugins, hooks, browser,
image access, saved memory or workspace instructions are enabled. Native
configuration is checked rather than assuming an empty MCP map removes inherited
definitions. Unexpected tool/approval events fail the request. The process has
a hard deadline and bounded output; only a validated final reply is returned.

## Connect the app

For Jordan only, keep the usual fictional-team/Hermes configuration for Riley. Add:

```text
DEMO_ACCOUNTANT_RUNTIME=codex
CODEX_DEMO_URL=http://127.0.0.1:4441
CODEX_DEMO_TOKEN_FILE=/outside/source/private-service-token
```

To use the Codex subscription for both fictional agents, additionally set
`DEMO_CLIENT_RUNTIME=codex`. This is an opt-in; accountant-only installations
keep Riley on Hermes. Each role still has its own persona, Nostr identity and
same-room context. The worker must report both `client` and `accountant` in its
health `roles` before the client option is enabled.

For a separate hosted app, use `CODEX_DEMO_SOCKET_FILE` instead of
`CODEX_DEMO_URL`. Only one may be configured. The socket must be an owned Unix
socket with mode `0600`, inside a mode `0700` directory. Mount that directory read-only
into the app; no Codex credential directory belongs in its mounts.

An existing SSH connection can forward a private server-side Unix socket to the
worker's loopback listener. Provision the private directory and verify the
connection before enabling `ops/compose.codex-hosted.yml`. The SHC installer
requires `--enable-codex-accountant` together with both demo flags and checks the
reachable model/effort first. To enable both roles, also pass
`--enable-codex-client`; it requires the accountant flag and dual-role worker
readiness. Later deployments must explicitly retain each configured Codex option;
omission cannot silently switch either character back to another model. The
Compose override defaults client routing to Hermes when no client choice exists.

If the worker runs on a laptop, that laptop and SSH connection must stay online.
An unavailable worker is a visible failed turn. It does not silently fall back
to another model or paid API. The user interface identifies the configured
Codex roles separately from Hermes.

Financial amounts and recorded payment status still come from the latest
verified ledger case. Model text cannot settle an invoice or change a record.
Only fictional information belongs in this demo. Codex receives the supplied
conversation context; encrypted Marmot transport does not hide it from the model.
