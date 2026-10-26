import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { binance } from "../src/adapters/binance.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const SECRET = "s";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

type Call = { path: string; query: URLSearchParams; apiKey: string | null };
type Route = (query: URLSearchParams, call: number) => Response;

/** A fake Binance: spot and futures answer with empty defaults unless a route overrides them. */
const fakeBinance = (routes: Record<string, Route> = {}) => {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const fetch = (async (url: string, init?: RequestInit) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({ path: pathname, query: searchParams, apiKey: new Headers(init?.headers).get("x-mbx-apikey") });
    const count = counts.get(pathname) ?? 0;
    counts.set(pathname, count + 1);
    const route = routes[pathname];
    if (route) return route(searchParams, count);
    if (pathname === "/api/v3/account") return json({ balances: [{ asset: "USDT", free: "10", locked: "0" }] });
    if (pathname === "/api/v3/ticker/price") return json([]);
    if (pathname === "/fapi/v3/account") return json({ totalMarginBalance: "100" });
    if (pathname.startsWith("/fapi/")) return json([]);
    return json({ code: -1, msg: "unknown route" }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, calls, to: (path: string) => calls.filter((call) => call.path === path) };
};

const fill = (id: number, symbol: string, time: number, extra: Record<string, unknown> = {}) => ({
  id,
  symbol,
  side: "BUY",
  positionSide: "BOTH",
  price: "100",
  qty: "1",
  commission: "0.04",
  commissionAsset: "USDT",
  time,
  ...extra,
});

const credentials = { apiKey: "k", apiSecret: SECRET };

describe("Binance USDⓈ-M futures", () => {
  it("a key that cannot read futures keeps the spot account, as before", async () => {
    const gateway = fakeBinance({ "/fapi/v3/account": () => json({ code: -2015, msg: "Invalid API-key" }, 401) });
    const { raw } = await binance.fetchRaw(credentials, { fetch: gateway.fetch });
    expect(raw.futures).toBeUndefined();
    expect(binance.normalize(raw).map((account) => account.id)).toEqual(["binance-spot"]);
    expect(gateway.to("/fapi/v1/userTrades")).toHaveLength(0);
  });

  it("an inactive futures account keeps the spot account too", async () => {
    const gateway = fakeBinance({ "/fapi/v3/account": () => json({ code: -4109, msg: "Inactive account." }, 400) });
    const { raw } = await binance.fetchRaw(credentials, { fetch: gateway.fetch });
    expect(raw.futures).toBeUndefined();
  });

  it("an unexpected futures error fails the sync instead of dropping its history", async () => {
    const gateway = fakeBinance({ "/fapi/v3/account": () => json({ code: -1022, msg: "Invalid signature" }, 400) });
    await expect(binance.fetchRaw(credentials, { fetch: gateway.fetch })).rejects.toThrow("400");
  });

  it("a firewall 403 fails the sync rather than reading as a key without futures", async () => {
    const gateway = fakeBinance({ "/fapi/v3/account": () => new Response("WAF Limit", { status: 403 }) });
    await expect(binance.fetchRaw(credentials, { fetch: gateway.fetch })).rejects.toThrow("firewall");
  });

  it("a server error or dropped connection is retried rather than failing the sync", async () => {
    let dropped = false;
    const gateway = fakeBinance({
      "/fapi/v3/account": (_, call) =>
        call === 0 ? json({ code: -1008, msg: "Request throttled" }, 503) : json({ totalMarginBalance: "5" }),
    });
    const flaky = (async (url: string, init?: RequestInit) => {
      if (!dropped && new URL(url).pathname === "/fapi/v3/positionRisk") {
        dropped = true;
        throw new TypeError("fetch failed");
      }
      return gateway.fetch(url, init);
    }) as typeof globalThis.fetch;
    const { raw } = await binance.fetchRaw(credentials, { fetch: flaky, historySince: new Date().toISOString() });
    expect(gateway.to("/fapi/v3/account")).toHaveLength(2);
    expect(raw.futures!.account.totalMarginBalance).toBe("5");
  });

  it("finds traded symbols in the income history and open positions, then reads each in 7-day windows", async () => {
    const since = new Date(Date.now() - 10 * DAY_MS).toISOString();
    const gateway = fakeBinance({
      "/fapi/v3/positionRisk": () =>
        json([
          { symbol: "BTCUSDT", positionAmt: "0.5", notional: "30000" },
          { symbol: "SOLUSDT", positionAmt: "0", notional: "0" },
        ]),
      "/fapi/v1/income": () =>
        json([
          { symbol: "ETHUSDT", incomeType: "COMMISSION", income: "-0.04" },
          { symbol: "", incomeType: "TRANSFER", income: "100" },
        ]),
      "/fapi/v1/userTrades": (query) =>
        json([fill(Number(query.get("startTime")) % 1000, query.get("symbol")!, Number(query.get("startTime")))]),
    });
    const { raw } = await binance.fetchRaw(credentials, { fetch: gateway.fetch, historySince: since });

    const tradeCalls = gateway.to("/fapi/v1/userTrades");
    expect([...new Set(tradeCalls.map((call) => call.query.get("symbol")))]).toEqual(["BTCUSDT", "ETHUSDT"]);
    for (const call of [...tradeCalls, ...gateway.to("/fapi/v1/income")]) {
      const start = Number(call.query.get("startTime"));
      const end = Number(call.query.get("endTime"));
      expect(end - start).toBeLessThan(7 * DAY_MS);
    }
    expect(tradeCalls).toHaveLength(4);
    expect(tradeCalls[0]!.query.get("startTime")).toBe(String(Date.parse(since)));
    expect(raw.futures!.trades).toHaveLength(4);
  });

  it("signs every futures request over its own parameters with the API key header", async () => {
    const gateway = fakeBinance({ "/fapi/v1/income": () => json([{ symbol: "ETHUSDT" }]) });
    await binance.fetchRaw(credentials, {
      fetch: gateway.fetch,
      historySince: new Date(Date.now() - DAY_MS).toISOString(),
    });
    const futuresCalls = gateway.calls.filter((call) => call.path.startsWith("/fapi/"));
    expect(futuresCalls.length).toBeGreaterThan(3);
    for (const call of futuresCalls) {
      const signature = call.query.get("signature");
      const unsigned = new URLSearchParams(call.query);
      unsigned.delete("signature");
      expect(signature).toBe(createHmac("sha256", SECRET).update(unsigned.toString()).digest("hex"));
      expect(call.apiKey).toBe("k");
      expect(call.query.get("timestamp")).toMatch(/^\d+$/);
    }
  });

  it("history reaches back at most 89 days, whatever historySince asks for", async () => {
    const before = Date.now();
    const gateway = fakeBinance();
    await binance.fetchRaw(credentials, {
      fetch: gateway.fetch,
      historySince: new Date(before - 200 * DAY_MS).toISOString(),
    });
    const after = Date.now();
    const firstStart = Number(gateway.to("/fapi/v1/income")[0]!.query.get("startTime"));
    expect(firstStart).toBeGreaterThanOrEqual(before - 89 * DAY_MS);
    expect(firstStart).toBeLessThanOrEqual(after - 89 * DAY_MS);
  });

  it("a full page is fetched again in halves so no fill is cut off", async () => {
    const since = Date.now() - 5 * DAY_MS;
    let next = 0;
    const gateway = fakeBinance({
      "/fapi/v1/income": () => json([{ symbol: "BTCUSDT" }]),
      "/fapi/v1/userTrades": (query) => {
        const span = Number(query.get("endTime")) - Number(query.get("startTime"));
        const count = span > 3 * DAY_MS ? 1000 : 2;
        return json(Array.from({ length: count }, () => fill(++next, "BTCUSDT", Number(query.get("startTime")))));
      },
    });
    const { raw } = await binance.fetchRaw(credentials, {
      fetch: gateway.fetch,
      historySince: new Date(since).toISOString(),
    });
    const windows = gateway.to("/fapi/v1/userTrades").map((call): [number, number] => [
      Number(call.query.get("startTime")),
      Number(call.query.get("endTime")),
    ]);
    expect(windows).toHaveLength(3);
    expect(windows[1]![0]).toBe(windows[0]![0]);
    expect(windows[2]![0]).toBe(windows[1]![1] + 1);
    expect(windows[2]![1]).toBe(windows[0]![1]);
    expect(raw.futures!.trades).toHaveLength(4);
  });

  it("prices fees paid in BNB at that hour's BNB/USDT open", async () => {
    const time = Date.now() - 2 * DAY_MS;
    const hour = Math.floor(time / HOUR_MS) * HOUR_MS;
    const gateway = fakeBinance({
      "/fapi/v1/income": () => json([{ symbol: "BTCUSDT" }]),
      "/fapi/v1/userTrades": (_, call) =>
        json(call === 0 ? [fill(1, "BTCUSDT", time, { commission: "0.0001", commissionAsset: "BNB" })] : []),
      "/api/v3/klines": () =>
        json([
          [hour, "590", "610", "585", "600.5", "1000", hour + HOUR_MS - 1],
          [hour + HOUR_MS, "600.5", "605", "598", "601", "900", hour + 2 * HOUR_MS - 1],
        ]),
    });
    const { raw } = await binance.fetchRaw(credentials, {
      fetch: gateway.fetch,
      historySince: new Date(Date.now() - 3 * DAY_MS).toISOString(),
    });
    const klines = gateway.to("/api/v3/klines");
    expect(klines).toHaveLength(1);
    expect(klines[0]!.query.get("symbol")).toBe("BNBUSDT");
    expect(klines[0]!.query.get("startTime")).toBe(String(hour));
    // The hour's open, which no longer moves once the hour has started.
    expect(raw.futures!.bnbUsdtHourly).toEqual({ [String(hour)]: 590 });
    expect(binance.normalize(raw)[1]!.trades[0]!.fee).toBeCloseTo(0.059, 10);
  });

  it("asks for no BNB prices when no fee was paid in BNB", async () => {
    const gateway = fakeBinance({
      "/fapi/v1/income": () => json([{ symbol: "BTCUSDT" }]),
      "/fapi/v1/userTrades": (_, call) => json(call === 0 ? [fill(1, "BTCUSDT", Date.now() - DAY_MS)] : []),
    });
    await binance.fetchRaw(credentials, {
      fetch: gateway.fetch,
      historySince: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    });
    expect(gateway.to("/api/v3/klines")).toHaveLength(0);
  });

  it("a rate-limited request waits and is retried rather than failing the sync", async () => {
    const gateway = fakeBinance({
      "/fapi/v3/account": (_, call) =>
        call === 0 ? json({ code: -1003 }, 429, { "Retry-After": "0" }) : json({ totalMarginBalance: "5" }),
    });
    const { raw } = await binance.fetchRaw(credentials, {
      fetch: gateway.fetch,
      historySince: new Date().toISOString(),
    });
    expect(gateway.to("/fapi/v3/account")).toHaveLength(2);
    expect(raw.futures!.account.totalMarginBalance).toBe("5");
  });

  it("a symbol Binance no longer lists is skipped rather than failing the sync", async () => {
    const gateway = fakeBinance({
      "/fapi/v1/income": () => json([{ symbol: "GONEUSDT" }, { symbol: "BTCUSDT" }]),
      "/fapi/v1/userTrades": (query) =>
        query.get("symbol") === "GONEUSDT"
          ? json({ code: -1121, msg: "Invalid symbol." }, 400)
          : json([fill(1, "BTCUSDT", Date.now() - DAY_MS)]),
    });
    const { raw } = await binance.fetchRaw(credentials, {
      fetch: gateway.fetch,
      historySince: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    });
    expect(raw.futures!.trades.map((trade) => trade.symbol)).toEqual(["BTCUSDT"]);
  });

  it("more than a page of fills in one millisecond is read on by fill ID", async () => {
    const time = Date.now() - DAY_MS;
    const burst = Array.from({ length: 1500 }, (_, index) => fill(index + 1, "BTCUSDT", time));
    const gateway = fakeBinance({
      "/fapi/v1/income": () => json([{ symbol: "BTCUSDT" }]),
      "/fapi/v1/userTrades": (query) => {
        const fromId = query.get("fromId");
        if (fromId) return json(burst.filter((row) => row.id >= Number(fromId)).slice(0, 1000));
        const start = Number(query.get("startTime"));
        const end = Number(query.get("endTime"));
        return json(burst.filter((row) => row.time >= start && row.time <= end).slice(0, 1000));
      },
    });
    const { raw } = await binance.fetchRaw(credentials, {
      fetch: gateway.fetch,
      historySince: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    });
    expect(raw.futures!.trades).toHaveLength(1500);
    expect(binance.normalize(raw)[1]!.trades).toHaveLength(1500);
  });
});
