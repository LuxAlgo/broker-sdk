import { createHmac } from "node:crypto";

import { BrokerRequestError, MissingCredentialsError } from "../errors.js";
import type { Account, Position, Trade } from "../schema.js";
import { asFiniteNumber, rejectResponse } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  Binance spot and USDⓈ-M futures, read-only API key + secret (the user
  creates a key with only "Enable Reading" checked). Spot: one signed
  /api/v3/account call for balances, one public /api/v3/ticker/price call to
  value them in USDT. Futures: /fapi/v3 balances and positions, and fills
  from /fapi/v1/userTrades.

  Binance has no "all my trades" call. userTrades needs a symbol and a window
  of at most 7 days, and keeps three months, so the symbols come from the
  income history (fees, realized P&L, funding), which needs neither, plus
  the open positions.
*/

const BINANCE_API = "https://api.binance.com";
const BINANCE_FUTURES_API = "https://fapi.binance.com";
const STABLECOINS = new Set(["USDT", "USDC", "FDUSD"]);

type BinanceAccount = {
  balances?: { asset: string; free: string; locked: string }[];
};

type BinanceFuturesAccount = { totalMarginBalance?: string };

type BinanceFuturesPosition = {
  symbol?: string;
  positionAmt?: string;
  entryPrice?: string;
  notional?: string;
};

type BinanceFuturesTrade = {
  id?: number;
  symbol?: string;
  side?: string;
  /** `BOTH` in one-way mode; `LONG` or `SHORT` in hedge mode. */
  positionSide?: string;
  price?: string;
  qty?: string;
  commission?: string;
  commissionAsset?: string;
  time?: number;
};

export type BinanceRaw = {
  account: BinanceAccount;
  /** Public USDT ticker prices, symbol → last price. */
  usdtPrices: Record<string, number>;
  /** USDⓈ-M futures, absent when the key cannot read them. */
  futures?: {
    account: BinanceFuturesAccount;
    positions: BinanceFuturesPosition[];
    trades: BinanceFuturesTrade[];
    /** BNB/USDT hourly closes by the hour's start (epoch ms), for fees paid in BNB. */
    bnbUsdtHourly: Record<string, number>;
  };
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const hourOf = (time: number): number => Math.floor(time / HOUR_MS) * HOUR_MS;

/**
 * A fee in a stablecoin counts at face value and one in BNB at that hour's
 * BNB/USDT close. Any other asset, a zero fee or a rebate is left out.
 */
const futuresFee = (trade: BinanceFuturesTrade, bnbUsdtHourly: Record<string, number>): number | undefined => {
  const commission = asFiniteNumber(trade.commission);
  if (commission === undefined || commission <= 0) return undefined;
  if (STABLECOINS.has(trade.commissionAsset ?? "")) return commission;
  if (trade.commissionAsset !== "BNB" || trade.time === undefined) return undefined;
  const bnbPrice = bnbUsdtHourly[String(hourOf(trade.time))];
  return bnbPrice !== undefined ? commission * bnbPrice : undefined;
};

const HEDGE_SIDES: Record<string, "long" | "short"> = { LONG: "long", SHORT: "short" };

/** Pure mapper from USDⓈ-M userTrades rows to trades, one per fill ID, oldest first. */
export const parseBinanceFuturesTrades = (
  rows: BinanceFuturesTrade[],
  bnbUsdtHourly: Record<string, number>,
): Trade[] => {
  const fills = new Map<string, { time: number; id: number; trade: Trade }>();
  for (const row of rows) {
    const side = row.side === "BUY" ? "buy" : row.side === "SELL" ? "sell" : undefined;
    const quantity = asFiniteNumber(row.qty) ?? 0;
    const price = asFiniteNumber(row.price) ?? 0;
    if (!row.symbol || !side || quantity <= 0 || price <= 0) continue;
    if (typeof row.id !== "number" || typeof row.time !== "number") continue;
    // A fill on a window boundary can come back twice; its ID is unique per symbol.
    const key = `${row.symbol}:${row.id}`;
    if (fills.has(key)) continue;

    const positionSide = HEDGE_SIDES[row.positionSide ?? ""];
    const fee = futuresFee(row, bnbUsdtHourly);
    fills.set(key, {
      time: row.time,
      id: row.id,
      trade: {
        symbol: row.symbol,
        side,
        quantity,
        price,
        ...(fee !== undefined ? { fee } : {}),
        executedAt: new Date(row.time).toISOString(),
        assetClass: "futures",
        // In hedge mode each side is its own position: a buy opens the long and closes the short.
        ...(positionSide
          ? { positionSide, positionEffect: (side === "buy") === (positionSide === "long") ? "open" : "close" }
          : {}),
      },
    });
  }
  return [...fills.values()]
    .sort((a, b) => a.time - b.time || a.trade.symbol.localeCompare(b.trade.symbol) || a.id - b.id)
    .map((fill) => fill.trade);
};

const futuresPositions = (rows: BinanceFuturesPosition[]): Position[] => {
  const positions: Position[] = [];
  for (const row of rows) {
    const quantity = asFiniteNumber(row.positionAmt);
    if (!row.symbol || quantity === undefined || quantity === 0) continue;
    const marketValue = asFiniteNumber(row.notional);
    const averageEntryPrice = asFiniteNumber(row.entryPrice);
    positions.push({
      symbol: row.symbol,
      quantity,
      ...(marketValue !== undefined ? { marketValue } : {}),
      ...(averageEntryPrice ? { averageEntryPrice } : {}),
      assetClass: "futures",
    });
  }
  return positions;
};

const normalize = (raw: BinanceRaw): Account[] => {
  const positions: Position[] = [];
  let equity = 0;
  for (const entry of raw.account.balances ?? []) {
    const quantity = (asFiniteNumber(entry.free) ?? Number.NaN) + (asFiniteNumber(entry.locked) ?? Number.NaN);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const price = STABLECOINS.has(entry.asset) ? 1 : raw.usdtPrices[entry.asset];
    const marketValue = price !== undefined ? quantity * price : undefined;
    if (marketValue !== undefined) equity += marketValue;
    positions.push({
      symbol: entry.asset,
      quantity,
      ...(marketValue !== undefined ? { marketValue } : {}),
      assetClass: "crypto",
    });
  }

  const accounts: Account[] = [
    {
      id: "binance-spot",
      name: "Binance spot",
      currency: "USD",
      equity,
      positions,
      trades: [],
    },
  ];
  if (raw.futures) {
    accounts.push({
      id: "binance-usdm-futures",
      name: "Binance USDⓈ-M futures",
      currency: "USD",
      equity: asFiniteNumber(raw.futures.account.totalMarginBalance) ?? 0,
      positions: futuresPositions(raw.futures.positions),
      trades: parseBinanceFuturesTrades(raw.futures.trades, raw.futures.bnbUsdtHourly),
    });
  }
  return accounts;
};

const signedQuery = (secret: string, params: Record<string, string> = {}): string => {
  const query = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: "10000" }).toString();
  const signature = createHmac("sha256", secret).update(query).digest("hex");
  return `${query}&signature=${signature}`;
};

/** userTrades and the income history keep three months; stay a day inside that. */
const FUTURES_LOOKBACK_MS = 89 * DAY_MS;
/** userTrades rejects windows longer than 7 days; both ends are inclusive. */
const WINDOW_MS = 7 * DAY_MS - 1;
const PAGE_LIMIT = 1000;
/** Futures allow 2,400 request weight a minute per IP; pause well before it. */
const WEIGHT_PAUSE_AT = 2000;
const MAX_RETRIES = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const untilNextMinute = () => 60_000 - (Date.now() % 60_000) + 1_000;

/**
 * Binance bans an IP (418) that keeps calling after a 429, so wait out the
 * minute instead of retrying fast, and pause before the weight limit is hit.
 * `url` is rebuilt per attempt so a signed request carries a fresh timestamp.
 */
const throttledFetch = async (ctx: FetchContext, url: () => string, init?: RequestInit): Promise<Response> => {
  for (let attempt = 0; ; attempt++) {
    const response = await ctx.fetch(url(), init);
    if (response.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
      await sleep(Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : untilNextMinute());
      continue;
    }
    const usedWeight = Number.parseFloat(response.headers.get("x-mbx-used-weight-1m") ?? "");
    if (usedWeight >= WEIGHT_PAUSE_AT) await sleep(untilNextMinute());
    return response;
  }
};

/** Binance's numeric error code from an error body, when it has one. */
const errorCode = async (response: Response): Promise<number | undefined> => {
  const body = (await response
    .clone()
    .json()
    .catch(() => undefined)) as { code?: unknown } | undefined;
  return typeof body?.code === "number" ? body.code : undefined;
};

/**
 * A key that cannot read futures, or an account without them, keeps the spot
 * account alone, as before futures were read: 401/403 or -2015 for the key,
 * -4109 for an inactive futures account, 451 where futures are not offered.
 */
const futuresUnavailable = async (response: Response): Promise<boolean> => {
  if (response.status === 401 || response.status === 403 || response.status === 451) return true;
  if (response.status !== 400) return false;
  const code = await errorCode(response);
  return code === -2015 || code === -4109;
};

/** Hourly BNB/USDT closes for the hours in which a fee was paid in BNB. */
const fetchBnbHours = async (ctx: FetchContext, trades: BinanceFuturesTrade[]): Promise<Record<string, number>> => {
  const hours = new Set<number>();
  for (const trade of trades) {
    if (trade.commissionAsset === "BNB" && typeof trade.time === "number") hours.add(hourOf(trade.time));
  }
  const sorted = [...hours].sort((a, b) => a - b);
  const closes: Record<string, number> = {};
  for (let index = 0; index < sorted.length; ) {
    const start = sorted[index]!;
    // One call returns up to 1,000 consecutive hourly candles.
    const end = start + (PAGE_LIMIT - 1) * HOUR_MS;
    const response = await throttledFetch(
      ctx,
      () => `${BINANCE_API}/api/v3/klines?symbol=BNBUSDT&interval=1h&startTime=${start}&endTime=${end}&limit=${PAGE_LIMIT}`,
    );
    if (!response.ok) rejectResponse("binance", "Binance", response);
    for (const kline of (await response.json()) as unknown[][]) {
      const openTime = kline[0];
      const close = asFiniteNumber(kline[4] as string);
      if (typeof openTime === "number" && hours.has(openTime) && close !== undefined) closes[String(openTime)] = close;
    }
    while (index < sorted.length && sorted[index]! <= end) index++;
  }
  return closes;
};

const fetchFutures = async (
  ctx: FetchContext,
  apiKey: string,
  apiSecret: string,
): Promise<BinanceRaw["futures"]> => {
  const call = (path: string, params?: Record<string, string>) =>
    throttledFetch(ctx, () => `${BINANCE_FUTURES_API}${path}?${signedQuery(apiSecret, params)}`, {
      headers: { "X-MBX-APIKEY": apiKey },
    });
  const list = async <T>(path: string, params?: Record<string, string>): Promise<T[]> => {
    const response = await call(path, params);
    if (!response.ok) {
      // A symbol from the income history that Binance no longer lists (-1121) has no readable fills.
      if (response.status === 400 && (await errorCode(response)) === -1121) return [];
      rejectResponse("binance", "Binance futures", response);
    }
    return (await response.json()) as T[];
  };

  const accountResponse = await call("/fapi/v3/account");
  if (!accountResponse.ok) {
    if (await futuresUnavailable(accountResponse)) return undefined;
    rejectResponse("binance", "Binance futures", accountResponse);
  }
  const account = (await accountResponse.json()) as BinanceFuturesAccount;
  const positions = await list<BinanceFuturesPosition>("/fapi/v3/positionRisk");

  const now = Date.now();
  const since = ctx.historySince === undefined ? Number.NaN : Date.parse(ctx.historySince);
  const floor = Math.max(now - FUTURES_LOOKBACK_MS, Number.isFinite(since) ? since : 0);

  /** Every row in [from, to]. A full page may be cut short, so its window is halved and fetched again. */
  const walk = async <T>(path: string, params: Record<string, string>, from: number, to: number): Promise<T[]> => {
    const rows: T[] = [];
    const page = async (start: number, end: number): Promise<void> => {
      const batch = await list<T>(path, {
        ...params,
        startTime: String(start),
        endTime: String(end),
        limit: String(PAGE_LIMIT),
      });
      if (batch.length < PAGE_LIMIT || end <= start) {
        for (const row of batch) rows.push(row);
        return;
      }
      const middle = start + Math.floor((end - start) / 2);
      await page(start, middle);
      await page(middle + 1, end);
    };
    for (let start = from; start <= to; start += WINDOW_MS + 1) await page(start, Math.min(to, start + WINDOW_MS));
    return rows;
  };

  const symbols = new Set<string>();
  for (const position of positions) {
    if (position.symbol && asFiniteNumber(position.positionAmt)) symbols.add(position.symbol);
  }
  for (const income of await walk<{ symbol?: string }>("/fapi/v1/income", {}, floor, now)) {
    if (income.symbol) symbols.add(income.symbol);
  }

  const trades: BinanceFuturesTrade[] = [];
  for (const symbol of [...symbols].sort()) {
    for (const trade of await walk<BinanceFuturesTrade>("/fapi/v1/userTrades", { symbol }, floor, now)) {
      trades.push(trade);
    }
  }

  return { account, positions, trades, bnbUsdtHourly: await fetchBnbHours(ctx, trades) };
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext) => {
  const { apiKey, apiSecret } = credentials;
  if (!apiKey || !apiSecret) {
    throw new MissingCredentialsError("binance", "Binance connection is missing its API key or secret");
  }

  const response = await ctx.fetch(`${BINANCE_API}/api/v3/account?${signedQuery(apiSecret)}`, {
    headers: { "X-MBX-APIKEY": apiKey },
  });
  if (!response.ok) rejectResponse("binance", "Binance", response);
  const account = (await response.json()) as BinanceAccount;

  const usdtPrices: Record<string, number> = {};
  const pricesResponse = await ctx.fetch(`${BINANCE_API}/api/v3/ticker/price`);
  if (pricesResponse.ok) {
    const rows = (await pricesResponse.json()) as { symbol: string; price: string }[];
    for (const row of rows) {
      if (!row.symbol.endsWith("USDT")) continue;
      const price = asFiniteNumber(row.price);
      if (price !== undefined) usdtPrices[row.symbol.slice(0, -4)] = price;
    }
  } else if (pricesResponse.status >= 500) {
    // Valuations are best-effort, but surface a hard outage rather than
    // silently returning a portfolio with no values at all.
    throw new BrokerRequestError("binance", `Binance ticker endpoint failed (${pricesResponse.status})`, pricesResponse.status);
  }

  const futures = await fetchFutures(ctx, apiKey, apiSecret);
  return { raw: { account, usdtPrices, ...(futures ? { futures } : {}) } };
};

export const binance: BrokerAdapter<BinanceRaw> = {
  id: "binance",
  displayName: "Binance",
  credentials: [
    { key: "apiKey", label: "API key", secret: false },
    { key: "apiSecret", label: "API secret", secret: true },
  ],
  readOnlySetup:
    'Create an API key in Binance with only "Enable Reading" checked — no trading or withdrawal scopes. It reads spot balances, plus USDⓈ-M futures balances, positions and the last three months of fills when the key can read futures.',
  fetchRaw,
  normalize,
};
