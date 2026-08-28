import { BrokerAuthError, MissingCredentialsError } from "../errors.js";
import type { Account, AssetClass, Position } from "../schema.js";
import { asFiniteNumber, rejectResponse } from "./http.js";
import type { AdapterFetchResult, BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  TradeStation, OAuth2 with YOUR OWN application (bring-your-own-app:
  request API access at developer.tradestation.com and use the ReadAccount
  scope). Run `buildTradestationAuthorizeUrl` + `exchangeTradestationCode`
  once to obtain tokens, then connect with the full credential set. Access
  tokens are short-lived (20 minutes); fetch refreshes when expired and hands
  the rotated set back through rotatedCredentials — persist it via
  onCredentialsRotated. `offline_access` in the scope is what makes the
  refresh token come back at all.

  Endpoint paths follow the published TradeStation v3 brokerage API
  (api.tradestation.com/v3, sign-in at signin.tradestation.com); the daily
  canary validates them against a real account. v3's read scope exposes no
  clean fills endpoint, so trades stay empty — never fabricated.
*/

const TRADESTATION_API = "https://api.tradestation.com";
const TRADESTATION_SIGNIN = "https://signin.tradestation.com";

export const buildTradestationAuthorizeUrl = (clientId: string, redirectUri: string, state: string): string => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    audience: TRADESTATION_API,
    scope: "ReadAccount offline_access",
    state,
  });
  return `${TRADESTATION_SIGNIN}/authorize?${params.toString()}`;
};

type TradestationTokens = { access_token: string; refresh_token?: string; expires_in: number };

const requestTokens = async (
  body: URLSearchParams,
  fetchImpl: typeof globalThis.fetch,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt: string }> => {
  const response = await fetchImpl(`${TRADESTATION_SIGNIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new BrokerAuthError("tradestation", `TradeStation token request failed (${response.status})`);
  }
  const tokens = (await response.json()) as TradestationTokens;
  return {
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  };
};

/** One-time: exchange the OAuth callback code for the initial token set. */
export const exchangeTradestationCode = async (
  options: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
) =>
  requestTokens(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code: options.code,
      redirect_uri: options.redirectUri,
    }),
    fetchImpl,
  );

const TRADESTATION_ASSET_CLASSES: Record<string, AssetClass> = {
  STOCK: "equity",
  STOCKOPTION: "option",
  INDEXOPTION: "option",
  FUTURE: "futures",
};

type TradestationAccount = { AccountID?: string; Currency?: string; AccountType?: string };
type TradestationBalance = { AccountID?: string; Equity?: string | number; CashBalance?: string | number };
type TradestationPosition = {
  AccountID?: string;
  Symbol?: string;
  /** Signed by the API — negative for short positions. */
  Quantity?: string | number;
  MarketValue?: string | number;
  AveragePrice?: string | number;
  AssetType?: string;
};

export type TradestationRaw = {
  accounts: TradestationAccount[];
  balances: TradestationBalance[];
  positions: TradestationPosition[];
};

const normalize = (raw: TradestationRaw): Account[] => {
  const balances = Array.isArray(raw.balances) ? raw.balances : [];
  const positions = Array.isArray(raw.positions) ? raw.positions : [];

  const accounts: Account[] = [];
  for (const account of Array.isArray(raw.accounts) ? raw.accounts : []) {
    const accountId = account?.AccountID;
    if (!accountId) continue;

    const accountPositions: Position[] = [];
    for (const position of positions) {
      if (position?.AccountID !== accountId || !position.Symbol) continue;
      const quantity = asFiniteNumber(position.Quantity);
      if (quantity === undefined || quantity === 0) continue;
      const marketValue = asFiniteNumber(position.MarketValue);
      const averageEntryPrice = asFiniteNumber(position.AveragePrice);
      const assetClass = position.AssetType ? TRADESTATION_ASSET_CLASSES[position.AssetType] : undefined;
      accountPositions.push({
        symbol: position.Symbol,
        quantity,
        ...(marketValue !== undefined ? { marketValue } : {}),
        ...(averageEntryPrice !== undefined ? { averageEntryPrice } : {}),
        ...(assetClass ? { assetClass } : {}),
      });
    }

    const balance = balances.find((entry) => entry?.AccountID === accountId);
    const equity = asFiniteNumber(balance?.Equity);
    const cash = asFiniteNumber(balance?.CashBalance);

    accounts.push({
      id: accountId,
      name: `TradeStation ${accountId}`,
      currency: account.Currency || "USD",
      equity: equity ?? accountPositions.reduce((sum, p) => sum + (p.marketValue ?? 0), 0),
      ...(cash !== undefined ? { cash } : {}),
      positions: accountPositions,
      // v3's read scope has no fills/executions endpoint — empty, never fabricated.
      trades: [],
    });
  }
  return accounts;
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext): Promise<AdapterFetchResult<TradestationRaw>> => {
  const clientId = credentials.clientId?.trim();
  const clientSecret = credentials.clientSecret?.trim();
  const refreshToken = credentials.refreshToken?.trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new MissingCredentialsError(
      "tradestation",
      "TradeStation connection is missing clientId, clientSecret, or refreshToken",
    );
  }

  // Refresh when the stored access token is absent or within a minute of
  // expiry; an unparseable expiresAt compares false and forces the refresh.
  let accessToken = credentials.accessToken;
  let rotatedCredentials: Credentials | undefined;
  const expiresAtMs = credentials.expiresAt ? new Date(credentials.expiresAt).getTime() : Number.NaN;
  if (!accessToken || !(expiresAtMs >= Date.now() + 60_000)) {
    const tokens = await requestTokens(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
      ctx.fetch,
    );
    accessToken = tokens.accessToken;
    rotatedCredentials = {
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    };
  }

  const get = async <T>(path: string): Promise<T> => {
    const response = await ctx.fetch(`${TRADESTATION_API}/v3${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) rejectResponse("tradestation", "TradeStation", response);
    return (await response.json()) as T;
  };

  const accountsBody = await get<{ Accounts?: TradestationAccount[] }>("/brokerage/accounts");
  const accounts = accountsBody.Accounts ?? [];
  const accountIds = accounts
    .map((account) => account.AccountID)
    .filter((accountId): accountId is string => Boolean(accountId));

  // Balances and positions take a comma-separated id list and answer for
  // every account in one call each.
  let balances: TradestationBalance[] = [];
  let positions: TradestationPosition[] = [];
  if (accountIds.length > 0) {
    const joinedIds = accountIds.join(",");
    const [balancesBody, positionsBody] = await Promise.all([
      get<{ Balances?: TradestationBalance[] }>(`/brokerage/accounts/${joinedIds}/balances`),
      get<{ Positions?: TradestationPosition[] }>(`/brokerage/accounts/${joinedIds}/positions`),
    ]);
    balances = balancesBody.Balances ?? [];
    positions = positionsBody.Positions ?? [];
  }

  return {
    raw: { accounts, balances, positions },
    ...(rotatedCredentials ? { rotatedCredentials } : {}),
  };
};

export const tradestation: BrokerAdapter<TradestationRaw> = {
  id: "tradestation",
  displayName: "TradeStation",
  credentials: [
    { key: "clientId", label: "OAuth app key (your own TradeStation API app)", secret: false },
    { key: "clientSecret", label: "OAuth app secret", secret: true },
    { key: "refreshToken", label: "OAuth refresh token", secret: true },
    { key: "accessToken", label: "OAuth access token (optional, auto-refreshed)", secret: true },
    { key: "expiresAt", label: "Access token expiry (optional, ISO timestamp)", secret: false },
  ],
  readOnlySetup:
    "Request your own API app at developer.tradestation.com, authorize it once with buildTradestationAuthorizeUrl/exchangeTradestationCode using the read-only ReadAccount scope (plus offline_access for the refresh token), and persist the rotated tokens; this SDK only ever calls the brokerage accounts, balances, and positions endpoints.",
  fetchRaw,
  normalize,
};
