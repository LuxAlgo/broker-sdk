import { createHmac } from "node:crypto";

import { BrokerRequestError, MissingCredentialsError } from "../errors.js";
import type { Account, Position } from "../schema.js";
import { asFiniteNumber, rejectResponse } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  Binance spot, read-only API key + secret (the user creates a key with only
  "Enable Reading" checked). One signed /api/v3/account call for balances,
  one public /api/v3/ticker/price call to value them in USDT.
*/

const BINANCE_API = "https://api.binance.com";
const STABLECOINS = new Set(["USDT", "USDC", "FDUSD"]);

type BinanceAccount = {
  balances?: { asset: string; free: string; locked: string }[];
};

export type BinanceRaw = {
  account: BinanceAccount;
  /** Public USDT ticker prices, symbol → last price. */
  usdtPrices: Record<string, number>;
};

const signedQuery = (secret: string): string => {
  const query = `timestamp=${Date.now()}&recvWindow=10000`;
  const signature = createHmac("sha256", secret).update(query).digest("hex");
  return `${query}&signature=${signature}`;
};

const normalize = (raw: BinanceRaw): Account[] => {
  const positions: Position[] = [];
  let equity = 0;
  for (const entry of raw.account.balances ?? []) {
    const quantity = (asFiniteNumber(entry.free) ?? Number.NaN) + (asFiniteNumber(entry.locked) ?? Number.NaN);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const price = STABLECOINS.has(entry.asset) ? 1 : raw.usdtPrices[entry.asset];
    const marketValue = price !== undefined ? quantity * price : undefined;
    if (marketValue !== undefined) equity += marketValue;
    positions.push({
      symbol: entry.asset,
      quantity,
      ...(marketValue !== undefined ? { marketValue } : {}),
      assetClass: "crypto",
    });
  }

  return [
    {
      id: "binance-spot",
      name: "Binance spot",
      currency: "USD",
      equity,
      positions,
      trades: [],
    },
  ];
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext) => {
  const { apiKey, apiSecret } = credentials;
  if (!apiKey || !apiSecret) {
    throw new MissingCredentialsError("binance", "Binance connection is missing its API key or secret");
  }

  const response = await ctx.fetch(`${BINANCE_API}/api/v3/account?${signedQuery(apiSecret)}`, {
    headers: { "X-MBX-APIKEY": apiKey },
  });
  if (!response.ok) rejectResponse("binance", "Binance", response);
  const account = (await response.json()) as BinanceAccount;

  const usdtPrices: Record<string, number> = {};
  const pricesResponse = await ctx.fetch(`${BINANCE_API}/api/v3/ticker/price`);
  if (pricesResponse.ok) {
    const rows = (await pricesResponse.json()) as { symbol: string; price: string }[];
    for (const row of rows) {
      if (!row.symbol.endsWith("USDT")) continue;
      const price = asFiniteNumber(row.price);
      if (price !== undefined) usdtPrices[row.symbol.slice(0, -4)] = price;
    }
  } else if (pricesResponse.status >= 500) {
    // Valuations are best-effort, but surface a hard outage rather than
    // silently returning a portfolio with no values at all.
    throw new BrokerRequestError("binance", `Binance ticker endpoint failed (${pricesResponse.status})`, pricesResponse.status);
  }

  return { raw: { account, usdtPrices } };
};

export const binance: BrokerAdapter<BinanceRaw> = {
  id: "binance",
  displayName: "Binance",
  credentials: [
    { key: "apiKey", label: "API key", secret: false },
    { key: "apiSecret", label: "API secret", secret: true },
  ],
  readOnlySetup: 'Create an API key in Binance with only "Enable Reading" checked — no trading or withdrawal scopes.',
  fetchRaw,
  normalize,
};
