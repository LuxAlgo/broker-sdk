import { MissingCredentialsError, UnsupportedCapabilityError } from "../errors.js";
import type { Bar, BarTimeframe, BarsRequest } from "../schema.js";
import { buildBar, finalizeBars } from "./bars.js";
import { asFiniteNumber, rejectResponse } from "./http.js";
import { tradierList } from "./tradier-list.js";
import type { Credentials, FetchContext } from "./types.js";

/*
  Tradier historical bars. Intraday comes from /v1/markets/timesales
  (interval 1min/5min/15min, `session_filter=all` so pre/post-market bars
  are included) and daily from /v1/markets/history. Both are read-only
  market-data endpoints on the production host: the read-only contract of
  this SDK still holds. Tradier has no hourly interval, so "1h" is refused
  rather than resampled — the SDK never invents bars.

  Every Tradier timestamp is a zone-less wall-clock string in
  America/New_York ("2024-03-08T09:30:00", "2024-03-08"), and the
  start/end query parameters are expected in the same form. The offset
  helpers below encode the US DST rule in force since 2007 (second Sunday
  of March to first Sunday of November, switching at 02:00 local) so the
  conversion needs no timezone library and no runtime tz database.
*/

const TRADIER_MARKETS_API = "https://api.tradier.com/v1/markets";

const TRADIER_INTERVALS: Partial<Record<BarTimeframe, string>> = {
  "1m": "1min",
  "5m": "5min",
  "15m": "15min",
};

const HOUR = 3_600_000;
const EST_OFFSET = 5 * HOUR;
const EDT_OFFSET = 4 * HOUR;

/** UTC instant of the n-th (1-based) given weekday (0 = Sunday) of a month, at 00:00 UTC. */
const nthWeekdayUtc = (year: number, month: number, weekday: number, n: number): number => {
  const first = Date.UTC(year, month, 1);
  const shift = (weekday - new Date(first).getUTCDay() + 7) % 7;
  return first + (shift + 7 * (n - 1)) * 24 * HOUR;
};

/** DST window for a year as UTC instants: [start, end). Springs forward at 02:00 EST, falls back at 02:00 EDT. */
const dstWindowUtc = (year: number): { start: number; end: number } => ({
  start: nthWeekdayUtc(year, 2, 0, 2) + 2 * HOUR + EST_OFFSET,
  end: nthWeekdayUtc(year, 10, 0, 1) + 2 * HOUR + EDT_OFFSET,
});

/** Offset to subtract from an ET wall-clock reading to reach UTC, at a UTC instant. */
export const etOffsetAt = (utcMs: number): number => {
  const { start, end } = dstWindowUtc(new Date(utcMs).getUTCFullYear());
  return utcMs >= start && utcMs < end ? EDT_OFFSET : EST_OFFSET;
};

/**
 * Convert an ET wall-clock time to epoch ms. The ambiguous fall-back hour
 * resolves to its first (EDT) occurrence; the skipped spring-forward hour
 * is read as EST, which lands it on the same real instant as the clock
 * that jumped ahead.
 */
export const etToEpochMs = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number => {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const { start, end } = dstWindowUtc(year);
  const asEdt = wall + EDT_OFFSET;
  return asEdt >= start && asEdt < end ? asEdt : wall + EST_OFFSET;
};

const TRADIER_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** Parse a Tradier ET wall-clock string ("2024-03-08T09:30:00" or "2024-03-08") to epoch ms. */
export const parseTradierEtTime = (value: string | undefined | null): number | undefined => {
  if (!value) return undefined;
  const match = TRADIER_TIME_PATTERN.exec(value.trim());
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s] = match;
  return etToEpochMs(Number(y), Number(mo), Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
};

const pad = (value: number): string => String(value).padStart(2, "0");

/** Format an epoch ms instant as Tradier's ET query parameter, with or without the clock. */
export const formatTradierEtTime = (epochMs: number, withClock: boolean): string => {
  const wall = new Date(epochMs - etOffsetAt(epochMs));
  const date = `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}`;
  return withClock ? `${date} ${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}` : date;
};

export type TradierTimesaleRow = {
  time?: string;
  open?: number | string;
  high?: number | string;
  low?: number | string;
  close?: number | string;
  volume?: number | string;
};
export type TradierHistoryRow = {
  date?: string;
  open?: number | string;
  high?: number | string;
  low?: number | string;
  close?: number | string;
  volume?: number | string;
};

export type TradierTimesalesResponse = { series?: { data?: TradierTimesaleRow | TradierTimesaleRow[] } | "null" | null };
export type TradierHistoryResponse = { history?: { day?: TradierHistoryRow | TradierHistoryRow[] } | "null" | null };

/**
 * Pure mapper from either Tradier bars payload to normalized bars. Daily
 * bars open at midnight ET, matching Alpaca's daily `t`. Rows with an
 * unparseable time or incomplete OHLC drop out.
 */
export const normalizeTradierBars = (
  payload: TradierTimesalesResponse | TradierHistoryResponse,
  request: BarsRequest,
): Bar[] => {
  const series = (payload as TradierTimesalesResponse).series;
  const history = (payload as TradierHistoryResponse).history;
  const rows: (TradierTimesaleRow | TradierHistoryRow)[] = [
    ...tradierList(typeof series === "object" ? series?.data : undefined),
    ...tradierList(typeof history === "object" ? history?.day : undefined),
  ];
  const bars: Bar[] = [];
  for (const row of rows) {
    const time = parseTradierEtTime("time" in row ? row.time : (row as TradierHistoryRow).date);
    const bar = buildBar(
      time,
      asFiniteNumber(row.open),
      asFiniteNumber(row.high),
      asFiniteNumber(row.low),
      asFiniteNumber(row.close),
      asFiniteNumber(row.volume),
    );
    if (bar) bars.push(bar);
  }
  return finalizeBars(bars, request);
};

/** Endpoint path and query for one request; exported so the wire format is testable. */
export const tradierBarsQuery = (symbol: string, request: BarsRequest): { path: string; params: URLSearchParams } => {
  const params = new URLSearchParams({ symbol });
  if (request.timeframe === "1d") {
    params.set("interval", "daily");
    if (request.from !== undefined) params.set("start", formatTradierEtTime(request.from, false));
    if (request.to !== undefined) params.set("end", formatTradierEtTime(request.to, false));
    return { path: "/history", params };
  }
  const interval = TRADIER_INTERVALS[request.timeframe];
  if (!interval) {
    throw new UnsupportedCapabilityError(
      "tradier",
      "fetchBars",
      `Tradier has no "${request.timeframe}" interval; use 1m, 5m, 15m, or 1d`,
    );
  }
  params.set("interval", interval);
  params.set("session_filter", "all");
  if (request.from !== undefined) params.set("start", formatTradierEtTime(request.from, true));
  if (request.to !== undefined) params.set("end", formatTradierEtTime(request.to, true));
  return { path: "/timesales", params };
};

export const fetchTradierBars = async (
  credentials: Credentials,
  symbol: string,
  request: BarsRequest,
  ctx: FetchContext,
): Promise<Bar[]> => {
  const { accessToken } = credentials;
  if (!accessToken) {
    throw new MissingCredentialsError("tradier", "Tradier connection is missing its access token");
  }
  const { path, params } = tradierBarsQuery(symbol.trim().toUpperCase(), request);
  const response = await ctx.fetch(`${TRADIER_MARKETS_API}${path}?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!response.ok) rejectResponse("tradier", "Tradier", response);
  const payload = (await response.json()) as TradierTimesalesResponse | TradierHistoryResponse;
  return normalizeTradierBars(payload, request);
};
