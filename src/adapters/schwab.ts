import { BrokerAuthError, MissingCredentialsError } from "../errors.js";
import type { Account, AssetClass, Position, Trade } from "../schema.js";
import { asFiniteNumber, asIsoTimestamp, rejectResponse } from "./http.js";
import type { AdapterFetchResult, BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  Charles Schwab, OAuth2 with YOUR OWN application (bring-your-own-app:
  register a free individual developer app at developer.schwab.com with the
  Accounts and Trading Production product). Run `buildSchwabAuthorizeUrl` +
  `exchangeSchwabCode` once to obtain tokens, then connect with the full
  credential set. Access tokens are short-lived (30 minutes); fetch
  refreshes when expired and hands the rotated set back through
  rotatedCredentials — persist it via onCredentialsRotated. Schwab refresh
  tokens themselves expire after 7 days and then require a re-authorize;
  that surfaces as a BrokerAuthError, never a silent wrong answer.

  Endpoint paths follow the published Schwab Trader API (api.schwabapi.com);
  the daily canary validates them against a real account.
*/

const SCHWAB_API = "https://api.schwabapi.com";
const SCHWAB_AUTH = `${SCHWAB_API}/v1/oauth`;
const HISTORY_DAYS = 90;

export const buildSchwabAuthorizeUrl = (clientId: string, redirectUri: string, state: string): string => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });
  return `${SCHWAB_AUTH}/authorize?${params.toString()}`;
};

type SchwabTokens = { access_token: string; refresh_token?: string; expires_in: number };

const requestTokens = async (
  clientId: string,
  clientSecret: string,
  body: URLSearchParams,
  fetchImpl: typeof globalThis.fetch,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt: string }> => {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetchImpl(`${SCHWAB_AUTH}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  });
  if (!response.ok) {
    throw new BrokerAuthError("schwab", `Schwab token request failed (${response.status})`);
  }
  const tokens = (await response.json()) as SchwabTokens;
  return {
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  };
};

/** One-time: exchange the OAuth callback code for the initial token set. */
export const exchangeSchwabCode = async (
  options: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
) =>
  requestTokens(
    options.clientId,
    options.clientSecret,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: options.redirectUri,
    }),
    fetchImpl,
  );

const SCHWAB_ASSET_CLASSES: Record<string, AssetClass> = {
  EQUITY: "equity",
  ETF: "equity",
  MUTUAL_FUND: "equity",
  OPTION: "option",
  FUTURE: "futures",
  FOREX: "forex",
  CASH_EQUIVALENT: "cash",
  FIXED_INCOME: "other",
};

type SchwabInstrument = { symbol?: string; assetType?: string };
type SchwabPosition = {
  instrument?: SchwabInstrument;
  longQuantity?: number;
  shortQuantity?: number;
  marketValue?: number;
  averagePrice?: number;
};
type SchwabBalances = { liquidationValue?: number; cashBalance?: number };
type SchwabAccountEntry = {
  securitiesAccount?: {
    accountNumber?: string;
    currentBalances?: SchwabBalances;
    positions?: SchwabPosition[];
  };
};
type SchwabTransferItem = { instrument?: SchwabInstrument; amount?: number; price?: number };
type SchwabTransaction = { type?: string; tradeDate?: string; transferItems?: SchwabTransferItem[] };

export type SchwabRaw = {
  accounts: SchwabAccountEntry[];
  /** TRADE transactions keyed by account number; empty when the call failed. */
  transactions: Record<string, SchwabTransaction[]>;
};

/** Pure mapper from Schwab TRADE transactions to trades; bad rows drop out. */
export const parseSchwabTransactions = (transactions: SchwabTransaction[] | undefined): Trade[] => {
  const trades: Trade[] = [];
  for (const tx of Array.isArray(transactions) ? transactions : []) {
    if (tx?.type !== "TRADE") continue;
    const executedAt = asIsoTimestamp(tx.tradeDate);
    for (const item of Array.isArray(tx.transferItems) ? tx.transferItems : []) {
      if (!item.instrument?.symbol || item.instrument.assetType === "CURRENCY") continue;
      const amount = asFiniteNumber(item.amount);
      const price = asFiniteNumber(item.price);
      if (amount === undefined || amount === 0 || price === undefined || price <= 0) continue;
      trades.push({
        symbol: item.instrument.symbol,
        side: amount > 0 ? "buy" : "sell",
        quantity: Math.abs(amount),
        price,
        ...(executedAt ? { executedAt } : {}),
      });
    }
  }
  return trades;
};

const normalize = (raw: SchwabRaw): Account[] => {
  const accounts: Account[] = [];
  for (const entry of Array.isArray(raw.accounts) ? raw.accounts : []) {
    const securities = entry?.securitiesAccount;
    const accountNumber = securities?.accountNumber;
    if (!securities || !accountNumber) continue;

    const positions: Position[] = [];
    for (const position of Array.isArray(securities.positions) ? securities.positions : []) {
      if (!position.instrument?.symbol) continue;
      const quantity = (asFiniteNumber(position.longQuantity) ?? 0) - (asFiniteNumber(position.shortQuantity) ?? 0);
      if (quantity === 0) continue;
      const marketValue = asFiniteNumber(position.marketValue);
      const averageEntryPrice = asFiniteNumber(position.averagePrice);
      const assetClass = position.instrument.assetType
        ? SCHWAB_ASSET_CLASSES[position.instrument.assetType]
        : undefined;
      positions.push({
        symbol: position.instrument.symbol,
        quantity,
        ...(marketValue !== undefined ? { marketValue } : {}),
        ...(averageEntryPrice !== undefined ? { averageEntryPrice } : {}),
        ...(assetClass ? { assetClass } : {}),
      });
    }

    const equity = asFiniteNumber(securities.currentBalances?.liquidationValue);
    const cash = asFiniteNumber(securities.currentBalances?.cashBalance);

    accounts.push({
      id: accountNumber,
      name: `Schwab ${accountNumber}`,
      currency: "USD",
      equity: equity ?? positions.reduce((sum, p) => sum + (p.marketValue ?? 0), 0),
      ...(cash !== undefined ? { cash } : {}),
      positions,
      trades: parseSchwabTransactions(raw.transactions?.[accountNumber]),
    });
  }
  return accounts;
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext): Promise<AdapterFetchResult<SchwabRaw>> => {
  const clientId = credentials.clientId?.trim();
  const clientSecret = credentials.clientSecret?.trim();
  const refreshToken = credentials.refreshToken?.trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new MissingCredentialsError("schwab", "Schwab connection is missing clientId, clientSecret, or refreshToken");
  }

  // Refresh when the stored access token is absent or within a minute of
  // expiry; an unparseable expiresAt compares false and forces the refresh.
  let accessToken = credentials.accessToken;
  let rotatedCredentials: Credentials | undefined;
  const expiresAtMs = credentials.expiresAt ? new Date(credentials.expiresAt).getTime() : Number.NaN;
  if (!accessToken || !(expiresAtMs >= Date.now() + 60_000)) {
    const tokens = await requestTokens(
      clientId,
      clientSecret,
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
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
    const response = await ctx.fetch(`${SCHWAB_API}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) rejectResponse("schwab", "Schwab", response);
    return (await response.json()) as T;
  };

  const accounts = await get<SchwabAccountEntry[]>("/trader/v1/accounts?fields=positions");

  // Hashed account ids gate the per-account endpoints; a failure here only
  // costs trade history, never the balances already fetched.
  const transactions: Record<string, SchwabTransaction[]> = {};
  try {
    const numbers = await get<{ accountNumber?: string; hashValue?: string }[]>(
      "/trader/v1/accounts/accountNumbers",
    );
    const endDate = new Date().toISOString();
    const startDate = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    for (const entry of Array.isArray(numbers) ? numbers : []) {
      if (!entry?.accountNumber || !entry.hashValue) continue;
      transactions[entry.accountNumber] = await get<SchwabTransaction[]>(
        `/trader/v1/accounts/${entry.hashValue}/transactions?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&types=TRADE`,
      ).catch(() => []);
    }
  } catch {
    // fail-soft: history is optional, balances are not
  }

  return {
    raw: { accounts, transactions },
    ...(rotatedCredentials ? { rotatedCredentials } : {}),
  };
};

export const schwab: BrokerAdapter<SchwabRaw> = {
  id: "schwab",
  displayName: "Charles Schwab",
  credentials: [
    { key: "clientId", label: "OAuth app key (your own Schwab developer app)", secret: false },
    { key: "clientSecret", label: "OAuth app secret", secret: true },
    { key: "refreshToken", label: "OAuth refresh token", secret: true },
    { key: "accessToken", label: "OAuth access token (optional, auto-refreshed)", secret: true },
    { key: "expiresAt", label: "Access token expiry (optional, ISO timestamp)", secret: false },
  ],
  readOnlySetup:
    "Create a free individual developer app at developer.schwab.com (Accounts and Trading Production), authorize it once with buildSchwabAuthorizeUrl/exchangeSchwabCode, and persist the rotated tokens; this SDK only ever calls the accounts, positions, and transactions endpoints.",
  fetchRaw,
  normalize,
};
