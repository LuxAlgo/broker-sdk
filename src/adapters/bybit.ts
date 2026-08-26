import { createHmac } from "node:crypto";

import { BrokerRequestError, MissingCredentialsError } from "../errors.js";
import type { Account, Position } from "../schema.js";
import { asFiniteNumber, rejectResponse } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  Bybit v5 unified account, read-only API key + secret (the user creates a
  key with only "Read-Only" selected). One signed wallet-balance call —
  Bybit returns per-coin USD valuations, so no extra pricing request.
*/

const BYBIT_API = "https://api.bybit.com";
const RECV_WINDOW = "10000";

export type BybitRaw = {
  retCode?: number;
  retMsg?: string;
  result?: {
    list?: {
      totalEquity?: string;
      coin?: { coin: string; walletBalance: string; usdValue?: string }[];
    }[];
  };
};

const normalize = (raw: BybitRaw): Account[] => {
  const account = raw.result?.list?.[0];
  const positions: Position[] = [];
  for (const entry of account?.coin ?? []) {
    const quantity = asFiniteNumber(entry.walletBalance);
    if (quantity === undefined || quantity <= 0) continue;
    const marketValue = asFiniteNumber(entry.usdValue);
    positions.push({
      symbol: entry.coin,
      quantity,
      ...(marketValue !== undefined ? { marketValue } : {}),
      assetClass: "crypto",
    });
  }
  const totalEquity = asFiniteNumber(account?.totalEquity);
  const equity = totalEquity ?? positions.reduce((sum, position) => sum + (position.marketValue ?? 0), 0);

  return [
    {
      id: "bybit-unified",
      name: "Bybit unified",
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
    throw new MissingCredentialsError("bybit", "Bybit connection is missing its API key or secret");
  }

  const timestamp = Date.now().toString();
  const query = "accountType=UNIFIED";
  // v5 signature: HMAC_SHA256(timestamp + apiKey + recvWindow + queryString).
  const signature = createHmac("sha256", apiSecret)
    .update(timestamp + apiKey + RECV_WINDOW + query)
    .digest("hex");

  const response = await ctx.fetch(`${BYBIT_API}/v5/account/wallet-balance?${query}`, {
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
      "X-BAPI-SIGN": signature,
    },
  });
  if (!response.ok) rejectResponse("bybit", "Bybit", response);
  const body = (await response.json()) as BybitRaw;
  if (body.retCode !== 0) {
    throw new BrokerRequestError("bybit", `Bybit error: ${body.retMsg ?? `code ${body.retCode}`}`);
  }

  return { raw: body };
};

export const bybit: BrokerAdapter<BybitRaw> = {
  id: "bybit",
  displayName: "Bybit",
  credentials: [
    { key: "apiKey", label: "API key", secret: false },
    { key: "apiSecret", label: "API secret", secret: true },
  ],
  readOnlySetup: 'Create an API key in Bybit with only "Read-Only" selected.',
  fetchRaw,
  normalize,
};
