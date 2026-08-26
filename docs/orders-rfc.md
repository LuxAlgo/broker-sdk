# RFC: the write layer (order placement)

Status: **experimental** — shipped as `@luxalgo/broker-sdk/orders`. Alpaca (paper + live behind the acknowledgement sentence) and Tradier (sandbox only).

## Goal

Extend the SDK beyond reading accounts to placing, tracking, and canceling orders: open source, with the user's own keys, no per-connection toll. Execution tooling built on this SDK imports this layer instead of writing its own broker code, so it is designed once, here.

## What ships today

- **Alpaca**: paper keys (`PK…`) connect without ceremony. A live key connects only when the caller passes `acknowledgeLiveTrading` set to the exact `LIVE_TRADING_ACKNOWLEDGEMENT` sentence at construction time — a per-connection, unmistakable opt-in that is never a boolean, never a default, never inherited from config.
- **Tradier**: sandbox only — the connection is pinned to sandbox.tradier.com, which only accepts sandbox tokens, so live orders are impossible by construction. Equity orders, day/gtc. Tradier has no client-order-id dedupe; the `tag` field correlates but does not prevent duplicates (documented, not pretended away).
- Normalized `Order` / `OrderRequest` shapes: market and limit, `day`/`gtc`/`ioc`/`fok`, quantity or notional sizing, `clientOrderId` idempotency.
- `placeOrder`, `getOrder`, `listOrders`, `cancelOrder`.
- Validation before any network call: exactly one of quantity/notional, positive sizes, limit orders need a price.

## Safety posture (non-negotiable)

1. **Separate module.** The root export and the MCP server contain no trading capability at all. Code must explicitly import `@luxalgo/broker-sdk/orders`.
2. **Paper first, per broker.** A broker's write support ships against its paper/sandbox environment and soaks there before live enablement is even designed for it.
3. **Live trading requires explicit, unmistakable opt-in** (future): a construction-time acknowledgement (e.g. `acknowledgeLiveTrading: "I understand this places real orders with real money"`), never a boolean, never a default, never inheritable from config files.
4. **Idempotency everywhere.** Every broker adapter must support a client order id or equivalent dedupe mechanism; automated callers are pushed toward it in docs and types.
5. **No agent surface by default.** The broker tools in [`@luxalgo/mcp`](https://github.com/LuxAlgo/luxalgo-mcp-server) stay read-only. If an agent-facing trading MCP ever ships, it is a separate package with human-confirmation tooling, not a flag on the read tools.
6. **Never guess semantics.** Ambiguous broker order states map to conservative normalized states; anything unknown is `pending`, not `filled`.

## Broker rollout order (proposed)

| Phase | Broker | Why |
| --- | --- | --- |
| v0 | Alpaca paper | Real order API, zero-risk environment, already our reference adapter |
| v1 | Alpaca live (behind acknowledgement) + Tradier | US equities coverage |
| v2 | Binance/Bybit/OKX testnets → live | Crypto majors; testnets exist |
| v3 | Topstep (ProjectX), Kraken | Futures + remaining majors |

Brokers with no order API in their user-key tier are documented as read-only, never emulated.

## Conformance

Order normalization gets its own vector set (`conformance/orders/`) once a second broker lands — one broker's mapping doesn't need a cross-broker gate yet; `normalizeAlpacaOrder` is pinned by unit tests in the meantime.

## Open questions

- Order modification (`replaceOrder`): ships with v1, or stays cancel-and-replace?
- Streaming order updates (Alpaca has SSE/WS): polling `getOrder` is enough for v0/v1.
- Bracket/OCO orders: deliberately out of scope until the plain surface has soaked.
