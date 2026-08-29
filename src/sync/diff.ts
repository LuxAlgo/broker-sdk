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
import type { SyncEvent } from "./events.js";

/**
 * Identity of one trade for diffing: symbol + side + quantity + price +
 * executedAt. Two fills identical on all five fields collide, so the diff
 * counts occurrences per key instead of assuming keys are unique.
 */
export const tradeKey = (trade: Trade): string =>
  [trade.symbol, trade.side, String(trade.quantity), String(trade.price), trade.executedAt ?? ""].join("|");

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
    const remaining = new Map<string, number>();
    for (const trade of before.trades) {
      const key = tradeKey(trade);
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    for (const trade of account.trades) {
      const key = tradeKey(trade);
      const count = remaining.get(key) ?? 0;
      if (count > 0) {
        remaining.set(key, count - 1);
      } else {
        events.push({ type: "trade_executed", broker, accountId, at, trade });
      }
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
