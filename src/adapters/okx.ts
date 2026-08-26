import { createHmac } from "node:crypto";

import { BrokerRequestError, MissingCredentialsError } from "../errors.js";
import type { Account, Position } from "../schema.js";
import { asFiniteNumber, rejectResponse } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  OKX v5 trading account, read-only API key + secret + passphrase (the user
  creates a key with only "Read" permission; OKX keys always carry a
  passphrase). One signed balance call — OKX returns per-currency USD
  valuations, so no extra pricing request.
*/

const OKX_API = "https://www.okx.com";
const BALANCE_PATH = "/api/v5/account/balance";

export type OkxRaw = {
  code?: string;
  msg?: string;
  data?: {
    totalEq?: string;
    details?: { ccy: string; eq: string; eqUsd?: string }[];
  }[];
};

const normalize = (raw: OkxRaw): Account[] => {
  const account = raw.data?.[0];
  const positions: Position[] = [];
  for (const entry of account?.details ?? []) {
    const quantity = asFiniteNumber(entry.eq);
    if (quantity === undefined || quantity <= 0) continue;
    const marketValue = asFiniteNumber(entry.eqUsd);
    positions.push({
      symbol: entry.ccy,
      quantity,
      ...(marketValue !== undefined ? { marketValue } : {}),
      assetClass: "crypto",
    });
  }
  const totalEq = asFiniteNumber(account?.totalEq);
  const equity = totalEq ?? positions.reduce((sum, position) => sum + (position.marketValue ?? 0), 0);

  return [
    {
      id: "okx-trading",
      name: "OKX trading",
      currency: "USD",
      equity,
      positions,
      trades: [],
    },
  ];
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext) => {
  const { apiKey, apiSecret, passphrase } = credentials;
  if (!apiKey || !apiSecret || !passphrase) {
    throw new MissingCredentialsError("okx", "OKX connection is missing its API key, secret, or passphrase");
  }

  const timestamp = new Date().toISOString();
  // v5 signature: base64(HMAC_SHA256(timestamp + method + path + body)).
  const signature = createHmac("sha256", apiSecret).update(`${timestamp}GET${BALANCE_PATH}`).digest("base64");

  const response = await ctx.fetch(`${OKX_API}${BALANCE_PATH}`, {
    headers: {
      "OK-ACCESS-KEY": apiKey,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": passphrase,
    },
  });
  if (!response.ok) rejectResponse("okx", "OKX", response);
  const body = (await response.json()) as OkxRaw;
  if (body.code !== "0") {
    throw new BrokerRequestError("okx", `OKX error: ${body.msg ?? `code ${body.code}`}`);
  }

  return { raw: body };
};

export const okx: BrokerAdapter<OkxRaw> = {
  id: "okx",
  displayName: "OKX",
  credentials: [
    { key: "apiKey", label: "API key", secret: false },
    { key: "apiSecret", label: "API secret", secret: true },
    { key: "passphrase", label: "API passphrase", secret: true },
  ],
  readOnlySetup: 'Create an API key in OKX with only the "Read" permission; the passphrase is set when creating the key.',
  fetchRaw,
  normalize,
};
