import { createPrivateKey, sign } from "node:crypto";

import { BrokerAuthError, MissingCredentialsError } from "../errors.js";
import type { Account, Position, Trade } from "../schema.js";
import { asFiniteNumber, asIsoTimestamp, rejectResponse } from "./http.js";
import type { AdapterFetchResult, BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  Robinhood Crypto trading API (trading.robinhood.com), read-only via the
  user's own API key from the Robinhood API Credentials Portal. Requests are
  Ed25519-signed with the user's private key — the key never leaves this
  process, only the signature travels.

  The account endpoint reports buying power (cash) and the holdings endpoint
  reports quantities only — no prices. So positions carry no marketValue and
  equity is the cash buying power alone; a missing value is more honest than
  a guessed one. Trades come from filled orders.

  Endpoint paths and header names follow the published Robinhood Crypto
  trading API docs; the daily canary validates them against a real account.
*/

const ROBINHOOD_API = "https://trading.robinhood.com";
const MAX_PAGES = 10;

/**
 * The exact string Robinhood expects to be Ed25519-signed:
 * apiKey + unix-seconds timestamp + path (including any query string) +
 * uppercase HTTP method + body (the exact JSON string; empty for GET).
 * Exported for tests.
 */
export const robinhoodCanonicalMessage = (
  apiKey: string,
  timestamp: number,
  path: string,
  method: string,
  body: string,
): string => `${apiKey}${timestamp}${path}${method.toUpperCase()}${body}`;

/** PKCS8 DER header for a raw 32-byte Ed25519 seed (RFC 8410). */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * Accepts the base64 private key in either form the portal/libsodium hand
 * out: the 32-byte seed, or the 64-byte seed||publicKey — the first 32
 * bytes are the seed either way.
 */
const toPrivateKey = (privateKeyBase64: string) => {
  const decoded = Buffer.from(privateKeyBase64, "base64");
  if (decoded.length !== 32 && decoded.length !== 64) {
    throw new BrokerAuthError(
      "robinhood-crypto",
      "Robinhood Crypto private key must be a base64-encoded 32-byte Ed25519 seed (or 64-byte seed||publicKey)",
    );
  }
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, decoded.subarray(0, 32)]),
    format: "der",
    type: "pkcs8",
  });
};

/** Base64 Ed25519 signature over the canonical message. Exported for tests. */
export const robinhoodSignMessage = (
  apiKey: string,
  privateKeyBase64: string,
  timestamp: number,
  path: string,
  method: string,
  body: string,
): string => {
  const message = robinhoodCanonicalMessage(apiKey, timestamp, path, method, body);
  return sign(null, Buffer.from(message), toPrivateKey(privateKeyBase64)).toString("base64");
};

type RobinhoodAccount = {
  account_number?: string;
  status?: string;
  buying_power?: string;
  buying_power_currency?: string;
};
type RobinhoodHolding = {
  asset_code?: string;
  total_quantity?: string | number;
  quantity_available_for_trading?: string | number;
};
type RobinhoodOrder = {
  symbol?: string;
  side?: string;
  state?: string;
  filled_asset_quantity?: string | number;
  average_price?: string | number;
  created_at?: string;
  updated_at?: string;
};

export type RobinhoodCryptoRaw = {
  account: RobinhoodAccount;
  holdings: RobinhoodHolding[];
  /** Filled orders; empty when the call failed — history is optional. */
  orders: RobinhoodOrder[];
};

/** Pure mapper from filled Robinhood orders to trades; bad rows drop out. */
export const parseRobinhoodOrders = (orders: RobinhoodOrder[] | undefined): Trade[] => {
  const trades: Trade[] = [];
  for (const order of Array.isArray(orders) ? orders : []) {
    if (order?.state !== "filled") continue;
    if (!order.symbol || (order.side !== "buy" && order.side !== "sell")) continue;
    // Trading pairs read "BTC-USD"; the base asset is the traded symbol.
    const symbol = order.symbol.split("-")[0];
    if (!symbol) continue;
    const quantity = asFiniteNumber(order.filled_asset_quantity);
    const price = asFiniteNumber(order.average_price);
    if (quantity === undefined || quantity <= 0 || price === undefined || price <= 0) continue;
    const executedAt = asIsoTimestamp(order.updated_at ?? order.created_at);
    trades.push({
      symbol,
      side: order.side,
      quantity,
      price,
      ...(executedAt ? { executedAt } : {}),
    });
  }
  return trades;
};

const normalize = (raw: RobinhoodCryptoRaw): Account[] => {
  const positions: Position[] = [];
  for (const holding of Array.isArray(raw.holdings) ? raw.holdings : []) {
    const quantity = asFiniteNumber(holding.total_quantity);
    if (!holding.asset_code || quantity === undefined || quantity <= 0) continue;
    // No price on the holdings endpoint — marketValue stays unset, never guessed.
    positions.push({ symbol: holding.asset_code, quantity, assetClass: "crypto" });
  }

  const accountNumber = raw.account?.account_number;
  const cash = asFiniteNumber(raw.account?.buying_power);

  return [
    {
      id: accountNumber ? `robinhood-crypto-${accountNumber}` : "robinhood-crypto",
      name: "Robinhood Crypto",
      currency: raw.account?.buying_power_currency || "USD",
      // Holdings are unpriced here, so cash buying power is the whole equity.
      equity: cash ?? 0,
      ...(cash !== undefined ? { cash } : {}),
      positions,
      trades: parseRobinhoodOrders(raw.orders),
    },
  ];
};

const fetchRaw = async (
  credentials: Credentials,
  ctx: FetchContext,
): Promise<AdapterFetchResult<RobinhoodCryptoRaw>> => {
  const apiKey = credentials.apiKey?.trim();
  const privateKey = credentials.privateKey?.trim();
  if (!apiKey || !privateKey) {
    throw new MissingCredentialsError(
      "robinhood-crypto",
      "Robinhood Crypto connection is missing its API key or Ed25519 private key",
    );
  }

  const get = async <T>(path: string): Promise<T> => {
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await ctx.fetch(`${ROBINHOOD_API}${path}`, {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "x-timestamp": String(timestamp),
        "x-signature": robinhoodSignMessage(apiKey, privateKey, timestamp, path, "GET", ""),
      },
    });
    if (!response.ok) rejectResponse("robinhood-crypto", "Robinhood Crypto", response);
    return (await response.json()) as T;
  };

  // Holdings and orders are cursor-paginated; follow `next` links, capped.
  type Page<T> = { next?: string | null; results?: T[] };
  const getAll = async <T>(path: string): Promise<T[]> => {
    const rows: T[] = [];
    let nextPath: string | undefined = path;
    for (let page = 0; nextPath && page < MAX_PAGES; page += 1) {
      const body: Page<T> = await get<Page<T>>(nextPath);
      rows.push(...(Array.isArray(body.results) ? body.results : []));
      // Each signature covers the path with its query string, so re-derive
      // the relative path from the absolute `next` URL.
      const next = body.next ? new URL(body.next, ROBINHOOD_API) : undefined;
      nextPath = next ? `${next.pathname}${next.search}` : undefined;
    }
    return rows;
  };

  const account = await get<RobinhoodAccount>("/api/v1/crypto/trading/accounts/");
  const holdings = await getAll<RobinhoodHolding>("/api/v1/crypto/trading/holdings/");
  const orders = await getAll<RobinhoodOrder>("/api/v1/crypto/trading/orders/?state=filled").catch(
    // fail-soft: history is optional, balances are not
    () => [] as RobinhoodOrder[],
  );

  return { raw: { account, holdings, orders } };
};

export const robinhoodCrypto: BrokerAdapter<RobinhoodCryptoRaw> = {
  id: "robinhood-crypto",
  displayName: "Robinhood Crypto",
  credentials: [
    { key: "apiKey", label: "API key (Robinhood API Credentials Portal)", secret: false },
    { key: "privateKey", label: "Ed25519 private key (base64 seed)", secret: true },
  ],
  readOnlySetup:
    "Create an API key in the Robinhood API Credentials Portal with read-only scope for account, holdings, and orders, register your Ed25519 public key there, and keep the base64 private key local — this SDK only ever signs GET requests with it.",
  fetchRaw,
  normalize,
};
