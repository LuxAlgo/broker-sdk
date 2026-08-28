import { createHmac } from "node:crypto";

import { BrokerRequestError, MissingCredentialsError } from "../errors.js";
import type { Account, Position, Trade } from "../schema.js";
import { asFiniteNumber, rejectResponse } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  KuCoin, read-only API key + secret + passphrase (key created with only the
  "General" permission; KuCoin keys always carry a passphrase). Two signed
  v2 calls: /api/v1/accounts for balances across the main/trade wallets, and
  /api/v1/fills for recent trade history.

  Valuation is deliberately conservative: /api/v1/accounts carries no
  prices, so only the USDT-pegged balances (USDT/USDC/USD, treated at face —
  same fiat-detection spirit as Kraken's KRAKEN_FIAT set) fold into `cash`,
  and every other holding stays an unpriced crypto position with no
  marketValue. `equity` is therefore just that cash — a smaller-but-true
  number rather than a guessed one. The account currency is stated as
  "USDT", not "USD", because KuCoin quotes in USDT and that is what the cash
  actually is.
*/

const KUCOIN_API = "https://api.kucoin.com";

/** Balances treated as cash at face value (USDT-pegged stables plus fiat USD). */
const KUCOIN_CASH = new Set(["USDT", "USDC", "USD"]);

type KucoinAccountRow = {
  currency?: string;
  /** Wallet the balance sits in ("main", "trade", …) — aggregated away. */
  type?: string;
  balance?: string;
  available?: string;
};

type KucoinFill = {
  /** Pair like "BTC-USDT"; the base becomes the trade symbol. */
  symbol?: string;
  side?: string;
  size?: string;
  price?: string;
  fee?: string;
  /** Epoch milliseconds. */
  createdAt?: number;
};

export type KucoinRaw = {
  /** /api/v1/accounts data rows, every account type included. */
  accounts: KucoinAccountRow[];
  /** /api/v1/fills data.items rows. */
  fills: KucoinFill[];
};

const parseKucoinFills = (fills: KucoinFill[]): Trade[] => {
  const trades: Trade[] = [];
  for (const fill of fills) {
    const side = fill.side === "buy" ? "buy" : fill.side === "sell" ? "sell" : null;
    const quantity = asFiniteNumber(fill.size) ?? 0;
    const price = asFiniteNumber(fill.price) ?? 0;
    if (!fill.symbol || !side || quantity <= 0 || price <= 0) continue;
    const fee = asFiniteNumber(fill.fee) ?? 0;
    trades.push({
      symbol: fill.symbol.split("-")[0]!,
      side,
      quantity,
      price,
      ...(fee > 0 ? { fee } : {}),
      ...(fill.createdAt ? { executedAt: new Date(fill.createdAt).toISOString() } : {}),
    });
  }
  return trades;
};

const normalize = (raw: KucoinRaw): Account[] => {
  // One currency can appear once per wallet type — sum them into one balance.
  const totals = new Map<string, number>();
  for (const row of Array.isArray(raw.accounts) ? raw.accounts : []) {
    const quantity = asFiniteNumber(row.balance);
    if (!row.currency || quantity === undefined || quantity <= 0) continue;
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + quantity);
  }

  const positions: Position[] = [];
  let cash = 0;
  for (const [symbol, quantity] of totals) {
    if (KUCOIN_CASH.has(symbol)) {
      cash += quantity;
      continue;
    }
    // No prices in /api/v1/accounts → no marketValue.
    positions.push({ symbol, quantity, assetClass: "crypto" });
  }

  return [
    {
      id: "kucoin",
      name: "KuCoin",
      currency: "USDT",
      // Nothing besides the stablecoin cash is priced, so equity is exactly it.
      equity: cash,
      cash,
      positions,
      trades: parseKucoinFills(Array.isArray(raw.fills) ? raw.fills : []),
    },
  ];
};

/** KuCoin signed GET, key version 2: sign timestamp+method+pathWithQuery, passphrase HMAC'd too. */
const kucoinGet = async <T>(pathWithQuery: string, credentials: Credentials, ctx: FetchContext): Promise<T> => {
  const { apiKey, apiSecret, passphrase } = credentials as { apiKey: string; apiSecret: string; passphrase: string };
  const timestamp = Date.now().toString();
  const response = await ctx.fetch(`${KUCOIN_API}${pathWithQuery}`, {
    headers: {
      "KC-API-KEY": apiKey,
      "KC-API-SIGN": createHmac("sha256", apiSecret).update(`${timestamp}GET${pathWithQuery}`).digest("base64"),
      "KC-API-TIMESTAMP": timestamp,
      "KC-API-PASSPHRASE": createHmac("sha256", apiSecret).update(passphrase).digest("base64"),
      "KC-API-KEY-VERSION": "2",
    },
  });
  if (!response.ok) rejectResponse("kucoin", "KuCoin", response);
  const body = (await response.json()) as { code?: string; msg?: string; data?: T };
  if (body.code !== "200000") {
    throw new BrokerRequestError("kucoin", `KuCoin error: ${body.msg ?? `code ${body.code}`}`);
  }
  return body.data as T;
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext) => {
  const { apiKey, apiSecret, passphrase } = credentials;
  if (!apiKey || !apiSecret || !passphrase) {
    throw new MissingCredentialsError("kucoin", "KuCoin connection is missing its API key, secret, or passphrase");
  }

  const [accounts, fillsPage] = await Promise.all([
    kucoinGet<KucoinAccountRow[]>("/api/v1/accounts", credentials, ctx),
    kucoinGet<{ items?: KucoinFill[] }>("/api/v1/fills?pageSize=100", credentials, ctx),
  ]);

  return { raw: { accounts: accounts ?? [], fills: fillsPage?.items ?? [] } };
};

export const kucoin: BrokerAdapter<KucoinRaw> = {
  id: "kucoin",
  displayName: "KuCoin",
  credentials: [
    { key: "apiKey", label: "API key", secret: false },
    { key: "apiSecret", label: "API secret", secret: true },
    { key: "passphrase", label: "API passphrase", secret: true },
  ],
  readOnlySetup:
    'Create an API key in KuCoin with only the "General" permission (no Trade, no Transfer); the passphrase is the one you set when creating the key.',
  fetchRaw,
  normalize,
};
