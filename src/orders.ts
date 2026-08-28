import { connectAlpacaTrading, type AlpacaTradingOptions } from "./orders/alpaca.js";
import { connectBinanceTrading, type BinanceTradingOptions } from "./orders/binance.js";
import { connectTradierTrading, type TradierTradingOptions } from "./orders/tradier.js";
import { BrokerError } from "./errors.js";
import type { TradingConnection } from "./orders/types.js";

/*
  EXPERIMENTAL — the write layer (order placement).

  Safe-environment-first, per broker: Alpaca paper and the Tradier sandbox
  connect without ceremony. A LIVE account connects only when the caller
  passes the exact acknowledgement sentence at construction time — never a
  boolean, never a default, never config inheritance. Full safety posture
  and rollout: docs/orders-rfc.md.

  The read-only guarantee of the rest of the SDK is untouched: nothing in
  `@luxalgo/broker-sdk` (the root export) or the MCP server imports this
  module. Trading exists only for code that explicitly imports
  `@luxalgo/broker-sdk/orders`.
*/

export type {
  Order,
  OrderRequest,
  OrderSide,
  OrderStatus,
  OrderType,
  TimeInForce,
  TradingConnection,
  TradingEnvironment,
} from "./orders/types.js";
export { LiveTradingBlockedError, validateOrderRequest } from "./orders/types.js";
export { LIVE_TRADING_ACKNOWLEDGEMENT, normalizeAlpacaOrder } from "./orders/alpaca.js";
export { normalizeTradierOrder } from "./orders/tradier.js";

export type TradingConnectOptions =
  | ({ broker: "alpaca" } & AlpacaTradingOptions)
  | ({ broker: "binance" } & BinanceTradingOptions)
  | ({ broker: "tradier" } & TradierTradingOptions);

/**
 * Open a trading connection.
 *
 * - `alpaca`: paper keys connect directly; live keys additionally require
 *   `acknowledgeLiveTrading` set to the exact `LIVE_TRADING_ACKNOWLEDGEMENT`
 *   sentence.
 * - `binance`: Spot Testnet only — the connection is pinned to
 *   testnet.binance.vision, so live orders are impossible by construction.
 * - `tradier`: sandbox only — the connection is pinned to the sandbox host,
 *   so live orders are impossible by construction.
 */
export const connectTrading = (options: TradingConnectOptions): TradingConnection => {
  switch (options.broker) {
    case "alpaca":
      return connectAlpacaTrading(options);
    case "binance":
      return connectBinanceTrading(options);
    case "tradier":
      return connectTradierTrading(options);
    default:
      throw new BrokerError(String((options as { broker: string }).broker), "Order placement supports alpaca, binance (Spot Testnet), and tradier (sandbox) so far — see docs/orders-rfc.md for the rollout");
  }
};
