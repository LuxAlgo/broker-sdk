/*
  The event model. Every sweep of the daemon turns snapshot changes into a
  flat list of these events, delivered to every configured sink as one batch.

  `at` is an ISO 8601 timestamp on every event: for account-level events it
  is the snapshot's `fetchedAt` (so the pure diff stays deterministic); for
  sweep-level events (`broker_error`, `sync_completed`) it is the daemon's
  clock at sweep time.
*/
import type { Position, Trade } from "../index.js";

/** Fields shared by every event scoped to one account at one broker. */
export type AccountEventBase = {
  broker: string;
  accountId: string;
  /** ISO 8601 timestamp. */
  at: string;
};

/** A trade appeared that was not in the previous snapshot. */
export type TradeExecutedEvent = AccountEventBase & {
  type: "trade_executed";
  trade: Trade;
};

/** An account's total equity moved between snapshots. */
export type BalanceChangedEvent = AccountEventBase & {
  type: "balance_changed";
  equity: number;
  previousEquity: number;
  delta: number;
};

/** A position exists now that did not exist in the previous snapshot. */
export type PositionOpenedEvent = AccountEventBase & {
  type: "position_opened";
  position: Position;
};

/** A previously open position is gone. */
export type PositionClosedEvent = AccountEventBase & {
  type: "position_closed";
  symbol: string;
  previousQuantity: number;
};

/** A position's quantity changed (partial fill, add, trim). */
export type PositionChangedEvent = AccountEventBase & {
  type: "position_changed";
  symbol: string;
  quantity: number;
  previousQuantity: number;
};

/** A broker connection failed to fetch during a sweep. */
export type BrokerErrorEvent = {
  type: "broker_error";
  broker: string;
  /** ISO 8601 timestamp. */
  at: string;
  message: string;
};

/** Emitted exactly once per sweep, after every broker was attempted. */
export type SyncCompletedEvent = {
  type: "sync_completed";
  /** ISO 8601 timestamp. */
  at: string;
  /** Broker ids that synced successfully this sweep. */
  brokers: string[];
  failures: { broker: string; message: string }[];
};

export type SyncEvent =
  | TradeExecutedEvent
  | BalanceChangedEvent
  | PositionOpenedEvent
  | PositionClosedEvent
  | PositionChangedEvent
  | BrokerErrorEvent
  | SyncCompletedEvent;

export type SyncEventType = SyncEvent["type"];
