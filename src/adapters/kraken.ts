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

const signRequest = (path: string, nonce: string, postData: string, secret: string): string => {
  const message = createHash("sha256")
    .update(nonce + postData)
    .digest();
  return createHmac("sha512", Buffer.from(secret, "base64"))
    .update(Buffer.concat([Buffer.from(path, "utf8"), message]))
    .digest("base64");
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

  const path = "/0/private/Balance";
  const nonce = Date.now().toString();
  const postData = `nonce=${nonce}`;
  const response = await ctx.fetch(`${KRAKEN_API}${path}`, {
    method: "POST",
    headers: {
      "API-Key": apiKey,
      "API-Sign": signRequest(path, nonce, postData, apiSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: postData,
  });
  if (!response.ok) rejectResponse("kraken", "Kraken", response);
  const body = (await response.json()) as { error?: string[]; result?: Record<string, string> };
  if (body.error && body.error.length > 0) {
    throw new BrokerRequestError("kraken", `Kraken error: ${body.error.join(", ")}`);
  }

  const balances = body.result ?? {};
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
