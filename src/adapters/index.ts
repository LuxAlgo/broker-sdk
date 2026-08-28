import { alpaca } from "./alpaca.js";
import { binance } from "./binance.js";
import { bybit } from "./bybit.js";
import { coinbase } from "./coinbase.js";
import { cryptoCom } from "./crypto-com.js";
import { etrade } from "./etrade.js";
import { gemini } from "./gemini.js";
import { hyperliquid } from "./hyperliquid.js";
import { ibkrFlex } from "./ibkr-flex.js";
import { kraken } from "./kraken.js";
import { kucoin } from "./kucoin.js";
import { okx } from "./okx.js";
import { publicDotCom } from "./public.js";
import { questrade } from "./questrade.js";
import { robinhoodCrypto } from "./robinhood-crypto.js";
import { schwab } from "./schwab.js";
import { tastytrade } from "./tastytrade.js";
import { topstep } from "./topstep.js";
import { tradestation } from "./tradestation.js";
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
export { gemini, type GeminiRaw } from "./gemini.js";
export { kraken, normalizeKrakenAsset, type KrakenRaw } from "./kraken.js";
export { kucoin, type KucoinRaw } from "./kucoin.js";
export { okx, type OkxRaw } from "./okx.js";
export { publicDotCom, parsePublicHistory, type PublicRaw, type PublicTransaction } from "./public.js";
export { questrade, parseQuestradeActivities, type QuestradeRaw } from "./questrade.js";
export { robinhoodCrypto, type RobinhoodCryptoRaw } from "./robinhood-crypto.js";
export {
  schwab,
  buildSchwabAuthorizeUrl,
  exchangeSchwabCode,
  parseSchwabTransactions,
  type SchwabRaw,
} from "./schwab.js";
export { tastytrade, type TastytradeRaw } from "./tastytrade.js";
export { topstep, parseTopstepTrades, topstepSymbol, type TopstepRaw } from "./topstep.js";
export { tradestation, type TradestationRaw } from "./tradestation.js";
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
  gemini,
  hyperliquid,
  "ibkr-flex": ibkrFlex,
  kraken,
  kucoin,
  okx,
  public: publicDotCom,
  questrade,
  "robinhood-crypto": robinhoodCrypto,
  schwab,
  tastytrade,
  topstep,
  tradestation,
  tradier,
  trading212,
  webull,
} satisfies Record<string, AnyBrokerAdapter>;

export type BrokerId = keyof typeof adapters;

export const getAdapter = (id: string): AnyBrokerAdapter | null =>
  (adapters as Record<string, AnyBrokerAdapter>)[id] ?? null;
