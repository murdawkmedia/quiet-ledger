# Optional real payment inside the demo

Sign in to the hackathon demo with `marmot`, then choose **Real 21-sat payment** in its navigation. This is an optional, voluntary payment to the configured Coinos receiver. The client/accountant conversation and its invoices remain fictional simulations.

Check the real-funds acknowledgement before creating one 21-sat Lightning invoice. Copy it or choose **Pay from a Cashu wallet** and scan it in Minibits/Zeus using Pay Lightning. Check wallet/mint fees before paying. Cashu is the payer's funding source; Coinos receives Lightning and the receipt says Lightning. The app cannot tell how the payer funded it and does not collect ecash tokens or wallet keys.

**Check payment** asks the receiving provider about the original invoice. A receipt appears only for verified matching provider state. An uncertain, expired or mismatched request stays visibly unresolved; refresh/retry never silently creates another invoice. Simulate payment and public manual-confirm actions cannot settle the real sample. A visit gets one original sample, retained independently of fictional-demo cleanup.

## Operator configuration

This optional feature is off without configuration. It requires hosted/self-hosted accounts and the hackathon demo enabled, plus `DEMO_LIVE_COINOS_TOKEN_FILE` naming an absolute canonical private file outside source. That file holds only a receiving terminal token (64 lowercase hex characters, optional trailing newline), mode0600, one link, owned by the app's user. It is never a wallet seed or spending credential.

The provided demo receiver is `countzapula@coinos.io`. Its Coinos terminal token is operator-configured, stays server-side and is not inherited by ordinary private accounts. This token can create/read incoming sales for its merchant; the public demo gets only its own fixed21-sat request and sanitized receipt, never merchant history or configuration. The app calls only `/pos/me`, `/pos/invoice` and the original invoice's status path at `https://names.coinos.io`.

The hosted compose already mounts its private `secrets/` directory. Put the independently backed-up token there and set the file variable to its `/run/secrets/` path. Enabling the feature requires an app restart. Preserve the storage/proxy/backup keys, existing financial records and separate chat runtime. Back up this additional credential separately: the database archive does not include external key files.

Coinos token provisioning is an explicit account-configuration action; its API also applies the selected display currency to other terminals for that name. Preserve the selected account setting and do not revoke other tokens. The fixed SAT invoice does not use fiat conversion.

## Limits

Native ecash custody and direct Cashu redemption are not implemented by this page. A connected receiver or controlled test is not a funded payment acceptance claim. No funds move just by opening the page or saving configuration. Retained real samples have a fixed capacity cap and fail closed when full rather than silently deleting financial evidence. Demo visitors have no API-key, provider-management, transfer or withdrawal authority.
