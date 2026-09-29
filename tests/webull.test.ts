import { describe, expect, it } from "vitest";

import { webull, webullOptionSymbol } from "../src/adapters/webull.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

type Call = { path: string; query: URLSearchParams; version: string | null };

/** A fake Webull gateway: one account, and `history` answers each order-history call. */
const fakeWebull = (history: (query: URLSearchParams, call: number) => Response) => {
  const calls: Call[] = [];
  let historyCalls = 0;
  const fetch = (async (url: string, init?: RequestInit) => {
    const { pathname, searchParams } = new URL(url);
    const version = new Headers(init?.headers).get("x-version");
    calls.push({ path: pathname, query: searchParams, version });
    if (pathname === "/trading/accounts/list") return json([{ account_id: "A1" }]);
    if (pathname === "/trading/assets/balances/get") return json({ total_net_liquidation_value: "10" });
    if (pathname === "/trading/assets/positions/list") return json([]);
    if (pathname === "/trading/orders/historical-orders/list") return history(searchParams, historyCalls++);
    return json({ error_msg: "404 Route Not Found" }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, calls, history: () => calls.filter((c) => c.path.endsWith("historical-orders/list")) };
};

const filled = (at: string | null) => ({
  symbol: "ABC",
  side: "BUY",
  status: "FILLED",
  instrument_type: "EQUITY",
  filled_quantity: "1",
  filled_price: "100",
  filled_time_at: at,
});

describe("Webull OpenAPI history", () => {
  it("names single-leg options OCC-style and refuses incomplete contract details", () => {
    const leg = { option_type: "CALL", option_expire_date: "2026-09-28", strike_price: "12.50" };
    expect(webullOptionSymbol("ABC", leg)).toBe("ABC 260928C12.5");
    expect(webullOptionSymbol("ABC", { ...leg, option_type: "" })).toBeUndefined();
    expect(webullOptionSymbol("ABC", { ...leg, option_expire_date: "soon" })).toBeUndefined();
  });

  it("calls the v3 trading routes, since the v1 openapi paths no longer exist", async () => {
    const gateway = fakeWebull(() => json({ data: [] }));
    await webull.fetchRaw({ apiKey: "k", apiSecret: "s" }, { fetch: gateway.fetch, historySince: new Date().toISOString() });
    expect(gateway.calls.every((call) => call.version === "v3")).toBe(true);
    expect(gateway.calls.some((call) => call.path.startsWith("/openapi/"))).toBe(false);
  });

  it("pages each 30-day window from historySince and follows pagination keys", async () => {
    const gateway = fakeWebull((query) =>
      json(
        query.get("pagination_key")
          ? { data: [{ orders: [filled(query.get("end_time"))] }] }
          : { data: [{ orders: [filled(query.get("end_time"))] }], pagination_key: "p2" },
      ),
    );
    const since = new Date(Date.now() - 45 * 86_400_000).toISOString();
    const { raw } = await webull.fetchRaw({ apiKey: "k", apiSecret: "s" }, { fetch: gateway.fetch, historySince: since });

    expect(raw.accounts[0]!.orders).toHaveLength(4);
    const windows = gateway.history().filter((call) => !call.query.get("pagination_key"));
    expect(windows).toHaveLength(2);
    expect(windows.at(-1)!.query.get("start_time")).toBe(since);
    expect(windows.every((call) => call.query.get("start_time")!.endsWith("Z"))).toBe(true);
  });

  it("a repeated pagination key ends the window instead of looping forever", async () => {
    const gateway = fakeWebull(() => json({ data: [], pagination_key: "same" }));
    const since = new Date(Date.now() - 86_400_000).toISOString();
    await webull.fetchRaw({ apiKey: "k", apiSecret: "s" }, { fetch: gateway.fetch, historySince: since });
    expect(gateway.history()).toHaveLength(2);
  });

  it("a rate-limited request is retried rather than failing the sync", async () => {
    const gateway = fakeWebull((_, call) => (call === 0 ? json({}, 429) : json({ data: [{ orders: [filled("2026-09-25T00:00:00Z")] }] })));
    const { raw } = await webull.fetchRaw(
      { apiKey: "k", apiSecret: "s" },
      { fetch: gateway.fetch, historySince: new Date(Date.now() - 86_400_000).toISOString() },
    );
    expect(raw.accounts[0]!.orders).toHaveLength(1);
    expect(gateway.history()).toHaveLength(2);
  });

  it("history older than Webull retains ends the walk, even when no orders were found yet", async () => {
    const gateway = fakeWebull((_, call) => (call === 0 ? json({ data: [] }) : json({ code: "INVALID" }, 417)));
    const { raw } = await webull.fetchRaw({ apiKey: "k", apiSecret: "s" }, { fetch: gateway.fetch });
    expect(raw.accounts[0]!.orders).toEqual([]);
    expect(gateway.history()).toHaveLength(2);
  });

  it("a rejected request for the newest window still fails loudly", async () => {
    const gateway = fakeWebull(() => json({ code: "INVALID" }, 417));
    await expect(webull.fetchRaw({ apiKey: "k", apiSecret: "s" }, { fetch: gateway.fetch })).rejects.toThrow("417");
  });
});
