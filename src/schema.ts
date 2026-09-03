/**
 * The normalized model. One shape for everything, regardless of broker:
 * accounts (with equity and currency), positions (symbol, quantity, market
 * value), and trades (symbol, side, quantity, price, fee, timestamp).
 *
 * This schema is the contract every adapter — including every
 * community-contributed one — must normalize into, and the conformance
 * vectors in `conformance/vectors/` are its executable specification.
 */

/**
 * Instrument classification, present only when the broker states it or the
 * venue implies it (a Topstep position is always a future). Never guessed.
 */
export type AssetClass = "equity" | "option" | "futures" | "forex" | "crypto" | "cash" | "other";

/** An open position. Negative `quantity` means short. */
export type Position = {
  symbol: string;
  quantity: number;
  /**
   * Market value in the account's `currency`, when the broker can price it.
   * Deliberately optional: a missing value is more honest than a guessed one
   * (e.g. Tradier reports cost basis, not market value — so it stays unset).
   */
  marketValue?: number;
  /** Average entry price per unit in the account's `currency`, when reported. */
  averageEntryPrice?: number;
  assetClass?: AssetClass;
};

/** One executed trade (a fill), always from the account holder's side. */
export type Trade = {
  symbol: string;
  side: "buy" | "sell";
  /** Always positive — `side` carries the direction. */
  quantity: number;
  /** Price per unit in the account's `currency`. */
  price: number;
  /** Commission/fee paid, when the source reports one. */
  fee?: number;
  /** ISO 8601 timestamp, when the source carried one. */
  executedAt?: string;
};

/** One account at a broker, fully normalized. */
export type Account = {
  /**
   * Broker-side stable identifier — safe to use as an upsert key when
   * persisting snapshots across refreshes.
   */
  id: string;
  name: string;
  /** ISO 4217 code that `equity`, `cash`, and position values are stated in. */
  currency: string;
  /** Total account value in `currency`. */
  equity: number;
  /** Cash component of equity, when the broker reports it separately. */
  cash?: number;
  /** Live vs paper/sandbox, when the broker distinguishes (e.g. Alpaca). */
  environment?: "live" | "paper";
  positions: Position[];
  /**
   * Trade history, most recent window the broker exposes. Empty when the
   * broker has no programmatic history endpoint — never fabricated.
   */
  trades: Trade[];
};

/** What one adapter fetch returns: the accounts plus rotation bookkeeping. */
export type NormalizedAccounts = {
  accounts: Account[];
};

/** The SDK-level envelope around a successful fetch. */
export type BrokerSnapshot = {
  broker: string;
  /** ISO 8601 — when this snapshot was fetched. */
  fetchedAt: string;
  accounts: Account[];
};

/** Describes one credential field an adapter needs. */
export type CredentialField = {
  key: string;
  label: string;
  /** True for secrets (API secrets, tokens); false for public identifiers. */
  secret: boolean;
};

/**
 * Bar resolution. Deliberately small: these are the timeframes every
 * bar-capable broker can serve directly, so no adapter ever has to resample.
 */
export type BarTimeframe = "1m" | "5m" | "15m" | "1h" | "1d";

/** One OHLCV bar. `time` is the bar's open, epoch milliseconds UTC. */
export type Bar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Omitted when the venue does not report volume for the bar. */
  volume?: number;
};

/** A request for historical bars of one symbol. */
export type BarsRequest = {
  timeframe: BarTimeframe;
  /** Inclusive window start, epoch milliseconds. Broker default when omitted. */
  from?: number;
  /** Window end, epoch milliseconds. Broker default when omitted. */
  to?: number;
  /**
   * Maximum number of bars; when the window holds more, the most recent
   * `limit` bars are kept. Always capped at `MAX_BARS` regardless.
   */
  limit?: number;
};

/** Hard ceiling on bars returned by one `fetchBars` call, whatever `limit` says. */
export const MAX_BARS = 10_000;
