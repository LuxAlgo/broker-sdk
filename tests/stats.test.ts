import { describe, expect, it } from "vitest";

import type { Trade } from "../src/schema.js";
import { computeStats, positionsFromTrades } from "../src/stats.js";

const trade = (overrides: Partial<Trade>): Trade => ({
  symbol: "BTC",
  side: "buy",
  quantity: 1,
  price: 100,
  ...overrides,
});

const statsFor = (trades: Trade[]) => computeStats([{ broker: "csv", equity: 0, positions: [], trades }]);

describe("the trading stats derived from trades", () => {
  it("count a completed buy-then-sell round trip as one win when it closed higher", () => {
    const stats = statsFor([
      trade({ side: "buy", price: 100, executedAt: "2026-01-01T00:00:00Z" }),
      trade({ side: "sell", price: 150, executedAt: "2026-01-02T00:00:00Z" }),
    ]);
    expect(stats.trades?.wins).toBe(1);
    expect(stats.trades?.losses).toBe(0);
    expect(stats.trades?.realizedPnl).toBe(50);
    expect(stats.trades?.winRate).toBe(1);
  });

  it("match sells against the earliest open buys first", () => {
    // Buy at 100, buy at 200, sell one at 150: FIFO closes the 100 lot for +50.
    const stats = statsFor([
      trade({ side: "buy", price: 100, executedAt: "2026-01-01T00:00:00Z" }),
      trade({ side: "buy", price: 200, executedAt: "2026-01-02T00:00:00Z" }),
      trade({ side: "sell", price: 150, executedAt: "2026-01-03T00:00:00Z" }),
    ]);
    expect(stats.trades?.realizedPnl).toBe(50);
    expect(stats.trades?.wins).toBe(1);
  });

  it("never invent profit for a sell with no recorded buy", () => {
    const stats = statsFor([trade({ side: "sell", price: 500, executedAt: "2026-01-01T00:00:00Z" })]);
    expect(stats.trades?.realizedPnl).toBe(0);
    expect(stats.trades?.closedTrades).toBe(0);
  });

  it("keep symbols separate — a win on one symbol never offsets another's loss", () => {
    const stats = statsFor([
      trade({ symbol: "BTC", side: "buy", price: 100, executedAt: "2026-01-01T00:00:00Z" }),
      trade({ symbol: "BTC", side: "sell", price: 200, executedAt: "2026-01-02T00:00:00Z" }),
      trade({ symbol: "ETH", side: "buy", price: 100, executedAt: "2026-01-01T00:00:00Z" }),
      trade({ symbol: "ETH", side: "sell", price: 40, executedAt: "2026-01-02T00:00:00Z" }),
    ]);
    expect(stats.trades?.bySymbol.BTC?.realizedPnl).toBe(100);
    expect(stats.trades?.bySymbol.ETH?.realizedPnl).toBe(-60);
    expect(stats.trades?.wins).toBe(1);
    expect(stats.trades?.losses).toBe(1);
  });

  it("aggregate equity by broker across accounts", () => {
    const stats = computeStats([
      { broker: "kraken", equity: 100, positions: [], trades: [] },
      { broker: "kraken", equity: 50, positions: [], trades: [] },
      { broker: "alpaca", equity: 200, positions: [{ symbol: "AAPL", quantity: 1, marketValue: 190 }], trades: [] },
    ]);
    expect(stats.totalEquity).toBe(350);
    expect(stats.equityByBroker).toEqual({ kraken: 150, alpaca: 200 });
    expect(stats.topPositions).toEqual([{ symbol: "AAPL", marketValue: 190 }]);
    expect(stats.trades).toBeNull();
  });
});

describe("positions derived from a trade list", () => {
  it("net buys against sells and drop flat symbols", () => {
    const positions = positionsFromTrades([
      trade({ symbol: "AAPL", side: "buy", quantity: 10 }),
      trade({ symbol: "AAPL", side: "sell", quantity: 4 }),
      trade({ symbol: "MSFT", side: "buy", quantity: 2 }),
      trade({ symbol: "MSFT", side: "sell", quantity: 2 }),
    ]);
    expect(positions).toEqual([{ symbol: "AAPL", quantity: 6 }]);
  });

  it("keep a net-short position visible as a negative quantity instead of dropping it", () => {
    const positions = positionsFromTrades([
      { symbol: "TSLA", side: "sell", quantity: 10, price: 250 },
      { symbol: "TSLA", side: "buy", quantity: 4, price: 240 },
      { symbol: "AAPL", side: "buy", quantity: 5, price: 180 },
      { symbol: "AAPL", side: "sell", quantity: 5, price: 185 },
    ]);
    expect(positions).toContainEqual({ symbol: "TSLA", quantity: -6 });
    expect(positions.find((position) => position.symbol === "AAPL")).toBeUndefined();
  });
});
