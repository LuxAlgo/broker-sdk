import { createHmac, randomUUID } from "node:crypto";

import { BrokerRequestError, MissingCredentialsError } from "../errors.js";
import type { Account, Position } from "../schema.js";
import { rejectResponse } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  Webull OpenAPI, read-only via the user's own App Key + App Secret (the
  user applies for OpenAPI access in their Webull account — approved in a
  day or two — then generates the pair themselves). Signing follows Webull's
  official SDK: HMAC-SHA1 over a percent-encoded canonical string of the
  request path plus sorted sign-headers and query params, secret suffixed
  with "&". Endpoints are the v2 /openapi/account/* set.
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
  }[];
};

const normalize = (raw: WebullRaw): Account[] => {
  const accounts: Account[] = [];
  for (const entry of raw.accounts) {
    const balanceRecord = (
      Array.isArray(entry.balance) ? ((entry.balance[0] ?? {}) as Record<string, unknown>) : (entry.balance ?? {})
    ) as Record<string, unknown>;
    const equity =
      numberIn(balanceRecord, ["total_asset", "totalAsset", "net_liquidation_value", "netLiquidationValue"]) ??
      numberIn((webullListIn(entry.balance)[0] ?? {}) as Record<string, unknown>, [
        "total_asset",
        "totalAsset",
        "net_liquidation_value",
        "netLiquidationValue",
      ]) ??
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
      trades: [],
    });
  }
  return accounts;
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext) => {
  const { apiKey, apiSecret } = credentials;
  if (!apiKey || !apiSecret) {
    throw new MissingCredentialsError("webull", "Webull connection is missing its App Key or App Secret");
  }

  const get = async <T>(uri: string, query: Record<string, string>): Promise<T> => {
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
      headers: { ...signHeaders, "x-signature": signature, "x-version": "v1" },
    });
    if (!response.ok) rejectResponse("webull", "Webull", response);
    return (await response.json()) as T;
  };

  const accountList = await get<unknown>("/openapi/account/list", {});
  const accountIds = webullListIn(accountList)
    .map((entry) => stringIn(entry, ["account_id", "accountId", "secAccountId"]))
    .filter((accountId): accountId is string => Boolean(accountId));
  if (accountIds.length === 0) {
    throw new BrokerRequestError("webull", "Webull returned no accounts — is OpenAPI access approved on this account?");
  }

  const accounts = [];
  for (const accountId of accountIds) {
    const [balance, positions] = await Promise.all([
      get<unknown>("/openapi/account/balance", { account_id: accountId, total_asset_currency: "USD" }),
      get<unknown>("/openapi/account/positions", { account_id: accountId }),
    ]);
    accounts.push({ accountId, balance, positions });
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
    "Apply for OpenAPI access in your Webull account (self-serve, approved in a day or two), then generate an App Key + App Secret pair.",
  fetchRaw,
  normalize,
};
