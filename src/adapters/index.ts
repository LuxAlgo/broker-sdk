import { alpaca } from "./alpaca.js";
import { binance } from "./binance.js";
import { bybit } from "./bybit.js";
import { coinbase } from "./coinbase.js";
import { cryptoCom } from "./crypto-com.js";
import { etrade } from "./etrade.js";
import { hyperliquid } from "./hyperliquid.js";
import { ibkrFlex } from "./ibkr-flex.js";
import { kraken } from "./kraken.js";
import { okx } from "./okx.js";
import { publicDotCom } from "./public.js";
import { questrade } from "./questrade.js";
import { topstep } from "./topstep.js";
import { tradier } from "./tradier.js";
import { trading212 } from "./trading212.js";
import { webull } from "./webull.js";
import type { BrokerAdapter } from "./types.js";

export type { BrokerAdapter, Credentials, FetchContext, AdapterFetchResult } from "./types.js";
export { alpaca, alpacaHostForKey, parseAlpacaFills, type AlpacaRaw } from "./alpaca.js";
export { binance, type BinanceRaw } from "./binance.js";
export { bybit, type BybitRaw } from "./bybit.js";
export {
  coinbase,
  buildCoinbaseAuthorizeUrl,
  exchangeCoinbaseCode,
  type CoinbaseRaw,
} from "./coinbase.js";
export { cryptoCom, cryptoComParamsString, type CryptoComRaw } from "./crypto-com.js";
export {
  etrade,
  createEtradeOAuthFlow,
  oauth1Signature,
  oauth1SignatureBase,
  parseEtradeTransactions,
  parseFormBody,
  type EtradeRaw,
  type EtradeTransaction,
} from "./etrade.js";
export { hyperliquid, parseHyperliquidFills, type HyperliquidRaw } from "./hyperliquid.js";
export { ibkrFlex, parseFlexStatement, type IbkrFlexRaw, type ParsedFlexStatement } from "./ibkr-flex.js";
export { kraken, normalizeKrakenAsset, type KrakenRaw } from "./kraken.js";
export { okx, type OkxRaw } from "./okx.js";
export { publicDotCom, parsePublicHistory, type PublicRaw, type PublicTransaction } from "./public.js";
export { questrade, parseQuestradeActivities, type QuestradeRaw } from "./questrade.js";
export { topstep, parseTopstepTrades, topstepSymbol, type TopstepRaw } from "./topstep.js";
export { tradier, parseTradierHistory, tradierList, type TradierRaw } from "./tradier.js";
export { trading212, trading212Symbol, type Trading212Raw } from "./trading212.js";
export { webull, buildWebullStringToSign, webullListIn, type WebullRaw } from "./webull.js";

/** An adapter with its raw type erased — what registry lookups return. */
export type AnyBrokerAdapter = BrokerAdapter<any>;

/**
 * Every live adapter by id. The CSV statement importer is deliberately
 * absent — it is a one-shot parser (`@luxalgo/broker-sdk/csv`), not a
 * refreshable connection.
 */
export const adapters = {
  alpaca,
  binance,
  bybit,
  coinbase,
  "crypto-com": cryptoCom,
  etrade,
  hyperliquid,
  "ibkr-flex": ibkrFlex,
  kraken,
  okx,
  public: publicDotCom,
  questrade,
  topstep,
  tradier,
  trading212,
  webull,
} satisfies Record<string, AnyBrokerAdapter>;

export type BrokerId = keyof typeof adapters;

export const getAdapter = (id: string): AnyBrokerAdapter | null =>
  (adapters as Record<string, AnyBrokerAdapter>)[id] ?? null;
