import { createHmac, randomUUID } from "node:crypto";

import { BrokerRequestError, MissingCredentialsError } from "../errors.js";
import type { Account, AssetClass, Position, Trade } from "../schema.js";
import { rejectResponse } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  Webull OpenAPI, read-only via the user's own App Key + App Secret (the
  user applies for OpenAPI access in their Webull account — approved in a
  day or two — then generates the pair themselves). Signing follows Webull's
  official SDK: HMAC-SHA1 over a percent-encoded canonical string of the
  request path plus sorted sign-headers and query params, secret suffixed
  with "&". Endpoints are the /trading/* set the official SDK calls with
  `x-version: v3`: the gateway routes on that header, and the older
  /openapi/account/* paths now answer 404.
*/

const WEBULL_HOST = "api.webull.com";

/** Python `urllib.quote(value, safe="")` — RFC 3986 with nothing spared. */
const strictEncode = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * The canonical string Webull signs: path, then all sign params (lowercased
 * header names + query params) sorted and joined as k=v with "&". Exported
 * for tests.
 */
export const buildWebullStringToSign = (uri: string, signParams: Record<string, string>): string => {
  const sorted = Object.keys(signParams)
    .sort()
    .map((key) => `${key}=${signParams[key]}`)
    .join("&");
  return strictEncode(`${uri}&${sorted}`);
};

/** Webull response envelopes vary; hunt for the first array under known keys. */
export const webullListIn = (body: unknown): Record<string, unknown>[] => {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body && typeof body === "object") {
    for (const key of ["data", "account_list", "accounts", "positions", "items", "holdings"]) {
      const value = (body as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as Record<string, unknown>[];
      if (value && typeof value === "object") {
        const nested = webullListIn(value);
        if (nested.length > 0) return nested;
      }
    }
  }
  return [];
};

const numberIn = (record: Record<string, unknown>, keys: string[]): number | undefined => {
  for (const key of keys) {
    const parsed = Number.parseFloat(String(record[key] ?? ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const stringIn = (record: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
};

export type WebullRaw = {
  accounts: {
    accountId: string;
    balance: unknown;
    positions: unknown;
    /** Historical orders, flattened out of their combo groups. */
    orders?: Record<string, unknown>[];
  }[];
};

const EQUITY_KEYS = [
  "total_net_liquidation_value",
  "total_asset",
  "totalAsset",
  "net_liquidation_value",
  "netLiquidationValue",
];

const ASSET_CLASSES: Record<string, AssetClass> = {
  EQUITY: "equity",
  OPTION: "option",
  CRYPTO: "crypto",
  FUTURES: "futures",
};

/** Orders still working report a running average that changes once they complete. */
const WORKING_STATUS = /PARTIAL|PENDING|WORKING|SUBMIT|NEW/;

/** OCC-style compact option symbol: `TSLA 260925P375`. Exported for tests. */
export const webullOptionSymbol = (underlying: string, leg: Record<string, unknown>): string | undefined => {
  const expiry = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(leg.option_expire_date ?? ""));
  const strike = Number.parseFloat(String(leg.strike_price ?? ""));
  const right = String(leg.option_type ?? "").toUpperCase();
  if (!expiry || !Number.isFinite(strike) || (right !== "CALL" && right !== "PUT")) return undefined;
  return `${underlying} ${expiry[1]!.slice(2)}${expiry[2]}${expiry[3]}${right[0]}${strike}`;
};

/**
 * One trade per filled order at Webull's average fill price. Multi-leg option
 * orders carry a single net price, not per-leg fills, so they are skipped
 * rather than split by guesswork. Exported for tests.
 */
export const webullTrades = (orders: Record<string, unknown>[]): Trade[] => {
  const trades: Trade[] = [];
  for (const order of orders) {
    const legs = Array.isArray(order.legs) ? (order.legs as Record<string, unknown>[]) : [];
    if (legs.length > 1) continue;
    if (WORKING_STATUS.test(String(order.status ?? "").toUpperCase())) continue;
    const quantity = numberIn(order, ["filled_quantity"]);
    const price = numberIn(order, ["filled_price"]);
    const sideText = String(order.side ?? "").toUpperCase();
    const side = sideText.startsWith("BUY")
      ? "buy"
      : sideText.startsWith("SELL") || sideText.startsWith("SHORT")
        ? "sell"
        : undefined;
    const underlying = stringIn(order, ["symbol"]) ?? (legs[0] ? stringIn(legs[0], ["symbol"]) : undefined);
    if (!side || !underlying || !quantity || quantity <= 0 || !price || price <= 0) continue;

    const assetClass = ASSET_CLASSES[String(order.instrument_type ?? "")];
    const isOption = assetClass === "option";
    const symbol = isOption && legs[0] ? webullOptionSymbol(underlying, legs[0]) : underlying;
    if (!symbol) continue;
    const multiplier = isOption && legs[0] ? numberIn(legs[0], ["option_contract_multiplier"]) : undefined;

    const feeItems = [...(Array.isArray(order.fees) ? order.fees : []), order.commission ?? {}] as Record<
      string,
      unknown
    >[];
    const fee = feeItems.reduce((sum, item) => sum + Math.abs(numberIn(item ?? {}, ["actual_value"]) ?? 0), 0);
    const filledAt = Date.parse(String(order.filled_time_at ?? "")) || Number(order.filled_time);
    const intent = String(order.position_intent ?? "").toUpperCase();
    const positionEffect = intent.endsWith("_TO_OPEN") ? "open" : intent.endsWith("_TO_CLOSE") ? "close" : undefined;

    trades.push({
      symbol,
      side,
      quantity,
      price,
      ...(fee > 0 ? { fee } : {}),
      ...(Number.isFinite(filledAt) && filledAt > 0 ? { executedAt: new Date(filledAt).toISOString() } : {}),
      ...(assetClass ? { assetClass } : {}),
      ...(multiplier ? { multiplier } : {}),
      ...(positionEffect ? { positionEffect } : {}),
    });
  }
  return trades;
};

const normalize = (raw: WebullRaw): Account[] => {
  const accounts: Account[] = [];
  for (const entry of raw.accounts) {
    const balanceRecord = (
      Array.isArray(entry.balance) ? ((entry.balance[0] ?? {}) as Record<string, unknown>) : (entry.balance ?? {})
    ) as Record<string, unknown>;
    const equity =
      numberIn(balanceRecord, EQUITY_KEYS) ??
      numberIn((webullListIn(entry.balance)[0] ?? {}) as Record<string, unknown>, EQUITY_KEYS) ??
      0;

    const positions: Position[] = [];
    for (const position of webullListIn(entry.positions)) {
      const instrument = (position.instrument ?? position.ticker ?? {}) as Record<string, unknown>;
      const symbol =
        stringIn(position, ["symbol", "ticker_symbol", "instrument_symbol"]) ?? stringIn(instrument, ["symbol"]);
      const quantity = numberIn(position, ["quantity", "qty", "position"]);
      if (!symbol || quantity === undefined || quantity === 0) continue;
      const marketValue = numberIn(position, ["market_value", "marketValue"]);
      positions.push({ symbol, quantity, ...(marketValue !== undefined ? { marketValue } : {}) });
    }

    accounts.push({
      id: entry.accountId,
      name: `Webull ${entry.accountId}`,
      currency: "USD",
      equity,
      positions,
      trades: webullTrades(entry.orders ?? []),
    });
  }
  return accounts;
};

const MAX_RETRIES = 5;
const DAY_MS = 86_400_000;
/** The history endpoint defaults to 7 days; 30-day windows are accepted. */
const WINDOW_MS = 30 * DAY_MS;
/** First-sync lookback when the caller passes no `historySince`. */
const FIRST_SYNC_LOOKBACK_MS = 365 * DAY_MS;

type WebullGet = <T>(uri: string, query: Record<string, string>) => Promise<T>;

/**
 * Walk historical orders newest-first in 30-day windows, following
 * `pagination_key`. Times must be ISO with a `Z` suffix (`+0000` is rejected
 * with 417). A 400/417 on an older window means it predates what Webull
 * retains, so the walk stops there with the newer history intact.
 */
const fetchOrders = async (get: WebullGet, accountId: string, since: string | undefined) => {
  const orders: Record<string, unknown>[] = [];
  const now = Date.now();
  const sinceMs = since === undefined ? Number.NaN : Date.parse(since);
  const floor = Number.isFinite(sinceMs) ? sinceMs : now - FIRST_SYNC_LOOKBACK_MS;
  windows: for (let end = now; end > floor; end -= WINDOW_MS) {
    const start = Math.max(floor, end - WINDOW_MS);
    const seen = new Set<string>();
    let paginationKey: string | undefined;
    do {
      let page: unknown;
      try {
        page = await get<unknown>("/trading/orders/historical-orders/list", {
          account_id: accountId,
          start_time: new Date(start).toISOString(),
          end_time: new Date(end).toISOString(),
          ...(paginationKey ? { pagination_key: paginationKey } : {}),
        });
      } catch (error) {
        const status = error instanceof BrokerRequestError ? error.status : undefined;
        if (end < now && (status === 400 || status === 417)) break windows;
        throw error;
      }
      for (const group of webullListIn(page)) {
        orders.push(...(Array.isArray(group.orders) ? (group.orders as Record<string, unknown>[]) : [group]));
      }
      const next = (page as { pagination_key?: unknown } | null)?.pagination_key;
      paginationKey = typeof next === "string" && next && !seen.has(next) ? next : undefined;
      if (paginationKey) seen.add(paginationKey);
    } while (paginationKey);
  }
  return orders;
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext) => {
  const { apiKey, apiSecret } = credentials;
  if (!apiKey || !apiSecret) {
    throw new MissingCredentialsError("webull", "Webull connection is missing its App Key or App Secret");
  }

  const get = async <T>(uri: string, query: Record<string, string>, attempt = 0): Promise<T> => {
    const signHeaders: Record<string, string> = {
      "x-app-key": apiKey,
      "x-timestamp": new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      "x-signature-version": "1.0",
      "x-signature-algorithm": "HMAC-SHA1",
      "x-signature-nonce": randomUUID(),
    };
    const stringToSign = buildWebullStringToSign(uri, { ...signHeaders, host: WEBULL_HOST, ...query });
    const signature = createHmac("sha1", `${apiSecret}&`).update(stringToSign).digest("base64");

    const search = new URLSearchParams(query).toString();
    const response = await ctx.fetch(`https://${WEBULL_HOST}${uri}${search ? `?${search}` : ""}`, {
      headers: { ...signHeaders, "x-signature": signature, "x-version": "v3" },
    });
    // Webull rate-limits per App Key; back off rather than fail the whole sync.
    if (response.status === 429 && attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      return get<T>(uri, query, attempt + 1);
    }
    if (!response.ok) rejectResponse("webull", "Webull", response);
    return (await response.json()) as T;
  };

  const accountList = await get<unknown>("/trading/accounts/list", {});
  const accountIds = webullListIn(accountList)
    .map((entry) => stringIn(entry, ["account_id", "accountId", "secAccountId"]))
    .filter((accountId): accountId is string => Boolean(accountId));
  if (accountIds.length === 0) {
    throw new BrokerRequestError("webull", "Webull returned no accounts — is OpenAPI access approved on this account?");
  }

  const accounts = [];
  for (const accountId of accountIds) {
    const [balance, positions] = await Promise.all([
      get<unknown>("/trading/assets/balances/get", { account_id: accountId, total_asset_currency: "USD" }),
      get<unknown>("/trading/assets/positions/list", { account_id: accountId }),
    ]);
    const orders = await fetchOrders(get, accountId, ctx.historySince);
    accounts.push({ accountId, balance, positions, orders });
  }

  return { raw: { accounts } };
};

export const webull: BrokerAdapter<WebullRaw> = {
  id: "webull",
  displayName: "Webull",
  credentials: [
    { key: "apiKey", label: "App Key", secret: false },
    { key: "apiSecret", label: "App Secret", secret: true },
  ],
  readOnlySetup:
    "Apply for OpenAPI access in your Webull account (self-serve, approved in a day or two), then generate an App Key + App Secret pair. Only balances, positions and order history are read.",
  fetchRaw,
  normalize,
};
