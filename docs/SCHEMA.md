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
| `side` | `"buy" \| "sell"` | Always from the account holder's side. |
| `quantity` | `number` | Always positive — `side` carries direction. |
| `price` | `number` | Per unit, in the account's `currency`. |
| `fee?` | `number` | Commission/fee, absolute value, only when reported and non-zero. |
| `executedAt?` | `string` | ISO 8601, only when the source carried a parseable timestamp. |

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
