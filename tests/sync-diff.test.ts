import { describe, expect, it } from "vitest";
import { diffSnapshots, tradeKey } from "../src/sync/diff.js";
import type {
  BalanceChangedEvent,
  PositionChangedEvent,
  PositionClosedEvent,
  PositionOpenedEvent,
  TradeExecutedEvent,
} from "../src/sync/events.js";
import { makeAccount, makePosition, makeSnapshot, makeTrade } from "./sync-helpers.js";

describe("tradeKey", () => {
  it("prefers native fill IDs even when timestamp formatting or other fields change", () => {
    expect(tradeKey(makeTrade({ executionId: "synthetic-1" }))).toBe("id:synthetic-1");
    expect(tradeKey(makeTrade({ executionId: "synthetic-1", price: 201 }))).toBe("id:synthetic-1");
    expect(tradeKey(makeTrade({ executionId: "synthetic-2" }))).not.toBe("id:synthetic-1");
  });

  it("keys on symbol, side, quantity, price, and executedAt", () => {
    const trade = makeTrade();
    expect(tradeKey(trade)).toBe("AAPL|buy|10|200|2026-08-28T10:00:00.000Z");
  });

  it("distinguishes trades that differ in any field", () => {
    const base = makeTrade();
    expect(tradeKey(base)).not.toBe(tradeKey(makeTrade({ symbol: "MSFT" })));
    expect(tradeKey(base)).not.toBe(tradeKey(makeTrade({ side: "sell" })));
    expect(tradeKey(base)).not.toBe(tradeKey(makeTrade({ quantity: 11 })));
    expect(tradeKey(base)).not.toBe(tradeKey(makeTrade({ price: 201 })));
    expect(tradeKey(base)).not.toBe(tradeKey(makeTrade({ executedAt: "2026-08-28T11:00:00.000Z" })));
  });

  it("tolerates a missing executedAt", () => {
    const trade = makeTrade();
    delete trade.executedAt;
    expect(tradeKey(trade)).toBe("AAPL|buy|10|200|");
  });
});

describe("diffSnapshots", () => {
  const topstepSnapshot = (trades: ReturnType<typeof makeTrade>[]) => makeSnapshot({
    broker: "topstep",
    accounts: [makeAccount({ trades })],
  });

  it("does not replay an unchanged Topstep fill when upgrading a millisecond-only snapshot", () => {
    const oldFill = makeTrade({ executedAt: "2026-10-06T14:45:36.246Z" });
    const preciseFill = { ...oldFill, executionId: "100", instrumentId: "CON.F.US.EP.U26",
      executedAt: "2026-10-06T14:45:36.246377Z" };
    const upgraded = topstepSnapshot([preciseFill]);
    expect(diffSnapshots(topstepSnapshot([oldFill]), upgraded)).toEqual([]);
    expect(diffSnapshots(upgraded, upgraded)).toEqual([]);
  });

  it("preserves occurrence counts during the precision/identity transition", () => {
    const oldFill = makeTrade({ executedAt: "2026-10-06T14:45:36.246Z" });
    const fills = ["100", "101", "102"].map((executionId) => ({
      ...oldFill, executionId, instrumentId: "CON.F.US.EP.U26", executedAt: "2026-10-06T14:45:36.246377Z",
    }));
    const events = diffSnapshots(topstepSnapshot([oldFill, { ...oldFill }]), topstepSnapshot(fills));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "trade_executed", trade: { executionId: "102" } });
  });

  it("reserves exact matches before consuming coarse legacy occurrences", () => {
    const oldFill = makeTrade({ executedAt: "2026-10-06T14:45:36.246Z" });
    const newFill = { ...oldFill, executionId: "new", instrumentId: "CON.F.US.EP.U26",
      executedAt: "2026-10-06T14:45:36.246377Z" };
    const events = diffSnapshots(topstepSnapshot([oldFill]), topstepSnapshot([newFill, oldFill]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "trade_executed", trade: { executionId: "new" } });
  });

  it("does not merge different native IDs within the same millisecond", () => {
    const base = makeTrade({ instrumentId: "CON.F.US.EP.U26", executedAt: "2026-10-06T14:45:36.246377Z" });
    const first = { ...base, executionId: "100" };
    const second = { ...base, executionId: "101" };
    const events = diffSnapshots(topstepSnapshot([first]), topstepSnapshot([second]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "trade_executed", trade: { executionId: "101" } });
  });

  it("does not match IDs across accounts", () => {
    const fill = makeTrade({ executionId: "100" });
    const previous = makeSnapshot({ accounts: [
      makeAccount({ id: "one", trades: [fill] }), makeAccount({ id: "two" }),
    ] });
    const next = makeSnapshot({ accounts: [
      makeAccount({ id: "one", trades: [fill] }), makeAccount({ id: "two", trades: [fill] }),
    ] });
    expect(diffSnapshots(previous, next)).toEqual([
      expect.objectContaining({ type: "trade_executed", accountId: "two" }),
    ]);
  });

  it("limits the coarse transition fallback to Topstep", () => {
    const previous = makeSnapshot({ accounts: [makeAccount({ trades: [makeTrade()] })] });
    const next = makeSnapshot({ accounts: [makeAccount({ trades: [makeTrade({ executionId: "100" })] })] });
    expect(diffSnapshots(previous, next)).toHaveLength(1);
  });

  it("emits nothing for the first-ever snapshot (baseline only)", () => {
    const next = makeSnapshot({
      accounts: [
        makeAccount({
          equity: 55_000,
          positions: [makePosition()],
          trades: [makeTrade(), makeTrade({ symbol: "MSFT" })],
        }),
      ],
    });
    expect(diffSnapshots(undefined, next)).toEqual([]);
  });

  it("emits nothing when nothing changed", () => {
    const snapshot = makeSnapshot({
      accounts: [makeAccount({ positions: [makePosition()], trades: [makeTrade()] })],
    });
    const again = makeSnapshot({
      fetchedAt: "2026-08-28T12:05:00.000Z",
      accounts: [makeAccount({ positions: [makePosition()], trades: [makeTrade()] })],
    });
    expect(diffSnapshots(snapshot, again)).toEqual([]);
  });

  it("emits trade_executed for trades that were not in the previous snapshot", () => {
    const previous = makeSnapshot({ accounts: [makeAccount({ trades: [makeTrade()] })] });
    const newTrade = makeTrade({ symbol: "MSFT", side: "sell", quantity: 3, price: 410 });
    const next = makeSnapshot({
      fetchedAt: "2026-08-28T12:05:00.000Z",
      accounts: [makeAccount({ trades: [makeTrade(), newTrade] })],
    });

    const events = diffSnapshots(previous, next) as TradeExecutedEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "trade_executed",
      broker: "alpaca",
      accountId: "acct-1",
      at: "2026-08-28T12:05:00.000Z",
      trade: newTrade,
    });
  });

  it("does not re-emit trades already seen in the previous snapshot", () => {
    const trades = [makeTrade(), makeTrade({ symbol: "MSFT" })];
    const previous = makeSnapshot({ accounts: [makeAccount({ trades })] });
    const next = makeSnapshot({
      fetchedAt: "2026-08-28T12:05:00.000Z",
      accounts: [makeAccount({ trades })],
    });
    expect(diffSnapshots(previous, next)).toEqual([]);
  });

  it("counts occurrences so duplicate identical fills are detected", () => {
    const fill = makeTrade();
    const previous = makeSnapshot({ accounts: [makeAccount({ trades: [fill] })] });
    const next = makeSnapshot({
      fetchedAt: "2026-08-28T12:05:00.000Z",
      accounts: [makeAccount({ trades: [fill, { ...fill }] })],
    });

    const events = diffSnapshots(previous, next);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("trade_executed");
  });

  it("emits balance_changed with the delta when equity moves", () => {
    const previous = makeSnapshot({ accounts: [makeAccount({ equity: 10_000 })] });
    const next = makeSnapshot({
      fetchedAt: "2026-08-28T12:05:00.000Z",
      accounts: [makeAccount({ equity: 10_250.5 })],
    });

    const events = diffSnapshots(previous, next) as BalanceChangedEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "balance_changed",
      broker: "alpaca",
      accountId: "acct-1",
      at: "2026-08-28T12:05:00.000Z",
      equity: 10_250.5,
      previousEquity: 10_000,
      delta: 250.5,
    });
  });

  it("emits a negative delta when equity drops", () => {
    const previous = makeSnapshot({ accounts: [makeAccount({ equity: 10_000 })] });
    const next = makeSnapshot({ accounts: [makeAccount({ equity: 9_400 })] });

    const events = diffSnapshots(previous, next) as BalanceChangedEvent[];
    expect(events[0]?.delta).toBe(-600);
  });

  it("emits no balance event when equity is unchanged", () => {
    const previous = makeSnapshot({ accounts: [makeAccount({ equity: 10_000 })] });
    const next = makeSnapshot({ accounts: [makeAccount({ equity: 10_000 })] });
    expect(diffSnapshots(previous, next)).toEqual([]);
  });

  it("emits position_opened for a brand new position", () => {
    const previous = makeSnapshot({ accounts: [makeAccount({ positions: [] })] });
    const position = makePosition({ symbol: "TSLA", quantity: 5, marketValue: 1_500 });
    const next = makeSnapshot({
      fetchedAt: "2026-08-28T12:05:00.000Z",
      accounts: [makeAccount({ positions: [position] })],
    });

    const events = diffSnapshots(previous, next) as PositionOpenedEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "position_opened",
      broker: "alpaca",
      accountId: "acct-1",
      at: "2026-08-28T12:05:00.000Z",
      position,
    });
  });

  it("emits position_closed with previousQuantity when a position disappears", () => {
    const previous = makeSnapshot({
      accounts: [makeAccount({ positions: [makePosition({ symbol: "TSLA", quantity: -5 })] })],
    });
    const next = makeSnapshot({
      fetchedAt: "2026-08-28T12:05:00.000Z",
      accounts: [makeAccount({ positions: [] })],
    });

    const events = diffSnapshots(previous, next) as PositionClosedEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "position_closed",
      broker: "alpaca",
      accountId: "acct-1",
      at: "2026-08-28T12:05:00.000Z",
      symbol: "TSLA",
      previousQuantity: -5,
    });
  });

  it("emits position_changed when quantity moves", () => {
    const previous = makeSnapshot({ accounts: [makeAccount({ positions: [makePosition({ quantity: 10 })] })] });
    const next = makeSnapshot({
      fetchedAt: "2026-08-28T12:05:00.000Z",
      accounts: [makeAccount({ positions: [makePosition({ quantity: 4 })] })],
    });

    const events = diffSnapshots(previous, next) as PositionChangedEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "position_changed",
      broker: "alpaca",
      accountId: "acct-1",
      at: "2026-08-28T12:05:00.000Z",
      symbol: "AAPL",
      quantity: 4,
      previousQuantity: 10,
    });
  });

  it("emits nothing for a position whose quantity is unchanged (even if value moved)", () => {
    const previous = makeSnapshot({
      accounts: [makeAccount({ positions: [makePosition({ quantity: 10, marketValue: 2_000 })] })],
    });
    const next = makeSnapshot({
      accounts: [makeAccount({ positions: [makePosition({ quantity: 10, marketValue: 2_100 })] })],
    });
    expect(diffSnapshots(previous, next)).toEqual([]);
  });

  it("treats an account seen for the first time as baseline only", () => {
    const previous = makeSnapshot({ accounts: [makeAccount()] });
    const newAccount = makeAccount({
      id: "acct-2",
      equity: 99_999,
      positions: [makePosition({ symbol: "BTC" })],
      trades: [makeTrade({ symbol: "BTC" })],
    });
    const next = makeSnapshot({ accounts: [makeAccount(), newAccount] });
    expect(diffSnapshots(previous, next)).toEqual([]);
  });

  it("diffs multiple accounts independently", () => {
    const previous = makeSnapshot({
      accounts: [makeAccount({ id: "a", equity: 100 }), makeAccount({ id: "b", equity: 200 })],
    });
    const next = makeSnapshot({
      accounts: [makeAccount({ id: "a", equity: 150 }), makeAccount({ id: "b", equity: 200 })],
    });

    const events = diffSnapshots(previous, next) as BalanceChangedEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]?.accountId).toBe("a");
  });

  it("stamps every event with the next snapshot's fetchedAt", () => {
    const previous = makeSnapshot({
      accounts: [makeAccount({ equity: 100, positions: [makePosition()], trades: [] })],
    });
    const next = makeSnapshot({
      fetchedAt: "2026-08-28T18:30:00.000Z",
      accounts: [
        makeAccount({
          equity: 120,
          positions: [makePosition({ symbol: "TSLA" })],
          trades: [makeTrade({ symbol: "TSLA", quantity: 1 })],
        }),
      ],
    });

    const events = diffSnapshots(previous, next);
    expect(events.length).toBeGreaterThanOrEqual(4); // trade, balance, opened, closed
    for (const event of events) {
      expect("at" in event && event.at).toBe("2026-08-28T18:30:00.000Z");
    }
  });
});
