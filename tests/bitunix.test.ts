import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bitunix, bitunixSignature, type BitunixRaw } from "../src/adapters/bitunix.js";
import { BrokerAuthError, BrokerRequestError, MissingCredentialsError } from "../src/errors.js";
import { connect, listBrokers } from "../src/index.js";

const NOW = Date.UTC(2026, 9, 28, 12);
const credentials = { apiKey: "fixture-api-key", apiSecret: "fixture-api-secret" };
const account = { marginCoin: "USDT", available: "1000", frozen: "10", margin: "100", crossUnrealizedPNL: "5", isolationUnrealizedPNL: "-2" };
const position = (id: string, side = "BUY", extra: Record<string, unknown> = {}) => ({
  positionId: id, symbol: "BTCUSDT", side, positionMode: "HEDGE", subAccountId: "main-fixture", ...extra,
});
const fill = (id: string, side = "BUY", extra: Record<string, unknown> = {}) => ({
  tradeId: id, orderId: `order-${id}`, symbol: "BTCUSDT", side, positionMode: "HEDGE", qty: "1", price: "100", fee: "0.1", ctime: String(NOW - 1000), reduceOnly: side === "SELL", ...extra,
});
const raw = (extra: Partial<BitunixRaw> = {}): BitunixRaw => ({ account, pendingPositions: [], historyPositions: [], trades: [], positionTrades: [], ...extra });
const json = (data: unknown) => Response.json({ code: 0, data });
type Call = { url: URL; init: RequestInit };
type Route = (query: URLSearchParams, index: number) => Response | Promise<Response>;
const gateway = (routes: Record<string, Route> = {}) => {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    const count = counts.get(url.pathname) ?? 0;
    counts.set(url.pathname, count + 1);
    const route = routes[url.pathname];
    if (route) return route(url.searchParams, count);
    if (url.pathname === "/api/v1/futures/account") return json([account]);
    if (url.pathname.endsWith("get_pending_positions")) return json([]);
    if (url.pathname.endsWith("get_history_positions")) return json({ positionList: [], total: "0" });
    if (url.pathname.endsWith("get_history_trades")) return json({ tradeList: [], total: "0" });
    throw new Error("Unexpected endpoint");
  }) as typeof globalThis.fetch;
  return { fetch, calls };
};

// Run throttling/retry timers without waiting in real time, capturing rejections immediately.
async function settle<T>(job: Promise<T>): Promise<T> {
  const done = job.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  await vi.runAllTimersAsync();
  const result = await done;
  if (!result.ok) throw result.error;
  return result.value;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

describe("Bitunix signing and IO", () => {
  it("matches an independently computed double-SHA256 GET vector", () => {
    expect(bitunixSignature({ symbol: "BTCUSDT", startTime: "100", endTime: "200" }, "public-test-key", "private-test-secret", "nonce-test", "1700000000000"))
      .toBe("76b3f6942b45e259ffd1002b281d6b3df834b13e74e4b182cf148e9c234fb4e7");
  });

  it("validates credentials and historySince before touching the network", async () => {
    const remote = gateway();
    await expect(bitunix.fetchRaw({ apiKey: "", apiSecret: "s" }, { fetch: remote.fetch })).rejects.toBeInstanceOf(MissingCredentialsError);
    for (const historySince of ["bad", new Date(NOW + 1).toISOString()]) {
      await expect(bitunix.fetchRaw(credentials, { fetch: remote.fetch, historySince })).rejects.toThrow("historySince");
    }
    expect(remote.calls).toHaveLength(0);
  });

  it("registers a normal SDK connection and sends signed GETs only to the official host", async () => {
    const remote = gateway();
    const snapshot = await settle(connect({ broker: "bitunix", credentials, fetch: remote.fetch }).fetchSnapshot());
    expect(snapshot.accounts[0]).toMatchObject({ currency: "USDT", equity: 1113, trades: [], positions: [] });
    expect(listBrokers().find((broker) => broker.id === "bitunix")?.credentials).toHaveLength(2);
    expect(remote.calls).toHaveLength(4);
    for (const { url, init } of remote.calls) {
      const headers = new Headers(init.headers);
      expect(url.origin).toBe("https://fapi.bitunix.com");
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      expect(init.body).toBeUndefined();
      expect(headers.get("nonce")!.length).toBeLessThan(64);
      expect(headers.get("sign")).toBe(bitunixSignature(Object.fromEntries(url.searchParams), credentials.apiKey, credentials.apiSecret, headers.get("nonce")!, headers.get("timestamp")!));
      expect(url.toString()).not.toContain(credentials.apiKey);
    }
    expect(remote.calls.find((call) => call.url.pathname.endsWith("get_pending_positions"))!.url.searchParams.get("includeSubAccounts")).toBe("false");
    expect(remote.calls.find((call) => call.url.pathname.endsWith("get_history_trades"))!.url.searchParams.get("startTime")).toBe("0");
  });

  it("follows skip/limit pages and keeps native IDs distinct", async () => {
    const remote = gateway({
      "/api/v1/futures/trade/get_history_trades": (query) => {
        const skip = Number(query.get("skip"));
        expect(query.get("limit")).toBe("100");
        const tradeList = skip === 0 ? Array.from({ length: 100 }, (_, i) => fill(`fill-${i}`, "BUY", { positionMode: "ONE_WAY" })) : [fill("last", "BUY", { positionMode: "ONE_WAY" })];
        return json({ tradeList, total: "101" });
      },
    });
    const result = await settle(bitunix.fetchRaw(credentials, { fetch: remote.fetch }));
    expect(bitunix.normalize(result.raw)[0]!.trades).toHaveLength(101);
    expect(remote.calls.filter((call) => call.url.pathname.endsWith("get_history_trades")).map((call) => call.url.searchParams.get("skip"))).toEqual(["0", "100"]);
  });

  it("uses historySince for fills, but discovers old positions without a creation-time cutoff", async () => {
    const pos = position("older-than-overlap", "BUY", { ctime: "1000" });
    const remote = gateway({
      "/api/v1/futures/position/get_pending_positions": () => json([pos]),
      "/api/v1/futures/position/get_history_positions": () => json({ positionList: [pos], total: "1" }),
      "/api/v1/futures/trade/get_history_trades": () => json({ tradeList: [fill("close", "SELL")], total: "1" }),
    });
    const since = NOW - 30 * 86400000;
    const result = await settle(bitunix.fetchRaw(credentials, { fetch: remote.fetch, historySince: new Date(since).toISOString() }));
    const historyCall = remote.calls.find((call) => call.url.pathname.endsWith("get_history_positions"))!;
    expect(historyCall.url.searchParams.has("startTime")).toBe(false);
    const fills = remote.calls.filter((call) => call.url.pathname.endsWith("get_history_trades"));
    expect(fills).toHaveLength(2); // history/pending overlap queries this position once
    for (const call of fills) {
      expect(call.url.searchParams.get("startTime")).toBe(String(since));
      expect(call.url.searchParams.get("endTime")).toBe(String(NOW));
    }
    expect(bitunix.normalize(result.raw)[0]!.trades[0]).toMatchObject({ positionSide: "long", positionEffect: "close" });
  });

  it("paginates the position catalogue and position-filtered fills too", async () => {
    const remote = gateway({
      "/api/v1/futures/position/get_history_positions": (query) => json({
        positionList: query.get("skip") === "0" ? Array.from({ length: 100 }, (_, i) => position(`p${i}`, "BUY", { positionMode: "ONE_WAY" })) : [position("hedge")], total: "101",
      }),
      "/api/v1/futures/trade/get_history_trades": (query) => {
        if (!query.has("positionId")) return json({ tradeList: [], total: "0" });
        return json({ tradeList: query.get("skip") === "0" ? Array.from({ length: 100 }, (_, i) => fill(`t${i}`)) : [fill("last")], total: "101" });
      },
    });
    const { raw: payload } = await settle(bitunix.fetchRaw(credentials, { fetch: remote.fetch }));
    expect(payload.historyPositions).toHaveLength(101);
    expect(payload.positionTrades[0]!.trades).toHaveLength(101);
  });

  it("fails rather than accepting a repeating or prematurely ended page", async () => {
    for (const repeated of [true, false]) {
      const remote = gateway({ "/api/v1/futures/trade/get_history_trades": () => json({ tradeList: Array.from({ length: repeated ? 100 : 1 }, (_, i) => fill(`t${i}`)), total: "200" }) });
      await expect(settle(bitunix.fetchRaw(credentials, { fetch: remote.fetch }))).rejects.toThrow(repeated ? "repeated" : "before its reported total");
    }
  });

  it("handles HTTP and business authentication failures without repeating them", async () => {
    for (const response of [Response.json({}, { status: 401 }), Response.json({ code: 403, msg: credentials.apiSecret }), Response.json({ code: 10007 })]) {
      const remote = gateway({ "/api/v1/futures/account": () => response });
      await expect(settle(bitunix.fetchRaw(credentials, { fetch: remote.fetch }))).rejects.toBeInstanceOf(BrokerAuthError);
      expect(remote.calls).toHaveLength(1);
    }
  });

  it("retries dropped requests, 5xx, HTTP and business rate limits with fresh signatures", async () => {
    const remote = gateway({ "/api/v1/futures/account": (_, index) => {
      if (index === 0) throw new Error(credentials.apiSecret);
      if (index === 1) return Response.json({}, { status: 503 });
      if (index === 2) return Response.json({ code: 10006 });
      return json([account]);
    } });
    await settle(bitunix.fetchRaw(credentials, { fetch: remote.fetch }));
    const attempts = remote.calls.filter((call) => call.url.pathname === "/api/v1/futures/account");
    expect(attempts).toHaveLength(4);
    expect(new Set(attempts.map((call) => new Headers(call.init.headers).get("sign"))).size).toBe(4);
    const limited = gateway({ "/api/v1/futures/account": (_, index) => index === 0 ? Response.json({}, { status: 429, headers: { "retry-after": "2" } }) : json(account) });
    await settle(bitunix.fetchRaw(credentials, { fetch: limited.fetch }));
    expect(limited.calls.filter((call) => call.url.pathname === "/api/v1/futures/account")).toHaveLength(2);
  });

  it("does not leak arbitrary provider messages or network errors after retry exhaustion", async () => {
    for (const route of [() => { throw Error(credentials.apiSecret); }, () => Response.json({ code: 10002, msg: credentials.apiSecret })]) {
      const remote = gateway({ "/api/v1/futures/account": route });
      try { await settle(bitunix.fetchRaw(credentials, { fetch: remote.fetch })); throw new Error("must fail"); }
      catch (error) { expect(error).toBeInstanceOf(BrokerRequestError); expect(String(error)).not.toContain(credentials.apiSecret); }
    }
  });

  it("rejects malformed JSON, envelope and page shapes", async () => {
    for (const response of [new Response("not json"), Response.json({ data: [] }), Response.json({ code: 0, data: [] })]) {
      const remote = gateway({ "/api/v1/futures/position/get_history_positions": () => response });
      await expect(settle(bitunix.fetchRaw(credentials, { fetch: remote.fetch }))).rejects.toBeInstanceOf(BrokerRequestError);
    }
  });
});

describe("Bitunix normalization", () => {
  it("keeps simultaneous long/short and actual MARKET fill prices, not position averages", () => {
    const long = position("long"); const short = position("short", "SELL");
    const lo = fill("lo"); const lc = fill("lc", "SELL", { price: "110", ctime: String(NOW) });
    const so = fill("so", "SELL", { reduceOnly: false }); const sc = fill("sc", "BUY", { reduceOnly: true, price: "90", ctime: String(NOW) });
    const normalized = bitunix.normalize(raw({
      historyPositions: [long, short],
      pendingPositions: [{ ...long, qty: "0.5", avgOpenPrice: "99" }, { ...short, qty: "2", avgOpenPrice: "100" }],
      trades: [lc, lo, sc, so],
      positionTrades: [{ positionId: "long", trades: [lo, lc] }, { positionId: "short", trades: [so, sc] }],
    }))[0]!;
    expect(normalized.positions).toEqual([
      { symbol: "BTCUSDT", quantity: 0.5, averageEntryPrice: 99, assetClass: "futures", positionSide: "long", positionId: "long" },
      { symbol: "BTCUSDT", quantity: -2, averageEntryPrice: 100, assetClass: "futures", positionSide: "short", positionId: "short" },
    ]);
    expect(normalized.trades.map((t) => [t.side, t.price, t.positionSide, t.positionEffect])).toEqual([
      ["buy", 100, "long", "open"], ["sell", 100, "short", "open"], ["sell", 110, "long", "close"], ["buy", 90, "short", "close"],
    ]);
    expect(normalized.trades.map((t) => t.positionId)).toEqual(["long", "short", "long", "short"]);
  });

  it("preserves distinct IDs for concurrent positions on the same symbol and side", () => {
    const first = fill("first"); const second = fill("second");
    const normalized = bitunix.normalize(raw({
      historyPositions: [position("position-a"), position("position-b")],
      trades: [first, second],
      positionTrades: [{ positionId: "position-a", trades: [first] }, { positionId: "position-b", trades: [second] }],
    }))[0]!;
    expect(normalized.trades).toHaveLength(2);
    expect(normalized.trades.map((t) => t.positionSide)).toEqual(["long", "long"]);
    expect(normalized.trades.map((t) => t.positionId)).toEqual(["position-a", "position-b"]);
  });

  it("deduplicates native IDs without losing distinct identical partial fills or signed fees", () => {
    const a = fill("a", "BUY", { positionMode: "ONE_WAY", fee: "-0.01" }); const b = { ...a, tradeId: "b" };
    const trades = bitunix.normalize(raw({ trades: [a, a, b, { ...a, tradeId: "bad", qty: "not-a-number" }] }))[0]!.trades;
    expect(trades).toHaveLength(2);
    expect(trades.map((trade) => trade.fee)).toEqual([-0.01, -0.01]);
    expect(trades[0]!.positionEffect).toBeUndefined();
    expect(trades[0]!.positionId).toBeUndefined();
  });

  it("does not infer an opening from a one-way reversal", () => {
    const trades = bitunix.normalize(raw({ trades: [fill("a", "SELL", { positionMode: "ONE_WAY", reduceOnly: false }), fill("b", "BUY", { positionMode: "ONE_WAY", reduceOnly: true })] }))[0]!.trades;
    expect(trades[0]!.positionEffect).toBeUndefined();
    expect(trades[1]!.positionEffect).toBe("close");
  });

  it("rejects unknown hedge association and conflicting fill identity", () => {
    expect(() => bitunix.normalize(raw({ trades: [fill("missing")] }))).toThrow("no matching position");
    expect(() => bitunix.normalize(raw({ trades: [fill("a", "BUY", { positionMode: "ONE_WAY" }), fill("a", "BUY", { positionMode: "ONE_WAY", price: "101" })] }))).toThrow("conflicting facts");
  });

  it("rejects mixing source accounts, position sides, symbols or reduce-only facts", () => {
    expect(() => bitunix.normalize(raw({ historyPositions: [position("a"), position("b", "SELL", { subAccountId: "other" })] }))).toThrow("multiple source accounts");
    expect(() => bitunix.normalize(raw({ historyPositions: [position("a"), position("a", "SELL")] }))).toThrow("conflicting position identity");
    expect(() => bitunix.normalize(raw({ historyPositions: [position("a")], positionTrades: [{ positionId: "a", trades: [fill("x", "BUY", { reduceOnly: true })] }] }))).toThrow("reduce-only");
    expect(() => bitunix.normalize(raw({ historyPositions: [position("a")], positionTrades: [{ positionId: "a", trades: [fill("x", "BUY", { symbol: "ETHUSDT" })] }] }))).toThrow("another symbol");
  });

  it("does not treat a negative pending-position fee as a rebate or add funding to fills", () => {
    const trade = fill("a");
    const result = bitunix.normalize(raw({ pendingPositions: [position("a", "LONG", { qty: "1", fee: "-99", funding: "-123" })], trades: [trade], positionTrades: [{ positionId: "a", trades: [trade] }] }))[0]!;
    expect(result.trades[0]!.fee).toBe(0.1);
    expect(result.equity).toBe(1113);
  });

  it("fails incomplete equity instead of manufacturing zero and rejects unsupported margin assets", () => {
    expect(() => bitunix.normalize(raw({ account: { marginCoin: "USDT" } }))).toThrow("incomplete account equity");
    expect(() => bitunix.normalize(raw({ account: { ...account, marginCoin: "BTC" } }))).toThrow("USDT futures only");
  });
});
