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
  with "&". Endpoints are the documented /trading/* routes; Webull's gateway
  picks their version from the `x-version: v3` header, and the retired
  /openapi/account/* routes answer 404.
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

type WebullRecord = Record<string, unknown>;

export type WebullRaw = {
  accounts: {
    accountId: string;
    balance: unknown;
    positions: unknown;
    /** Historical orders, taken out of their combo groups. */
    orders?: WebullRecord[];
  }[];
};

/** `total_net_liquidation_value` is the documented v3 field; the rest are older names. */
const EQUITY_KEYS = [
  "total_net_liquidation_value",
  "total_asset",
  "totalAsset",
  "net_liquidation_value",
  "netLiquidationValue",
];

const INSTRUMENT_CLASSES: Record<string, AssetClass> = {
  EQUITY: "equity",
  OPTION: "option",
  FUTURES: "futures",
  CRYPTO: "crypto",
};

/**
 * Compact OCC-style option symbol, `TSLA 260925P375`, from an order or
 * position leg. Undefined unless the expiry, right and strike all parse.
 * Exported for tests.
 */
export const webullOptionSymbol = (underlying: string, leg: WebullRecord): string | undefined => {
  const expiry = /^(\d{2})(\d{2})-(\d{2})-(\d{2})$/.exec(stringIn(leg, ["option_expire_date"]) ?? "");
  const right = (stringIn(leg, ["option_type"]) ?? "").toUpperCase();
  const strike = numberIn(leg, ["strike_price", "option_exercise_price"]);
  if (!expiry || (right !== "CALL" && right !== "PUT") || strike === undefined || strike <= 0) return undefined;
  return `${underlying} ${expiry[2]}${expiry[3]}${expiry[4]}${right[0]}${strike}`;
};

/** Statuses after which an order's filled quantity and average price no longer change. */
const SETTLED_STATUSES = new Set(["FILLED", "CANCELLED", "FAILED"]);

/** One instrument per order: its own symbol, or its single option leg's contract. */
const instrumentOf = (order: WebullRecord) => {
  const legs = Array.isArray(order.legs) ? (order.legs as WebullRecord[]) : [];
  const assetClass = INSTRUMENT_CLASSES[stringIn(order, ["instrument_type"]) ?? ""];
  const underlying = stringIn(order, ["symbol"]) ?? (legs[0] ? stringIn(legs[0], ["symbol"]) : undefined);
  if (!underlying) return undefined;
  if (assetClass !== "option") return { symbol: underlying, assetClass };
  const leg = legs[0];
  const symbol = leg ? webullOptionSymbol(underlying, leg) : undefined;
  if (!leg || !symbol) return undefined;
  const multiplier = numberIn(leg, ["option_contract_multiplier"]);
  return { symbol, assetClass, ...(multiplier ? { multiplier } : {}) };
};

/**
 * Filled orders as trades, one per order at Webull's average fill price.
 * Orders still working are left for a later sync, once their fill is final.
 * Multi-leg orders report one net price for all legs, so they are skipped
 * rather than split by guesswork. An order seen twice, on two pages or in
 * two windows, counts once. Exported for tests.
 */
export const webullTrades = (orders: WebullRecord[]): Trade[] => {
  const trades: Trade[] = [];
  const seen = new Set<string>();
  for (const order of orders) {
    const id = stringIn(order, ["order_id", "client_order_id"]);
    if (id !== undefined) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    if (!SETTLED_STATUSES.has((stringIn(order, ["status"]) ?? "").toUpperCase())) continue;
    if (Array.isArray(order.legs) && order.legs.length > 1) continue;
    const sideText = (stringIn(order, ["side"]) ?? "").toUpperCase();
    const side = sideText === "BUY" ? "buy" : sideText === "SELL" || sideText === "SHORT" ? "sell" : undefined;
    const quantity = numberIn(order, ["filled_quantity"]);
    const price = numberIn(order, ["filled_price"]);
    const instrument = instrumentOf(order);
    if (!side || !instrument || !quantity || quantity <= 0 || !price || price <= 0) continue;

    // Fees are not in Webull's published schema, but live orders carry them.
    const charges = [...(Array.isArray(order.fees) ? (order.fees as WebullRecord[]) : [])];
    if (order.commission && typeof order.commission === "object") charges.push(order.commission as WebullRecord);
    const fee = charges.reduce((total, charge) => total + Math.abs(numberIn(charge, ["actual_value"]) ?? 0), 0);

    const filledAt = Date.parse(stringIn(order, ["filled_time_at"]) ?? "");
    const filledMs = Number.isFinite(filledAt) ? filledAt : numberIn(order, ["filled_time"]);
    const intent = (stringIn(order, ["position_intent"]) ?? "").toUpperCase();
    const positionEffect = intent.endsWith("_TO_OPEN") ? "open" : intent.endsWith("_TO_CLOSE") ? "close" : undefined;

    trades.push({
      symbol: instrument.symbol,
      side,
      quantity,
      price,
      ...(fee > 0 ? { fee } : {}),
      ...(filledMs !== undefined && filledMs > 0 ? { executedAt: new Date(filledMs).toISOString() } : {}),
      ...(instrument.assetClass ? { assetClass: instrument.assetClass } : {}),
      ...("multiplier" in instrument ? { multiplier: instrument.multiplier } : {}),
      ...(positionEffect ? { positionEffect } : {}),
    });
  }
  return trades;
};

const webullPosition = (record: WebullRecord): Position | undefined => {
  const instrument = (record.instrument ?? record.ticker ?? {}) as WebullRecord;
  const quantity = numberIn(record, ["quantity", "qty", "position"]);
  const underlying = stringIn(record, ["symbol", "ticker_symbol", "instrument_symbol"]) ?? stringIn(instrument, ["symbol"]);
  if (!underlying || quantity === undefined || quantity === 0) return undefined;
  const legs = Array.isArray(record.legs) ? (record.legs as WebullRecord[]) : [];
  const assetClass = INSTRUMENT_CLASSES[stringIn(record, ["instrument_type"]) ?? ""];
  const optionSymbol = assetClass === "option" && legs.length === 1 ? webullOptionSymbol(underlying, legs[0]!) : undefined;
  const multiplier = optionSymbol ? (numberIn(legs[0]!, ["option_contract_multiplier"]) ?? 1) : 1;
  const lastPrice = numberIn(record, ["last_price"]);
  const marketValue =
    numberIn(record, ["market_value", "marketValue"]) ??
    (lastPrice !== undefined ? quantity * lastPrice * multiplier : undefined);
  return {
    symbol: optionSymbol ?? underlying,
    quantity,
    ...(marketValue !== undefined ? { marketValue } : {}),
    ...(assetClass ? { assetClass } : {}),
  };
};

const normalize = (raw: WebullRaw): Account[] =>
  raw.accounts.map((entry) => {
    const balanceRecord = (
      Array.isArray(entry.balance) ? (entry.balance[0] ?? {}) : (entry.balance ?? {})
    ) as WebullRecord;
    const equity =
      numberIn(balanceRecord, EQUITY_KEYS) ?? numberIn(webullListIn(entry.balance)[0] ?? {}, EQUITY_KEYS) ?? 0;
    const positions = webullListIn(entry.positions)
      .map(webullPosition)
      .filter((position): position is Position => position !== undefined);
    return {
      id: entry.accountId,
      name: `Webull ${entry.accountId}`,
      currency: "USD",
      equity,
      positions,
      trades: webullTrades(entry.orders ?? []),
    };
  });

const DAY_MS = 86_400_000;
/** Order history is read in 30-day windows (Webull's default is the last 7 days). */
const HISTORY_WINDOW_MS = 30 * DAY_MS;
/** How far back a first sync reads when the caller passes no `historySince`. */
const FIRST_SYNC_MS = 365 * DAY_MS;
/** Webull allows two calls every two seconds on each account and order endpoint. */
const RATE_WINDOW_MS = 2_000;
const MAX_RETRIES = 5;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type WebullGet = (uri: string, query: Record<string, string>) => Promise<unknown>;

/**
 * Order history from `since` to now, newest window first, following
 * `pagination_key`. Webull rejects (400 or 417) a window older than the
 * history it keeps for the account, which ends the walk with the newer
 * windows kept; the same rejection on the newest window is a real error.
 */
const fetchOrderHistory = async (get: WebullGet, accountId: string, since: number, now: number) => {
  const orders: WebullRecord[] = [];
  for (let end = now; end > since; end -= HISTORY_WINDOW_MS) {
    const window = {
      account_id: accountId,
      start_time: new Date(Math.max(since, end - HISTORY_WINDOW_MS)).toISOString(),
      end_time: new Date(end).toISOString(),
    };
    const keys = new Set<string>();
    for (let key: string | undefined; ; ) {
      let page: unknown;
      try {
        page = await get("/trading/orders/historical-orders/list", key ? { ...window, pagination_key: key } : window);
      } catch (error) {
        const status = error instanceof BrokerRequestError ? error.status : undefined;
        if (end !== now && (status === 400 || status === 417)) return orders;
        throw error;
      }
      // Combo orders come grouped; each order in a group is its own fill.
      for (const group of webullListIn(page)) {
        if (Array.isArray(group.orders)) for (const order of group.orders as WebullRecord[]) orders.push(order);
        else orders.push(group);
      }
      const next = page && typeof page === "object" ? (page as WebullRecord).pagination_key : undefined;
      // A key seen before would page forever; it ends the window instead.
      if (typeof next !== "string" || !next || keys.has(next)) break;
      keys.add(next);
      key = next;
    }
  }
  return orders;
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext) => {
  const { apiKey, apiSecret } = credentials;
  if (!apiKey || !apiSecret) {
    throw new MissingCredentialsError("webull", "Webull connection is missing its App Key or App Secret");
  }

  const get: WebullGet = async (uri, query) => {
    for (let attempt = 0; ; attempt++) {
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
      if (response.status === 429 && attempt < MAX_RETRIES) {
        // The limit is per endpoint and App Key over two seconds; back off past it.
        const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
        await sleep(Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : RATE_WINDOW_MS * (attempt + 1));
        continue;
      }
      if (!response.ok) rejectResponse("webull", "Webull", response);
      return response.json();
    }
  };

  const accountList = await get("/trading/accounts/list", {});
  const accountIds = webullListIn(accountList)
    .map((entry) => stringIn(entry, ["account_id", "accountId", "secAccountId"]))
    .filter((accountId): accountId is string => Boolean(accountId));
  if (accountIds.length === 0) {
    throw new BrokerRequestError("webull", "Webull returned no accounts — is OpenAPI access approved on this account?");
  }

  const now = Date.now();
  const sinceMs = ctx.historySince === undefined ? Number.NaN : Date.parse(ctx.historySince);
  const since = Number.isFinite(sinceMs) ? sinceMs : now - FIRST_SYNC_MS;
  const accounts = [];
  for (const accountId of accountIds) {
    const balance = await get("/trading/assets/balances/get", { account_id: accountId, total_asset_currency: "USD" });
    const positions = await get("/trading/assets/positions/list", { account_id: accountId });
    const orders = await fetchOrderHistory(get, accountId, since, now);
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
    "Apply for OpenAPI access in your Webull account (self-serve, approved in a day or two), then generate an App Key + App Secret pair. Only accounts, balances, positions and order history are read.",
  fetchRaw,
  normalize,
};
