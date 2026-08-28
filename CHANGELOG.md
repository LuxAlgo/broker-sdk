# Changelog

All notable changes to `@luxalgo/broker-sdk` are documented here.

## 0.4.0

- Six new adapters, 22 brokers total: **Charles Schwab** (bring-your-own OAuth2 app), **TradeStation** (bring-your-own OAuth2 app), **tastytrade** (rotating remember token), **Robinhood Crypto** (official API, Ed25519 request signing via node:crypto), **Gemini**, and **KuCoin**.
- Orders (experimental): **Binance Spot Testnet**, pinned to testnet.binance.vision so live orders are impossible by construction.
- New flow helpers exported from `/adapters`: `buildSchwabAuthorizeUrl`, `exchangeSchwabCode`, `buildTradestationAuthorizeUrl`, `exchangeTradestationCode`, `robinhoodSignMessage`, `robinhoodCanonicalMessage`.
- Unpriced crypto holdings on venues without a pricing endpoint (Gemini, KuCoin, Robinhood Crypto) are reported without `marketValue` and excluded from fabricated equity, per the fail-soft rule.

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
