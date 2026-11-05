# Contributor instructions

Read README.md, SECURITY.md and the relevant setup guide. This is an experimental
private-finance application. Keep credentials, runtime state, private/customer
records and generated browser output out of source. Use only fictional test
accounts/data. Financial behavior uses integer minor units and must preserve
currency precision, idempotency and strict authorization. Run relevant tests and
TypeScript before proposing changes. Do not execute real payments, trades,
payouts, seed operations or collateral locks as a test. The canonical ngit source
and GitHub mirror must retain matching accepted release refs.
