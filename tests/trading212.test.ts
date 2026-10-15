import { afterEach, describe, expect, it, vi } from "vitest";

import { trading212 } from "../src/adapters/trading212.js";
import { BrokerAuthError, BrokerRequestError } from "../src/errors.js";

const summary = { id: 42, currency: "GBP", totalValue: 1000, cash: { availableToTrade: 250 } };

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

afterEach(() => vi.useRealTimers());

describe("Trading 212 adapter", () => {
  it("uses Basic auth on the demo host and follows history pages", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://demo.trading212.com");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        `Basic ${Buffer.from("key-id:secret").toString("base64")}`,
      );
      if (url.pathname.endsWith("/account/summary")) return response(summary);
      if (url.pathname.endsWith("/positions")) return response([]);
      if (url.searchParams.get("cursor") === "2") {
        return response({ items: [
          { order: { ticker: "AAPL_US_EQ", side: "SELL", instrument: { currency: "GBP" } },
            fill: { type: "TRADE", quantity: -1, price: 210, filledAt: "2026-09-23T10:00:00Z" } },
        ], nextPagePath: null });
      }
      return response({ items: [
        { order: { ticker: "AAPL_US_EQ", side: "BUY", instrument: { currency: "USD" } },
          fill: { type: "TRADE", quantity: 2, price: 100, filledAt: "2026-09-22T10:00:00Z", walletImpact: { fxRate: 0.8 } } },
      ], nextPagePath: "/api/v0/equity/history/orders?limit=50&cursor=2" });
    });
    const pending = trading212.fetchRaw(
      { apiKey: "key-id", apiSecret: "secret", environment: "demo" },
      { fetch: fetcher },
    );
    await vi.runAllTimersAsync();
    const { raw } = await pending;
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(trading212.normalize(raw)[0]).toMatchObject({
      environment: "paper",
      trades: [
        { symbol: "AAPL", side: "buy", quantity: 2, price: 80 },
        { symbol: "AAPL", side: "sell", quantity: 1, price: 210 },
      ],
    });
  });

  it("rejects invalid pagination paths without sending credentials there", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/account/summary")) return response(summary);
      if (path.endsWith("/positions")) return response([]);
      return response({ items: [], nextPagePath: "https://other.example/api/v0/equity/history/orders" });
    });
    await expect(trading212.fetchRaw({ apiKey: "k", apiSecret: "s" }, { fetch: fetcher }))
      .rejects.toBeInstanceOf(BrokerRequestError);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("preserves typed authentication errors", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({}, 401));
    await expect(trading212.fetchRaw({ apiKey: "k", apiSecret: "s" }, { fetch: fetcher }))
      .rejects.toBeInstanceOf(BrokerAuthError);
  });
});
