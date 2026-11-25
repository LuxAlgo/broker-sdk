import { describe, expect, it } from "vitest";

import { bitunix, type BitunixRaw } from "../src/adapters/bitunix.js";
import type { BrokerSnapshot } from "../src/index.js";
import { computeStats } from "../src/stats.js";
import { diffSnapshots } from "../src/sync/index.js";

const NOW = Date.UTC(2026, 9, 28, 12);
const account = { marginCoin: "USDT", available: "1000", frozen: "10", margin: "100", crossUnrealizedPNL: "5", isolationUnrealizedPNL: "-2" };
const position = (id: string, side = "BUY", extra: Record<string, unknown> = {}) => ({
  positionId: id, symbol: "BTCUSDT", side, positionMode: "HEDGE", subAccountId: "main-fixture", ...extra,
});
const fill = (id: string, side = "BUY", extra: Record<string, unknown> = {}) => ({
  tradeId: id, orderId: `order-${id}`, symbol: "BTCUSDT", side, positionMode: "HEDGE", qty: "1", price: "100", fee: "0.1", ctime: String(NOW - 1000), reduceOnly: side === "SELL", ...extra,
});
const raw = (extra: Partial<BitunixRaw> = {}): BitunixRaw => ({ account, pendingPositions: [], historyPositions: [], trades: [], positionTrades: [], ...extra });
const snapshot = (payload: BitunixRaw): BrokerSnapshot => ({ broker: "bitunix", fetchedAt: new Date(NOW).toISOString(), accounts: bitunix.normalize(payload) });

describe("Bitunix native position consumers", () => {
  it.each(["HEDGE", "ONE_WAY"])("keeps unchanged and reordered same-side pending %s positions quiet", (positionMode) => {
    const a = position("position-a", "BUY", { positionMode, qty: "1" });
    const b = position("position-b", "BUY", { positionMode, qty: "2" });
    const before = snapshot(raw({ pendingPositions: [a, b] }));

    expect(diffSnapshots(before, snapshot(raw({ pendingPositions: [a, b] })))).toEqual([]);
    expect(diffSnapshots(before, snapshot(raw({ pendingPositions: [b, a] })))).toEqual([]);
  });

  it("carries pending native IDs through opened, changed and closed events", () => {
    const a = position("position-a", "BUY", { qty: "1" });
    const b = position("position-b", "BUY", { qty: "2" });
    const c = position("position-c", "BUY", { qty: "3" });
    const before = snapshot(raw({ pendingPositions: [a, b] }));
    const next = snapshot(raw({ pendingPositions: [{ ...b, qty: "1" }, c] }));

    expect(diffSnapshots(before, next)).toEqual([
      { type: "position_changed", broker: "bitunix", accountId: "bitunix-usdt-futures", at: next.fetchedAt, symbol: "BTCUSDT", positionSide: "long", positionId: "position-b", quantity: 1, previousQuantity: 2 },
      { type: "position_opened", broker: "bitunix", accountId: "bitunix-usdt-futures", at: next.fetchedAt, position: { symbol: "BTCUSDT", quantity: 3, assetClass: "futures", positionSide: "long", positionId: "position-c" } },
      { type: "position_closed", broker: "bitunix", accountId: "bitunix-usdt-futures", at: next.fetchedAt, symbol: "BTCUSDT", positionSide: "long", positionId: "position-a", previousQuantity: 1 },
    ]);
  });

  it("matches an interleaved close to its native opening for SDK stats", () => {
    const a = fill("a-open", "BUY", { ctime: String(NOW - 2000) });
    const b = fill("b-open", "BUY", { price: "200" });
    const close = fill("b-close", "SELL", { price: "150", ctime: String(NOW) });
    const accounts = bitunix.normalize(raw({
      historyPositions: [position("position-a"), position("position-b")],
      trades: [a, b, close],
      positionTrades: [{ positionId: "position-a", trades: [a] }, { positionId: "position-b", trades: [b, close] }],
    }));

    expect(computeStats(accounts).trades).toMatchObject({ count: 3, closedTrades: 1, realizedPnl: -50, wins: 0, losses: 1, bySymbol: { BTCUSDT: { realizedPnl: -50 } } });
  });

  it("emits only the new native position's fill when execution facts and timestamps match", () => {
    const a = fill("a-open"); const b = fill("b-open");
    const before = snapshot(raw({ historyPositions: [position("position-a")], trades: [a], positionTrades: [{ positionId: "position-a", trades: [a] }] }));
    const next = snapshot(raw({
      historyPositions: [position("position-a"), position("position-b")], trades: [b, a],
      positionTrades: [{ positionId: "position-a", trades: [a] }, { positionId: "position-b", trades: [b] }],
    }));

    expect(diffSnapshots(before, next)).toEqual([
      { type: "trade_executed", broker: "bitunix", accountId: "bitunix-usdt-futures", at: next.fetchedAt, trade: { symbol: "BTCUSDT", side: "buy", quantity: 1, price: 100, fee: 0.1, executedAt: new Date(NOW - 1000).toISOString(), assetClass: "futures", positionSide: "long", positionEffect: "open", positionId: "position-b" } },
    ]);
  });
});
