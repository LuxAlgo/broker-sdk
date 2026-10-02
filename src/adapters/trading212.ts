import { BrokerRequestError, MissingCredentialsError } from "../errors.js";
import type { Account, Position, Trade } from "../schema.js";
import { asFiniteNumber, asIsoTimestamp, rejectResponse } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

const HISTORY_PATH = "/api/v0/equity/history/orders";

type T212Summary = {
  id?: number;
  currency?: string;
  totalValue?: number;
  cash?: { availableToTrade?: number };
};
type T212Position = {
  instrument?: { ticker?: string; currency?: string };
  quantity?: number;
  averagePricePaid?: number;
  walletImpact?: { currentValue?: number };
};
type T212HistoryItem = {
  order?: { ticker?: string; side?: string; instrument?: { currency?: string } };
  fill?: {
    type?: string;
    quantity?: number;
    price?: number;
    filledAt?: string;
    walletImpact?: { fxRate?: number };
  } | null;
};

export type Trading212Raw = {
  summary: T212Summary;
  positions: T212Position[];
  history: T212HistoryItem[];
  environment: "live" | "demo";
};

/** Trading 212 tickers look like "AAPL_US_EQ" — show the plain symbol. */
export const trading212Symbol = (ticker: string): string => ticker.split("_")[0] || ticker;

const normalize = (raw: Trading212Raw): Account[] => {
  const positions: Position[] = [];
  for (const position of raw.positions) {
    const ticker = position.instrument?.ticker;
    const quantity = asFiniteNumber(position.quantity);
    if (!ticker || quantity === undefined || quantity === 0) continue;
    const marketValue = asFiniteNumber(position.walletImpact?.currentValue);
    const averageEntryPrice = position.instrument?.currency === raw.summary.currency
      ? asFiniteNumber(position.averagePricePaid)
      : undefined;
    positions.push({
      symbol: trading212Symbol(ticker),
      quantity,
      ...(marketValue !== undefined ? { marketValue } : {}),
      ...(averageEntryPrice !== undefined ? { averageEntryPrice } : {}),
      assetClass: "equity",
    });
  }

  const trades: Trade[] = [];
  for (const item of raw.history) {
    const order = item.order;
    const fill = item.fill;
    if (!order?.ticker || !fill || (fill.type && fill.type !== "TRADE")) continue;
    const side = order.side?.toLowerCase();
    if (side !== "buy" && side !== "sell") continue;
    const quantity = asFiniteNumber(fill.quantity);
    const price = asFiniteNumber(fill.price);
    const executedAt = asIsoTimestamp(fill.filledAt);
    if (quantity === undefined || quantity === 0 || price === undefined || !executedAt) continue;
    const instrumentCurrency = order.instrument?.currency;
    const fxRate = asFiniteNumber(fill.walletImpact?.fxRate);
    let accountPrice = price;
    if (instrumentCurrency && instrumentCurrency !== raw.summary.currency) {
      if (fxRate === undefined || fxRate <= 0) continue;
      accountPrice *= fxRate;
    }
    trades.push({
      symbol: trading212Symbol(order.ticker),
      side,
      quantity: Math.abs(quantity),
      price: accountPrice,
      executedAt,
    });
  }

  const equity = asFiniteNumber(raw.summary.totalValue);
  const cash = asFiniteNumber(raw.summary.cash?.availableToTrade);
  return [{
    id: raw.summary.id !== undefined ? `trading212-${raw.summary.id}` : "trading212",
    name: "Trading212",
    currency: raw.summary.currency ?? "EUR",
    equity: equity ?? 0,
    ...(cash !== undefined ? { cash } : {}),
    environment: raw.environment === "demo" ? "paper" : "live",
    positions,
    trades,
  }];
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext) => {
  const { apiKey, apiSecret } = credentials;
  if (!apiKey || !apiSecret) {
    throw new MissingCredentialsError("trading212", "Trading212 requires an API key ID and secret key");
  }
  const environment = credentials.environment || "live";
  if (environment !== "live" && environment !== "demo") {
    throw new BrokerRequestError("trading212", "Trading212 environment must be live or demo");
  }
  const selectedEnvironment: "live" | "demo" = environment;
  const origin = `https://${selectedEnvironment}.trading212.com`;
  const authorization = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`, "utf8").toString("base64")}`;

  const get = async <T>(path: string): Promise<T> => {
    const url = new URL(path, origin);
    if (url.origin !== origin || !url.pathname.startsWith("/api/v0/")) {
      throw new BrokerRequestError("trading212", "Trading212 returned an invalid API path");
    }
    const response = await ctx.fetch(url, { headers: { Authorization: authorization } });
    if (!response.ok) rejectResponse("trading212", "Trading212", response);
    return (await response.json()) as T;
  };

  const summary = await get<T212Summary>("/api/v0/equity/account/summary");
  const positions = await get<T212Position[]>("/api/v0/equity/positions");
  if (!Array.isArray(positions) || !summary?.currency || asFiniteNumber(summary.totalValue) === undefined) {
    throw new BrokerRequestError("trading212", "Trading212 returned an unexpected account response");
  }

  const history: T212HistoryItem[] = [];
  let nextPagePath: string | null = `${HISTORY_PATH}?limit=50`;
  const visited = new Set<string>();
  while (nextPagePath) {
    const url: URL = new URL(nextPagePath, origin);
    if (url.origin !== origin || url.pathname !== HISTORY_PATH || visited.has(url.href)) {
      throw new BrokerRequestError("trading212", "Trading212 returned an invalid history page path");
    }
    visited.add(url.href);
    // This endpoint permits six requests per minute.
    if (visited.size > 1) await new Promise((resolve) => setTimeout(resolve, 10_000));
    const page: { items?: T212HistoryItem[]; nextPagePath?: string | null } =
      await get(url.href);
    if (!Array.isArray(page.items)) {
      throw new BrokerRequestError("trading212", "Trading212 returned an unexpected history response");
    }
    history.push(...page.items);
    nextPagePath = page.nextPagePath ?? null;
  }
  return { raw: { summary, positions, history, environment: selectedEnvironment } };
};

export const trading212: BrokerAdapter<Trading212Raw> = {
  id: "trading212",
  displayName: "Trading212",
  credentials: [
    { key: "apiKey", label: "API key ID", secret: false },
    { key: "apiSecret", label: "Secret key", secret: true },
    { key: "environment", label: "Environment (optional: live or demo)", secret: false },
  ],
  readOnlySetup: "Create a key under Settings → API with read access to account, positions, and historical orders. Demo keys need the demo environment.",
  fetchRaw,
  normalize,
};
