import { createHmac, randomBytes } from "node:crypto";

import { BrokerAuthError, BrokerRequestError, MissingCredentialsError } from "../errors.js";
import type { Account, Position, Trade } from "../schema.js";
import { asFiniteNumber } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  E*TRADE, read-only via OAuth 1.0a with YOUR OWN developer key (their API
  predates OAuth2). Bring-your-own-app: request an individual API key at
  developer.etrade.com (free), then run the flow — request token → the user
  signs in at us.etrade.com and reads back a short verification code →
  access token (`createEtradeOAuthFlow` below). Access tokens die at
  midnight US Eastern every day, so a connection syncs all day and then
  needs a re-auth the next morning — that is the broker's design, not a bug.
  OAuth endpoints always live on api.etrade.com; resource calls hit apisb
  (sandbox) or api (production) — production, i.e. your real account, is
  the default for a personal key.
*/

const ETRADE_OAUTH_HOST = "https://api.etrade.com";
const ETRADE_PRODUCTION_HOST = "https://api.etrade.com";
const ETRADE_SANDBOX_HOST = "https://apisb.etrade.com";
const TRANSACTION_WINDOW_DAYS = 30;

/** RFC 3986 percent-encoding, exactly as OAuth 1.0a requires. */
const rfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * The OAuth 1.0a signature base string: METHOD & enc(url) & enc(sorted
 * k=v params). Exported for tests — this string IS the protocol contract.
 */
export const oauth1SignatureBase = (method: string, url: string, params: Record<string, string>): string => {
  const pairs = Object.entries(params)
    .map(([key, value]) => [rfc3986(key), rfc3986(value)] as const)
    .sort(([aKey, aValue], [bKey, bValue]) => (aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey)))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return `${method.toUpperCase()}&${rfc3986(url)}&${rfc3986(pairs)}`;
};

/** HMAC-SHA1 over the base string; key = enc(consumerSecret)&enc(tokenSecret). */
export const oauth1Signature = (base: string, consumerSecret: string, tokenSecret: string): string =>
  createHmac("sha1", `${rfc3986(consumerSecret)}&${rfc3986(tokenSecret)}`)
    .update(base)
    .digest("base64");

type ConsumerPair = { consumerKey: string; consumerSecret: string };
type TokenPair = { token: string; secret: string };

const oauth1Header = (
  method: string,
  url: string,
  consumer: ConsumerPair,
  tokenPair: TokenPair | null,
  extra: Record<string, string>,
  query: Record<string, string> = {},
): string => {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumer.consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...(tokenPair ? { oauth_token: tokenPair.token } : {}),
    ...extra,
  };
  const base = oauth1SignatureBase(method, url, { ...oauthParams, ...query });
  const signature = oauth1Signature(base, consumer.consumerSecret, tokenPair?.secret ?? "");
  const header = Object.entries({ ...oauthParams, oauth_signature: signature })
    .map(([key, value]) => `${rfc3986(key)}="${rfc3986(value)}"`)
    .join(", ");
  return `OAuth ${header}`;
};

/**
 * OAuth endpoints answer with form-encoded token pairs. Split on the FIRST
 * "=" only — token secrets are often base64 and carry "=" padding, which a
 * naive split would drop, silently losing the token. Exported for tests.
 */
export const parseFormBody = (body: string): Record<string, string> =>
  Object.fromEntries(
    body
      .split("&")
      .filter((pair) => pair.includes("="))
      .map((pair) => {
        const separator = pair.indexOf("=");
        return [decodeURIComponent(pair.slice(0, separator)), decodeURIComponent(pair.slice(separator + 1))] as const;
      }),
  );

/**
 * The bring-your-own-app authorization flow. Run once to obtain the daily
 * access token pair, then pass everything to `connect` as credentials:
 *
 *   const flow = createEtradeOAuthFlow({ consumerKey, consumerSecret });
 *   const { authorizeUrl, requestToken, requestTokenSecret } = await flow.start();
 *   // send the user to authorizeUrl; they read back a verification code
 *   const tokens = await flow.exchange(requestToken, requestTokenSecret, code);
 */
export const createEtradeOAuthFlow = (
  consumer: ConsumerPair,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
) => {
  const oauthCall = async (url: string, tokenPair: TokenPair | null, extra: Record<string, string>) => {
    const response = await fetchImpl(url, {
      headers: { Authorization: oauth1Header("GET", url, consumer, tokenPair, extra) },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new BrokerRequestError("etrade", `E*TRADE rejected the request (${response.status})`, response.status);
    }
    return parseFormBody(body);
  };

  return {
    start: async (): Promise<{ authorizeUrl: string; requestToken: string; requestTokenSecret: string }> => {
      const tokens = await oauthCall(`${ETRADE_OAUTH_HOST}/oauth/request_token`, null, { oauth_callback: "oob" });
      if (!tokens.oauth_token || !tokens.oauth_token_secret) {
        throw new BrokerRequestError("etrade", "E*TRADE returned no request token");
      }
      return {
        authorizeUrl: `https://us.etrade.com/e/t/etws/authorize?key=${encodeURIComponent(consumer.consumerKey)}&token=${encodeURIComponent(tokens.oauth_token)}`,
        requestToken: tokens.oauth_token,
        requestTokenSecret: tokens.oauth_token_secret,
      };
    },
    exchange: async (
      requestToken: string,
      requestTokenSecret: string,
      verifier: string,
    ): Promise<{ accessToken: string; accessTokenSecret: string }> => {
      const tokens = await oauthCall(
        `${ETRADE_OAUTH_HOST}/oauth/access_token`,
        { token: requestToken, secret: requestTokenSecret },
        { oauth_verifier: verifier },
      );
      if (!tokens.oauth_token || !tokens.oauth_token_secret) {
        throw new BrokerAuthError("etrade", "E*TRADE rejected the verification code — start the connection again");
      }
      return { accessToken: tokens.oauth_token, accessTokenSecret: tokens.oauth_token_secret };
    },
  };
};

type EtradeAccountRow = { accountId?: string; accountIdKey?: string; accountDesc?: string; accountType?: string };
export type EtradeTransaction = {
  transactionType?: string;
  transactionDate?: number;
  fee?: number;
  brokerage?: { quantity?: number; price?: number; product?: { symbol?: string } };
};
type EtradeBalance = { BalanceResponse?: { Computed?: { RealTimeValues?: { totalAccountValue?: number } } } };
type EtradePortfolio = {
  PortfolioResponse?: {
    AccountPortfolio?: { Position?: { quantity?: number; marketValue?: number; Product?: { symbol?: string } }[] }[];
  };
};

export type EtradeRaw = {
  accounts: {
    accountIdKey: string;
    accountId?: string;
    accountDesc?: string;
    balance: EtradeBalance;
    portfolio: EtradePortfolio | null;
    transactions: EtradeTransaction[];
  }[];
};

/** Pure mapper: Bought/Sold rows (any variant) become trades; income and transfers do not. */
export const parseEtradeTransactions = (transactions: EtradeTransaction[]): Trade[] => {
  const trades: Trade[] = [];
  for (const transaction of transactions) {
    const type = transaction.transactionType?.toLowerCase() ?? "";
    const side = type.includes("bought") ? "buy" : type.includes("sold") ? "sell" : null;
    const symbol = transaction.brokerage?.product?.symbol;
    const quantity = Math.abs(transaction.brokerage?.quantity ?? 0);
    const price = transaction.brokerage?.price ?? 0;
    if (!side || !symbol || quantity <= 0 || price <= 0) continue;
    const fee = Math.abs(transaction.fee ?? 0);
    trades.push({
      symbol,
      side,
      quantity,
      price,
      ...(fee > 0 ? { fee } : {}),
      ...(transaction.transactionDate ? { executedAt: new Date(transaction.transactionDate).toISOString() } : {}),
    });
  }
  return trades;
};

const normalize = (raw: EtradeRaw): Account[] => {
  const accounts: Account[] = [];
  for (const entry of raw.accounts) {
    const positions: Position[] = [];
    for (const page of entry.portfolio?.PortfolioResponse?.AccountPortfolio ?? []) {
      for (const position of page.Position ?? []) {
        const symbol = position.Product?.symbol;
        const quantity = position.quantity ?? 0;
        if (!symbol || quantity === 0) continue;
        const marketValue = asFiniteNumber(position.marketValue);
        positions.push({ symbol, quantity, ...(marketValue !== undefined ? { marketValue } : {}) });
      }
    }

    const totalValue = asFiniteNumber(entry.balance.BalanceResponse?.Computed?.RealTimeValues?.totalAccountValue);
    accounts.push({
      id: entry.accountIdKey,
      name: entry.accountDesc || `E*TRADE ${entry.accountId ?? ""}`.trim(),
      currency: "USD",
      equity: totalValue ?? 0,
      positions,
      trades: parseEtradeTransactions(entry.transactions),
    });
  }
  return accounts;
};

const etradeDate = (date: Date): string =>
  `${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}${date.getUTCFullYear()}`;

const fetchRaw = async (credentials: Credentials, ctx: FetchContext) => {
  const { consumerKey, consumerSecret, accessToken, accessTokenSecret } = credentials;
  if (!consumerKey || !consumerSecret) {
    throw new MissingCredentialsError("etrade", "E*TRADE connection is missing its consumer key/secret (bring your own developer app — see docs/byo-oauth.md)");
  }
  if (!accessToken || !accessTokenSecret) {
    throw new MissingCredentialsError("etrade", "E*TRADE connection is missing its access token — run createEtradeOAuthFlow first");
  }
  const consumer = { consumerKey, consumerSecret };
  const tokenPair = { token: accessToken, secret: accessTokenSecret };
  // Personal keys work against production (your own account); sandbox keys opt in.
  const apiHost = credentials.environment === "sandbox" ? ETRADE_SANDBOX_HOST : ETRADE_PRODUCTION_HOST;

  // Tokens idle out after two hours; a renew brings an inactive (but not
  // yet expired) token back. Failure just means the real call decides.
  await ctx
    .fetch(`${ETRADE_OAUTH_HOST}/oauth/renew_access_token`, {
      headers: {
        Authorization: oauth1Header("GET", `${ETRADE_OAUTH_HOST}/oauth/renew_access_token`, consumer, tokenPair, {}),
      },
    })
    .catch(() => undefined);

  const signedGet = async <T>(path: string, query: Record<string, string> = {}): Promise<T> => {
    const url = `${apiHost}${path}`;
    const search = new URLSearchParams(query).toString();
    const response = await ctx.fetch(search ? `${url}?${search}` : url, {
      headers: { Authorization: oauth1Header("GET", url, consumer, tokenPair, {}, query) },
    });
    if (response.status === 401) {
      throw new BrokerAuthError("etrade", "E*TRADE session expired (their tokens end at midnight US Eastern) — re-run the authorization flow");
    }
    if (!response.ok) {
      throw new BrokerRequestError("etrade", `E*TRADE rejected the request (${response.status})`, response.status);
    }
    return (await response.json()) as T;
  };

  const list = await signedGet<{ AccountListResponse?: { Accounts?: { Account?: EtradeAccountRow[] } } }>(
    "/v1/accounts/list.json",
  );
  const accountRows = (list.AccountListResponse?.Accounts?.Account ?? []).filter(
    (account): account is EtradeAccountRow & { accountIdKey: string } => Boolean(account.accountIdKey),
  );
  if (accountRows.length === 0) {
    throw new BrokerRequestError("etrade", "E*TRADE returned no accounts for this connection");
  }

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - TRANSACTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const accounts = [];
  for (const account of accountRows) {
    const [balance, portfolio, transactions] = await Promise.all([
      signedGet<EtradeBalance>(`/v1/accounts/${account.accountIdKey}/balance.json`, {
        instType: "BROKERAGE",
        realTimeNAV: "true",
      }),
      signedGet<EtradePortfolio>(`/v1/accounts/${account.accountIdKey}/portfolio.json`).catch(() => null),
      signedGet<{ TransactionListResponse?: { Transaction?: EtradeTransaction[] } }>(
        `/v1/accounts/${account.accountIdKey}/transactions.json`,
        { startDate: etradeDate(startDate), endDate: etradeDate(endDate), count: "50" },
      ).catch(() => null),
    ]);
    accounts.push({
      accountIdKey: account.accountIdKey,
      ...(account.accountId !== undefined ? { accountId: account.accountId } : {}),
      ...(account.accountDesc !== undefined ? { accountDesc: account.accountDesc } : {}),
      balance,
      portfolio,
      transactions: transactions?.TransactionListResponse?.Transaction ?? [],
    });
  }

  return { raw: { accounts } };
};

export const etrade: BrokerAdapter<EtradeRaw> = {
  id: "etrade",
  displayName: "E*TRADE",
  credentials: [
    { key: "consumerKey", label: "Your app's consumer key", secret: false },
    { key: "consumerSecret", label: "Your app's consumer secret", secret: true },
    { key: "accessToken", label: "OAuth access token (daily)", secret: true },
    { key: "accessTokenSecret", label: "OAuth access token secret (daily)", secret: true },
  ],
  readOnlySetup:
    "Bring your own app: request a free individual API key at developer.etrade.com, then run createEtradeOAuthFlow to get the daily access token pair. Tokens expire at midnight US Eastern — E*TRADE's rule, not ours.",
  fetchRaw,
  normalize,
};
