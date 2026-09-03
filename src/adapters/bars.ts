import { MAX_BARS, type Bar, type BarsRequest } from "../schema.js";

/*
  Helpers shared by every bar-capable adapter, all pure. Normalizers hand
  back bars oldest-first with duplicates on the same open time collapsed
  (keep-last, since brokers re-send a still-forming bar), and `limit`
  keeps the most recent bars so the semantics match across venues that
  page from the start (Alpaca) and venues that return the whole window at
  once (Tradier).
*/

/** Effective cap for one request: the caller's `limit`, never above `MAX_BARS`. */
export const effectiveBarLimit = (request: BarsRequest): number => {
  const limit = request.limit;
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return MAX_BARS;
  return Math.min(Math.floor(limit), MAX_BARS);
};

/** Sort oldest-first, collapse same-time duplicates, keep the most recent `limit`. */
export const finalizeBars = (bars: Bar[], request: BarsRequest): Bar[] => {
  const byTime = new Map<number, Bar>();
  for (const bar of bars) byTime.set(bar.time, bar);
  const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);
  const limit = effectiveBarLimit(request);
  return sorted.length > limit ? sorted.slice(sorted.length - limit) : sorted;
};

/**
 * Build one bar from already-parsed numbers, or nothing when any OHLC
 * value is missing or the bar is internally inconsistent (high below low,
 * open or close outside the range). Volume is optional and dropped when
 * negative or unparseable — omitted, never guessed.
 */
export const buildBar = (
  time: number | undefined,
  open: number | undefined,
  high: number | undefined,
  low: number | undefined,
  close: number | undefined,
  volume: number | undefined,
): Bar | undefined => {
  if (time === undefined || open === undefined || high === undefined || low === undefined || close === undefined) {
    return undefined;
  }
  if (high < low || open > high || open < low || close > high || close < low) return undefined;
  return {
    time,
    open,
    high,
    low,
    close,
    ...(volume !== undefined && volume >= 0 ? { volume } : {}),
  };
};
