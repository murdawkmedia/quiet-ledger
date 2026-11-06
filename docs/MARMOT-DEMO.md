# Marmot conversations and the hackathon demo

Open the hosted app and choose **Hackathon demo**, then enter the public demo
password **marmot**. Each visit creates a separate fictional workspace and one
CAD125 invoice. Demo records stay for 30 days; sign-ins expire after two hours and can reopen the
same workspace using its private browser cookie. Only test accounts/data belong
in agent-led acceptance.

Choose **Prepare demo** to create two independent messaging identities in the
browser. Send a merchant update, acknowledge it or request a review as the
customer, simulate payment, then send a receipt notice. The displayed messages
come from real Marmot encryption/decryption. The financial settlement is a
simulation and cannot move money. Reload, choose Prepare demo again, and the
same browser can recover its conversation.

Private account users can choose **Private conversations**, select an invoice
and start. The customer opens **Open private conversation** from their private
invoice checkout and starts in their own browser. Once both are present, the
merchant connects the customer and the customer explicitly accepts the private
invitation. Normal checkout does not require messaging. A receipt notice is
available only after the ledger records payment; messages cannot settle invoices.

## What is implemented

The pinned `@internet-privacy/marmot-ts` 0.9.0 SDK creates signed key packages,
MLS membership and encrypted Welcome/application events. Separate generated
messaging keys are used for merchant and customer. Account Nostr signer keys,
passkeys, Bitcoin wallet keys and seeds are never imported into messaging.
Only four fixed generic messages are admitted by the application. Invoice
amounts, names, descriptions, banking details, credentials and private links
remain outside those messages.

Delivery uses authenticated same-origin HTTP endpoints scoped to one invoice.
The SDK's private relay metadata label is a non-routable `.invalid` hostname;
no WebSocket opens and no public relay is contacted. This is actual Marmot
cryptography with private event delivery, not a claim of public relay or
White Noise interoperability. The SDK is experimental; treat this as a
hackathon preview rather than audited production messaging.

## Privacy and device limits

Conversation keys, decrypted history and MLS state stay in origin IndexedDB
on the participant's browser. They are not encrypted separately at rest there.
Use a trusted browser/device. Clearing site data loses access. There is no
key recovery, device transfer or participant rotation. One merchant device
and one customer device are bound to each invoice; opening another device
with different messaging keys fails explicitly. Simultaneous writers for the
same role/room are prevented with browser locks where supported.

The hosted ledger and event envelopes have encrypted server storage. Operators
can decrypt financial records and observe which invoice/room, role, event kinds,
public messaging identities and times are involved. Only conversation content
has end-to-end encryption. The demo runs both roles in one visitor browser to
show the flow; it is not a claim that the visitor's device isolates two people.
A stolen invoice bearer link can act as its customer, as with the checkout
itself. Share it only with the intended customer.

The preview stores at most 128 events per room, 512 KiB event payload per room,
1MiB per workspace and 8 MiB globally, split into a 2 MiB public-demo pool and
6MiB private-account pool. Queries return at most40 events. Browser
sync and reload are tested on the bounded demo; long-lived archival delivery,
key rotation and catch-up beyond the query window need more work. Limits
fail visibly and never change invoice payment state. Failed outbound delivery
retains exact ciphertext for retry with **Refresh messages**.

## Demo controls

`HACKATHON_DEMO_ENABLED=true` enables the hosted entry. The installer requires
`--enable-hackathon-demo`; its default remains disabled. Disabling it preserves
stored demo rows while denying their sessions and public links. Existing
private account authentication remains passkey/Nostr; the public password
never authenticates a real account.

The service permits at most 256 saved visits, 8 starts/client/hour and 5 failed
password attempts/client/10 minutes. Client counters are process-local and
reset on restart; the global saved-workspace cap persists. The next successful
start removes registered demo workspaces after their 30-day retention deadline
and their dependent records. Expired legacy visits remain inaccessible while
their encrypted records are kept for that same recovery window. There is no background cleanup or per-device IndexedDB expiration.
Demo sessions cannot create/change provider connections, account credentials,
API keys or payouts. Their dedicated bounded invoice editor can create up to
eight fictional invoices per visit and save fictional client templates; private
account invoice routes remain denied. A running agent team must be reset before
replacing its invoice. Their invoice cannot be paid through the public
receiving/payment endpoints. Only the dedicated idempotent simulation action
can record its fictional receipt.

## API surface

- Owner GET/POST `/api/invoices/:id/conversation`: metadata or create/rendezvous.
- Customer GET/POST `/api/checkout/:token/conversation`: same, scoped bearer link.
- POST suffix `/events` accepts one bounded signed event; exact retry is idempotent.
- POST suffix `/query` accepts bounded Nostr filters within that room.

The server assigns roles from session or link. Merchant writes require session
CSRF; all writes require the exact configured origin. API keys/MCP do not grant
messaging-key or conversation management access. No event can prove a payment
or alter financial records. Existing invoicing API/MCP remains available to
private accounts under its existing scopes.

Run `npm run test:e2e:marmot` after building. It includes fixture UI behavior and
actual Express/SQLite/SDK tests; neither accesses real provider accounts or funds.
