import { MissingCredentialsError } from "../errors.js";
import type { Bar, BarTimeframe, BarsRequest } from "../schema.js";
import { buildBar, effectiveBarLimit, finalizeBars } from "./bars.js";
import { asFiniteNumber, rejectResponse } from "./http.js";
import type { Credentials, FetchContext } from "./types.js";

/*
  Alpaca historical bars. Market data lives on its own host
  (data.alpaca.markets) shared by live and paper keys, so unlike the
  account endpoints there is no host to pick from the key prefix — the same
  headers authenticate either kind. Stocks use /v2/stocks/{symbol}/bars,
  crypto pairs (anything with a "/", e.g. BTC/USD) use the v1beta3 crypto
  endpoint, which keys its response by symbol. Both are read-only
  market-data endpoints: the read-only contract of this SDK still holds.

  The IEX feed is the default because it is included with every account;
  SIP requires a paid data subscription and would fail for most users.
*/

export const ALPACA_DATA_API = "https://data.alpaca.markets";
/** Alpaca's per-page maximum. */
const PAGE_SIZE = 10_000;
/** Guard against a broker that keeps handing back page tokens. */
const MAX_PAGES = 50;

const ALPACA_TIMEFRAMES: Record<BarTimeframe, string> = {
  "1m": "1Min",
  "5m": "5Min",
  "15m": "15Min",
  "1h": "1Hour",
  "1d": "1Day",
};

/** Alpaca spells crypto symbols with a slash (BTC/USD); stocks never carry one. */
export const isAlpacaCryptoSymbol = (symbol: string): boolean => symbol.includes("/");

export type AlpacaBarRow = {
  /** RFC 3339 bar open. */
  t?: string;
  o?: number | string;
  h?: number | string;
  l?: number | string;
  c?: number | string;
  v?: number | string;
};

type AlpacaStockBarsPage = { bars?: AlpacaBarRow[] | null; next_page_token?: string | null };
type AlpacaCryptoBarsPage = { bars?: Record<string, AlpacaBarRow[] | null> | null; next_page_token?: string | null };

/**
 * Pure mapper from Alpaca bar rows (all pages concatenated) to normalized
 * bars. Rows with an unparseable timestamp or incomplete OHLC drop out.
 */
export const normalizeAlpacaBars = (rows: AlpacaBarRow[], request: BarsRequest): Bar[] => {
  const bars: Bar[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const parsedTime = row.t ? Date.parse(row.t) : Number.NaN;
    const bar = buildBar(
      Number.isNaN(parsedTime) ? undefined : parsedTime,
      asFiniteNumber(row.o),
      asFiniteNumber(row.h),
      asFiniteNumber(row.l),
      asFiniteNumber(row.c),
      asFiniteNumber(row.v),
    );
    if (bar) bars.push(bar);
  }
  return finalizeBars(bars, request);
};

/** Query string for one bars page; exported so the wire format is testable. */
export const alpacaBarsQuery = (symbol: string, request: BarsRequest, pageToken?: string): URLSearchParams => {
  const params = new URLSearchParams();
  if (isAlpacaCryptoSymbol(symbol)) params.set("symbols", symbol);
  params.set("timeframe", ALPACA_TIMEFRAMES[request.timeframe]);
  if (request.from !== undefined) params.set("start", new Date(request.from).toISOString());
  if (request.to !== undefined) params.set("end", new Date(request.to).toISOString());
  params.set("limit", String(Math.min(effectiveBarLimit(request), PAGE_SIZE)));
  // Newest-first so a small `limit` yields the most recent bars; the
  // normalizer restores chronological order.
  params.set("sort", "desc");
  if (!isAlpacaCryptoSymbol(symbol)) params.set("feed", "iex");
  if (pageToken) params.set("page_token", pageToken);
  return params;
};

export const fetchAlpacaBars = async (
  credentials: Credentials,
  symbol: string,
  request: BarsRequest,
  ctx: FetchContext,
): Promise<Bar[]> => {
  const apiKey = credentials.apiKey?.trim();
  const apiSecret = credentials.apiSecret?.trim();
  if (!apiKey || !apiSecret) {
    throw new MissingCredentialsError("alpaca", "Alpaca connection is missing its API key or secret");
  }
  const trimmed = symbol.trim().toUpperCase();
  const crypto = isAlpacaCryptoSymbol(trimmed);
  const path = crypto ? "/v1beta3/crypto/us/bars" : `/v2/stocks/${encodeURIComponent(trimmed)}/bars`;
  const cap = effectiveBarLimit(request);

  const rows: AlpacaBarRow[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES && rows.length < cap; page += 1) {
    const response = await ctx.fetch(`${ALPACA_DATA_API}${path}?${alpacaBarsQuery(trimmed, request, pageToken)}`, {
      headers: { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": apiSecret },
    });
    if (!response.ok) rejectResponse("alpaca", "Alpaca", response);
    const body = (await response.json()) as AlpacaStockBarsPage | AlpacaCryptoBarsPage;
    const pageRows = crypto
      ? ((body as AlpacaCryptoBarsPage).bars?.[trimmed] ?? [])
      : ((body as AlpacaStockBarsPage).bars ?? []);
    rows.push(...pageRows);
    pageToken = body.next_page_token ?? undefined;
    if (!pageToken || pageRows.length === 0) break;
  }
  return normalizeAlpacaBars(rows, request);
};
