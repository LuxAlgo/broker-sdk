import { BrokerAuthError, BrokerRequestError, MissingCredentialsError } from "../errors.js";
import type { Account, Position, Trade } from "../schema.js";
import { asFiniteNumber, asIsoTimestamp, rejectResponse } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  Topstep (futures prop firm), read-only via the user's own ProjectX Gateway
  API key — generated self-serve in TopstepX after subscribing to API access.
  ProjectX is Topstep-exclusive since early 2026, so the gateway host is
  fixed. Login exchanges the key for a 24h JWT; then account search, open
  positions, and the last month of executed trades.
*/

const TOPSTEP_API = "https://api.topstepx.com/api";
const TRADE_WINDOW_DAYS = 30;

type TopstepTradeRow = {
  contractId?: string;
  creationTimestamp?: string;
  price?: number;
  fees?: number;
  side?: number;
  size?: number;
  voided?: boolean;
};
type TopstepPositionRow = { contractId?: string; type?: number; size?: number; averagePrice?: number };

export type TopstepRaw = {
  accounts: {
    id: number;
    name?: string;
    balance?: number;
    positions: TopstepPositionRow[];
    trades: TopstepTradeRow[];
  }[];
};

/** Contract ids look like "CON.F.US.EP.U26" — the fourth segment is the symbol. */
export const topstepSymbol = (contractId: string): string => {
  const parts = contractId.split(".");
  return parts.length >= 4 ? (parts[3] ?? contractId) : contractId;
};

/** Pure mapper from Topstep executions (side 0 buys, 1 sells) to trades. */
export const parseTopstepTrades = (trades: TopstepTradeRow[] | undefined): Trade[] => {
  const mapped: Trade[] = [];
  for (const trade of trades ?? []) {
    if (trade.voided) continue;
    const side = trade.side === 0 ? "buy" : trade.side === 1 ? "sell" : null;
    const quantity = Math.abs(trade.size ?? 0);
    const price = trade.price ?? 0;
    if (!trade.contractId || !side || quantity <= 0 || price <= 0) continue;
    const fee = Math.abs(trade.fees ?? 0);
    const executedAt = asIsoTimestamp(trade.creationTimestamp);
    mapped.push({
      symbol: topstepSymbol(trade.contractId),
      side,
      quantity,
      price,
      ...(fee > 0 ? { fee } : {}),
      ...(executedAt ? { executedAt } : {}),
    });
  }
  return mapped;
};

const normalize = (raw: TopstepRaw): Account[] => {
  const accounts: Account[] = [];
  for (const account of raw.accounts) {
    const positions: Position[] = [];
    for (const position of account.positions ?? []) {
      const size = Math.abs(position.size ?? 0);
      if (!position.contractId || size === 0) continue;
      const averageEntryPrice = asFiniteNumber(position.averagePrice);
      // type 2 is short; size always arrives positive.
      positions.push({
        symbol: topstepSymbol(position.contractId),
        quantity: position.type === 2 ? -size : size,
        ...(averageEntryPrice !== undefined ? { averageEntryPrice } : {}),
        assetClass: "futures",
      });
    }

    const balance = asFiniteNumber(account.balance);
    accounts.push({
      id: String(account.id),
      name: account.name || `Topstep ${account.id}`,
      currency: "USD",
      equity: balance ?? 0,
      positions,
      trades: parseTopstepTrades(account.trades),
    });
  }
  return accounts;
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext) => {
  const { userName, apiKey } = credentials;
  if (!userName || !apiKey) {
    throw new MissingCredentialsError("topstep", "Topstep connection is missing its username or API key");
  }

  const post = async <T>(path: string, body: Record<string, unknown>, token?: string): Promise<T> => {
    const response = await ctx.fetch(`${TOPSTEP_API}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) rejectResponse("topstep", "Topstep", response);
    return (await response.json()) as T;
  };

  type TopstepLogin = { token?: string; success?: boolean; errorMessage?: string | null };
  const login = await post<TopstepLogin>("/Auth/loginKey", { userName, apiKey });
  if (!login.success || !login.token) {
    throw new BrokerAuthError(
      "topstep",
      login.errorMessage || "Topstep rejected the API key — check your TopstepX username and key",
    );
  }
  const token = login.token;

  type TopstepAccounts = { accounts?: { id?: number; name?: string; balance?: number }[]; success?: boolean };
  const accountsBody = await post<TopstepAccounts>("/Account/search", { onlyActiveAccounts: true }, token);
  const activeAccounts = (accountsBody.accounts ?? []).filter(
    (account): account is { id: number; name?: string; balance?: number } => typeof account.id === "number",
  );
  if (activeAccounts.length === 0) {
    throw new BrokerRequestError("topstep", "Topstep returned no active accounts for this key");
  }

  const startTimestamp = new Date(Date.now() - TRADE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const accounts = [];
  for (const account of activeAccounts) {
    const [positionsBody, tradesBody] = await Promise.all([
      post<{ positions?: TopstepPositionRow[] }>("/Position/searchOpen", { accountId: account.id }, token),
      post<{ trades?: TopstepTradeRow[] }>(
        "/Trade/search",
        { accountId: account.id, startTimestamp, endTimestamp: new Date().toISOString() },
        token,
      ),
    ]);
    accounts.push({
      id: account.id,
      ...(account.name !== undefined ? { name: account.name } : {}),
      ...(account.balance !== undefined ? { balance: account.balance } : {}),
      positions: positionsBody.positions ?? [],
      trades: tradesBody.trades ?? [],
    });
  }

  return { raw: { accounts } };
};

export const topstep: BrokerAdapter<TopstepRaw> = {
  id: "topstep",
  displayName: "Topstep",
  credentials: [
    { key: "userName", label: "TopstepX username", secret: false },
    { key: "apiKey", label: "ProjectX API key", secret: true },
  ],
  readOnlySetup:
    "Subscribe to API access in TopstepX, then generate a ProjectX Gateway API key; the SDK only calls account, position, and trade-search endpoints.",
  fetchRaw,
  normalize,
};
