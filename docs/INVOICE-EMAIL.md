# Send invoices and handle email replies

Use your private account for email. The demo previews fictional messages only.
Email includes the invoice number, amount, optional message and private checkout
link. Submission, delivery, reading and invoice payment are separate outcomes.

For native messaging and optional phone gateway setup, see
[private invoices and conversations](REAL-INVOICING.md).

## Connect your Gmail sender

Open **Invoices** and choose **Email** beside an invoice. Under **Email settings**,
enter your Gmail or Google Workspace sender address and a
[Google App Password](https://support.google.com/accounts/answer/185833).
Google requires 2-Step Verification and may restrict App Passwords for some
accounts. Use **Save and connect Gmail** to check authentication; this sends no
test email. A normal Google account password is not supported. If App Passwords
are unavailable, use a mail app draft instead.

The App Password is saved in encrypted, workspace-scoped server storage and is
never returned by the settings API. The server operator retains decryption
access. This credential is independent of account passkey/Nostr sign-in and
does not involve an AI provider. A changed sender/password needs a fresh check.

## Send an invoice

1. Choose a **Common recipients** suggestion or enter custom addresses separated
   by commas. Suggestions use only this workspace's saved email recipients and
   prior invoice customer addresses. Save frequent addresses in **Email settings**.
2. Optionally set **My copy address** and check **Send a copy to myself**. This is
   a visible CC. At most five addresses, including that copy, may receive the
   initial invoice email.
3. Prepare and review the preview. Check To, CC, sender, subject, message and link.
4. Choose **Send invoice from…** to submit it through the connected sender.

SMTP uses fixed `smtp.gmail.com:465` with TLS and certificate checking. The app
does not attach files or fetch URL attachments. Gmail accepting every recipient
means provider acceptance; it does not prove delivery or reading.

**Prepare mail app draft** creates a `mailto:` draft without an SMTP credential.
Open it in your mail app, choose the sender, review it and send there. Preparing
or opening the draft is never recorded as delivery. Replies to mail-app drafts
are not automatically tracked by this inbox integration; tracked threads start
from submissions recorded through the connected Quiet Ledger sender.

### Review an uncertain submission

Quiet Ledger saves the submission intent before contacting Gmail. An unchanged
request retry returns that saved result. It does not automatically submit a new
copy after a timeout, process interruption or partial acceptance.

If the result is uncertain or some recipients were rejected, inspect the sent
mailbox and recipients first. In **Recent submissions**, choose the **Email review
result**, enter an **Email review note**, then choose **Record email review**.
Record either that you confirmed it was sent or confirmed it was not sent. This
records your review and sends no email. A later copy needs a new preview and an
explicit send; consider who may already have received the earlier submission.
Proven authentication rejection is recorded as not sent and needs reconnection.

## Enable incoming invoice replies

Connecting SMTP does not enable mailbox reading. The same App Password can grant
access to more of the mailbox than the selected folder; a folder filter limits
what Quiet Ledger processes, not the credential's authority. A dedicated
invoicing mailbox offers clearer separation.

1. Open **Email inbox** after connecting Gmail.
2. Check **Enable incoming invoice replies**. Set **Gmail folder or label** to
   `INBOX` or an existing folder you use for invoicing.
3. Choose **Save inbox settings** and let its initial check finish. This records
   a baseline for new mail. It does not import the old inbox.
4. Send the initial invoice through Quiet Ledger after that baseline exists.
   Ask the client to press Reply in their ordinary mail app.
5. Choose **Check new replies** when needed. The standard server also checks
   enabled mailboxes in the background while it runs.

IMAP uses fixed `imap.gmail.com:993` with TLS. Polls and message sizes are bounded.
A changed mailbox UID validity creates a new baseline rather than importing old
mail. Unrelated mail with no known invoice references is skipped. A matching
subject alone is insufficient. Changed recipients, ambiguous references,
automated replies, malformed content and unsupported bodies are held instead
of becoming outgoing reply authority.

The reader downloads a bounded plain-text body only for a matching candidate.
It does not download HTML parts, attachments or remote images. Messages without
a usable plain-text part cannot be imported as ordinary replies. An attachment
indicator does not mean its files are available in Quiet Ledger.

### Review and reply in the invoice thread

Matching replies remain labelled **Unverified email** even after review. Email
headers and addresses are not proof of who wrote them.

1. Open **Email inbox** and review a reply marked **Needs review**.
2. Choose **Approve reply** or **Reject reply**. Approval alone sends no response
   and confirms no payment. Held records may have no importable body or invoice
   association; handle those in the original mailbox.
3. Open the invoice's **Thread**. Under **Reply by email**, select an approved
   email and write the reply.
4. Choose **Preview email reply**, review the complete To/CC/subject/body, then
   choose **Send email reply**.

Recipients and subject come from the original recorded invoice email. The app
uses that approved reply's message ID for threading. It does not silently follow
a new Reply-To address or add a new CC participant. If authority, mailbox or
preview details change, prepare a new preview. Uncertain submissions follow the
same mailbox-review rule as initial emails.

The invoice thread also supports **Private note**. Saving one is a workspace
record and sends nothing to the client.

## Optional Marmot Email gateway

An invoice's **Thread** has a separate opt-in Email gateway. Pair it with your own
Marmot identity to review received email and explicitly reply from that client
while the browser is closed. Follow the
[gateway pairing and commands](REAL-INVOICING.md#pair-an-optional-email-gateway-with-your-phone).
The gateway and Gmail can read bridged email. It does not make the client's
email end-to-end encrypted, impersonate their Nostr identity or join native-only
rooms automatically.

Incoming email can appear in the paired owner room with `/approve` and `/reject`
instructions. `/email` prepares a recipient/content preview; `/send` with its
short-lived confirmation submits that exact email once. Plain chat cannot send
mail or settle an invoice. Automatic Marmot self-copies of newly issued invoices
and receipts are not implemented; use **Messages → Send invoice link** for an
explicit initial share.

## Disconnect, recovery and access

Disable **Enable incoming invoice replies** to stop inbox reads. **Disconnect
Gmail** removes the active delivery credential and disables its inbox integration.
Disable an invoice's gateway separately to retire its email send authority.
Disconnected mailbox settings, imported records, history and existing encrypted
backups may remain. No disconnect recalls mail already accepted by Gmail.

See [backup and recovery](SELF-HOSTING.md#backup-and-recovery) before restoring a
server. Restore preserves invoice/mail records but resets gateway identity,
group state and pairing and cancels prepared gateway confirmations. Stop the
old installation before pairing a replacement. An unknown SMTP result remains
unknown until you check the mailbox and record a review.

Mailbox settings, initial sending, inbox review, thread replies and gateway setup
are private browser actions with workspace ownership, session and CSRF/origin
checks. API bearer keys and MCP cannot perform these email actions. Public
checkout links use the server's configured origin.

The generic source includes no sender address, mailbox credential or customer
records. Automated email checks use controlled transports; an actual Gmail
connection and controlled first send/reply remain owner acceptance steps.

## Fictional demo

The demo can save fictional email suggestions and copy addresses and prepare
previews. It cannot connect Gmail, read an inbox, send email, use a gateway or open
a mail draft through this flow. Its old Marmot self-copy control remains planned
and disabled. Demo invoices and settings follow their separate 30-day retention.
