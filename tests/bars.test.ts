import { describe, expect, it } from "vitest";

import { alpacaBarsQuery, isAlpacaCryptoSymbol, normalizeAlpacaBars } from "../src/adapters/alpaca-bars.js";
import { finalizeBars } from "../src/adapters/bars.js";
import {
  etOffsetAt,
  etToEpochMs,
  formatTradierEtTime,
  normalizeTradierBars,
  parseTradierEtTime,
  tradierBarsQuery,
} from "../src/adapters/tradier-bars.js";
import { MissingCredentialsError, UnsupportedCapabilityError } from "../src/errors.js";
import { connect, listBrokers, supportsBars, MAX_BARS } from "../src/index.js";

/** Records every URL a connection hits and serves canned bodies in order. */
const recordingFetch = (bodies: unknown[]) => {
  const urls: string[] = [];
  const fetch = ((url: string | URL) => {
    urls.push(String(url));
    const body = bodies[Math.min(urls.length - 1, bodies.length - 1)];
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as typeof globalThis.fetch;
  return { fetch, urls };
};

describe("normalizing Alpaca bars", () => {
  const rows = [
    { t: "2024-03-08T14:31:00Z", o: 171.2, h: 171.4, l: 171.1, c: 171.3, v: 1200, n: 40, vw: 171.25 },
    { t: "2024-03-08T14:30:00Z", o: "171.0", h: "171.3", l: "170.9", c: "171.2", v: "2400" },
    { t: "not-a-date", o: 1, h: 2, l: 0.5, c: 1.5, v: 1 },
    { t: "2024-03-08T14:32:00Z", o: 171.3, h: 171.5, l: 171.2 },
    { t: "2024-03-08T14:33:00Z", o: 175, h: 171.5, l: 171.2, c: 171.4, v: 10 },
  ];

  it("maps vendor rows to oldest-first bars, parsing RFC 3339 to epoch ms and dropping bad rows", () => {
    expect(normalizeAlpacaBars(rows, { timeframe: "1m" })).toEqual([
      { time: Date.UTC(2024, 2, 8, 14, 30), open: 171.0, high: 171.3, low: 170.9, close: 171.2, volume: 2400 },
      { time: Date.UTC(2024, 2, 8, 14, 31), open: 171.2, high: 171.4, low: 171.1, close: 171.3, volume: 1200 },
    ]);
  });

  it("keeps the most recent `limit` bars and returns nothing for empty or null pages", () => {
    expect(normalizeAlpacaBars(rows, { timeframe: "1m", limit: 1 })).toEqual([
      { time: Date.UTC(2024, 2, 8, 14, 31), open: 171.2, high: 171.4, low: 171.1, close: 171.3, volume: 1200 },
    ]);
    expect(normalizeAlpacaBars([], { timeframe: "1d" })).toEqual([]);
    expect(normalizeAlpacaBars(null as never, { timeframe: "1d" })).toEqual([]);
  });

  it("omits volume when the venue does not report it", () => {
    const [bar] = normalizeAlpacaBars([{ t: "2024-03-08T05:00:00Z", o: 1, h: 2, l: 1, c: 2 }], { timeframe: "1d" });
    expect(bar).toEqual({ time: Date.UTC(2024, 2, 8, 5), open: 1, high: 2, low: 1, close: 2 });
    expect(bar).not.toHaveProperty("volume");
  });

  it("collapses a re-sent forming bar onto its final value and honors the hard cap", () => {
    const first = { time: 1, open: 1, high: 2, low: 1, close: 1.5 };
    const again = { time: 1, open: 1, high: 3, low: 1, close: 2.5 };
    expect(finalizeBars([first, again], { timeframe: "1m" })).toEqual([again]);
    const many = Array.from({ length: MAX_BARS + 5 }, (_, i) => ({ time: i, open: 1, high: 1, low: 1, close: 1 }));
    const capped = finalizeBars(many, { timeframe: "1m", limit: MAX_BARS * 2 });
    expect(capped).toHaveLength(MAX_BARS);
    expect(capped[0]?.time).toBe(5);
  });

  it("speaks Alpaca's wire format: timeframe names, IEX feed for stocks, symbols param for crypto", () => {
    const stock = alpacaBarsQuery("AAPL", {
      timeframe: "15m",
      from: Date.UTC(2024, 2, 8, 14, 30),
      to: Date.UTC(2024, 2, 8, 21),
      limit: 50,
    });
    expect(Object.fromEntries(stock)).toEqual({
      timeframe: "15Min",
      start: "2024-03-08T14:30:00.000Z",
      end: "2024-03-08T21:00:00.000Z",
      limit: "50",
      sort: "desc",
      feed: "iex",
    });
    const crypto = alpacaBarsQuery("BTC/USD", { timeframe: "1h" }, "tok");
    expect(crypto.get("symbols")).toBe("BTC/USD");
    expect(crypto.get("timeframe")).toBe("1Hour");
    expect(crypto.get("feed")).toBeNull();
    expect(crypto.get("page_token")).toBe("tok");
    expect(crypto.get("limit")).toBe(String(MAX_BARS));
    expect(alpacaBarsQuery("SPY", { timeframe: "1d" }).get("timeframe")).toBe("1Day");
    expect(isAlpacaCryptoSymbol("ETH/USD")).toBe(true);
    expect(isAlpacaCryptoSymbol("ETHUSD")).toBe(false);
  });
});

describe("Eastern Time without a timezone library", () => {
  it("switches offsets at the 2024 spring-forward instant (2:00 EST, March 10)", () => {
    expect(etOffsetAt(Date.UTC(2024, 2, 10, 6, 59))).toBe(5 * 3_600_000);
    expect(etOffsetAt(Date.UTC(2024, 2, 10, 7, 0))).toBe(4 * 3_600_000);
  });

  it("switches back at the 2024 fall-back instant (2:00 EDT, November 3)", () => {
    expect(etOffsetAt(Date.UTC(2024, 10, 3, 5, 59))).toBe(4 * 3_600_000);
    expect(etOffsetAt(Date.UTC(2024, 10, 3, 6, 0))).toBe(5 * 3_600_000);
  });

  it("converts wall-clock ET to epoch ms on both sides of each boundary", () => {
    expect(etToEpochMs(2024, 3, 10, 1, 59)).toBe(Date.UTC(2024, 2, 10, 6, 59));
    expect(etToEpochMs(2024, 3, 10, 3, 0)).toBe(Date.UTC(2024, 2, 10, 7, 0));
    // The skipped 02:30 reads as EST — the same instant the jumped clock shows as 03:30 EDT.
    expect(etToEpochMs(2024, 3, 10, 2, 30)).toBe(Date.UTC(2024, 2, 10, 7, 30));
    // The repeated hour resolves to its first (EDT) occurrence.
    expect(etToEpochMs(2024, 11, 3, 1, 30)).toBe(Date.UTC(2024, 10, 3, 5, 30));
    expect(etToEpochMs(2024, 11, 3, 2, 0)).toBe(Date.UTC(2024, 10, 3, 7, 0));
    // A different year moves the boundary: DST started March 9 in 2025.
    expect(etToEpochMs(2025, 3, 9, 3, 0)).toBe(Date.UTC(2025, 2, 9, 7, 0));
    expect(etToEpochMs(2025, 3, 8, 9, 30)).toBe(Date.UTC(2025, 2, 8, 14, 30));
  });

  it("parses Tradier's zone-less strings and formats query parameters back in ET", () => {
    expect(parseTradierEtTime("2024-03-08T09:30:00")).toBe(Date.UTC(2024, 2, 8, 14, 30));
    expect(parseTradierEtTime("2024-07-01T09:30:00")).toBe(Date.UTC(2024, 6, 1, 13, 30));
    expect(parseTradierEtTime("2024-03-08")).toBe(Date.UTC(2024, 2, 8, 5));
    expect(parseTradierEtTime("2024-07-01")).toBe(Date.UTC(2024, 6, 1, 4));
    expect(parseTradierEtTime("yesterday")).toBeUndefined();
    expect(parseTradierEtTime(undefined)).toBeUndefined();
    expect(formatTradierEtTime(Date.UTC(2024, 6, 1, 13, 30), true)).toBe("2024-07-01 09:30");
    expect(formatTradierEtTime(Date.UTC(2024, 2, 8, 14, 30), true)).toBe("2024-03-08 09:30");
    // 03:00 UTC on March 9 is still the evening of March 8 in New York.
    expect(formatTradierEtTime(Date.UTC(2024, 2, 9, 3), false)).toBe("2024-03-08");
  });
});

describe("normalizing Tradier bars", () => {
  it("maps timesales rows across a DST boundary, dropping rows with unreadable times or partial OHLC", () => {
    const payload = {
      series: {
        data: [
          { time: "2024-03-08T15:59:00", timestamp: 1709931540, price: 170.5, open: 170.4, high: 170.6, low: 170.3, close: 170.5, volume: 900, vwap: 170.45 },
          { time: "2024-03-11T09:30:00", timestamp: 1710163800, price: 172, open: "171.9", high: "172.2", low: "171.8", close: "172.0", volume: "3100", vwap: 172 },
          { time: "", open: 1, high: 2, low: 1, close: 1, volume: 1 },
          { time: "2024-03-11T09:31:00", open: 172, high: 172.1, low: 171.9, volume: 5 },
        ],
      },
    };
    expect(normalizeTradierBars(payload, { timeframe: "1m" })).toEqual([
      { time: Date.UTC(2024, 2, 8, 20, 59), open: 170.4, high: 170.6, low: 170.3, close: 170.5, volume: 900 },
      { time: Date.UTC(2024, 2, 11, 13, 30), open: 171.9, high: 172.2, low: 171.8, close: 172.0, volume: 3100 },
    ]);
  });

  it("maps daily history rows to midnight ET opens and unwraps single-row and null collections", () => {
    const single = { history: { day: { date: "2024-03-08", open: 169, high: 171, low: 168.5, close: 170.7, volume: 50_000_000 } } };
    expect(normalizeTradierBars(single, { timeframe: "1d" })).toEqual([
      { time: Date.UTC(2024, 2, 8, 5), open: 169, high: 171, low: 168.5, close: 170.7, volume: 50_000_000 },
    ]);
    expect(normalizeTradierBars({ history: null }, { timeframe: "1d" })).toEqual([]);
    expect(normalizeTradierBars({ history: "null" }, { timeframe: "1d" })).toEqual([]);
    expect(normalizeTradierBars({ series: { data: null } } as never, { timeframe: "1m" })).toEqual([]);
    expect(normalizeTradierBars({} as never, { timeframe: "1m" })).toEqual([]);
  });

  it("keeps the most recent `limit` bars", () => {
    const payload = {
      history: {
        day: [
          { date: "2024-03-06", open: 1, high: 2, low: 1, close: 2, volume: 1 },
          { date: "2024-03-07", open: 2, high: 3, low: 2, close: 3, volume: 1 },
          { date: "2024-03-08", open: 3, high: 4, low: 3, close: 4, volume: 1 },
        ],
      },
    };
    expect(normalizeTradierBars(payload, { timeframe: "1d", limit: 2 }).map((bar) => bar.open)).toEqual([2, 3]);
  });

  it("routes intraday to timesales with session_filter=all and daily to history, refusing 1h", () => {
    const intraday = tradierBarsQuery("AAPL", {
      timeframe: "5m",
      from: Date.UTC(2024, 2, 8, 14, 30),
      to: Date.UTC(2024, 2, 8, 21),
    });
    expect(intraday.path).toBe("/timesales");
    expect(Object.fromEntries(intraday.params)).toEqual({
      symbol: "AAPL",
      interval: "5min",
      session_filter: "all",
      start: "2024-03-08 09:30",
      end: "2024-03-08 16:00",
    });
    const daily = tradierBarsQuery("AAPL", { timeframe: "1d", from: Date.UTC(2024, 0, 2, 5) });
    expect(daily.path).toBe("/history");
    expect(Object.fromEntries(daily.params)).toEqual({ symbol: "AAPL", interval: "daily", start: "2024-01-02" });
    expect(() => tradierBarsQuery("AAPL", { timeframe: "1h" })).toThrow(UnsupportedCapabilityError);
  });
});

describe("connection.fetchBars()", () => {
  it("pages Alpaca stock bars with page_token on the market-data host and returns them oldest-first", async () => {
    const { fetch, urls } = recordingFetch([
      { bars: [{ t: "2024-03-08T14:31:00Z", o: 2, h: 3, l: 2, c: 3, v: 1 }], next_page_token: "p2", symbol: "AAPL" },
      { bars: [{ t: "2024-03-08T14:30:00Z", o: 1, h: 2, l: 1, c: 2, v: 1 }], next_page_token: null, symbol: "AAPL" },
    ]);
    const connection = connect({ broker: "alpaca", credentials: { apiKey: "PKTEST", apiSecret: "s" }, fetch });
    const bars = await connection.fetchBars("aapl", { timeframe: "1m", from: Date.UTC(2024, 2, 8, 14, 30) });
    expect(bars.map((bar) => bar.time)).toEqual([Date.UTC(2024, 2, 8, 14, 30), Date.UTC(2024, 2, 8, 14, 31)]);
    expect(urls).toHaveLength(2);
    const first = new URL(urls[0]!);
    expect(first.origin).toBe("https://data.alpaca.markets");
    expect(first.pathname).toBe("/v2/stocks/AAPL/bars");
    expect(first.searchParams.get("feed")).toBe("iex");
    expect(first.searchParams.get("timeframe")).toBe("1Min");
    expect(first.searchParams.get("page_token")).toBeNull();
    expect(new URL(urls[1]!).searchParams.get("page_token")).toBe("p2");
  });

  it("stops paging Alpaca once `limit` bars are in hand", async () => {
    const page = {
      bars: [
        { t: "2024-03-08T14:32:00Z", o: 1, h: 2, l: 1, c: 2, v: 1 },
        { t: "2024-03-08T14:31:00Z", o: 1, h: 2, l: 1, c: 2, v: 1 },
      ],
      next_page_token: "more",
    };
    const { fetch, urls } = recordingFetch([page, page]);
    const connection = connect({ broker: "alpaca", credentials: { apiKey: "AK", apiSecret: "s" }, fetch });
    const bars = await connection.fetchBars("AAPL", { timeframe: "1m", limit: 2 });
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).searchParams.get("limit")).toBe("2");
    expect(bars).toHaveLength(2);
  });

  it("uses the v1beta3 crypto endpoint for slash pairs and reads the per-symbol map", async () => {
    const { fetch, urls } = recordingFetch([
      { bars: { "BTC/USD": [{ t: "2024-03-08T00:00:00Z", o: 66000, h: 67000, l: 65500, c: 66800, v: 12.5 }] } },
    ]);
    const connection = connect({ broker: "alpaca", credentials: { apiKey: "AK", apiSecret: "s" }, fetch });
    const bars = await connection.fetchBars("BTC/USD", { timeframe: "1d" });
    expect(bars).toEqual([{ time: Date.UTC(2024, 2, 8), open: 66000, high: 67000, low: 65500, close: 66800, volume: 12.5 }]);
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe("/v1beta3/crypto/us/bars");
    expect(url.searchParams.get("symbols")).toBe("BTC/USD");
    expect(url.searchParams.get("feed")).toBeNull();
  });

  it("fetches Tradier intraday bars from timesales with ET-formatted bounds", async () => {
    const { fetch, urls } = recordingFetch([
      { series: { data: [{ time: "2024-07-01T09:30:00", open: 1, high: 2, low: 1, close: 2, volume: 10 }] } },
    ]);
    const connection = connect({ broker: "tradier", credentials: { accessToken: "t" }, fetch });
    const bars = await connection.fetchBars("AAPL", {
      timeframe: "15m",
      from: Date.UTC(2024, 6, 1, 13, 30),
      to: Date.UTC(2024, 6, 1, 20),
    });
    expect(bars).toEqual([{ time: Date.UTC(2024, 6, 1, 13, 30), open: 1, high: 2, low: 1, close: 2, volume: 10 }]);
    const url = new URL(urls[0]!);
    expect(url.origin + url.pathname).toBe("https://api.tradier.com/v1/markets/timesales");
    expect(url.searchParams.get("interval")).toBe("15min");
    expect(url.searchParams.get("session_filter")).toBe("all");
    expect(url.searchParams.get("start")).toBe("2024-07-01 09:30");
    expect(url.searchParams.get("end")).toBe("2024-07-01 16:00");
  });

  it("fetches Tradier daily bars from history", async () => {
    const { fetch, urls } = recordingFetch([{ history: { day: [{ date: "2024-07-01", open: 1, high: 2, low: 1, close: 2, volume: 3 }] } }]);
    const connection = connect({ broker: "tradier", credentials: { accessToken: "t" }, fetch });
    await connection.fetchBars("AAPL", { timeframe: "1d" });
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe("/v1/markets/history");
    expect(url.searchParams.get("interval")).toBe("daily");
  });

  it("refuses before any network call when credentials are missing or the timeframe is unsupported", async () => {
    const untouchable = (() => {
      throw new Error("network must not be touched");
    }) as typeof globalThis.fetch;
    const tradier = connect({ broker: "tradier", credentials: { accessToken: "t" }, fetch: untouchable });
    await expect(tradier.fetchBars("AAPL", { timeframe: "1h" })).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    const alpaca = connect({ broker: "alpaca", credentials: { apiKey: "", apiSecret: "" }, fetch: untouchable });
    await expect(alpaca.fetchBars("AAPL", { timeframe: "1m" })).rejects.toBeInstanceOf(MissingCredentialsError);
  });

  it("throws a typed unsupported error for brokers without market-data endpoints", async () => {
    const connection = connect({
      broker: "kraken",
      credentials: { apiKey: "k", apiSecret: "cw==" },
      fetch: (() => {
        throw new Error("network must not be touched");
      }) as typeof globalThis.fetch,
    });
    expect(typeof connection.fetchBars).toBe("function");
    const error = await connection.fetchBars("BTC/USD", { timeframe: "1d" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedCapabilityError);
    expect(error).toMatchObject({ broker: "kraken", capability: "fetchBars" });
  });

  it("advertises the capability per broker", () => {
    expect(supportsBars("alpaca")).toBe(true);
    expect(supportsBars("tradier")).toBe(true);
    expect(supportsBars("kraken")).toBe(false);
    const flags = Object.fromEntries(listBrokers().map((broker) => [broker.id, broker.supportsBars]));
    expect(flags.alpaca).toBe(true);
    expect(flags.tradier).toBe(true);
    expect(flags.binance).toBe(false);
  });
});
