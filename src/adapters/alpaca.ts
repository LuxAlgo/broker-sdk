import { MissingCredentialsError } from "../errors.js";
import type { Account, AssetClass, Trade } from "../schema.js";
import { fetchAlpacaBars } from "./alpaca-bars.js";
import { asFiniteNumber, asIsoTimestamp, rejectResponse } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  Alpaca, read-only via the user's own API key + secret (generated in the
  Alpaca dashboard). Live and paper keys both work: paper key IDs start with
  "PK" and are only valid against the paper host, so the host is picked from
  the key itself. Three calls: account (equity), positions (mark-valued),
  and fill activities (real executions that feed win/loss stats).
*/

const ALPACA_LIVE_API = "https://api.alpaca.markets";
const ALPACA_PAPER_API = "https://paper-api.alpaca.markets";
const FILL_PAGE_SIZE = 100;

/** Paper key IDs are "PK…", live are "AK…"; unknown prefixes go to live. */
export const alpacaHostForKey = (apiKey: string): string =>
  apiKey.trim().toUpperCase().startsWith("PK") ? ALPACA_PAPER_API : ALPACA_LIVE_API;

type AlpacaAccount = { account_number?: string; equity?: string; currency?: string; cash?: string };
type AlpacaPosition = {
  symbol: string;
  qty: string;
  market_value?: string;
  avg_entry_price?: string;
  asset_class?: string;
};

const ALPACA_ASSET_CLASSES: Record<string, AssetClass> = {
  us_equity: "equity",
  us_option: "option",
  crypto: "crypto",
};
type AlpacaFill = {
  activity_type?: string;
  side?: string;
  symbol?: string;
  qty?: string;
  price?: string;
  transaction_time?: string;
};

export type AlpacaRaw = {
  environment: "live" | "paper";
  account: AlpacaAccount;
  positions: AlpacaPosition[];
  fills: AlpacaFill[];
};

/** Pure mapper from Alpaca fill activities to trades; bad rows drop out. */
export const parseAlpacaFills = (fills: AlpacaFill[]): Trade[] => {
  const trades: Trade[] = [];
  for (const fill of fills) {
    const side = fill.side === "buy" || fill.side === "sell" ? fill.side : null;
    const quantity = asFiniteNumber(fill.qty);
    const price = asFiniteNumber(fill.price);
    if (!fill.symbol || !side || quantity === undefined || quantity <= 0 || price === undefined || price <= 0) {
      continue;
    }
    const executedAt = asIsoTimestamp(fill.transaction_time);
    trades.push({
      symbol: fill.symbol,
      side,
      quantity,
      price,
      ...(executedAt ? { executedAt } : {}),
    });
  }
  return trades;
};

const normalize = (raw: AlpacaRaw): Account[] => {
  const positions = [];
  for (const position of Array.isArray(raw.positions) ? raw.positions : []) {
    const quantity = asFiniteNumber(position.qty);
    if (!position.symbol || quantity === undefined || quantity === 0) continue;
    const marketValue = asFiniteNumber(position.market_value);
    const averageEntryPrice = asFiniteNumber(position.avg_entry_price);
    const assetClass = position.asset_class ? ALPACA_ASSET_CLASSES[position.asset_class] : undefined;
    positions.push({
      symbol: position.symbol,
      quantity,
      ...(marketValue !== undefined ? { marketValue } : {}),
      ...(averageEntryPrice !== undefined ? { averageEntryPrice } : {}),
      ...(assetClass ? { assetClass } : {}),
    });
  }

  const equity = asFiniteNumber(raw.account.equity);
  const cash = asFiniteNumber(raw.account.cash);

  return [
    {
      id: raw.account.account_number ?? "alpaca",
      name: raw.account.account_number ? `Alpaca ${raw.account.account_number}` : "Alpaca",
      currency: raw.account.currency ?? "USD",
      equity: equity ?? positions.reduce((sum, p) => sum + (p.marketValue ?? 0), 0),
      ...(cash !== undefined ? { cash } : {}),
      environment: raw.environment,
      positions,
      trades: parseAlpacaFills(Array.isArray(raw.fills) ? raw.fills : []),
    },
  ];
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext) => {
  // Trim once so host selection and the auth headers always agree, even for
  // stored credentials that were saved with stray whitespace.
  const apiKey = credentials.apiKey?.trim();
  const apiSecret = credentials.apiSecret?.trim();
  if (!apiKey || !apiSecret) {
    throw new MissingCredentialsError("alpaca", "Alpaca connection is missing its API key or secret");
  }

  const host = alpacaHostForKey(apiKey);
  const get = async <T>(path: string): Promise<T> => {
    const response = await ctx.fetch(`${host}${path}`, {
      headers: {
        "APCA-API-KEY-ID": apiKey,
        "APCA-API-SECRET-KEY": apiSecret,
      },
    });
    if (!response.ok) rejectResponse("alpaca", "Alpaca", response);
    return (await response.json()) as T;
  };

  const account = await get<AlpacaAccount>("/v2/account");
  const positions = await get<AlpacaPosition[]>("/v2/positions");
  // Latest page of fills is enough to seed the stats; refreshes keep
  // extending coverage over time as new fills land in the window.
  const fills = await get<AlpacaFill[]>(`/v2/account/activities/FILL?page_size=${FILL_PAGE_SIZE}`);

  return {
    raw: {
      environment: host === ALPACA_PAPER_API ? ("paper" as const) : ("live" as const),
      account,
      positions,
      fills,
    },
  };
};

export const alpaca: BrokerAdapter<AlpacaRaw> = {
  id: "alpaca",
  displayName: "Alpaca",
  credentials: [
    { key: "apiKey", label: "API key ID", secret: false },
    { key: "apiSecret", label: "API secret key", secret: true },
  ],
  readOnlySetup:
    "Generate an API key in the Alpaca dashboard (paper keys start with PK and work too); the SDK only ever calls account, position, and activity endpoints.",
  fetchRaw,
  normalize,
  fetchBars: fetchAlpacaBars,
};
