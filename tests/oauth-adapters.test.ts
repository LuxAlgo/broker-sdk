import { describe, expect, it } from "vitest";

import { oauth1Signature, oauth1SignatureBase, parseFormBody } from "../src/adapters/etrade.js";
import { buildCoinbaseAuthorizeUrl } from "../src/adapters/coinbase.js";

describe("OAuth 1.0a signing (E*TRADE)", () => {
  it("builds the base string with sorted, percent-encoded params", () => {
    const base = oauth1SignatureBase("get", "https://api.etrade.com/oauth/request_token", {
      oauth_consumer_key: "key",
      oauth_callback: "oob",
      z: "last",
    });
    expect(base.startsWith("GET&https%3A%2F%2Fapi.etrade.com%2Foauth%2Frequest_token&")).toBe(true);
    // Sorted: oauth_callback before oauth_consumer_key before z.
    expect(decodeURIComponent(base.split("&")[2]!)).toBe("oauth_callback=oob&oauth_consumer_key=key&z=last");
  });

  it("signs deterministically for a given key pair", () => {
    const base = "GET&url&params";
    expect(oauth1Signature(base, "consumer", "token")).toBe(oauth1Signature(base, "consumer", "token"));
    expect(oauth1Signature(base, "consumer", "token")).not.toBe(oauth1Signature(base, "consumer", "other"));
  });

  it("keeps '=' padding inside token secrets when parsing form bodies", () => {
    const parsed = parseFormBody("oauth_token=abc&oauth_token_secret=c2VjcmV0PT0%3D");
    expect(parsed.oauth_token_secret).toBe("c2VjcmV0PT0=");
  });
});

describe("Coinbase OAuth2 helpers", () => {
  it("builds the authorize URL with only the read scope", () => {
    const url = new URL(buildCoinbaseAuthorizeUrl("client-1", "https://app.example/cb", "state-1"));
    expect(url.origin + url.pathname).toBe("https://login.coinbase.com/oauth2/auth");
    expect(url.searchParams.get("scope")).toBe("wallet:accounts:read");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("state")).toBe("state-1");
  });
});
