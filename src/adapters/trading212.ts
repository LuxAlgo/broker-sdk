import { MissingCredentialsError } from "../errors.js";
import type { Account, Position } from "../schema.js";
import { asFiniteNumber, rejectResponse } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  Trading212 (UK/EU), read-only via the user's own API key (generated
  self-serve in the app: Settings → API). Three calls against the live
  environment: account info (currency), cash (total balance), and the
  portfolio (positions with current prices).
*/

const TRADING212_API = "https://live.trading212.com/api/v0";

type T212AccountInfo = { currencyCode?: string; id?: number };
type T212Cash = { total?: number; free?: number; invested?: number };
type T212Position = { ticker?: string; quantity?: number; currentPrice?: number; averagePrice?: number };

export type Trading212Raw = {
  info: T212AccountInfo;
  cash: T212Cash;
  portfolio: T212Position[];
};

/** Trading212 tickers look like "AAPL_US_EQ" — show the plain symbol. */
export const trading212Symbol = (ticker: string): string => ticker.split("_")[0] ?? ticker;

const normalize = (raw: Trading212Raw): Account[] => {
  const positions: Position[] = [];
  for (const position of Array.isArray(raw.portfolio) ? raw.portfolio : []) {
    const quantity = position.quantity ?? 0;
    if (!position.ticker || quantity === 0) continue;
    const price = asFiniteNumber(position.currentPrice);
    const marketValue = price !== undefined ? quantity * price : undefined;
    const averageEntryPrice = asFiniteNumber(position.averagePrice);
    positions.push({
      symbol: trading212Symbol(position.ticker),
      quantity,
      ...(marketValue !== undefined ? { marketValue } : {}),
      ...(averageEntryPrice !== undefined ? { averageEntryPrice } : {}),
      assetClass: "equity",
    });
  }

  const total = asFiniteNumber(raw.cash.total);
  const free = asFiniteNumber(raw.cash.free);

  return [
    {
      id: raw.info.id !== undefined ? `trading212-${raw.info.id}` : "trading212",
      name: "Trading212",
      currency: raw.info.currencyCode ?? "EUR",
      equity: total ?? 0,
      ...(free !== undefined ? { cash: free } : {}),
      positions,
      trades: [],
    },
  ];
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext) => {
  const { apiKey } = credentials;
  if (!apiKey) {
    throw new MissingCredentialsError("trading212", "Trading212 connection is missing its API key");
  }

  const get = async <T>(path: string): Promise<T> => {
    const response = await ctx.fetch(`${TRADING212_API}${path}`, {
      headers: { Authorization: apiKey },
    });
    if (!response.ok) rejectResponse("trading212", "Trading212", response);
    return (await response.json()) as T;
  };

  const [info, cash, portfolio] = await Promise.all([
    get<T212AccountInfo>("/equity/account/info"),
    get<T212Cash>("/equity/account/cash"),
    get<T212Position[]>("/equity/portfolio"),
  ]);

  return { raw: { info, cash, portfolio } };
};

export const trading212: BrokerAdapter<Trading212Raw> = {
  id: "trading212",
  displayName: "Trading212",
  credentials: [{ key: "apiKey", label: "API key", secret: true }],
  readOnlySetup: "Generate an API key in the Trading212 app under Settings → API.",
  fetchRaw,
  normalize,
};
