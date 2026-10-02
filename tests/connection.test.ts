import { describe, expect, it } from "vitest";

import { connect, createPortfolio, listBrokers } from "../src/index.js";
import { MissingCredentialsError } from "../src/errors.js";

/** Fake fetch serving Trading 212's current read-only endpoints. */
const trading212Fetch = ((url: string | URL, init?: RequestInit) => {
  expect(new Headers(init?.headers).get("Authorization")).toBe(`Basic ${Buffer.from("k:s").toString("base64")}`);
  const path = String(url);
  const body = path.includes("/equity/account/summary")
    ? { currency: "EUR", id: 7, totalValue: 1000, cash: { availableToTrade: 400 } }
    : path.includes("/equity/positions")
      ? [{ instrument: { ticker: "AAPL_US_EQ", currency: "EUR" }, quantity: 1, averagePricePaid: 180, walletImpact: { currentValue: 190 } }]
      : { items: [{ order: { ticker: "AAPL_US_EQ", side: "BUY", instrument: { currency: "EUR" } }, fill: { type: "TRADE", quantity: 1, price: 180, filledAt: "2026-09-22T10:00:00Z" } }], nextPagePath: null };
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}) as typeof fetch;

describe("connect()", () => {
  it("fetches a normalized snapshot through an injected fetch", async () => {
    const connection = connect({
      broker: "trading212",
      credentials: { apiKey: "k", apiSecret: "s" },
      fetch: trading212Fetch,
    });
    const snapshot = await connection.fetchSnapshot();
    expect(snapshot.broker).toBe("trading212");
    expect(Date.parse(snapshot.fetchedAt)).not.toBeNaN();
    expect(snapshot.accounts).toEqual([
      {
        id: "trading212-7",
        name: "Trading212",
        currency: "EUR",
        equity: 1000,
        cash: 400,
        environment: "live",
        positions: [{ symbol: "AAPL", quantity: 1, marketValue: 190, averageEntryPrice: 180, assetClass: "equity" }],
        trades: [{ symbol: "AAPL", side: "buy", quantity: 1, price: 180, executedAt: "2026-09-22T10:00:00.000Z" }],
      },
    ]);
  });

  it("throws a typed error before any network call when credentials are missing", async () => {
    const connection = connect({
      broker: "trading212",
      credentials: { apiKey: "", apiSecret: "" },
      fetch: (() => {
        throw new Error("network must not be touched");
      }) as typeof fetch,
    });
    await expect(connection.fetchSnapshot()).rejects.toBeInstanceOf(MissingCredentialsError);
  });
});

describe("createPortfolio()", () => {
  it("collects failures per connection instead of failing the whole fetch", async () => {
    const portfolio = createPortfolio();
    portfolio.add({ broker: "trading212", credentials: { apiKey: "k", apiSecret: "s" }, fetch: trading212Fetch });
    portfolio.add({
      broker: "kraken",
      credentials: { apiKey: "k", apiSecret: Buffer.from("s").toString("base64") },
      label: "Broken Kraken",
      fetch: (() => Promise.resolve(new Response("{}", { status: 403 }))) as typeof fetch,
    });

    const result = await portfolio.fetchAll();
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.broker).toBe("trading212");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ broker: "kraken", label: "Broken Kraken" });
  });
});

describe("listBrokers()", () => {
  it("describes every adapter with credential fields and a read-only setup guide", () => {
    const brokers = listBrokers();
    expect(brokers.length).toBeGreaterThanOrEqual(14);
    for (const broker of brokers) {
      expect(broker.displayName.length).toBeGreaterThan(0);
      expect(broker.readOnlySetup.length).toBeGreaterThan(0);
      expect(Array.isArray(broker.credentials)).toBe(true);
    }
    const trading212 = brokers.find((broker) => broker.id === "trading212");
    expect(trading212?.credentials.map((field) => field.key)).toEqual(["apiKey", "apiSecret", "environment"]);
    const hyperliquid = brokers.find((broker) => broker.id === "hyperliquid");
    expect(hyperliquid?.credentials).toEqual([{ key: "walletAddress", label: "Wallet address (0x…)", secret: false }]);
  });
});
