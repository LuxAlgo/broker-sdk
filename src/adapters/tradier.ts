import { MissingCredentialsError, BrokerRequestError } from "../errors.js";
import type { Account, Position, Trade } from "../schema.js";
import { asFiniteNumber, asIsoTimestamp, rejectResponse } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  Tradier, read-only via the user's own API access token (every Tradier
  account gets one in account settings; Bearer auth). Profile lists the
  account numbers; per account we pull balances, positions, and trade
  history. Tradier quirk handled throughout: single-element collections
  come back as a bare object instead of an array, and empty ones as null.
*/

const TRADIER_API = "https://api.tradier.com/v1";

/** Normalize Tradier's object-or-array-or-null collections to an array. */
export const tradierList = <T>(value: T | T[] | null | undefined | "null"): T[] => {
  if (value === null || value === undefined || value === "null") return [];
  return Array.isArray(value) ? value : [value];
};

type TradierHistoryEvent = {
  type?: string;
  date?: string;
  trade?: { symbol?: string; quantity?: number | string; price?: number | string; commission?: number | string };
};

type TradierBalances = { balances?: { total_equity?: number | string; total_cash?: number | string } };
type TradierPosition = { symbol?: string; quantity?: number | string; cost_basis?: number | string };
type TradierPositions = {
  positions?: { position?: TradierPosition | TradierPosition[] } | "null";
};

/** OCC option symbols: root (≤6) + yymmdd + C/P + 8-digit strike. */
const OCC_OPTION_PATTERN = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;
type TradierHistory = {
  history?: { event?: TradierHistoryEvent | TradierHistoryEvent[] } | "null";
};

export type TradierRaw = {
  accounts: {
    accountNumber: string;
    balances: TradierBalances;
    positions: TradierPositions;
    history: TradierHistory;
  }[];
};

/** Pure mapper from Tradier history events to trades — sign carries the side. */
export const parseTradierHistory = (events: TradierHistoryEvent[]): Trade[] => {
  const trades: Trade[] = [];
  for (const event of events) {
    if (event.type !== "trade" || !event.trade) continue;
    const symbol = event.trade.symbol;
    const quantityRaw = asFiniteNumber(event.trade.quantity);
    const price = asFiniteNumber(event.trade.price);
    if (!symbol || quantityRaw === undefined || quantityRaw === 0 || price === undefined || price <= 0) {
      continue;
    }
    const commission = asFiniteNumber(event.trade.commission);
    const fee = commission !== undefined ? Math.abs(commission) : undefined;
    const executedAt = asIsoTimestamp(event.date);
    trades.push({
      symbol,
      side: quantityRaw > 0 ? "buy" : "sell",
      quantity: Math.abs(quantityRaw),
      price,
      ...(fee !== undefined && fee > 0 ? { fee } : {}),
      ...(executedAt ? { executedAt } : {}),
    });
  }
  return trades;
};

const normalize = (raw: TradierRaw): Account[] => {
  const accounts: Account[] = [];
  for (const entry of raw.accounts) {
    const positions: Position[] = [];
    const positionEntries =
      typeof entry.positions.positions === "object" ? entry.positions.positions?.position : undefined;
    for (const position of tradierList(positionEntries)) {
      const quantity = asFiniteNumber(position.quantity);
      if (!position.symbol || quantity === undefined || quantity === 0) continue;
      // Tradier reports cost basis, not market value — leave marketValue
      // unset rather than pass a misleading number downstream. Cost basis
      // over quantity is a real average entry price, so that one we keep.
      const costBasis = asFiniteNumber(position.cost_basis);
      const averageEntryPrice = costBasis !== undefined ? Math.abs(costBasis / quantity) : undefined;
      positions.push({
        symbol: position.symbol,
        quantity,
        ...(averageEntryPrice !== undefined ? { averageEntryPrice } : {}),
        assetClass: OCC_OPTION_PATTERN.test(position.symbol) ? "option" : "equity",
      });
    }

    const equity = asFiniteNumber(entry.balances.balances?.total_equity);
    const cash = asFiniteNumber(entry.balances.balances?.total_cash);
    const historyEvents = typeof entry.history.history === "object" ? entry.history.history?.event : undefined;

    accounts.push({
      id: entry.accountNumber,
      name: `Tradier ${entry.accountNumber}`,
      currency: "USD",
      equity: equity ?? 0,
      ...(cash !== undefined ? { cash } : {}),
      positions,
      trades: parseTradierHistory(tradierList(historyEvents)),
    });
  }
  return accounts;
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext) => {
  const { accessToken } = credentials;
  if (!accessToken) {
    throw new MissingCredentialsError("tradier", "Tradier connection is missing its access token");
  }

  const get = async <T>(path: string): Promise<T> => {
    const response = await ctx.fetch(`${TRADIER_API}${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) rejectResponse("tradier", "Tradier", response);
    return (await response.json()) as T;
  };

  type TradierProfile = { profile?: { account?: { account_number?: string } | { account_number?: string }[] } };
  const profile = await get<TradierProfile>("/user/profile");
  const accountNumbers = tradierList(profile.profile?.account)
    .map((account) => account.account_number)
    .filter((accountNumber): accountNumber is string => Boolean(accountNumber));
  if (accountNumbers.length === 0) {
    throw new BrokerRequestError("tradier", "Tradier returned no accounts for this token");
  }

  const accounts = [];
  for (const accountNumber of accountNumbers) {
    const [balances, positions, history] = await Promise.all([
      get<TradierBalances>(`/accounts/${accountNumber}/balances`),
      get<TradierPositions>(`/accounts/${accountNumber}/positions`),
      get<TradierHistory>(`/accounts/${accountNumber}/history?type=trade&limit=100`),
    ]);
    accounts.push({ accountNumber, balances, positions, history });
  }

  return { raw: { accounts } };
};

export const tradier: BrokerAdapter<TradierRaw> = {
  id: "tradier",
  displayName: "Tradier",
  credentials: [{ key: "accessToken", label: "API access token", secret: true }],
  readOnlySetup:
    "Copy the API access token from Tradier account settings; the SDK only calls profile, balance, position, and history endpoints.",
  fetchRaw,
  normalize,
};
