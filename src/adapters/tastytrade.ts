import { BrokerAuthError, MissingCredentialsError } from "../errors.js";
import type { Account, AssetClass, Position, Trade } from "../schema.js";
import { asFiniteNumber, asIsoTimestamp, rejectResponse } from "./http.js";
import type { AdapterFetchResult, BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  tastytrade, via the official Open API (api.tastyworks.com). There is no
  read-scoped key: POST /sessions with the account login exchanges the
  password (or a previously issued remember token) for a short-lived session
  token, used per fetch and never persisted. With `remember-me` the exchange
  also returns a single-use remember token; it is preferred over the password
  on the next fetch and the fresh one is handed back through
  rotatedCredentials — persist it via onCredentialsRotated.

  Endpoint paths and the { data: ... } envelope follow the published Open API;
  the daily canary validates them against a real account.
*/

const TASTYTRADE_API = "https://api.tastyworks.com";

const TASTYTRADE_ASSET_CLASSES: Record<string, AssetClass> = {
  Equity: "equity",
  "Equity Option": "option",
  Future: "futures",
  "Future Option": "futures",
  Cryptocurrency: "crypto",
};

type TastytradeBalances = {
  "net-liquidating-value"?: string | number;
  "cash-balance"?: string | number;
  currency?: string;
};
type TastytradePosition = {
  symbol?: string;
  /** Always positive; "quantity-direction" carries the sign. */
  quantity?: string | number;
  "quantity-direction"?: string;
  "close-price"?: string | number;
  "average-open-price"?: string | number;
  "instrument-type"?: string;
};
export type TastytradeTransaction = {
  "transaction-type"?: string;
  action?: string;
  symbol?: string;
  quantity?: string | number;
  price?: string | number;
  commission?: string | number;
  "executed-at"?: string;
};

export type TastytradeRaw = {
  accounts: {
    accountNumber?: string;
    balances?: TastytradeBalances;
    positions?: TastytradePosition[];
    /** First page of Trade transactions; empty when the call failed. */
    transactions?: TastytradeTransaction[];
  }[];
};

/** Pure mapper from tastytrade Trade transactions to trades; bad rows drop out. */
export const parseTastytradeTransactions = (transactions: TastytradeTransaction[] | undefined): Trade[] => {
  const trades: Trade[] = [];
  for (const tx of Array.isArray(transactions) ? transactions : []) {
    if (tx?.["transaction-type"] !== "Trade") continue;
    const action = tx.action ?? "";
    const side = action.startsWith("Buy") ? "buy" : action.startsWith("Sell") ? "sell" : null;
    const quantity = Math.abs(asFiniteNumber(tx.quantity) ?? 0);
    const price = asFiniteNumber(tx.price);
    if (!tx.symbol || !side || quantity <= 0 || price === undefined || price <= 0) continue;
    const fee = asFiniteNumber(tx.commission);
    const executedAt = asIsoTimestamp(tx["executed-at"]);
    trades.push({
      symbol: tx.symbol,
      side,
      quantity,
      price,
      ...(fee !== undefined && fee >= 0 ? { fee } : {}),
      ...(executedAt ? { executedAt } : {}),
    });
  }
  return trades;
};

const normalize = (raw: TastytradeRaw): Account[] => {
  const accounts: Account[] = [];
  for (const entry of Array.isArray(raw.accounts) ? raw.accounts : []) {
    const accountNumber = entry?.accountNumber;
    if (!accountNumber) continue;

    const positions: Position[] = [];
    for (const position of Array.isArray(entry.positions) ? entry.positions : []) {
      const size = Math.abs(asFiniteNumber(position?.quantity) ?? 0);
      if (!position?.symbol || size === 0) continue;
      const quantity = position["quantity-direction"] === "Short" ? -size : size;
      const closePrice = asFiniteNumber(position["close-price"]);
      const averageEntryPrice = asFiniteNumber(position["average-open-price"]);
      const assetClass = position["instrument-type"]
        ? TASTYTRADE_ASSET_CLASSES[position["instrument-type"]]
        : undefined;
      positions.push({
        symbol: position.symbol,
        quantity,
        ...(closePrice !== undefined ? { marketValue: quantity * closePrice } : {}),
        ...(averageEntryPrice !== undefined ? { averageEntryPrice } : {}),
        ...(assetClass ? { assetClass } : {}),
      });
    }

    const equity = asFiniteNumber(entry.balances?.["net-liquidating-value"]);
    const cash = asFiniteNumber(entry.balances?.["cash-balance"]);

    accounts.push({
      id: accountNumber,
      name: `tastytrade ${accountNumber}`,
      currency: entry.balances?.currency || "USD",
      equity: equity ?? positions.reduce((sum, p) => sum + (p.marketValue ?? 0), 0),
      ...(cash !== undefined ? { cash } : {}),
      positions,
      trades: parseTastytradeTransactions(entry.transactions),
    });
  }
  return accounts;
};

type TastytradeSessionData = { "session-token"?: string; "remember-token"?: string };

const createSession = async (
  body: Record<string, unknown>,
  fetchImpl: typeof globalThis.fetch,
): Promise<TastytradeSessionData | null> => {
  const response = await fetchImpl(`${TASTYTRADE_API}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) return null;
  const parsed = (await response.json()) as { data?: TastytradeSessionData };
  return parsed.data ?? null;
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext): Promise<AdapterFetchResult<TastytradeRaw>> => {
  const login = credentials.login?.trim();
  const password = credentials.password?.trim();
  const rememberToken = credentials.rememberToken?.trim();
  if (!login || !password) {
    throw new MissingCredentialsError("tastytrade", "tastytrade connection is missing its login or password");
  }

  // Remember tokens are single-use: prefer the stored one, fall back to the
  // password when it has already been consumed or expired. `remember-me`
  // asks for a fresh remember token either way, rotated back to the caller.
  let session = rememberToken
    ? await createSession({ login, "remember-token": rememberToken, "remember-me": true }, ctx.fetch)
    : null;
  if (!session?.["session-token"]) {
    session = await createSession({ login, password, "remember-me": true }, ctx.fetch);
  }
  const sessionToken = session?.["session-token"];
  if (!sessionToken) {
    throw new BrokerAuthError("tastytrade", "tastytrade rejected the login — check the username and password");
  }
  const newRememberToken = session?.["remember-token"];

  // Session tokens are per-fetch only; they are never stored in credentials.
  const get = async <T>(path: string): Promise<T> => {
    const response = await ctx.fetch(`${TASTYTRADE_API}${path}`, {
      headers: { Authorization: sessionToken },
    });
    if (!response.ok) rejectResponse("tastytrade", "tastytrade", response);
    return ((await response.json()) as { data: T }).data;
  };

  const customerAccounts = await get<{ items?: { account?: { "account-number"?: string } }[] }>(
    "/customers/me/accounts",
  );
  const accountNumbers = (customerAccounts.items ?? [])
    .map((item) => item.account?.["account-number"])
    .filter((accountNumber): accountNumber is string => Boolean(accountNumber));

  const tradesQuery = new URLSearchParams({ "transaction-types[]": "Trade" }).toString();
  const accounts = [];
  for (const accountNumber of accountNumbers) {
    const [balances, positionsBody, transactionsBody] = await Promise.all([
      get<TastytradeBalances>(`/accounts/${accountNumber}/balances`),
      get<{ items?: TastytradePosition[] }>(`/accounts/${accountNumber}/positions`),
      // Paginated; the first page is the recent-history window. History is
      // optional — a failure here never costs the balances already fetched.
      get<{ items?: TastytradeTransaction[] }>(`/accounts/${accountNumber}/transactions?${tradesQuery}`).catch(
        () => ({ items: [] }),
      ),
    ]);
    accounts.push({
      accountNumber,
      balances,
      positions: positionsBody.items ?? [],
      transactions: transactionsBody.items ?? [],
    });
  }

  return {
    raw: { accounts },
    ...(newRememberToken ? { rotatedCredentials: { rememberToken: newRememberToken } } : {}),
  };
};

export const tastytrade: BrokerAdapter<TastytradeRaw> = {
  id: "tastytrade",
  displayName: "tastytrade",
  credentials: [
    { key: "login", label: "tastytrade login (email or username)", secret: false },
    { key: "password", label: "Password", secret: true },
    { key: "rememberToken", label: "Remember token (optional, rotates every fetch)", secret: true },
  ],
  readOnlySetup:
    "tastytrade has no read-scoped key — the session comes from your login (use a dedicated password and enable 2FA-exempt API access per their Open API docs); this SDK still only ever calls account, balance, position, and transaction endpoints.",
  fetchRaw,
  normalize,
};
