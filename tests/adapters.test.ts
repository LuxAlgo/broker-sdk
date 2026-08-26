import { describe, expect, it } from "vitest";

import { alpacaHostForKey } from "../src/adapters/alpaca.js";
import { cryptoComParamsString } from "../src/adapters/crypto-com.js";
import { normalizeKrakenAsset } from "../src/adapters/kraken.js";
import { topstepSymbol } from "../src/adapters/topstep.js";
import { tradierList } from "../src/adapters/tradier.js";
import { trading212Symbol } from "../src/adapters/trading212.js";
import { buildWebullStringToSign } from "../src/adapters/webull.js";

describe("choosing the Alpaca environment from the key itself", () => {
  it("paper keys (PK...) go to the paper host, live keys to the live host", () => {
    expect(alpacaHostForKey("PK3EXAMPLEONLY")).toBe("https://paper-api.alpaca.markets");
    expect(alpacaHostForKey("  pkLowercaseAndPadded ")).toBe("https://paper-api.alpaca.markets");
    expect(alpacaHostForKey("AKEXAMPLEONLY")).toBe("https://api.alpaca.markets");
  });

  it("an unrecognized key prefix falls back to the live host", () => {
    expect(alpacaHostForKey("XX123")).toBe("https://api.alpaca.markets");
  });
});

describe("reading Tradier's collection quirks", () => {
  it("treats single-item objects and null collections like arrays", () => {
    expect(tradierList([{ a: 1 }, { a: 2 }])).toHaveLength(2);
    expect(tradierList({ a: 1 })).toHaveLength(1);
    expect(tradierList(null)).toEqual([]);
    expect(tradierList(undefined)).toEqual([]);
    expect(tradierList("null")).toEqual([]);
  });
});

describe("signing requests to Webull and Crypto.com", () => {
  it("canonicalizes Webull sign params sorted and fully percent-encoded", () => {
    const signed = buildWebullStringToSign("/openapi/account/list", {
      "x-app-key": "key",
      host: "api.webull.com",
      account_id: "A1",
    });
    // Sorted: account_id, host, x-app-key — and no raw "/" or "&" survive encoding.
    expect(decodeURIComponent(signed)).toBe("/openapi/account/list&account_id=A1&host=api.webull.com&x-app-key=key");
    expect(signed).not.toContain("/");
    expect(signed).not.toContain("&");
  });

  it("builds Crypto.com's params string with keys sorted alphabetically", () => {
    expect(cryptoComParamsString({ b: 2, a: "x", c: [1, 2] })).toBe("ax" + "b2" + "c12");
    expect(cryptoComParamsString({})).toBe("");
  });
});

describe("symbol normalization", () => {
  it("maps Kraken legacy asset codes to plain symbols and passes modern ones through", () => {
    expect(normalizeKrakenAsset("XXBT")).toBe("BTC");
    expect(normalizeKrakenAsset("ZUSD")).toBe("USD");
    expect(normalizeKrakenAsset("ADA")).toBe("ADA");
  });

  it("extracts the symbol segment from Topstep contract ids", () => {
    expect(topstepSymbol("CON.F.US.EP.U26")).toBe("EP");
    expect(topstepSymbol("weird")).toBe("weird");
  });

  it("strips Trading212 ticker suffixes", () => {
    expect(trading212Symbol("AAPL_US_EQ")).toBe("AAPL");
    expect(trading212Symbol("AAPL")).toBe("AAPL");
  });
});
