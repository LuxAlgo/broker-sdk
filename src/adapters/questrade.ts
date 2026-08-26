import { BrokerAuthError, BrokerRequestError, MissingCredentialsError } from "../errors.js";
import type { Account, Position, Trade } from "../schema.js";
import { asFiniteNumber, asIsoTimestamp, rejectResponse } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  Questrade (Canada), read-only via the user's own API refresh token
  (generated self-serve in Questrade's API centre). The token is single-use:
  every exchange returns a fresh access token AND a fresh refresh token, so
  the rotated pair is handed back through rotatedCredentials — persist it
  before the old one dies. Accounts, balances, positions, and the last month
  of trade activities.
*/

const QUESTRADE_LOGIN = "https://login.questrade.com";
const ACTIVITY_WINDOW_DAYS = 30;

type QuestradeBalances = {
  combinedBalances?: { currency?: string; totalEquity?: number }[];
  perCurrencyBalances?: { currency?: string; totalEquity?: number }[];
};
type QuestradePositions = {
  positions?: { symbol?: string; openQuantity?: number; currentMarketValue?: number; averageEntryPrice?: number }[];
};
type QuestradeActivity = {
  type?: string;
  action?: string;
  symbol?: string;
  quantity?: number;
  price?: number;
  commission?: number;
  tradeDate?: string;
};

export type QuestradeRaw = {
  accounts: {
    accountNumber: string;
    balances: QuestradeBalances;
    positions: QuestradePositions;
    activities: QuestradeActivity[];
  }[];
};

/** Pure mapper from Questrade activities to trades; only real executions pass. */
export const parseQuestradeActivities = (activities: QuestradeActivity[] | undefined): Trade[] => {
  const trades: Trade[] = [];
  for (const activity of activities ?? []) {
    if (activity.type !== "Trades") continue;
    const action = activity.action?.toLowerCase();
    const side = action === "buy" ? "buy" : action === "sell" ? "sell" : null;
    const quantity = Math.abs(activity.quantity ?? 0);
    const price = activity.price ?? 0;
    if (!activity.symbol || !side || quantity <= 0 || price <= 0) continue;
    const commission = Math.abs(activity.commission ?? 0);
    const executedAt = asIsoTimestamp(activity.tradeDate);
    trades.push({
      symbol: activity.symbol,
      side,
      quantity,
      price,
      ...(commission > 0 ? { fee: commission } : {}),
      ...(executedAt ? { executedAt } : {}),
    });
  }
  return trades;
};

const normalize = (raw: QuestradeRaw): Account[] => {
  const accounts: Account[] = [];
  for (const entry of raw.accounts) {
    const positions: Position[] = [];
    for (const position of entry.positions.positions ?? []) {
      const quantity = position.openQuantity ?? 0;
      if (!position.symbol || quantity === 0) continue;
      const marketValue = asFiniteNumber(position.currentMarketValue);
      const averageEntryPrice = asFiniteNumber(position.averageEntryPrice);
      positions.push({
        symbol: position.symbol,
        quantity,
        ...(marketValue !== undefined ? { marketValue } : {}),
        ...(averageEntryPrice !== undefined ? { averageEntryPrice } : {}),
      });
    }

    const combined = entry.balances.combinedBalances ?? entry.balances.perCurrencyBalances ?? [];
    const cad = combined.find((balance) => balance.currency === "CAD") ?? combined[0];
    const totalEquity = asFiniteNumber(cad?.totalEquity);

    accounts.push({
      id: entry.accountNumber,
      name: `Questrade ${entry.accountNumber}`,
      currency: cad?.currency ?? "CAD",
      equity: totalEquity ?? 0,
      positions,
      trades: parseQuestradeActivities(entry.activities),
    });
  }
  return accounts;
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext) => {
  const { refreshToken } = credentials;
  if (!refreshToken) {
    throw new MissingCredentialsError("questrade", "Questrade connection is missing its refresh token");
  }

  // Single-use token exchange; a failure here usually means the token was
  // consumed elsewhere — the user re-generates one in Questrade's API centre.
  const tokenResponse = await ctx.fetch(
    `${QUESTRADE_LOGIN}/oauth2/token?grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  );
  if (!tokenResponse.ok) {
    throw new BrokerAuthError(
      "questrade",
      "Questrade rejected the token — generate a new one in the API centre and reconnect",
    );
  }
  type QuestradeTokens = { access_token?: string; refresh_token?: string; api_server?: string };
  const tokens = (await tokenResponse.json()) as QuestradeTokens;
  const accessToken = tokens.access_token;
  const apiServer = tokens.api_server;
  if (!accessToken || !apiServer || !tokens.refresh_token) {
    throw new BrokerRequestError("questrade", "Questrade returned an incomplete token exchange");
  }

  const get = async <T>(path: string): Promise<T> => {
    const response = await ctx.fetch(`${apiServer}v1${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) rejectResponse("questrade", "Questrade", response);
    return (await response.json()) as T;
  };

  type QuestradeAccounts = { accounts?: { number?: string; type?: string }[] };
  const accountsBody = await get<QuestradeAccounts>("/accounts");
  const accountNumbers = (accountsBody.accounts ?? [])
    .map((account) => account.number)
    .filter((accountNumber): accountNumber is string => Boolean(accountNumber));
  if (accountNumbers.length === 0) {
    throw new BrokerRequestError("questrade", "Questrade returned no accounts for this token");
  }

  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const activityRange = `startTime=${encodeURIComponent(startTime.toISOString())}&endTime=${encodeURIComponent(endTime.toISOString())}`;

  const accounts = [];
  for (const accountNumber of accountNumbers) {
    const [balances, positions, activitiesBody] = await Promise.all([
      get<QuestradeBalances>(`/accounts/${accountNumber}/balances`),
      get<QuestradePositions>(`/accounts/${accountNumber}/positions`),
      get<{ activities?: QuestradeActivity[] }>(`/accounts/${accountNumber}/activities?${activityRange}`),
    ]);
    accounts.push({ accountNumber, balances, positions, activities: activitiesBody.activities ?? [] });
  }

  return {
    raw: { accounts },
    // The old refresh token is now dead — persist the rotated one.
    rotatedCredentials: { refreshToken: tokens.refresh_token },
  };
};

export const questrade: BrokerAdapter<QuestradeRaw> = {
  id: "questrade",
  displayName: "Questrade",
  credentials: [{ key: "refreshToken", label: "API refresh token", secret: true }],
  readOnlySetup:
    "Generate a refresh token in Questrade's API centre. Tokens are single-use and rotate on every fetch — persist rotatedCredentials (see onCredentialsRotated) or the connection dies.",
  fetchRaw,
  normalize,
};
