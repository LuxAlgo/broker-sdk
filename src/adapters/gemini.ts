import { createHmac } from "node:crypto";

import { BrokerRequestError, MissingCredentialsError } from "../errors.js";
import type { Account, Position } from "../schema.js";
import { asFiniteNumber, rejectResponse } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  Gemini, read-only API key + secret (key created with only the Auditor
  role). One signed /v1/balances call. Gemini's private REST is POST-only
  with the request described in a base64 JSON payload header and signed with
  HMAC-SHA384 — the body itself stays empty.

  Valuation is deliberately conservative: /v1/balances carries no prices, so
  only USD is priced (at face, into `cash`) and every other holding stays an
  unpriced position with no marketValue. `equity` is therefore just the USD
  cash — a smaller-but-true number rather than a guessed one (omit-don't-
  guess, same posture as the schema's marketValue contract). Non-USD fiat
  balances are kept as `cash`-class positions but not summed into equity,
  because folding them into a USD figure would fabricate an FX conversion.

  Trade history is skipped on purpose: /v1/mytrades requires a symbol
  parameter per call, and the balances payload does not say which symbols
  ever traded — guessing symbols is worse than returning no history.
*/

const GEMINI_API = "https://api.gemini.com";

/** Fiat currencies Gemini can custody; only USD folds into cash/equity. */
const GEMINI_FIAT = new Set(["USD", "EUR", "GBP", "SGD", "CAD", "AUD", "JPY", "CHF"]);

type GeminiBalance = {
  currency?: string;
  amount?: string;
  available?: string;
};

export type GeminiRaw = {
  /** /v1/balances rows: currency code with total and available amounts. */
  balances: GeminiBalance[];
};

const normalize = (raw: GeminiRaw): Account[] => {
  const positions: Position[] = [];
  let cash = 0;
  for (const balance of Array.isArray(raw.balances) ? raw.balances : []) {
    const quantity = asFiniteNumber(balance.amount);
    if (!balance.currency || quantity === undefined || quantity <= 0) continue;
    const symbol = balance.currency.toUpperCase();
    if (symbol === "USD") {
      cash += quantity;
      continue;
    }
    positions.push({
      symbol,
      quantity,
      // No prices in /v1/balances → no marketValue; fiat is cash, coins are crypto.
      assetClass: GEMINI_FIAT.has(symbol) ? "cash" : "crypto",
    });
  }

  return [
    {
      id: "gemini-exchange",
      name: "Gemini exchange",
      currency: "USD",
      // Nothing besides USD is priced, so equity is exactly the cash.
      equity: cash,
      cash,
      positions,
      trades: [],
    },
  ];
};

/** Gemini private REST: base64 JSON payload header, hex HMAC-SHA384 signature, empty body. */
const geminiPrivate = async <T>(path: string, apiKey: string, apiSecret: string, ctx: FetchContext): Promise<T> => {
  const payload = Buffer.from(JSON.stringify({ request: path, nonce: Date.now() }), "utf8").toString("base64");
  const signature = createHmac("sha384", apiSecret).update(payload).digest("hex");
  const response = await ctx.fetch(`${GEMINI_API}${path}`, {
    method: "POST",
    headers: {
      "X-GEMINI-APIKEY": apiKey,
      "X-GEMINI-PAYLOAD": payload,
      "X-GEMINI-SIGNATURE": signature,
      "Content-Type": "text/plain",
    },
  });
  if (!response.ok) rejectResponse("gemini", "Gemini", response);
  return (await response.json()) as T;
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext) => {
  const { apiKey, apiSecret } = credentials;
  if (!apiKey || !apiSecret) {
    throw new MissingCredentialsError("gemini", "Gemini connection is missing its API key or secret");
  }

  const balances = await geminiPrivate<GeminiBalance[] | { message?: string; reason?: string }>(
    "/v1/balances",
    apiKey,
    apiSecret,
    ctx,
  );
  if (!Array.isArray(balances)) {
    throw new BrokerRequestError("gemini", `Gemini error: ${balances.message ?? balances.reason ?? "unexpected response"}`);
  }

  return { raw: { balances } };
};

export const gemini: BrokerAdapter<GeminiRaw> = {
  id: "gemini",
  displayName: "Gemini",
  credentials: [
    { key: "apiKey", label: "API key", secret: false },
    { key: "apiSecret", label: "API secret", secret: true },
  ],
  readOnlySetup: "Create an API key at exchange.gemini.com/settings/api with only the Auditor (read) role.",
  fetchRaw,
  normalize,
};
