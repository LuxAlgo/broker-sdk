<p align="center">
  <img src="https://raw.githubusercontent.com/LuxAlgo/broker-sdk/main/docs/assets/hero.svg" alt="Broker SDK. Every broker. One schema. Your keys never leave your machine." width="100%"/>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@luxalgo/broker-sdk"><img src="https://img.shields.io/npm/v/@luxalgo/broker-sdk?color=000000&labelColor=000000" alt="npm version"/></a>
  <a href="https://github.com/LuxAlgo/broker-sdk/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/LuxAlgo/broker-sdk/ci.yml?label=ci&labelColor=000000" alt="CI"/></a>
  <a href="https://github.com/LuxAlgo/broker-sdk/actions/workflows/canary.yml"><img src="https://img.shields.io/github/actions/workflow/status/LuxAlgo/broker-sdk/canary.yml?label=canary&labelColor=000000" alt="Canary"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-000000?labelColor=000000&color=555555" alt="MIT license"/></a>
</p>

<p align="center">
  <a href="docs/recipes.md"><b>Recipes</b></a>
  &nbsp;·&nbsp;
  <a href="docs/SCHEMA.md"><b>Schema</b></a>
  &nbsp;·&nbsp;
  <a href="docs/byo-oauth.md"><b>OAuth setup</b></a>
  &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/@luxalgo/broker-sdk"><b>npm</b></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/LuxAlgo/luxalgo-mcp-server"><b>MCP server</b></a>
</p>

<p align="center"><sub>Broker SDK is a <a href="https://www.luxalgo.com">LuxAlgo</a> open-source project. Official repository: <a href="https://github.com/LuxAlgo/broker-sdk">github.com/LuxAlgo/broker-sdk</a></sub></p>

**Open-source broker connectivity for code, apps, and AI agents.** Point it at Alpaca, Binance, Kraken, Interactive Brokers, Hyperliquid, Tradier and more. Get back the same clean picture from every one of them: accounts, balances, positions, trade history, and computed performance stats.

No hosted service in the path. No per-connection fees. No telemetry. This is the connectivity layer that platforms charge for, as an MIT-licensed library.

```bash
npm install @luxalgo/broker-sdk
```

## Your portfolio in five lines

```ts
import { connect } from "@luxalgo/broker-sdk";

const kraken = connect({ broker: "kraken", credentials: { apiKey, apiSecret } });
const snapshot = await kraken.fetchSnapshot();
console.log(snapshot.accounts); // normalized: equity, positions, trades
```

Every broker returns the same shape. Learn it once:

```ts
type Account = {
  id: string;          // broker-side stable id, safe as an upsert key
  name: string;
  currency: string;    // ISO 4217
  equity: number;      // total account value
  cash?: number;       // when the broker reports it separately
  environment?: "live" | "paper";
  positions: { symbol: string; quantity: number; marketValue?: number }[];
  trades: { symbol: string; side: "buy" | "sell"; quantity: number; price: number; fee?: number; executedAt?: string }[];
};
```

## Your whole portfolio, every broker at once

```ts
import { createPortfolio } from "@luxalgo/broker-sdk";
import { computeStats } from "@luxalgo/broker-sdk/stats";

const portfolio = createPortfolio();
portfolio.add({ broker: "alpaca", credentials: { apiKey, apiSecret } });
portfolio.add({ broker: "binance", credentials: { apiKey, apiSecret } });
portfolio.add({ broker: "hyperliquid", credentials: { walletAddress } });

const { snapshots, failures } = await portfolio.fetchAll();
const stats = computeStats(
  snapshots.flatMap((s) => s.accounts.map((a) => ({ ...a, broker: s.broker }))),
);
console.log(stats.totalEquity, stats.trades?.winRate, stats.topPositions);
```

One broker failing never takes down the sweep: failures come back alongside the snapshots that succeeded. The stats engine does FIFO round-trip matching, win rate, average win and loss, and per-symbol activity. A sell with no recorded buy is ignored, never guessed at.

## Import any broker statement

No API? Any account at any institution is importable from a trade-history CSV. The parser is tolerant on headers (brokers disagree on column names) and strict on rows (anything unreadable is skipped and counted, never guessed):

```ts
import { parseStatementCsv, positionsFromTrades } from "@luxalgo/broker-sdk/csv";

const { trades, skippedRows, contentHash } = parseStatementCsv(csvText);
const positions = positionsFromTrades(trades);
```

## Supported brokers

| Broker | Credentials | Trades history |
| --- | --- | :---: |
| Alpaca (live + paper) | API key + secret | ✅ |
| Binance | API key + secret (read-only) | ➖ |
| Bybit | API key + secret (read-only) | ➖ |
| Coinbase | your own OAuth2 app (read scope) | ➖ |
| Crypto.com Exchange | API key + secret (read-only) | ➖ |
| E\*TRADE | your own OAuth 1.0a app | ✅ |
| Hyperliquid | wallet address only | ✅ |
| Interactive Brokers (Flex) | Flex token + query ID | ✅ |
| Kraken | API key + secret ("Query Funds") | ➖ |
| OKX | API key + secret + passphrase (read) | ➖ |
| Public.com | API secret key | ✅ |
| Questrade | API refresh token | ✅ |
| Topstep (ProjectX) | username + API key | ✅ |
| Tradier | access token | ✅ |
| Trading212 | API key | ➖ |
| Webull (OpenAPI) | App key + secret | ➖ |
| Any broker via CSV import | a statement file | ✅ |

`listBrokers()` returns every adapter with its exact credential fields and a one-line guide to creating the key with **read-only scope**, which is all this SDK ever needs.

**Sanctioned APIs only.** If a broker does not officially support programmatic access for its users, it is not in this repo: no scraping, no reverse-engineered private APIs, ever. That's why you won't find Robinhood here. Brokers reachable only through credentialed aggregators (Plaid-style: Fidelity, Schwab, Chase) can't ship in an open-source library and are out of scope. OAuth brokers where you register your own free developer app (E\*TRADE, Coinbase) are supported bring-your-own-app style; the flow helpers and setup guide live in [docs/byo-oauth.md](docs/byo-oauth.md).

## Read-only, local-only, by design

- **Your keys stay yours.** The SDK runs where your code runs. There is no LuxAlgo server in the path, no telemetry, no phoning home. We don't want your keys.
- **Read-only by default.** The root export reads accounts, balances, positions, and history. Nothing in it can place an order.
- **Credential rotation is first-class.** Brokers with single-use tokens (Questrade) hand the rotated credentials back through `onCredentialsRotated` so you can persist them before the old ones die.
- **Fail-soft, never fabricate.** A position the broker can't price has no `marketValue` rather than a made-up one. A history row that can't be read is skipped and counted, not guessed.

## Give your AI agent portfolio access

Run the [LuxAlgo MCP server](https://github.com/LuxAlgo/luxalgo-mcp-server) locally and its `broker_*` tools give Claude, Cursor, or any MCP client read-only access to your real accounts through this SDK. Keys go in your own MCP client config as env vars; the agent can ask "how is my portfolio doing?" but can never trade.

## Place orders (experimental)

The write layer lives in a deliberately separate module. Importing the SDK never gives code trading capability by accident:

```ts
import { connectTrading } from "@luxalgo/broker-sdk/orders";

const trading = connectTrading({ broker: "alpaca", credentials: { apiKey, apiSecret } }); // paper keys only
const order = await trading.placeOrder({ symbol: "AAPL", side: "buy", type: "limit", quantity: 5, limitPrice: 180.5 });
await trading.cancelOrder(order.id);
```

Supported: **Alpaca** (paper by default; a live account additionally requires `acknowledgeLiveTrading` set to the exact `LIVE_TRADING_ACKNOWLEDGEMENT` sentence, never a boolean, never a default) and **Tradier** (sandbox only, pinned to the sandbox host so live orders are impossible by construction). Roadmap and full safety posture: [docs/orders-rfc.md](docs/orders-rfc.md).

## The conformance kit

<p align="center">
  <img src="https://raw.githubusercontent.com/LuxAlgo/broker-sdk/main/docs/assets/conformance.svg" alt="Adapter architecture: fetchRaw does IO only, normalize is pure, golden vectors gate every adapter" width="100%"/>
</p>

The schema plus golden test vectors live in [`conformance/vectors/`](conformance/vectors): one per adapter, pairing a raw provider payload with the exact normalized output. Every adapter splits into an IO-only `fetchRaw` and a pure `normalize`, so the mapping of every broker is tested without a network or credentials, and every community adapter must pass the gate before merge.

Two workflows keep the adapters honest in production:

- **Canary**: a scheduled run against real read-only accounts, per broker, so a silent API change surfaces as a red badge instead of a user bug report.
- **API watch**: hash-diffs each broker's public API docs and changelogs and files an issue the day something moves.

## Runtime

Node ≥ 18.17 (built-in `fetch`; `node:crypto` for request signing). Zero runtime dependencies. ESM and CJS. TypeScript strict, `exactOptionalPropertyTypes` on. Bring your own persistence: snapshots are plain JSON.

## The suite

| Package | What it is |
| --- | --- |
| [`@luxalgo/broker-sdk`](https://github.com/LuxAlgo/broker-sdk) (this repo) | The TypeScript SDK and reference implementation |
| [`@luxalgo/mcp`](https://github.com/LuxAlgo/luxalgo-mcp-server) | The LuxAlgo MCP server; its local `broker_*` tools give AI agents read-only portfolio access through this SDK |

## Contributing

Copy-paste starting points live in [docs/recipes.md](docs/recipes.md); the bring-your-own-app OAuth guide (E\*TRADE, Coinbase) in [docs/byo-oauth.md](docs/byo-oauth.md). Adapter #17 is yours to add, and [CONTRIBUTING.md](CONTRIBUTING.md) walks you through it. The short version: sanctioned user-key APIs only, split fetch/normalize, ship a conformance vector, pass the gate.

## Disclaimer

This software reports what your broker reports. It is not investment advice, and nothing in it recommends any trade. Use at your own risk; verify important numbers against your broker's own statements.

## License

[MIT](LICENSE) © LuxAlgo Global, LLC. The "Broker SDK" and "LuxAlgo" names and the LuxAlgo logo are trademarks of LuxAlgo Global, LLC; see [TRADEMARKS.md](TRADEMARKS.md). Security reports: [SECURITY.md](SECURITY.md).
