# Connect a wallet or payment provider

Open https://quiet-ledger-dyp.pages.dev, sign in and choose **Connections**.
Connections belong to your private workspace and remain after logout, another
login or a server restart. Your provider account must already exist.

1. Choose the provider and enter its receiving details or API credentials.
2. Leave **Live** selected for real receiving. Choose **Test** only for matching
   provider test credentials where offered.
3. Choose **Verify & save connection**, or **Save receiving instructions** for
   manual details. Verification reads metadata/account identity without creating
   an invoice, charge or outgoing transaction.
4. Open **Payment methods** or a customer checkout to use the saved connection.
   Invoice prices use the selected currency; provider eligibility still applies.
   ACH requires USD, SEPA requires EUR and Interac requires CAD. Unsupported
   currency/method combinations are filtered before a receiving request is saved.

Credentials are encrypted on the server and never returned in connection lists.
The hosting operator can decrypt them. Use restricted receiving/read credentials
where supported. Never enter a wallet seed, private wallet key, bank password
or PIN. Bank instructions are deliberately shown to the payer; enter only the
receiving details you intend to share.

## Available setup forms

| Connection | Details needed | What remains conditional |
| --- | --- | --- |
| Lightning Address | Existing `name@domain` receiver | Receiver must support the required metadata and payment-proof protocol for automatic settlement |
| LNURL-pay | Public HTTPS pay endpoint | Same-origin callback and exact invoice checks; missing settlement proof requires review |
| Bitcoin Core | Public HTTPS wallet RPC, credentials | Synchronized mainnet wallet; receive calls may allocate fresh addresses |
| Watch-only Bitcoin | HTTPS watch-only RPC and dedicated watched address | One address per receiving request; no address pool is supplied |
| LND | Public HTTPS REST endpoint and invoice/read macaroon | Synchronized mainnet node; app never sends or signs |
| Liquid Elements | HTTPS RPC, credentials, optional dedicated address | Confidential amounts/assets need independent review |
| Ark / Bark | HTTPS origin, API token, pinned server key, existing address/index | Token can grant full wallet authority; app limits calls, and invoice attribution remains manual |
| Stripe | Secret/restricted key, account ID, merchant country | Country, currency, enabled methods and device eligibility |
| Square | Access token, merchant/location IDs, country and currency | Active card-capable location; exact order/payment readback, no capture call |
| PayPal | Client ID/secret, merchant ID and country | API credentials authenticate; merchant identity/country still need review. Approval is unpaid until separately captured; this app never captures |
| Revolut Merchant | Merchant secret, location ID and country | Eligible Merchant account/country/method; uncertain creates require original-reference recovery |
| Bank / Interac / Wise instructions | Receiving method, recipient and bank/Interac details | Saved payer instructions, not a bank API connection; merchant confirms exact received payment |
| Dedicated crypto instructions | Public address, asset and network | Manual confirmation and one allocation per destination; no reusable address pool |

Wise, Tangerine and other bank receiving details can use the instructions form.
That does not grant access to balances, transfers or bill payment. Bull Bitcoin,
Bitcoin Well, Shakepay and RoboSats do not become automatic cash-out/trade
integrations through this form. Outgoing payouts remain simulated.

Hosted node endpoints must be publicly reachable HTTPS on port 443. The service
cannot use a user's `localhost`, home LAN, Tailscale address or onion endpoint.
Use an existing appropriately protected public receiving endpoint; do not expose
an unrestricted wallet RPC. The app rejects private/reserved addresses, redirects
and DNS rebinding. This restriction does not change the separate local mode.

## Recheck or disconnect

**Recheck connection** repeats metadata/identity verification. A failed check
keeps the encrypted settings but marks the connection unavailable until a later
successful check. It does not mark an invoice paid.

**Disconnect** removes active saved credentials/instructions. It stops new
receiving requests and automated checks through that connection. Existing
provider payment requests are not cancelled, and saved invoice/receiving history
and encrypted backups remain. Independently review outstanding payments and
revoke old public links where appropriate. Reconnecting creates a new identity;
it never redirects an old request to a different account.

The beta permits 20 saved connections per workspace. Credential replacement uses
disconnect plus a new setup. There is no OAuth app registration or background
token-refresh promise; provider credentials still need their required permissions
and renewal. No provider secret is stored in browser storage or exposed to MCP.

## Firefox and Bitwarden

Use the Bitwarden Firefox extension, unlock it, enable **Ask to save and use
passkeys**, and allow it on this site. The desktop application alone does not
provide this browser flow. Reload Quiet Ledger after an update.

For an explicit manager gesture, choose **Create an account**, then **Use a
password manager**, then **Open password manager**. Normal passkey buttons also
work. Progress, cancellation and bounded errors recover from a stalled manager
or request. Account settings offer the same flow when linking a backup passkey.

Genuine signup/save/logout/login passed with Firefox 158.0.1 and Mozilla-signed
Bitwarden 2026.10.2 using a disposable local test vault and the production CSP.
The browser credential API was not overridden. This proves that tested flow;
## API boundary and verification

Cookie-session/CSRF endpoints are GET/POST `/api/account/connections`, POST
`/api/account/connections/:id/check` and DELETE `/api/account/connections/:id`.
Creates require an Idempotency-Key; preserve it for an unchanged retry. List and
mutation replies contain summaries only. Bearer keys/MCP cannot manage or read
provider credentials; existing receiving scopes can use saved adapter IDs.

Provider readback tests use fictional transports. Actual public-URL acceptance
verified saved instructions, logout/login persistence, tenant isolation,
customer checkout, disconnect and all nine remote MCP tools. A real funded
Bitcoin/fiat payment has not been accepted. Current verification is documented by the reproducible test commands in the README.