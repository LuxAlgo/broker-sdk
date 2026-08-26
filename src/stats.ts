import type { Account, Position, Trade } from "./schema.js";

/*
  The stats engine: FIFO round-trip matching, win rate, per-symbol activity.
  Everything here is pure and recomputable from account snapshots — stats
  are derived data, never a source of truth. Realized PnL matches sells
  against buys FIFO per symbol; open remainders contribute position size
  but no PnL.
*/

export type SymbolStats = {
  trades: number;
  /** Total traded notional (quantity × price across both sides). */
  notional: number;
  realizedPnl: number;
};

export type TradeStats = {
  count: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  avgPositionSize: number | null;
  realizedPnl: number;
  bySymbol: Record<string, SymbolStats>;
};

export type PortfolioStats = {
  totalEquity: number;
  accountCount: number;
  equityByBroker: Record<string, number>;
  topPositions: { symbol: string; marketValue: number }[];
  trades: TradeStats | null;
};

export type StatsAccount = Pick<Account, "equity" | "positions" | "trades"> & {
  /** Which broker the account came from — feeds equityByBroker. */
  broker?: string;
};

/** FIFO-match sells against prior buys; returns per-round-trip results. */
export const matchRoundTrips = (trades: Trade[]): { pnl: number }[] => {
  const sorted = [...trades].sort((a, b) => (a.executedAt ?? "").localeCompare(b.executedAt ?? ""));
  const openLots = new Map<string, { quantity: number; price: number }[]>();
  const roundTrips: { pnl: number }[] = [];

  for (const trade of sorted) {
    if (trade.side === "buy") {
      const lots = openLots.get(trade.symbol) ?? [];
      lots.push({ quantity: trade.quantity, price: trade.price });
      openLots.set(trade.symbol, lots);
      continue;
    }
    let remaining = trade.quantity;
    const lots = openLots.get(trade.symbol) ?? [];
    while (remaining > 1e-9 && lots.length > 0) {
      const lot = lots[0];
      if (!lot) break;
      const matched = Math.min(remaining, lot.quantity);
      roundTrips.push({ pnl: (trade.price - lot.price) * matched });
      lot.quantity -= matched;
      remaining -= matched;
      if (lot.quantity <= 1e-9) lots.shift();
    }
    // A sell with no matching buy (history starts mid-position) is ignored
    // for PnL rather than guessed at.
  }

  return roundTrips;
};

export const computeTradeStats = (trades: Trade[]): TradeStats | null => {
  if (trades.length === 0) return null;

  const bySymbol: Record<string, SymbolStats> = {};
  let totalNotional = 0;
  for (const trade of trades) {
    const notional = trade.quantity * trade.price;
    totalNotional += notional;
    const entry = (bySymbol[trade.symbol] ??= { trades: 0, notional: 0, realizedPnl: 0 });
    entry.trades += 1;
    entry.notional += notional;
  }

  // Per-symbol realized PnL, then roll the round-trips up for win/loss stats.
  const allRoundTrips: { pnl: number }[] = [];
  for (const symbol of Object.keys(bySymbol)) {
    const symbolTrips = matchRoundTrips(trades.filter((trade) => trade.symbol === symbol));
    const stats = bySymbol[symbol];
    if (stats) stats.realizedPnl = symbolTrips.reduce((sum, trip) => sum + trip.pnl, 0);
    allRoundTrips.push(...symbolTrips);
  }

  const wins = allRoundTrips.filter((trip) => trip.pnl > 0);
  const losses = allRoundTrips.filter((trip) => trip.pnl < 0);
  const closedTrades = allRoundTrips.length;
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

  return {
    count: trades.length,
    closedTrades,
    wins: wins.length,
    losses: losses.length,
    winRate: closedTrades > 0 ? wins.length / closedTrades : null,
    avgWin: wins.length > 0 ? sum(wins.map((trip) => trip.pnl)) / wins.length : null,
    avgLoss: losses.length > 0 ? sum(losses.map((trip) => trip.pnl)) / losses.length : null,
    avgPositionSize: trades.length > 0 ? totalNotional / trades.length : null,
    realizedPnl: sum(allRoundTrips.map((trip) => trip.pnl)),
    bySymbol,
  };
};

/**
 * Aggregate stats across accounts (usually every account from every
 * snapshot in a portfolio). Caller is responsible for currency
 * normalization first when mixing currencies — see `@luxalgo/broker-sdk/fx`.
 */
export const computeStats = (accounts: StatsAccount[]): PortfolioStats => {
  const equityByBroker: Record<string, number> = {};
  const positionValues = new Map<string, number>();
  let totalEquity = 0;

  for (const account of accounts) {
    totalEquity += account.equity;
    const broker = account.broker ?? "unknown";
    equityByBroker[broker] = (equityByBroker[broker] ?? 0) + account.equity;
    for (const position of account.positions) {
      if (position.marketValue !== undefined) {
        positionValues.set(position.symbol, (positionValues.get(position.symbol) ?? 0) + position.marketValue);
      }
    }
  }

  const topPositions = [...positionValues.entries()]
    .map(([symbol, marketValue]) => ({ symbol, marketValue }))
    .sort((a, b) => b.marketValue - a.marketValue)
    .slice(0, 5);

  return {
    totalEquity,
    accountCount: accounts.length,
    equityByBroker,
    topPositions,
    trades: computeTradeStats(accounts.flatMap((account) => account.trades)),
  };
};

/** Net open positions implied by a trade list (statement imports, backtests). */
export const positionsFromTrades = (trades: Trade[]): Position[] => {
  const net = new Map<string, number>();
  for (const trade of trades) {
    net.set(trade.symbol, (net.get(trade.symbol) ?? 0) + (trade.side === "buy" ? trade.quantity : -trade.quantity));
  }
  // Net shorts survive as negative quantities (same convention as live
  // futures positions); only flat symbols drop out.
  return [...net.entries()]
    .filter(([, quantity]) => Math.abs(quantity) > 1e-9)
    .map(([symbol, quantity]) => ({ symbol, quantity }));
};
