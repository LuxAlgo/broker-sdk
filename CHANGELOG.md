# Changelog

All notable changes to `@luxalgo/broker-sdk` are documented here.

## Unreleased

- New `/statements` subpath: `parseStatement` imports real-world statement files — MetaTrader 4/5 statements (the UTF-16LE HTML report included), MT5 deals tables from tester reports, ThinkOrSwim/Schwab account statements, and TradingView strategy-tester trade lists — into `Trade` fills, with `parseStatementCsv` as the generic fallback. Adapted from LuxAlgo/prop-firm-sim's import layer (MIT). Detection is a hard per-format fingerprint; unreadable rows are skipped and counted; every derived value is disclosed as a structured issue; fills are tagged with the account the statement discloses so multi-account histories are never silently merged.
- Statement conformance vectors under `conformance/vectors/statements/`: one raw statement file per format paired with the exact fills it must produce.

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
