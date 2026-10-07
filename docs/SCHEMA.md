# The normalized schema

One shape for everything, regardless of broker. This document is the human-readable companion to `src/schema.ts` (the source of truth) and `conformance/vectors/` (its executable specification).

## Entities

### Account

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Broker-side stable identifier. Safe as an upsert key across refreshes. |
| `name` | `string` | Human-readable, derived from the broker + account number. |
| `currency` | `string` | ISO 4217 code that `equity`, `cash`, and position values are stated in. |
| `equity` | `number` | Total account value in `currency`. |
| `cash?` | `number` | Cash component, only when the broker reports it separately. |
| `environment?` | `"live" \| "paper"` | Only when the broker distinguishes (Alpaca). |
| `positions` | `Position[]` | Open positions. |
| `trades` | `Trade[]` | Most recent history window the broker exposes; `[]` when none exists — never fabricated. |

### Position

| Field | Type | Notes |
| --- | --- | --- |
| `symbol` | `string` | Broker-native symbol, normalized where the broker uses legacy codes (Kraken `XXBT` → `BTC`) or composite ids (Topstep `CON.F.US.EP.U26` → `EP`, Trading212 `AAPL_US_EQ` → `AAPL`). |
| `quantity` | `number` | Negative means short. |
| `marketValue?` | `number` | In the account's `currency`, only when the broker can price it. A missing value is more honest than a guessed one. |
| `averageEntryPrice?` | `number` | Per unit in the account's `currency`, only when the broker reports it (or a real cost basis it derives from, e.g. Tradier's `cost_basis ÷ quantity`). |
| `assetClass?` | `"equity" \| "option" \| "futures" \| "forex" \| "crypto" \| "cash" \| "other"` | Only when the broker states it (Alpaca, IBKR, Public) or the venue implies it (a Topstep position is always a future; a Kraken USD balance is cash). Never guessed — Webull and Questrade omit it. |

### Trade

| Field | Type | Notes |
| --- | --- | --- |
| `symbol` | `string` | Same normalization as positions. |
| `executionId?` | `string` | Native fill identifier, scoped to the broker account; never substituted with an order ID. |
| `instrumentId?` | `string` | Native instrument identifier, such as Topstep's full futures contract ID, including expiry. |
| `executionTieBreak?` | `number` | Deterministic numeric tie-break key for equal timestamps. Does not imply chronological sequence unless the provider documents that guarantee. |
| `reportedGrossPnl?` | `number` | Provider-reported realized gross P&L on this fill, in account currency, before fees/commissions. Omitted when unknown; zero and losses are preserved. |
| `side` | `"buy" \| "sell"` | Always from the account holder's side. |
| `quantity` | `number` | Always positive — `side` carries direction. |
| `price` | `number` | Per unit, in the account's `currency`. |
| `fee?` | `number` | Non-negative reported costs. Topstep sums available non-negative `fees` and `commissions`, preserving explicit zero; omitted when neither is known or either is negative. Other adapters may omit zero costs. |
| `executedAt?` | `string` | ISO 8601, only when the source carried a parseable timestamp. Topstep normalizes offsets to UTC while retaining fractional precision beyond milliseconds. |

Topstep's `executionTieBreak` uses non-negative safe-integer numeric fill IDs;
the [API reference](https://gateway.docs.projectx.com/docs/api-reference/trade/trade-search/)
does not guarantee their chronology. String IDs have no inferred ordering key;
unsafe numeric IDs are omitted. Provider array order is preserved. Stats compares
precise instants, preserving input order for ties; it does not use this key,
contract IDs, or reported P&L to reconstruct futures results.

Keep precise timestamps as strings: `Date` discards sub-millisecond digits.
Sync uses native fill IDs and occurrence counts within each account. On upgrade,
old Topstep fills without native metadata can match by the original trade fields
and millisecond timestamp. Exact matches take precedence. Fills indistinguishable
in the old data remain ambiguous during that transition. Other timestamp-keyed
consumers must handle the precision change themselves.

The [published Topstep API schema](https://api.topstepx.com/swagger/v1/swagger.json)
declares both `fees` and optional `commissions`, but does not describe whether
`fees` is inclusive. The adapter adds these fields as separate components;
confirm totals against broker statements when accounting accuracy is required.
Negative component semantics are also unspecified, so their total is omitted.

### Bar

Historical OHLCV, returned by `connection.fetchBars(symbol, request)` for brokers whose adapter implements the optional `fetchBars` capability (Alpaca, Tradier). Bars come oldest-first.

| Field | Type | Notes |
| --- | --- | --- |
| `time` | `number` | Bar open, epoch milliseconds UTC. Daily bars open at midnight America/New_York on both brokers (Alpaca reports it that way; Tradier's dates are converted). |
| `open` / `high` / `low` / `close` | `number` | In the venue's quote currency. A row missing any of the four, or internally inconsistent (open or close outside `[low, high]`), is dropped, never patched. |
| `volume?` | `number` | Only when the venue reports it for the bar. |

### BarsRequest

| Field | Type | Notes |
| --- | --- | --- |
| `timeframe` | `"1m" \| "5m" \| "15m" \| "1h" \| "1d"` | Only resolutions the venue serves natively — adapters never resample. Tradier has no hourly interval and rejects `"1h"` with `UnsupportedCapabilityError`. |
| `from?` / `to?` | `number` | Window bounds, epoch milliseconds. Broker defaults apply when omitted. |
| `limit?` | `number` | Keeps the most recent `limit` bars of the window. Every call is capped at `MAX_BARS` (10,000) regardless. |

### BrokerSnapshot

The envelope `fetchSnapshot()` returns: `{ broker, fetchedAt, accounts }`. Plain JSON — persist it however you like.

## Principles

1. **Omit, don't guess.** Every optional field is optional because some broker genuinely cannot provide it. Adapters never invent values to fill the shape.
2. **Numbers are JS numbers.** Sufficient for portfolio reporting; documented so consumers doing accounting-grade arithmetic know to treat sub-satoshi precision with care.
3. **Pure normalization.** `normalize(raw)` is deterministic and IO-free. The conformance vectors pin its behavior per adapter, and any port in another language must reproduce them byte-for-byte.
4. **Stable ids.** `Account.id` is chosen to survive refreshes (account numbers, wallet-address-derived ids, content hashes for CSV imports), so persistence layers can upsert.

## Deliberate omissions (pre-1.0 open questions)

- ~~`assetClass`~~ and ~~cost basis / average entry price~~ — resolved in v0.2 as optional `Position.assetClass` and `Position.averageEntryPrice`, populated only where the broker genuinely reports them.
- **Order-level data (ids, order types)** — read-only v1 reports fills, not orders. Lands with the write layer.
