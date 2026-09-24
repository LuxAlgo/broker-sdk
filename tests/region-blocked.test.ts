import { describe, expect, it } from "vitest";

import { binance } from "../src/adapters/binance.js";
import { rejectResponse } from "../src/adapters/http.js";
import { BrokerAuthError, BrokerError, RegionBlockedError } from "../src/errors.js";
import { connect } from "../src/index.js";

/*
  Binance.com and Bybit answer HTTP 451 to US IPs before they look at a key.
  A caller must be able to tell that apart from bad credentials without
  parsing a message, or it will send its users off to rotate keys that were
  fine all along.
*/

describe("a broker that refuses the caller's region", () => {
  it("is reported as a region block, not as rejected credentials", () => {
    const attempt = () => rejectResponse("binance", "Binance", new Response(null, { status: 451 }));
    expect(attempt).toThrow(RegionBlockedError);
    expect(attempt).not.toThrow(BrokerAuthError);
    try {
      attempt();
    } catch (error) {
      expect(error).toBeInstanceOf(BrokerError);
      expect((error as RegionBlockedError).status).toBe(451);
      expect((error as RegionBlockedError).broker).toBe("binance");
      expect((error as RegionBlockedError).message).toMatch(/unavailable from this region/);
    }
  });

  it("still reports 401 and 403 as rejected credentials", () => {
    for (const status of [401, 403]) {
      expect(() => rejectResponse("binance", "Binance", new Response(null, { status }))).toThrow(BrokerAuthError);
    }
  });
});

/*
  Binance.US is a separate company running the same spot API at another
  host, with its own accounts and keys. A caller with a Binance.US key
  points the adapter there; everything else about the connection is the
  same, and a caller that says nothing still gets Binance.com.
*/

const fakeBinance = (seen: string[]): typeof globalThis.fetch =>
  (async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.includes("/api/v3/account")) return Response.json({ balances: [{ asset: "BTC", free: "1", locked: "0" }] });
    return Response.json([{ symbol: "BTCUSDT", price: "50000" }]);
  }) as typeof globalThis.fetch;

describe("pointing the Binance adapter at Binance.US", () => {
  it("sends every request to the host the caller named", async () => {
    const seen: string[] = [];
    const connection = connect({
      broker: "binance",
      credentials: { apiKey: "k", apiSecret: "s" },
      fetch: fakeBinance(seen),
      baseUrl: "https://api.binance.us",
    });
    const snapshot = await connection.fetchSnapshot();
    expect(seen.length).toBeGreaterThan(0);
    for (const url of seen) expect(url.startsWith("https://api.binance.us/")).toBe(true);
    expect(snapshot.accounts[0]?.positions[0]).toMatchObject({ symbol: "BTC", quantity: 1, marketValue: 50000 });
  });

  it("goes to Binance.com when the caller names nothing", async () => {
    const seen: string[] = [];
    await binance.fetchRaw({ apiKey: "k", apiSecret: "s" }, { fetch: fakeBinance(seen) });
    for (const url of seen) expect(url.startsWith("https://api.binance.com/")).toBe(true);
  });
});
