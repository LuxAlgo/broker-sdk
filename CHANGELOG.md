# Changelog

All notable changes to `@luxalgo/broker-sdk` are documented here.

## Unreleased

### Fixed

- **Webull:** moved to the `/trading/*` routes with `x-version: v3`, the routes Webull's official SDK uses. Webull's gateway picks the backend from that header. The `/openapi/account/*` paths answered `404 Route Not Found`, and the v1 balance and positions routes returned 404 for accounts that were otherwise valid, so every Webull connection failed with "Webull rejected the request (404)".
- **Webull:** equity is read from `total_net_liquidation_value`, the v3 balance field, and no longer reports 0.
- **Webull:** rate-limited requests (429) are retried with exponential backoff.

### Added

- **Webull trade history** from `/trading/orders/historical-orders/list`. The adapter walks 30-day windows, follows `pagination_key`, looks back 365 days on first sync, and stops cleanly at Webull's retention limit. Each filled order becomes one trade at its average fill price, with fees summed. Single-leg options get OCC-style symbols (`TSLA 260925P375`). Multi-leg orders and orders still working are skipped.
- `Trade.assetClass`, `Trade.multiplier` and `Trade.positionEffect`. All three are optional and set only when the broker states them.
- `historySince` on `connect()` (and `FetchContext`): a lower bound for brokers that page through history, so later syncs fetch only recent orders.

## 0.5.1

- IBKR Flex XML: optional `statementTimeZone` on `connect()` and `parseFlexStatement()` interprets timestamps without offsets in the selected IANA timezone, including daylight saving. Existing callers retain the UTC default. Explicit UTC/numeric offsets are honored; invalid, ambiguous, or nonexistent local timestamps leave `executedAt` absent.
- Optional normalization context for adapters. Other brokers' timestamp behavior is unchanged.

## 0.5.0

### Added

- Historical OHLCV bars: `connection.fetchBars(symbol, { timeframe, from, to, limit })` returns normalized `Bar[]` from the broker's own read-only market-data endpoints. Implemented for **Alpaca** (stocks on the IEX feed via `data.alpaca.markets` v2 bars, crypto pairs via v1beta3, `page_token` paging capped at 10,000 bars) and **Tradier** (intraday via `timesales`, daily via `history`, America/New_York timestamps converted with a DST-aware helper).
- Schema: `Bar`, `BarTimeframe`, `BarsRequest`, `MAX_BARS`; optional `fetchBars` on `BrokerAdapter`.
- `supportsBars(brokerId)` and a `supportsBars` flag on `listBrokers()` entries; `UnsupportedCapabilityError` for brokers without market-data endpoints or timeframes a venue cannot serve.

## 0.4.0

- Six new adapters, 22 brokers total: **Charles Schwab** (bring-your-own OAuth2 app), **TradeStation** (bring-your-own OAuth2 app), **tastytrade** (rotating remember token), **Robinhood Crypto** (official API, Ed25519 request signing via node:crypto), **Gemini**, and **KuCoin**.
- Orders (experimental): **Binance Spot Testnet**, pinned to testnet.binance.vision so live orders are impossible by construction.
- New flow helpers exported from `/adapters`: `buildSchwabAuthorizeUrl`, `exchangeSchwabCode`, `buildTradestationAuthorizeUrl`, `exchangeTradestationCode`, `robinhoodSignMessage`, `robinhoodCanonicalMessage`.
- Unpriced crypto holdings on venues without a pricing endpoint (Gemini, KuCoin, Robinhood Crypto) are reported without `marketValue` and excluded from fabricated equity, per the fail-soft rule.
- New `/connect` subpath export: the drop-in `BrokerConnect` React component plus a headless core at `/connect/core`; React is an optional peer dependency used only by this subpath.
- New `/sync` subpath export and `broker-sync` bin: a self-hosted refresh daemon that polls connected brokers, diffs snapshots, and emits typed events to webhook, JSONL, or console sinks, with HMAC-signed webhook deliveries.

## 0.3.0

- New adapters: E\*TRADE and Coinbase, bring-your-own-app OAuth (flow helpers included; see `docs/byo-oauth.md`).
- Orders (experimental): multi-broker dispatcher `connectTrading({ broker })`. Tradier support, sandbox only, pinned to the sandbox host. Alpaca live accounts additionally require the exact `LIVE_TRADING_ACKNOWLEDGEMENT` sentence.
- Credential rotation for OAuth refresh flows surfaces through `onCredentialsRotated`.

## 0.2.0

- Schema: `assetClass` and `averageEntryPrice` on positions, mapped where each broker reports them or the venue implies them.
- Conformance vectors updated for every adapter.

## 0.1.0

- Initial release: 14 broker adapters behind one normalized schema (`connect`, `createPortfolio`, `listBrokers`).
- Subpath exports: `/stats` (FIFO round-trip matching, win rate, realized PnL), `/csv` (statement import), `/fx` (opt-in USD conversion).
- Conformance kit: one golden raw-to-normalized vector per adapter, tested without network or credentials.
- Zero runtime dependencies; ESM and CJS; Node 18.17+.
