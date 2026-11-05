import { createHash, createHmac } from "node:crypto";

import { BrokerRequestError, MissingCredentialsError } from "../errors.js";
import type { Account, Position } from "../schema.js";
import { asFiniteNumber, rejectResponse } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  Kraken, read-only API key + secret (key created with only "Query Funds"
  permission). One signed Balance call; valuation via the public Ticker
  endpoint for the assets held. Kraken's legacy asset codes (XXBT, ZUSD, …)
  are normalized before display.

  The signed call is exported (`krakenPrivate`) so that an app signing the
  same key for anything else (a WebSocket token, an order read) signs it the
  one way and draws its nonces from the one clock: Kraken takes a nonce per
  key that only ever climbs, so two signers of one key must agree.
*/

const KRAKEN_API = "https://api.kraken.com";

const KRAKEN_ASSET_ALIASES: Record<string, string> = {
  XXBT: "BTC",
  XBT: "BTC",
  XETH: "ETH",
  XXRP: "XRP",
  XXLM: "XLM",
  XLTC: "LTC",
  ZUSD: "USD",
  ZEUR: "EUR",
  ZGBP: "GBP",
};

export const normalizeKrakenAsset = (code: string): string => KRAKEN_ASSET_ALIASES[code] ?? code;

const KRAKEN_FIAT = new Set(["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF"]);

/** API-Sign: HMAC-SHA512 of the path and SHA256(nonce + POST data), keyed by the base64-decoded secret. */
export const signKrakenRequest = (path: string, nonce: string, postData: string, apiSecret: string): string => {
  const message = createHash("sha256")
    .update(nonce + postData)
    .digest();
  return createHmac("sha512", Buffer.from(apiSecret, "base64"))
    .update(Buffer.concat([Buffer.from(path, "utf8"), message]))
    .digest("base64");
};

// Kraken takes a nonce per key that only ever climbs: the millisecond clock, one step past the last nonce
// sent from this process when two calls land in one millisecond. (Two processes signing one key can still
// cross; Kraken's "Invalid nonce" is then the word, and the call is simply made again.)
let lastNonce = 0;
export const nextKrakenNonce = (): string => {
  lastNonce = Math.max(Date.now(), lastNonce + 1);
  return String(lastNonce);
};

/** Kraken's no, in its own words (`EAPI:Invalid key`, `EGeneral:Permission denied`, `EAPI:Invalid nonce`), kept whole. */
export class KrakenApiError extends BrokerRequestError {
  constructor(readonly errors: string[]) {
    super("kraken", `Kraken error: ${errors.join(", ")}`);
    this.name = "KrakenApiError";
  }
}

/**
 * One signed call to a Kraken private endpoint (`Balance`, `GetWebSocketsToken`, `OpenOrders`, …), answered
 * with its result. Kraken's no is a KrakenApiError; rejected credentials and any other refused request are the
 * SDK's usual errors; a dropped call throws as fetch does.
 */
export const krakenPrivate = async <T>(
  credentials: { apiKey: string; apiSecret: string },
  endpoint: string,
  body: Record<string, string> = {},
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<T> => {
  const path = `/0/private/${endpoint}`;
  const nonce = nextKrakenNonce();
  const postData = new URLSearchParams({ nonce, ...body }).toString();
  const response = await fetchImpl(`${KRAKEN_API}${path}`, {
    method: "POST",
    headers: {
      "API-Key": credentials.apiKey,
      "API-Sign": signKrakenRequest(path, nonce, postData, credentials.apiSecret),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: postData,
  });
  if (!response.ok) rejectResponse("kraken", "Kraken", response);
  const answer = (await response.json()) as { error?: string[]; result?: T };
  if (answer.error && answer.error.length > 0) throw new KrakenApiError(answer.error);
  if (answer.result === undefined) throw new BrokerRequestError("kraken", "Kraken answered without a result");
  return answer.result;
};

export type KrakenRaw = {
  /** /0/private/Balance result: legacy asset code → amount string. */
  balances: Record<string, string>;
  /** Public ticker last prices by normalized asset (e.g. BTC → 64000). */
  usdPrices: Record<string, number>;
};

const normalize = (raw: KrakenRaw): Account[] => {
  const entries = Object.entries(raw.balances)
    .map(([code, amount]) => ({ symbol: normalizeKrakenAsset(code), quantity: asFiniteNumber(amount) }))
    .filter((entry): entry is { symbol: string; quantity: number } => entry.quantity !== undefined && entry.quantity > 0);

  const positions: Position[] = [];
  let equity = 0;
  for (const entry of entries) {
    const price = entry.symbol === "USD" ? 1 : raw.usdPrices[entry.symbol];
    const marketValue = price !== undefined ? entry.quantity * price : undefined;
    if (marketValue !== undefined) equity += marketValue;
    positions.push({
      ...entry,
      ...(marketValue !== undefined ? { marketValue } : {}),
      // Kraken balances mix fiat cash with coins; only the known fiats are cash.
      assetClass: KRAKEN_FIAT.has(entry.symbol) ? "cash" : "crypto",
    });
  }

  return [
    {
      id: "kraken-spot",
      name: "Kraken spot",
      currency: "USD",
      equity,
      positions,
      trades: [],
    },
  ];
};

const fetchUsdPrices = async (assets: string[], ctx: FetchContext): Promise<Record<string, number>> => {
  const prices: Record<string, number> = {};
  const pairs = assets
    .filter((asset) => asset !== "USD")
    .map((asset) => `${asset}USD`)
    .join(",");
  if (!pairs) return prices;
  const response = await ctx.fetch(`${KRAKEN_API}/0/public/Ticker?pair=${pairs}`);
  if (!response.ok) return prices;
  const body = (await response.json()) as { result?: Record<string, { c?: [string, string] }> };
  for (const [pair, ticker] of Object.entries(body.result ?? {})) {
    const last = asFiniteNumber(ticker.c?.[0]);
    if (last === undefined) continue;
    // Response pair keys can come back in legacy form (e.g. XXBTZUSD).
    const asset = normalizeKrakenAsset(pair.replace(/(ZUSD|USD)$/, ""));
    prices[asset] = last;
  }
  return prices;
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext) => {
  const { apiKey, apiSecret } = credentials;
  if (!apiKey || !apiSecret) {
    throw new MissingCredentialsError("kraken", "Kraken connection is missing its API key or secret");
  }

  const balances = await krakenPrivate<Record<string, string>>({ apiKey, apiSecret }, "Balance", {}, ctx.fetch);
  const assets = [...new Set(Object.keys(balances).map(normalizeKrakenAsset))];
  const usdPrices = await fetchUsdPrices(assets, ctx);

  return { raw: { balances, usdPrices } };
};

export const kraken: BrokerAdapter<KrakenRaw> = {
  id: "kraken",
  displayName: "Kraken",
  credentials: [
    { key: "apiKey", label: "API key", secret: false },
    { key: "apiSecret", label: "Private key", secret: true },
  ],
  readOnlySetup: 'Create an API key in Kraken with only the "Query Funds" permission.',
  fetchRaw,
  normalize,
};
