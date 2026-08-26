# Security policy

This project sits next to people's brokerage credentials, so we take reports seriously.

## Reporting a vulnerability

Please use **GitHub's private vulnerability reporting** (the *Security* tab → *Report a vulnerability*) rather than a public issue. We'll acknowledge within a few days and coordinate a fix and disclosure with you.

Never include real API keys, tokens, or account identifiers in a report — redact everything.

## Scope notes

- The SDK and server never transmit credentials anywhere except directly to the user's own broker over HTTPS, and never write them to disk. Anything violating that is a critical bug.
- The read path must be incapable of placing orders; the write layer (`@luxalgo/broker-sdk/orders`) must be unreachable without an explicit import and, for live accounts, the acknowledgement sentence. A bypass of either gate is a critical bug.
