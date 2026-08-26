# Contributing

Thanks for helping every developer drop their per-connection bill.

## Ground rules

1. **Sanctioned APIs only.** An adapter is eligible when the broker officially supports programmatic access with user-generated credentials (API key, token, or a free self-registered developer app). No scraping, no reverse-engineered private endpoints, no exceptions — a PR that violates this is closed regardless of quality.
2. **Read-only.** Adapters call account, balance, position, and history endpoints — never trading ones. Document the minimal read-only scope in the adapter's `readOnlySetup`.
3. **Never fabricate.** Unpriceable positions get no `marketValue`; unreadable rows are skipped and counted. When in doubt, omit.

## Adding an adapter

1. Create `src/adapters/<broker>.ts` exporting a `BrokerAdapter<Raw>`:
   - `fetchRaw(credentials, ctx)` — IO only. Use `ctx.fetch`, throw the typed errors from `src/errors.ts` (`MissingCredentialsError` before any network call, `BrokerAuthError` on rejected credentials, `BrokerRequestError` otherwise).
   - `normalize(raw)` — pure. No IO, no clocks, no randomness: same input, same output, forever.
   - `credentials` + `readOnlySetup` — the exact fields a user must supply and the one-line guide to creating a read-only key.
2. Register it in `src/adapters/index.ts` (`adapters` map + re-exports) and add its credential shape to `BrokerCredentials` in `src/index.ts`.
3. **Ship a conformance vector** in `conformance/vectors/<broker>.json`:

   ```json
   {
     "broker": "<id>",
     "description": "What this vector proves, including the quirks it pins down.",
     "raw": { "the payloads fetchRaw gathers": "..." },
     "expected": [ { "the exact normalized accounts": "..." } ]
   }
   ```

   Use realistic payload shapes (copy the structure of real API responses, redact real values) and include at least one malformed row that must be skipped. The conformance test (`tests/conformance.test.ts`) refuses to pass while any registered adapter lacks a vector.
4. Add unit tests for any pure helpers (signing canonicalization, symbol normalization).
5. `pnpm check` must pass: typecheck + all tests.
6. Update the broker table in the README.

## Reporting a broken adapter

Broker APIs drift. The most useful report is a failing conformance vector: capture the new raw payload (redact your values!), state what the normalized output should be, and open an issue — that makes the break reproducible and the fix testable. If you can, send the fix in the same PR.

## Sign your work (DCO)

Every commit must carry a `Signed-off-by` line certifying the [Developer Certificate of Origin](https://developercertificate.org/). Git adds it for you:

```bash
git commit -s
```

CI rejects pull requests with unsigned commits.

## Code style

- TypeScript strict; zero runtime dependencies — `fetch` and `node:crypto` are the whole toolbox.
- Comments explain constraints the code can't (a broker quirk, a signature format), not what the next line does.
- File names are kebab-case.
