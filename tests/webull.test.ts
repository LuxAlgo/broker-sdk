import { describe, expect, it } from "vitest";

import { webull, webullOptionSymbol } from "../src/adapters/webull.js";

const DAY_MS = 86_400_000;
const credentials = { apiKey: "k", apiSecret: "s" };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

type Call = { path: string; query: URLSearchParams; version: string | null };

/** A fake Webull: one account; `history` answers each order-history call in turn. */
const fakeWebull = (history: (query: URLSearchParams, call: number) => Response) => {
  const calls: Call[] = [];
  let historyCalls = 0;
  const fetch = (async (url: string, init?: RequestInit) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({ path: pathname, query: searchParams, version: new Headers(init?.headers).get("x-version") });
    if (pathname === "/trading/accounts/list") return json([{ account_id: "A1" }]);
    if (pathname === "/trading/assets/balances/get") return json({ total_net_liquidation_value: "100" });
    if (pathname === "/trading/assets/positions/list") return json([]);
    if (pathname === "/trading/orders/historical-orders/list") return history(searchParams, historyCalls++);
    return json({ error_code: "NOT_FOUND", message: "404 Route Not Found" }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, calls, history: () => calls.filter((call) => call.path.endsWith("/historical-orders/list")) };
};

const filled = (id: string, at: string) => ({
  order_id: id,
  symbol: "ABC",
  side: "BUY",
  status: "FILLED",
  instrument_type: "EQUITY",
  filled_quantity: "1",
  filled_price: "10",
  filled_time_at: at,
});

describe("Webull", () => {
  it("names option contracts OCC-style, and only when the contract is fully described", () => {
    const leg = { option_type: "PUT", option_expire_date: "2026-09-25", strike_price: "12.50" };
    expect(webullOptionSymbol("ABC", leg)).toBe("ABC 260925P12.5");
    expect(webullOptionSymbol("ABC", { option_type: "CALL", option_expire_date: "2026-12-18", option_exercise_price: "55" })).toBe(
      "ABC 261218C55",
    );
    expect(webullOptionSymbol("ABC", { ...leg, option_type: "" })).toBeUndefined();
    expect(webullOptionSymbol("ABC", { ...leg, option_expire_date: "Sep 25" })).toBeUndefined();
    expect(webullOptionSymbol("ABC", { ...leg, strike_price: "" })).toBeUndefined();
  });

  it("calls only the documented v3 trading routes, never the retired ones", async () => {
    const gateway = fakeWebull(() => json({ data: [] }));
    await webull.fetchRaw(credentials, { fetch: gateway.fetch, historySince: new Date().toISOString() });
    expect(gateway.calls.map((call) => call.path)).toEqual([
      "/trading/accounts/list",
      "/trading/assets/balances/get",
      "/trading/assets/positions/list",
      "/trading/orders/historical-orders/list",
    ]);
    expect(gateway.calls.every((call) => call.version === "v3")).toBe(true);
  });

  it("reads order history in 30-day windows back to historySince, following pagination keys", async () => {
    const since = new Date(Date.now() - 45 * DAY_MS).toISOString();
    const gateway = fakeWebull((query, call) =>
      json({
        data: [{ combo_type: "NORMAL", orders: [filled(`O${call}`, query.get("end_time")!)] }],
        ...(call === 0 ? { pagination_key: "next" } : {}),
      }),
    );
    const { raw } = await webull.fetchRaw(credentials, { fetch: gateway.fetch, historySince: since });

    const history = gateway.history();
    expect(history.map((call) => call.query.get("pagination_key"))).toEqual([null, "next", null]);
    const windows = history.filter((call) => !call.query.get("pagination_key"));
    expect(Date.parse(windows[0]!.query.get("end_time")!) - Date.parse(windows[0]!.query.get("start_time")!)).toBe(
      30 * DAY_MS,
    );
    expect(windows[1]!.query.get("start_time")).toBe(since);
    expect(windows[1]!.query.get("end_time")).toBe(windows[0]!.query.get("start_time"));
    expect(raw.accounts[0]!.orders).toHaveLength(3);
  });

  it("a pagination key seen before ends the window instead of paging forever", async () => {
    const gateway = fakeWebull(() => json({ data: [], pagination_key: "same" }));
    await webull.fetchRaw(credentials, { fetch: gateway.fetch, historySince: new Date(Date.now() - DAY_MS).toISOString() });
    expect(gateway.history()).toHaveLength(2);
  });

  it("a rate-limited call waits and is retried", async () => {
    const gateway = fakeWebull((_, call) =>
      call === 0 ? json({ error_code: "TOO_MANY_REQUESTS" }, 429, { "Retry-After": "0" }) : json({ data: [] }),
    );
    await webull.fetchRaw(credentials, { fetch: gateway.fetch, historySince: new Date(Date.now() - DAY_MS).toISOString() });
    expect(gateway.history()).toHaveLength(2);
  });

  it("a window older than the history Webull keeps ends the walk, keeping the newer orders", async () => {
    const gateway = fakeWebull((query, call) =>
      call === 0 ? json({ data: [filled("O1", query.get("end_time")!)] }) : json({ error_code: "INVALID_PARAMETER" }, 417),
    );
    const { raw } = await webull.fetchRaw(credentials, { fetch: gateway.fetch });
    expect(gateway.history()).toHaveLength(2);
    expect(webull.normalize(raw)[0]!.trades).toHaveLength(1);
  });

  it("a rejected newest window still fails the sync", async () => {
    const gateway = fakeWebull(() => json({ error_code: "INVALID_PARAMETER" }, 417));
    await expect(webull.fetchRaw(credentials, { fetch: gateway.fetch })).rejects.toThrow("417");
  });

  it("an order returned in two windows is one trade", async () => {
    const at = new Date(Date.now() - 31 * DAY_MS).toISOString();
    const gateway = fakeWebull(() => json({ data: [filled("SAME", at)] }));
    const { raw } = await webull.fetchRaw(credentials, {
      fetch: gateway.fetch,
      historySince: new Date(Date.now() - 45 * DAY_MS).toISOString(),
    });
    expect(raw.accounts[0]!.orders).toHaveLength(2);
    expect(webull.normalize(raw)[0]!.trades).toHaveLength(1);
  });
});
