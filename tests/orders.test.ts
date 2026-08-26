import { describe, expect, it } from "vitest";

import { BrokerError } from "../src/errors.js";
import {
  connectTrading,
  LIVE_TRADING_ACKNOWLEDGEMENT,
  LiveTradingBlockedError,
  normalizeAlpacaOrder,
  normalizeTradierOrder,
} from "../src/orders.js";

const paperCredentials = { apiKey: "PKTEST123", apiSecret: "secret" };

const captureFetch = (calls: { url: string; init?: RequestInit }[], body: unknown = {}, status = 200) =>
  ((url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    return Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status }));
  }) as typeof fetch;

describe("the live-trading gate", () => {
  it("refuses live Alpaca keys without the acknowledgement", () => {
    expect(() => connectTrading({ broker: "alpaca", credentials: { apiKey: "AKLIVE123", apiSecret: "s" } })).toThrow(
      LiveTradingBlockedError,
    );
  });

  it("refuses a wrong acknowledgement sentence — no near-misses", () => {
    expect(() =>
      connectTrading({
        broker: "alpaca",
        credentials: { apiKey: "AKLIVE123", apiSecret: "s" },
        acknowledgeLiveTrading: "yes I am sure",
      }),
    ).toThrow(LiveTradingBlockedError);
  });

  it("connects live only with the exact sentence, and says so in environment", async () => {
    const calls: { url: string }[] = [];
    const trading = connectTrading({
      broker: "alpaca",
      credentials: { apiKey: "AKLIVE123", apiSecret: "s" },
      acknowledgeLiveTrading: LIVE_TRADING_ACKNOWLEDGEMENT,
      fetch: captureFetch(calls, []),
    });
    expect(trading.environment).toBe("live");
    await trading.listOrders();
    expect(calls[0]?.url).toContain("https://api.alpaca.markets");
  });

  it("paper keys connect without ceremony and talk only to the paper host", async () => {
    const calls: { url: string }[] = [];
    const trading = connectTrading({
      broker: "alpaca",
      credentials: paperCredentials,
      fetch: captureFetch(calls, []),
    });
    expect(trading.environment).toBe("paper");
    await trading.listOrders();
    expect(calls[0]?.url).toContain("https://paper-api.alpaca.markets");
  });
});

describe("placing Alpaca orders", () => {
  it("validates before any network call", async () => {
    const calls: { url: string }[] = [];
    const trading = connectTrading({ broker: "alpaca", credentials: paperCredentials, fetch: captureFetch(calls) });

    await expect(trading.placeOrder({ symbol: "AAPL", side: "buy", type: "market" })).rejects.toThrow(BrokerError);
    await expect(
      trading.placeOrder({ symbol: "AAPL", side: "buy", type: "market", quantity: 1, notional: 100 }),
    ).rejects.toThrow(/exactly one/);
    await expect(trading.placeOrder({ symbol: "AAPL", side: "buy", type: "limit", quantity: 1 })).rejects.toThrow(
      /limitPrice/,
    );
    expect(calls).toHaveLength(0);
  });

  it("submits the request and returns the normalized order", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const trading = connectTrading({
      broker: "alpaca",
      credentials: paperCredentials,
      fetch: captureFetch(calls, {
        id: "ord-1",
        client_order_id: "my-key",
        symbol: "AAPL",
        side: "buy",
        type: "limit",
        status: "new",
        qty: "5",
        limit_price: "180.5",
        filled_qty: "0",
        submitted_at: "2026-08-25T14:00:00Z",
      }),
    });

    const order = await trading.placeOrder({
      symbol: "AAPL",
      side: "buy",
      type: "limit",
      quantity: 5,
      limitPrice: 180.5,
      timeInForce: "gtc",
      clientOrderId: "my-key",
    });

    expect(order).toEqual({
      id: "ord-1",
      clientOrderId: "my-key",
      symbol: "AAPL",
      side: "buy",
      type: "limit",
      status: "open",
      quantity: 5,
      limitPrice: 180.5,
      filledQuantity: 0,
      submittedAt: "2026-08-25T14:00:00.000Z",
    });

    const sent = JSON.parse(String(calls[0]?.init?.body));
    expect(sent).toEqual({
      symbol: "AAPL",
      side: "buy",
      type: "limit",
      time_in_force: "gtc",
      qty: "5",
      limit_price: "180.5",
      client_order_id: "my-key",
    });
  });

  it("cancels via DELETE and tolerates the 204", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const trading = connectTrading({
      broker: "alpaca",
      credentials: paperCredentials,
      fetch: captureFetch(calls, undefined, 204),
    });
    await trading.cancelOrder("ord-1");
    expect(calls[0]?.url).toContain("/v2/orders/ord-1");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });
});

describe("placing Tradier sandbox orders", () => {
  const tradierFetch = (calls: { url: string; init?: RequestInit }[]) =>
    ((url: string | URL, init?: RequestInit) => {
      const path = String(url);
      calls.push({ url: path, ...(init ? { init } : {}) });
      let body: unknown = {};
      if (path.endsWith("/user/profile")) {
        body = { profile: { account: { account_number: "SB123" } } };
      } else if (path.endsWith("/orders") && init?.method === "POST") {
        body = { order: { id: 987, status: "ok" } };
      } else if (path.includes("/orders/987")) {
        body = {
          order: {
            id: 987,
            symbol: "SPY",
            side: "buy",
            type: "limit",
            status: "open",
            quantity: 2,
            price: 500.5,
            exec_quantity: 0,
            create_date: "2026-08-25T15:00:00Z",
            tag: "idem-1",
          },
        };
      }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as typeof fetch;

  it("is pinned to the sandbox host and discovers the account from the profile", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const trading = connectTrading({ broker: "tradier", credentials: { accessToken: "sb-token" }, fetch: tradierFetch(calls) });
    expect(trading.environment).toBe("sandbox");

    const order = await trading.placeOrder({
      symbol: "SPY",
      side: "buy",
      type: "limit",
      quantity: 2,
      limitPrice: 500.5,
      clientOrderId: "idem-1",
    });

    expect(calls.every((call) => call.url.startsWith("https://sandbox.tradier.com/v1"))).toBe(true);
    const create = calls.find((call) => call.init?.method === "POST");
    expect(String(create?.init?.body)).toBe(
      "class=equity&symbol=SPY&side=buy&quantity=2&type=limit&duration=day&price=500.5&tag=idem-1",
    );
    expect(order).toEqual({
      id: "987",
      clientOrderId: "idem-1",
      symbol: "SPY",
      side: "buy",
      type: "limit",
      status: "open",
      quantity: 2,
      limitPrice: 500.5,
      filledQuantity: 0,
      submittedAt: "2026-08-25T15:00:00.000Z",
    });
  });

  it("rejects what Tradier cannot do, before any network call", async () => {
    const calls: { url: string }[] = [];
    const trading = connectTrading({ broker: "tradier", credentials: { accessToken: "sb-token", accountId: "SB123" }, fetch: captureFetch(calls) });
    await expect(trading.placeOrder({ symbol: "SPY", side: "buy", type: "market", notional: 100 })).rejects.toThrow(
      /notional/,
    );
    await expect(
      trading.placeOrder({ symbol: "SPY", side: "buy", type: "market", quantity: 1, timeInForce: "fok" }),
    ).rejects.toThrow(/time-in-force/);
    await expect(
      trading.placeOrder({ symbol: "SPY", side: "buy", type: "market", quantity: 1, clientOrderId: "no spaces!" }),
    ).rejects.toThrow(/tags/);
    expect(calls).toHaveLength(0);
  });
});

describe("normalizing order payloads", () => {
  it("maps ambiguous or unknown Alpaca statuses conservatively", () => {
    expect(normalizeAlpacaOrder({ status: "pending_cancel" }).status).toBe("open");
    expect(normalizeAlpacaOrder({ status: "done_for_day" }).status).toBe("canceled");
    expect(normalizeAlpacaOrder({ status: "some_future_status" }).status).toBe("pending");
    expect(normalizeAlpacaOrder({}).status).toBe("pending");
  });

  it("keeps partial fills visible on both brokers", () => {
    const alpaca = normalizeAlpacaOrder({ status: "partially_filled", qty: "10", filled_qty: "4", filled_avg_price: "99.5" });
    expect(alpaca).toMatchObject({ status: "partially_filled", filledQuantity: 4, filledAvgPrice: 99.5 });

    const tradier = normalizeTradierOrder({ id: 1, status: "partially_filled", quantity: 10, exec_quantity: 4, avg_fill_price: 99.5 });
    expect(tradier).toMatchObject({ status: "partially_filled", filledQuantity: 4, filledAvgPrice: 99.5 });
  });

  it("maps Tradier error states to rejected, never filled", () => {
    expect(normalizeTradierOrder({ id: 1, status: "error" }).status).toBe("rejected");
    expect(normalizeTradierOrder({ id: 1, status: "mystery" }).status).toBe("pending");
  });
});
