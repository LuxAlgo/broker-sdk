# Changelog

All notable changes to `@luxalgo/broker-sdk` are documented here.

## Unreleased

### Fixed

- **Webull:** connections failed with "Webull rejected the request (404)" because the adapter called the retired `/openapi/account/*` routes. It now calls the documented `/trading/*` routes with the `x-version: v3` header. Equity is read from `total_net_liquidation_value`, so it no longer reads 0. Rate-limited calls (429) wait and retry (proposed by @anthony-som in [#19](https://github.com/LuxAlgo/broker-sdk/pull/19)).
- **Sync daemon:** later sweeps pass `historySince` (the saved snapshot's time less 30 days), so brokers that page through history no longer re-read their whole lookback on every sweep.

### Added

- **Webull trade history** from `/trading/orders/historical-orders/list`, read in 30-day windows: a year back on the first sync, from `historySince` after that. Each settled order with a fill becomes one trade at Webull's average fill price, with its fees. Single-leg options get OCC-style symbols (`TSLA 260925P375`), their contract size and whether they opened or closed. Multi-leg orders and orders still working are skipped, and an order seen twice counts once. A rejected window older than the history Webull keeps ends the walk.
- `Trade.assetClass`, `Trade.multiplier` and `Trade.positionEffect`, set only when the broker reports them.
- `historySince` on `connect()` and `FetchContext`: a lower bound for brokers that page through trade history.
- **Binance USDⓈ-M futures** as a second account: every margin asset valued in USD as equity (`totalMarginBalance` counts only USDT in single-asset mode), open positions, and fills from `/fapi/v1/userTrades` for the last three months. Binance only returns fills per symbol, so the symbols come from the income history and the open positions. Each symbol is read in 7-day windows, from `historySince` on later syncs, and more than a page of fills in one millisecond is read on by fill ID. Requests pause before Binance's weight limit, wait out a 429, and retry a server error or a dropped connection. Fees in a stablecoin count at face value and fees in BNB at the BNB/USDT open of their hour; a fee in any other asset is left out. A key that can't read futures keeps the spot account as before. A 403, which Binance sends when its firewall limits an IP, is reported as that rather than as rejected credentials. Spot fills are still not read.
- `Trade.positionSide` and `Position.positionSide` (`"long" | "short"`), set when the broker keeps a long and a short position on one symbol apart, as Binance hedge mode does. Hedge-mode fills also carry `positionEffect`. `computeStats` matches each side's lots on its own, short side included, and the sync diff tracks the two positions separately.

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
