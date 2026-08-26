# Recipes

Copy-paste starting points. Every recipe is complete — no hidden setup beyond `npm install @luxalgo/broker-sdk` and your own read-only keys.

## Your portfolio in five lines

```ts
import { connect } from "@luxalgo/broker-sdk";

const kraken = connect({ broker: "kraken", credentials: { apiKey, apiSecret } });
const { accounts } = await kraken.fetchSnapshot();
console.table(accounts.map(({ id, currency, equity }) => ({ id, currency, equity })));
```

## Every broker at once, with failures isolated

```ts
import { createPortfolio } from "@luxalgo/broker-sdk";

const portfolio = createPortfolio();
portfolio.add({ broker: "alpaca", credentials: { apiKey: A_KEY, apiSecret: A_SECRET } });
portfolio.add({ broker: "binance", credentials: { apiKey: B_KEY, apiSecret: B_SECRET } });
portfolio.add({ broker: "hyperliquid", credentials: { walletAddress: "0x…" } });

const { snapshots, failures } = await portfolio.fetchAll();
for (const failure of failures) console.error(`${failure.broker}: ${failure.error.message}`);
```

## Win rate and realized PnL

```ts
import { computeStats } from "@luxalgo/broker-sdk/stats";

const stats = computeStats(snapshots.flatMap((s) => s.accounts.map((a) => ({ ...a, broker: s.broker }))));
console.log(`win rate: ${(stats.trades?.winRate ?? 0) * 100}%`);
console.log(`realized PnL: ${stats.trades?.realizedPnl}`);
console.log("per symbol:", stats.trades?.bySymbol);
```

## Import any broker statement (no API needed)

```ts
import { parseStatementCsv, positionsFromTrades } from "@luxalgo/broker-sdk/csv";
import { readFileSync } from "node:fs";

const { trades, skippedRows } = parseStatementCsv(readFileSync("statement.csv", "utf8"));
console.log(`${trades.length} trades imported, ${skippedRows} rows skipped`);
console.log(positionsFromTrades(trades)); // net open positions
```

## Mixed currencies → one USD total

```ts
import { getUsdRates, toUsd } from "@luxalgo/broker-sdk/fx"; // explicit opt-in: calls frankfurter.dev

const rates = await getUsdRates();
const totalUsd = snapshots
  .flatMap((s) => s.accounts)
  .reduce((sum, account) => sum + toUsd(account.equity, account.currency, rates), 0);
```

## Persist snapshots and survive token rotation

```ts
import { connect } from "@luxalgo/broker-sdk";

const connection = connect({
  broker: "questrade",
  credentials: { refreshToken: loadToken() },
  // Questrade tokens are single-use: persist the rotation or the next fetch dies.
  onCredentialsRotated: (next) => saveToken(next.refreshToken),
});
const snapshot = await connection.fetchSnapshot();
await db.upsert("accounts", snapshot.accounts); // Account.id is a stable upsert key
```

## Give your agent read access (MCP)

No code — run [`@luxalgo/mcp`](https://github.com/LuxAlgo/luxalgo-mcp-server) locally with your read-only keys as `BROKERS_*` env vars in your MCP client config, then ask Claude "how's my portfolio doing?".

## Place a paper order (experimental)

```ts
import { connectTrading } from "@luxalgo/broker-sdk/orders";

const trading = connectTrading({ broker: "alpaca", credentials: { apiKey: PAPER_KEY, apiSecret: PAPER_SECRET } });
const order = await trading.placeOrder({
  symbol: "AAPL",
  side: "buy",
  type: "limit",
  quantity: 5,
  limitPrice: 180.5,
  clientOrderId: "my-idempotency-key",
});
```

Paper keys only — live keys are rejected with no override. See [orders-rfc.md](orders-rfc.md).

Stats and totals report what your broker reports; nothing here is investment advice. Verify important numbers against your broker's own statements.
