import { createHmac } from "node:crypto";

import { BrokerRequestError, MissingCredentialsError } from "../errors.js";
import type { Account, Position } from "../schema.js";
import { asFiniteNumber, rejectResponse } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  Crypto.com Exchange, read-only via the user's own API key + secret (created
  with only the "Read" permission). One signed user-balance call — the
  exchange returns per-position USD market values, so no extra pricing
  request.
*/

const CRYPTO_COM_API = "https://api.crypto.com/exchange/v1";

/**
 * Crypto.com's request signature covers a canonical params string: object
 * keys sorted alphabetically, concatenated as key + value, recursively.
 * Exported for tests.
 */
export const cryptoComParamsString = (params: unknown): string => {
  if (params === null || params === undefined) return "";
  if (Array.isArray(params)) return params.map((entry) => cryptoComParamsString(entry)).join("");
  if (typeof params === "object") {
    return Object.keys(params as Record<string, unknown>)
      .sort()
      .map((key) => key + cryptoComParamsString((params as Record<string, unknown>)[key]))
      .join("");
  }
  return String(params);
};

export type CryptoComRaw = {
  code?: number;
  message?: string;
  result?: {
    data?: {
      total_cash_balance?: string;
      total_available_balance?: string;
      position_balances?: { instrument_name?: string; quantity?: string; market_value?: string }[];
    }[];
  };
};

const normalize = (raw: CryptoComRaw): Account[] => {
  const account = raw.result?.data?.[0];
  const positions: Position[] = [];
  for (const position of account?.position_balances ?? []) {
    const quantity = asFiniteNumber(position.quantity);
    if (!position.instrument_name || quantity === undefined || quantity <= 0) continue;
    const marketValue = asFiniteNumber(position.market_value);
    positions.push({
      symbol: position.instrument_name,
      quantity,
      ...(marketValue !== undefined ? { marketValue } : {}),
      assetClass: "crypto",
    });
  }
  const totalCash = asFiniteNumber(account?.total_cash_balance);
  const equity = totalCash ?? positions.reduce((sum, position) => sum + (position.marketValue ?? 0), 0);

  return [
    {
      id: "crypto-com",
      name: "Crypto.com Exchange",
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
    throw new MissingCredentialsError("crypto-com", "Crypto.com connection is missing its API key or secret");
  }

  const method = "private/user-balance";
  const id = 1;
  const nonce = Date.now();
  const params = {};
  const payload = `${method}${id}${apiKey}${cryptoComParamsString(params)}${nonce}`;
  const sig = createHmac("sha256", apiSecret).update(payload).digest("hex");

  const response = await ctx.fetch(`${CRYPTO_COM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, method, api_key: apiKey, params, nonce, sig }),
  });
  if (!response.ok) rejectResponse("crypto-com", "Crypto.com", response);
  const body = (await response.json()) as CryptoComRaw;
  if (body.code !== 0) {
    throw new BrokerRequestError("crypto-com", `Crypto.com error: ${body.message ?? `code ${body.code}`}`);
  }

  return { raw: body };
};

export const cryptoCom: BrokerAdapter<CryptoComRaw> = {
  id: "crypto-com",
  displayName: "Crypto.com",
  credentials: [
    { key: "apiKey", label: "API key", secret: false },
    { key: "apiSecret", label: "API secret", secret: true },
  ],
  readOnlySetup: 'Create an API key in Crypto.com Exchange with only the "Read" permission.',
  fetchRaw,
  normalize,
};
