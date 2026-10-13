/*
  The pure diff engine: previous snapshot vs next snapshot for one broker,
  out come events. No IO, no clock — `at` on every emitted event is the next
  snapshot's `fetchedAt`, so the same inputs always produce the same output.

  A first-ever snapshot (previous === undefined) emits NOTHING: it only
  establishes the baseline, so a fresh install never replays history as
  events. The same rule applies to an account seen for the first time inside
  an already-known broker snapshot.
*/
import type { BrokerSnapshot, Trade } from "../index.js";
import { asPreciseIsoTimestamp } from "../timestamps.js";
import type { SyncEvent } from "./events.js";

/**
 * Prefer account-scoped native fill identity; otherwise use the original
 * symbol/side/quantity/price/timestamp tuple. Occurrence counting preserves
 * duplicate fills even when a provider supplies no unique ID.
 */
export const tradeKey = (trade: Trade): string =>
  trade.executionId ? `id:${trade.executionId}` : legacyTradeKey(trade);

const legacyTradeKey = (trade: Trade, timestamp = trade.executedAt ?? ""): string =>
  [trade.symbol, trade.side, String(trade.quantity), String(trade.price), timestamp].join("|");

const millisecondTradeKey = (trade: Trade): string => {
  const timestamp = asPreciseIsoTimestamp(trade.executedAt) ?? trade.executedAt ?? "";
  return legacyTradeKey(trade, timestamp.replace(/(\.\d{3})\d+Z$/, "$1Z"));
};

/**
 * Diff two snapshots of the same broker into events. Accounts are matched
 * by their broker-side stable `id`, positions by `symbol`, trades by
 * `tradeKey` occurrence counting.
 */
export const diffSnapshots = (previous: BrokerSnapshot | undefined, next: BrokerSnapshot): SyncEvent[] => {
  if (!previous) return [];

  const events: SyncEvent[] = [];
  const at = next.fetchedAt;
  const broker = next.broker;
  const previousAccounts = new Map(previous.accounts.map((account) => [account.id, account]));

  for (const account of next.accounts) {
    const before = previousAccounts.get(account.id);
    if (!before) continue; // first sighting of this account: baseline only

    const accountId = account.id;

    // Trades: anything in `next` not matched by a remaining occurrence in
    // `previous` is new. Occurrence counting keeps duplicate identical
    // fills honest in both directions.
    const remaining = new Map<string, Trade[]>();
    for (const trade of before.trades) {
      const key = tradeKey(trade);
      const fills = remaining.get(key) ?? [];
      fills.push(trade);
      remaining.set(key, fills);
    }
    // Reserve exact matches first so a coarse legacy match cannot steal one.
    const unmatched: Trade[] = [];
    for (const trade of account.trades) {
      const fills = remaining.get(tradeKey(trade));
      if (fills && fills.length > 0) {
        fills.pop();
      } else {
        unmatched.push(trade);
      }
    }
    const legacy = new Map<string, number>();
    if (broker === "topstep") {
      for (const fills of remaining.values()) {
        for (const trade of fills) {
          // Pre-upgrade snapshots had neither native identity nor full contracts.
          if (trade.executionId || trade.instrumentId) continue;
          const key = millisecondTradeKey(trade);
          legacy.set(key, (legacy.get(key) ?? 0) + 1);
        }
      }
    }
    for (const trade of unmatched) {
      const key = millisecondTradeKey(trade);
      const count = legacy.get(key) ?? 0;
      if (count > 0) legacy.set(key, count - 1);
      else events.push({ type: "trade_executed", broker, accountId, at, trade });
    }

    // Balance.
    if (account.equity !== before.equity) {
      events.push({
        type: "balance_changed",
        broker,
        accountId,
        at,
        equity: account.equity,
        previousEquity: before.equity,
        delta: account.equity - before.equity,
      });
    }

    // Positions, keyed by symbol.
    const beforePositions = new Map(before.positions.map((position) => [position.symbol, position]));
    for (const position of account.positions) {
      const previousPosition = beforePositions.get(position.symbol);
      if (!previousPosition) {
        events.push({ type: "position_opened", broker, accountId, at, position });
        continue;
      }
      beforePositions.delete(position.symbol);
      if (previousPosition.quantity !== position.quantity) {
        events.push({
          type: "position_changed",
          broker,
          accountId,
          at,
          symbol: position.symbol,
          quantity: position.quantity,
          previousQuantity: previousPosition.quantity,
        });
      }
    }
    for (const [symbol, previousPosition] of beforePositions) {
      events.push({
        type: "position_closed",
        broker,
        accountId,
        at,
        symbol,
        previousQuantity: previousPosition.quantity,
      });
    }
  }

  return events;
};
