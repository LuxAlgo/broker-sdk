import { BrokerAuthError, BrokerRequestError, MissingCredentialsError } from "../errors.js";
import type { Account, AssetClass, Position, Trade } from "../schema.js";
import { asFiniteNumber, asIsoTimestamp, rejectResponse } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  Public.com, read-only via the user's own API secret key (generated
  self-serve in Public's settings). The stored secret mints a short-lived
  bearer token per fetch (POST /userapiauthservice/personal/access-tokens),
  then the trading gateway serves accounts, the v2 portfolio, and
  transaction history. Endpoint shapes verified against Public's official
  CLI (github.com/PublicDotCom/publicdotcom-cli).
*/

const PUBLIC_API = "https://api.public.com";
const TOKEN_VALIDITY_MINUTES = 15;
const HISTORY_WINDOW_DAYS = 30;

const PUBLIC_ASSET_CLASSES: Record<string, AssetClass> = {
  EQUITY: "equity",
  ETF: "equity",
  OPTION: "option",
  CRYPTO: "crypto",
  BOND: "other",
};

type PublicPortfolio = {
  buyingPower?: number | string;
  totalAccountValue?: number | string;
  equity?: { type?: string; value?: number | string }[];
  positions?: {
    instrument?: { symbol?: string; type?: string };
    quantity?: number | string;
    currentValue?: number | string;
  }[];
};
export type PublicTransaction = {
  type?: string;
  side?: string;
  symbol?: string;
  quantity?: number | string;
  principalAmount?: number | string;
  fees?: number | string;
  timestamp?: string;
};

export type PublicRaw = {
  accounts: {
    accountId: string;
    portfolio: PublicPortfolio;
    transactions: PublicTransaction[];
  }[];
};

/**
 * Pure mapper from Public history rows to trades. Only rows with a BUY/SELL
 * side count; price derives from principal ÷ quantity since history reports
 * amounts, not unit prices.
 */
export const parsePublicHistory = (transactions: PublicTransaction[]): Trade[] => {
  const trades: Trade[] = [];
  for (const transaction of transactions) {
    const sideRaw = transaction.side?.toUpperCase();
    const side = sideRaw === "BUY" ? "buy" : sideRaw === "SELL" ? "sell" : null;
    const quantity = Math.abs(asFiniteNumber(transaction.quantity) ?? 0);
    const principal = Math.abs(asFiniteNumber(transaction.principalAmount) ?? 0);
    if (!side || !transaction.symbol || quantity <= 0 || principal <= 0) continue;
    const price = principal / quantity;
    const fee = Math.abs(asFiniteNumber(transaction.fees) ?? 0);
    const executedAt = asIsoTimestamp(transaction.timestamp);
    trades.push({
      symbol: transaction.symbol,
      side,
      quantity,
      price,
      ...(fee > 0 ? { fee } : {}),
      ...(executedAt ? { executedAt } : {}),
    });
  }
  return trades;
};

const normalize = (raw: PublicRaw): Account[] => {
  const accounts: Account[] = [];
  for (const entry of raw.accounts) {
    const positions: Position[] = [];
    for (const position of entry.portfolio.positions ?? []) {
      const symbol = position.instrument?.symbol;
      const quantity = asFiniteNumber(position.quantity);
      if (!symbol || quantity === undefined || quantity === 0) continue;
      const marketValue = asFiniteNumber(position.currentValue);
      const assetClass = position.instrument?.type ? PUBLIC_ASSET_CLASSES[position.instrument.type] : undefined;
      positions.push({
        symbol,
        quantity,
        ...(marketValue !== undefined ? { marketValue } : {}),
        ...(assetClass ? { assetClass } : {}),
      });
    }

    // totalAccountValue when present; otherwise the equity buckets sum up.
    const equity =
      asFiniteNumber(entry.portfolio.totalAccountValue) ??
      (entry.portfolio.equity ?? []).reduce((sum, bucket) => sum + (asFiniteNumber(bucket.value) ?? 0), 0);

    accounts.push({
      id: entry.accountId,
      name: `Public ${entry.accountId.slice(-4)}`,
      currency: "USD",
      equity,
      positions,
      trades: parsePublicHistory(entry.transactions),
    });
  }
  return accounts;
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext) => {
  const { apiKey } = credentials;
  if (!apiKey) {
    throw new MissingCredentialsError("public", "Public connection is missing its secret key");
  }

  const tokenResponse = await ctx.fetch(`${PUBLIC_API}/userapiauthservice/personal/access-tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: apiKey, validityInMinutes: TOKEN_VALIDITY_MINUTES }),
  });
  if (!tokenResponse.ok) {
    throw new BrokerAuthError("public", "Public rejected the secret key — generate a new one in settings and reconnect");
  }
  const { accessToken } = (await tokenResponse.json()) as { accessToken?: string };
  if (!accessToken) {
    throw new BrokerRequestError("public", "Public returned no access token");
  }

  const get = async <T>(path: string): Promise<T> => {
    const response = await ctx.fetch(`${PUBLIC_API}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) rejectResponse("public", "Public", response);
    return (await response.json()) as T;
  };

  type PublicAccounts = { accounts?: { accountId?: string; accountType?: string }[] };
  const accountList = await get<PublicAccounts>("/userapigateway/trading/account");
  const accountIds = (accountList.accounts ?? [])
    .map((account) => account.accountId)
    .filter((accountId): accountId is string => Boolean(accountId));
  if (accountIds.length === 0) {
    throw new BrokerRequestError("public", "Public returned no accounts for this key");
  }

  const end = new Date();
  const start = new Date(end.getTime() - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const accounts = [];
  for (const accountId of accountIds) {
    const [portfolio, history] = await Promise.all([
      get<PublicPortfolio>(`/userapigateway/trading/${accountId}/portfolio/v2`),
      get<{ transactions?: PublicTransaction[] }>(
        `/userapigateway/trading/${accountId}/history?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}&pageSize=100`,
      ).catch(() => null),
    ]);
    accounts.push({ accountId, portfolio, transactions: history?.transactions ?? [] });
  }

  return { raw: { accounts } };
};

export const publicDotCom: BrokerAdapter<PublicRaw> = {
  id: "public",
  displayName: "Public",
  credentials: [{ key: "apiKey", label: "API secret key", secret: true }],
  readOnlySetup:
    "Generate an API secret key in Public's settings; the SDK exchanges it for short-lived read tokens and only calls account, portfolio, and history endpoints.",
  fetchRaw,
  normalize,
};
