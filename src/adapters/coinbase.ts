import { BrokerAuthError, BrokerRequestError, MissingCredentialsError } from "../errors.js";
import type { Account, Position } from "../schema.js";
import { asFiniteNumber } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  Coinbase, OAuth2 with YOUR OWN application (bring-your-own-app: create a
  free OAuth2 app at portal.cdp.coinbase.com and request only the read
  scope). Run `buildCoinbaseAuthorizeUrl` + `exchangeCoinbaseCode` once to
  obtain tokens, then connect with the full credential set. Access tokens
  are short-lived; fetch refreshes when expired and hands the rotated set
  back through rotatedCredentials — persist it via onCredentialsRotated.
*/

const COINBASE_AUTH = "https://login.coinbase.com/oauth2";
const COINBASE_API = "https://api.coinbase.com";
const COINBASE_SCOPE = "wallet:accounts:read";

export const buildCoinbaseAuthorizeUrl = (clientId: string, redirectUri: string, state: string): string => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: COINBASE_SCOPE,
  });
  return `${COINBASE_AUTH}/auth?${params.toString()}`;
};

type CoinbaseTokens = { access_token: string; refresh_token: string; expires_in: number };

const requestTokens = async (
  body: URLSearchParams,
  fetchImpl: typeof globalThis.fetch,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }> => {
  const response = await fetchImpl(`${COINBASE_AUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new BrokerAuthError("coinbase", `Coinbase token request failed (${response.status})`);
  }
  const tokens = (await response.json()) as CoinbaseTokens;
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  };
};

/** One-time: exchange the OAuth callback code for the initial token set. */
export const exchangeCoinbaseCode = async (
  options: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
) =>
  requestTokens(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: options.redirectUri,
    }),
    fetchImpl,
  );

type CoinbaseAccount = {
  id: string;
  name?: string;
  balance?: { amount: string; currency: string };
};

export type CoinbaseRaw = {
  accounts: CoinbaseAccount[];
  /** Public exchange rates: units of currency per 1 USD. */
  usdRates: Record<string, number>;
};

const normalize = (raw: CoinbaseRaw): Account[] => {
  const positions: Position[] = [];
  let equity = 0;
  for (const account of raw.accounts) {
    const quantity = asFiniteNumber(account.balance?.amount);
    const currency = account.balance?.currency;
    if (!currency || quantity === undefined || quantity <= 0) continue;
    // rates map is "units of currency per 1 USD", so value = quantity / rate.
    const rate = currency === "USD" ? 1 : raw.usdRates[currency];
    const marketValue = rate !== undefined && rate > 0 ? quantity / rate : undefined;
    if (marketValue !== undefined) equity += marketValue;
    positions.push({
      symbol: currency,
      quantity,
      ...(marketValue !== undefined ? { marketValue } : {}),
      assetClass: currency === "USD" ? "cash" : "crypto",
    });
  }

  return [
    {
      id: "coinbase-portfolio",
      name: "Coinbase",
      currency: "USD",
      equity,
      positions,
      trades: [],
    },
  ];
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext) => {
  const { clientId, clientSecret, refreshToken } = credentials;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new MissingCredentialsError(
      "coinbase",
      "Coinbase connection needs your app's clientId/clientSecret and a refreshToken (bring your own app — see docs/byo-oauth.md)",
    );
  }

  let accessToken = credentials.accessToken;
  let rotatedCredentials: Record<string, string> | undefined;
  const expired =
    !accessToken || !credentials.expiresAt || new Date(credentials.expiresAt).getTime() < Date.now() + 60_000;
  if (expired) {
    const refreshed = await requestTokens(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      ctx.fetch,
    );
    rotatedCredentials = refreshed;
    accessToken = refreshed.accessToken;
  }

  const response = await ctx.fetch(`${COINBASE_API}/v2/accounts?limit=100`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 401) {
    throw new BrokerAuthError("coinbase", "Coinbase session expired — re-run the authorization flow");
  }
  if (!response.ok) {
    throw new BrokerRequestError("coinbase", `Coinbase rejected the request (${response.status})`, response.status);
  }
  const body = (await response.json()) as { data?: CoinbaseAccount[] };

  const usdRates: Record<string, number> = {};
  const ratesResponse = await ctx.fetch(`${COINBASE_API}/v2/exchange-rates?currency=USD`);
  if (ratesResponse.ok) {
    const ratesBody = (await ratesResponse.json()) as { data?: { rates?: Record<string, string> } };
    for (const [currency, rate] of Object.entries(ratesBody.data?.rates ?? {})) {
      const parsed = asFiniteNumber(rate);
      if (parsed !== undefined && parsed > 0) usdRates[currency] = parsed;
    }
  }

  return {
    raw: { accounts: body.data ?? [], usdRates },
    ...(rotatedCredentials ? { rotatedCredentials } : {}),
  };
};

export const coinbase: BrokerAdapter<CoinbaseRaw> = {
  id: "coinbase",
  displayName: "Coinbase",
  credentials: [
    { key: "clientId", label: "Your app's OAuth client id", secret: false },
    { key: "clientSecret", label: "Your app's OAuth client secret", secret: true },
    { key: "refreshToken", label: "OAuth refresh token", secret: true },
  ],
  readOnlySetup:
    "Bring your own app: create a free OAuth2 app at portal.cdp.coinbase.com with only the wallet:accounts:read scope, then run buildCoinbaseAuthorizeUrl + exchangeCoinbaseCode to get tokens. Tokens rotate — persist onCredentialsRotated.",
  fetchRaw,
  normalize,
};
