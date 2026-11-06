# Email an invoice

Open **Invoices** and choose **Email** beside an invoice. The demo has the same
entry under **Demo invoices**, with previews only. Email includes the invoice
number, amount, optional message and private checkout link. It does not issue a
payment or prove that a client received or read the message.

Choose an address from **Common recipients** or type custom addresses separated
by commas. Suggestions come only from this workspace's saved contacts and prior
invoice customer addresses. Save frequent contacts under **Email settings**.
Set **My copy address** and optionally check **Send a copy to myself**. At most
five addresses, including the copy, may receive one message. Review the preview
before sending. The copy is CC and is visible to the other recipients.

## Send from your Gmail account

In a private workspace, enter your Gmail or Google Workspace sender address and
a [Google App Password](https://support.google.com/accounts/answer/185833).
Google requires 2-Step Verification and may restrict App Passwords for some
accounts. Use **Save and connect Gmail** to check authentication; this sends no
test email. Your normal Google account password is not supported. If App
Passwords are unavailable, use the mail app draft option instead.

The App Password is saved in encrypted, workspace-scoped server storage and is
never returned by the settings API. The hosting operator retains decryption
access. It is independent of the browser's passkey/Nostr sign-in and any agent
model provider. Updating the sender/password requires a new authentication check.
**Disconnect Gmail** removes the stored delivery credential for this workspace.

After previewing, choose **Send invoice from…**. SMTP uses the fixed Google
endpoint `smtp.gmail.com:465` with TLS, certificate checking, no file/URL
attachments and a bounded overall timeout. An accepted result means Gmail
accepted every listed recipient, not that the email was delivered or read.

A durable submission is reserved before contacting Gmail. Reusing its request
key returns the stored result. A timeout, interrupted process or partial
acceptance is shown as uncertain and is not automatically resent. Check Gmail
before attempting another copy. Proven authentication failure is recorded as
not sent and requires reconnecting. Recent submissions remain with the invoice.

**Prepare mail app draft** works without an SMTP credential. It creates a
`mailto:` draft containing the intended recipients, optional CC, subject and
invoice link. Open it in your mail app, choose the sender, review and send it
there. Preparing or opening this draft is never reported as email delivery.

## Demo and Marmot

Demo workspaces can save fictional contacts/copy addresses and preview messages.
They cannot connect Gmail, open a mail draft through this flow or submit email.
No email provider is contacted. Saved demo email settings follow the same
30-day retention as the invoices and are removed only with their expired demo.

An optional **Send myself a copy in Marmot / White Noise** control is labelled
**Planned** and disabled. A future version may deliver an encrypted invoice or
receipt notice to an explicitly paired owner inbox. No self-copy, White Noise
pairing or public relay publication is implemented by this email feature.
Existing invoice conversations remain a separate feature.

## Operator and integration notes

The generic source contains no personal sender, default mailbox or credentials.
Every hosted customer connects their own sender. SMTP credentials are excluded
from invoice exports, chat/model context, API summaries and public source.
Encrypted ledger backups include the private email settings and submission
records; protect the separate recovery keys too.

Browser-only routes are `/api/invoice-email/settings`,
`/api/invoice-email/verify` and `/api/invoices/:id/email`. They require the existing
session, invoice ownership and CSRF/origin checks on writes. Bearer/API/MCP
credentials cannot send email or manage delivery settings. The trusted configured
public origin supplies checkout links; callers cannot choose an arbitrary origin.
