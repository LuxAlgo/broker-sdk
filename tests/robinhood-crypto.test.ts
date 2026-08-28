import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  parseRobinhoodOrders,
  robinhoodCanonicalMessage,
  robinhoodSignMessage,
} from "../src/adapters/robinhood-crypto.js";

// Fixed Ed25519 keypair: a seed of 32 bytes of 0x01, wrapped in the same
// PKCS8 DER header the adapter uses, so the expected signature is derived
// here with nothing but node:crypto.
const SEED = Buffer.alloc(32, 0x01);
const SEED_BASE64 = SEED.toString("base64");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([PKCS8_PREFIX, SEED]),
  format: "der",
  type: "pkcs8",
});

const API_KEY = "rh-api-key-00000000-0000-0000-0000-000000000000";
const TIMESTAMP = 1756368000; // 2026-08-28T08:00:00Z
const GET_PATH = "/api/v1/crypto/trading/orders/?state=filled";

describe("signing requests to Robinhood Crypto", () => {
  it("canonicalizes the message as apiKey + timestamp + path + METHOD + body", () => {
    expect(robinhoodCanonicalMessage(API_KEY, TIMESTAMP, GET_PATH, "GET", "")).toBe(
      `${API_KEY}1756368000/api/v1/crypto/trading/orders/?state=filledGET`,
    );
    // The method is uppercased and the body is the exact JSON string.
    expect(robinhoodCanonicalMessage("key", 1, "/api/v1/crypto/trading/accounts/", "get", '{"a":1}')).toBe(
      'key1/api/v1/crypto/trading/accounts/GET{"a":1}',
    );
  });

  it("produces a stable base64 Ed25519 signature that verifies against the public key", () => {
    const message = robinhoodCanonicalMessage(API_KEY, TIMESTAMP, GET_PATH, "GET", "");
    const expected = sign(null, Buffer.from(message), PRIVATE_KEY).toString("base64");

    const signature = robinhoodSignMessage(API_KEY, SEED_BASE64, TIMESTAMP, GET_PATH, "GET", "");
    expect(signature).toBe(expected);
    expect(
      verify(null, Buffer.from(message), createPublicKey(PRIVATE_KEY), Buffer.from(signature, "base64")),
    ).toBe(true);
  });

  it("accepts the 64-byte libsodium seed||publicKey form by taking the first 32 bytes", () => {
    // Raw public key = last 32 bytes of the SPKI DER export.
    const spki = createPublicKey(PRIVATE_KEY).export({ format: "der", type: "spki" });
    const libsodiumKey = Buffer.concat([SEED, spki.subarray(spki.length - 32)]).toString("base64");

    expect(robinhoodSignMessage(API_KEY, libsodiumKey, TIMESTAMP, GET_PATH, "GET", "")).toBe(
      robinhoodSignMessage(API_KEY, SEED_BASE64, TIMESTAMP, GET_PATH, "GET", ""),
    );
  });
});

describe("parsing Robinhood Crypto filled orders", () => {
  it("maps filled orders to trades and drops malformed rows", () => {
    expect(
      parseRobinhoodOrders([
        {
          symbol: "BTC-USD",
          side: "buy",
          state: "filled",
          filled_asset_quantity: "0.1",
          average_price: "65000.5",
          created_at: "2026-08-21T10:00:00Z",
        },
        {
          symbol: "ETH-USD",
          side: "sell",
          state: "filled",
          filled_asset_quantity: "1",
          average_price: "3200",
          created_at: "2026-08-22T09:29:58Z",
          updated_at: "2026-08-22T09:30:00.500Z",
        },
        // not filled
        { symbol: "SOL-USD", side: "buy", state: "canceled", filled_asset_quantity: "1", average_price: "150" },
        // missing side / missing symbol
        { symbol: "BTC-USD", state: "filled", filled_asset_quantity: "0.2", average_price: "64000" },
        { side: "buy", state: "filled", filled_asset_quantity: "0.2", average_price: "64000" },
        // non-positive or unparseable quantity/price
        { symbol: "BTC-USD", side: "buy", state: "filled", filled_asset_quantity: "0", average_price: "64000" },
        { symbol: "BTC-USD", side: "sell", state: "filled", filled_asset_quantity: "0.2", average_price: "-1" },
        { symbol: "BTC-USD", side: "buy", state: "filled", filled_asset_quantity: "nope", average_price: "64000" },
      ]),
    ).toEqual([
      { symbol: "BTC", side: "buy", quantity: 0.1, price: 65000.5, executedAt: "2026-08-21T10:00:00.000Z" },
      { symbol: "ETH", side: "sell", quantity: 1, price: 3200, executedAt: "2026-08-22T09:30:00.500Z" },
    ]);
  });

  it("treats missing collections as empty", () => {
    expect(parseRobinhoodOrders(undefined)).toEqual([]);
    expect(parseRobinhoodOrders([])).toEqual([]);
  });
});
