# Set up private invoices and conversations

Use a private account for real client records. The public `marmot` demo remains a
separate fictional workspace. For your own installation, start with
[self-hosting](SELF-HOSTING.md). Keep the server running for incoming email and
the optional persistent gateway; ordinary private accounts need no AI service.

This is an experimental private pilot. Start with a fictional invoice and a
controlled contact before using the same setup for client work. Connecting a
mailbox, inviting a person and sending an email are explicit actions.

## Save the client and issue the invoice

1. Open **Clients**. Save the client's name, billing address, email and preferred
   currency. Add their Marmot public identity only if you want to contact them
   there. Email and Marmot identities are separate fields; saving them together
   does not verify who owns either one.
2. Choose **Create invoice** and select the saved client. Review the dates, prices,
   currency and accepted payment methods. Selecting a different currency does
   not convert existing prices.
3. Under **Billing details**, enter your business name and the details you intend
   the payer to see. The issued invoice keeps those details and its client/price
   snapshot when contacts or templates later change.
4. Create the invoice. Open its checkout and choose **Print invoice** to print or
   use the browser's PDF option. Share its private checkout link only with the
   intended recipient.

Creating an invoice sends no email or chat message. Its **Thread** contains
workspace notes and recorded email activity. **Save private note** sends nothing
to the client. See [invoices and templates](INVOICES.md) for the full editor flow.

For receiving, configure your own bank/Interac instructions or a supported
Bitcoin adapter under [Connections](CONNECTIONS.md). Manual receiving requires
the owner's independent confirmation of the payment; automatic settlement needs
the adapter's supported proof. A client message saying “paid” cannot settle the
invoice. Outgoing conversion, bill payment and payouts remain simulated.

## Invite a Marmot contact

Use **Messages** for direct native conversations. This creates a messaging
identity separate from the Nostr key or passkey used to sign in.

1. Enter a messaging passphrase of at least 12 characters and choose
   **Unlock messaging**. First use creates the browser identity; later use unlocks
   it. Unlocking publishes its public key package and inbox relay list to the
   reviewed White Noise US/EU relays.
2. Copy **My Marmot public key** or use **Show public-key QR**. This QR contains
   your public identity. It does not reveal a secret key or accept invitations.
3. Ask the contact for the public key from their Marmot client, such as White
   Noise. Choose a saved Marmot contact or paste an npub, nprofile or hexadecimal
   public key under **Invite a contact**, then choose **Send invitation**.
4. Have the other person accept the invitation. For an incoming invitation,
   review the displayed sender key before choosing **Accept**. Verify that key
   with the person through a channel you already trust before sharing an invoice.
5. Send a short message and check that replies work. Select the intended room
   and invoice, then choose **Send invoice link** when you want to share it.

Both participants need compatible Marmot protocol versions and a current key
package on the reviewed US/EU relays. Pasted nprofile relay hints do not open
connections to other relays. The other person does not need a Quiet Ledger
account to use a compatible client. Actual installed
White Noise UI interoperability has not been tested for this pilot, so verify
invitation and replies on the particular client/version before relying on them.

Production native rooms currently contain two members. Accountants and other
clients need separate rooms. A room stays **Invitation pending** until a verified
peer message supplies evidence that the peer joined. Relay acceptance alone
does not prove device delivery or reading. A prepared Welcome with no relay
acknowledgement retries its exact ciphertext. Older pending invitations without
recoverable delivery records retire and require a fresh invitation. A membership change
retires the room: its retained history remains readable, and a new explicit
invitation is needed to continue.

**Send invoice link** sends that selected link to the selected room. It does not
send email, invite other people, share older invoices or change payment status.
Native-only rooms do not automatically gain an Email gateway.

### Browser storage and recovery

The messaging key, SDK state and retained messages are encrypted in this
browser's IndexedDB with the messaging passphrase. Account sign-in does not
recover that passphrase or copy chat state to another browser. One writer may
open a messaging namespace at a time; close or lock the other tab first.

Use **Lock messaging** when finished. **Lock and download identity backup** stops
the engine before exporting an encrypted identity backup. Keep it and its
passphrase separately. The backup restores the public identity, not old chat
history or a current MLS group state. Stop the old device and restore into an
empty destination, such as a fresh browser profile, then ask contacts for fresh
invitations. Existing keyrings are not overwritten. Clearing browser data
without recovery material loses access. See [backup and recovery](SELF-HOSTING.md#backup-and-recovery)
for the separate server and gateway rules.

The pilot retains at most 50 native rooms per browser identity, including
retired rooms, and 5,000 messages per room. Text messages are limited to 8,000
characters. History pages can load earlier messages; a capacity or incomplete
catch-up error needs attention rather than implying that the history is complete.

## Receive and reply to email

Follow [invoice email setup](INVOICE-EMAIL.md) to connect your own Gmail App
Password. SMTP connection alone does not enable reading.

Enable **Email inbox** before sending the first invoice you want to track. Choose
**INBOX** or an existing dedicated folder/label and let the initial check establish
its new-mail baseline. Then send the invoice through Quiet Ledger. The client
presses Reply in their usual email app.

Matching replies appear as unverified email. Review them in **Email inbox** and
choose **Approve reply** or **Reject reply**. Approval permits an explicit reply;
it does not prove the sender's identity or send a response. Open the invoice's
**Thread**, select an approved email under **Reply by email**, write the reply,
then use **Preview email reply** and **Send email reply**. To, CC and subject come
from the original recorded invoice email; the app does not silently adopt a new
Reply-To address or add a participant.

## Pair an optional Email gateway with your phone

The gateway is a server participant that can read bridged email. Gmail can also
read email. Use it only when that disclosure fits the conversation. Each invoice
gets a separate room containing the gateway and the chosen owner identity. The
email client is represented as a claimed email sender, never as a native Nostr
member. A saved client email address alone enables no forwarding.

1. Connect and initialize **Email inbox** as above.
2. Open the invoice's **Thread** and find **Optional Marmot email gateway**.
   Check **Enable this invoice's email gateway** and enter your own White Noise
   npub, or the public key from **Messages**. Choose **Save gateway settings**.
3. Accept the gateway's invitation in that chosen client. Compare the displayed
   gateway public key with the setup page. Send the exact `/pair` command shown
   on the page from the chosen owner identity within ten minutes.
4. Choose **Refresh gateway status** and wait for **Paired**. If the pairing code
   was lost or expired, save the settings again and use the newly shown room/code.

The server worker can now bring matching incoming email into this invoice's
owner room while the browser is closed. Follow the gateway's instructions:

| Command | Result |
| --- | --- |
| `/approve <item-id>` | Approve the displayed unverified email for this invoice. |
| `/reject <item-id>` | Reject that email without sending a response. |
| `/email <reply text>` | Prepare an exact To/CC/subject/body preview using an approved reply context. |
| `/send <confirmation>` | Submit that preview once, within its five-minute expiry. |

Use the item ID and confirmation supplied by the gateway. Plain chat, approval
alone and a client's message never authorize outgoing email or payment. If the
full preview is too long for a native message, shorten the reply or use the
dashboard. A long imported email may also exceed the native limit once gateway
labels are added; it remains available in the dashboard. An uncertain SMTP result
is not automatically retried; review it in
the mailbox and [record an email review](INVOICE-EMAIL.md#review-an-uncertain-submission).

This gateway handles incoming replies and explicit replies to them. It does not
automatically send your phone a copy of each newly issued invoice or receipt.
To share an initial invoice with your own phone, use its public identity as a
native contact and explicitly choose **Send invoice link** in that room.

Disable the invoice gateway to stop its forwarding and invalidate pending email
confirmations. Disable **Email inbox** or disconnect Gmail to stop mailbox use.
Retained encrypted messages and backups remain. Server backup restore deliberately
resets gateway identity, state and pairing; follow the
[gateway recovery procedure](SELF-HOSTING.md#backup-and-recovery) before restarting
a recovered sender.

## What has been checked

Native tests exchange real MLS messages between independent SDK participants,
including restart, replay, failed delivery, room retirement and encrypted local
storage. Browser checks use two independent accounts with intercepted WSS relays.
Email and background-worker checks use controlled SMTP/IMAP transports.

Those checks do not establish compatibility with an installed White Noise UI,
actual Gmail account acceptance, funded Bitcoin/fiat receiving or a formal
cryptographic audit. Make the first real mailbox connection, controlled send/reply
and receiving check as deliberate owner actions before extending the pilot.
