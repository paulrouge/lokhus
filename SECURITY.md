# Security

Lokhus builds, hashes and signs transactions that move real funds. Reports are welcome and taken seriously.

## Reporting

Email **security@lokhus.com**, or use GitHub's private vulnerability reporting on this repository. Please include steps to reproduce and what an attacker gains.

Don't open a public issue or post details anywhere until a fix is out. You'll get a reply within a few days.

## In scope

- Anything that could make a user sign or execute something other than what the app shows.
- Bypassing the SODAX calldata checks, signature verification or Safe tx hashing.
- Reading or changing another account's data, or decrypting end-to-end encrypted data without the user's keys.
- Session, passkey, recovery or step-up flaws in the server.
- The deployment at lokhus.com (headers, TLS, DNS).

## Out of scope

- Bugs in Safe, SODAX or wallet contracts and apps themselves; report those to their teams.
- Denial of service through traffic volume.
- Findings that need a compromised device or browser extension on the user's side.

How the hosted app can fail and what protects against each case: [lokhus.com/trust](https://lokhus.com/trust).
