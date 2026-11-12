import { describe, expect, it } from "vitest";

import type { Trade } from "../src/schema.js";
import { computeStats, matchRoundTrips, positionsFromTrades } from "../src/stats.js";

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

  it.each([
    { positionSide: "long", open: "buy", close: "sell", first: 100, second: 200 },
    { positionSide: "short", open: "sell", close: "buy", first: 200, second: 100 },
  ] as const)("close the correct interleaved native $positionSide position", ({ positionSide, open, close, first, second }) => {
    const stats = statsFor([
      trade({ positionId: "A", positionSide, side: open, price: first, executedAt: "2026-01-01" }),
      trade({ positionId: "B", positionSide, side: open, price: second, executedAt: "2026-01-02" }),
      trade({ positionId: "B", positionSide, side: close, price: 150, executedAt: "2026-01-03" }),
    ]);
    expect(stats.trades?.realizedPnl).toBe(-50);
    expect(stats.trades?.losses).toBe(1);
    expect(stats.trades?.bySymbol.BTC?.realizedPnl).toBe(-50);
  });

  it.each([
    [undefined, ""],
    ["", undefined],
    ["01", "1"],
    [" A", "A"],
    ["A\u0000long", "A"],
  ])("keep opaque position IDs %j and %j separate from each other and legacy lots", (first, second) => {
    const a = first === undefined ? {} : { positionId: first };
    const b = second === undefined ? {} : { positionId: second };
    const stats = statsFor([
      trade({ ...a, price: 100, executedAt: "2026-01-01" }),
      trade({ ...b, price: 200, executedAt: "2026-01-02" }),
      trade({ ...b, side: "sell", price: 150, executedAt: "2026-01-03" }),
    ]);
    expect(stats.trades?.realizedPnl).toBe(-50);
  });

  it("match multiple lots FIFO within a native position", () => {
    const trips = matchRoundTrips([
      trade({ positionId: "A", price: 100 }),
      trade({ positionId: "A", price: 200 }),
      trade({ positionId: "A", side: "sell", price: 150, quantity: 1.5 }),
    ]);
    expect(trips).toEqual([{ pnl: 50 }, { pnl: -25 }]);
  });

  it.each([
    { symbol: "ETH", positionSide: "long" },
    { symbol: "BTC", positionSide: "short" },
    { symbol: "BTC\u0000long", positionSide: undefined },
  ] as const)("retain symbol and hedge side in native identity: $symbol / $positionSide", ({ symbol, positionSide }) => {
    const trips = matchRoundTrips([
      trade({ positionId: "A", positionSide: "long", price: 100 }),
      trade({
        positionId: "A", symbol, ...(positionSide === undefined ? {} : { positionSide }),
        side: positionSide === "short" ? "buy" : "sell", price: 150,
      }),
    ]);
    expect(trips).toEqual([]);
  });

  it("keep identical native IDs local to each account when aggregating stats", () => {
    const stats = computeStats([
      { equity: 0, positions: [], trades: [trade({ positionId: "A", price: 100, executedAt: "2026-01-01" })] },
      {
        equity: 0, positions: [], trades: [
          trade({ positionId: "A", price: 200, executedAt: "2026-01-02" }),
          trade({ positionId: "A", side: "sell", price: 150, executedAt: "2026-01-03" }),
        ],
      },
    ]);
    expect(stats.trades?.realizedPnl).toBe(-50);
    expect(stats.trades?.closedTrades).toBe(1);
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

  it("keep hedge-mode sides apart — covering a short never closes the long", () => {
    const stats = statsFor([
      trade({ side: "buy", price: 100, positionSide: "long", executedAt: "2026-01-01T00:00:00Z" }),
      trade({ side: "sell", price: 120, positionSide: "short", executedAt: "2026-01-02T00:00:00Z" }),
      trade({ side: "buy", price: 90, positionSide: "short", executedAt: "2026-01-03T00:00:00Z" }),
      trade({ side: "sell", price: 150, positionSide: "long", executedAt: "2026-01-04T00:00:00Z" }),
    ]);
    // The long closes at 150 against its own 100 entry, and the short sold at
    // 120 is covered at 90: two wins, never one side matched against the other.
    expect(stats.trades?.realizedPnl).toBe(80);
    expect(stats.trades?.wins).toBe(2);
  });

  it("match a hedge-mode short's covers against its own sells", () => {
    const short = (side: "buy" | "sell", price: number, day: number) =>
      trade({ side, price, positionSide: "short", executedAt: `2026-01-0${day}T00:00:00Z` });
    const stats = statsFor([short("sell", 120, 1), short("buy", 90, 2), short("sell", 100, 3), short("buy", 110, 4)]);
    expect(stats.trades?.realizedPnl).toBe(20);
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
