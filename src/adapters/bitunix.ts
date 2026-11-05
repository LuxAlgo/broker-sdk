import { createHash, randomUUID } from "node:crypto";

import { BrokerAuthError, BrokerRequestError, MissingCredentialsError } from "../errors.js";
import type { Account, Position, Trade } from "../schema.js";
import { rejectResponse } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  Bitunix USDT futures, using only the official read-only REST endpoints.
  Live HEDGE responses use BUY/SELL for position sides, not the documented
  LONG/SHORT, and trade sides are execution sides (unlike Place Order).
  Fills omit positionId: query by positionId to associate them with a side.
  History positions can include a still-open position; pending is authoritative
  for current quantities. Neither position prices nor maxQty fabricate fills.
*/
const HOST = "https://fapi.bitunix.com";
const PATHS = {
  account: "/api/v1/futures/account",
  pending: "/api/v1/futures/position/get_pending_positions",
  history: "/api/v1/futures/position/get_history_positions",
  trades: "/api/v1/futures/trade/get_history_trades",
} as const;
const PAGE_SIZE = 100;
const MAX_PAGES = 10_000;
const MAX_RETRIES = 3;
type Row = Record<string, unknown>;
export type BitunixRaw = {
  account: Row;
  pendingPositions: Row[];
  historyPositions: Row[];
  trades: Row[];
  positionTrades: { positionId: string; trades: Row[] }[];
};

function fail(message: string): never { throw new BrokerRequestError("bitunix", message); }
const isRow = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const number = (value: unknown): number | undefined => {
  if (typeof value !== "number" && (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const direction = (value: unknown): "long" | "short" | undefined =>
  value === "BUY" || value === "LONG" ? "long" : value === "SELL" || value === "SHORT" ? "short" : undefined;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Official GET canonicalization: ASCII-sorted key+value pairs, empty body. */
export const bitunixSignature = (
  params: Record<string, string>, apiKey: string, apiSecret: string, nonce: string, timestamp: string,
): string => {
  const query = Object.keys(params).sort().map((key) => key + params[key]).join("");
  return sha256(sha256(nonce + timestamp + apiKey + query) + apiSecret);
};

const checkMarginCoin = (row: Row): void => {
  if (row.marginCoin != null && row.marginCoin !== "USDT") fail("Bitunix adapter supports USDT futures only");
};

/** Duplicate history/pending entries must describe the same source position. */
const positionsById = (raw: BitunixRaw): Map<string, Row> => {
  const result = new Map<string, Row>();
  const sourceAccounts = new Set<string>();
  for (const row of [...raw.historyPositions, ...raw.pendingPositions]) {
    checkMarginCoin(row);
    const account = text(row.subAccountId);
    if (account) sourceAccounts.add(account);
    const id = text(row.positionId);
    if (!id || !text(row.symbol) || !direction(row.side)) continue;
    const old = result.get(id);
    if (old && (old.symbol !== row.symbol || direction(old.side) !== direction(row.side) || old.positionMode !== row.positionMode)) {
      fail("Bitunix returned conflicting position identity");
    }
    result.set(id, row);
  }
  if (sourceAccounts.size > 1) fail("Bitunix returned multiple source accounts; use a key scoped to one main account");
  return result;
};

const parseTrades = (raw: BitunixRaw, positions: Map<string, Row>): Trade[] => {
  const groups = new Map<string, Row>();
  const keyOf = (row: Row) => JSON.stringify([row.symbol, row.tradeId]);
  for (const group of raw.positionTrades) {
    const position = positions.get(group.positionId);
    if (!position) fail("Bitunix returned fills for an unknown position");
    for (const row of group.trades) {
      if (!text(row.tradeId)) continue;
      if (row.symbol !== position.symbol) fail("Bitunix position-filtered fills contain another symbol");
      if (text(row.positionId) && row.positionId !== group.positionId) fail("Bitunix position filter returned another position ID");
      const key = keyOf(row);
      const old = groups.get(key);
      if (old && (old.positionId !== position.positionId)) fail("Bitunix assigned one fill to multiple positions");
      groups.set(key, position);
    }
  }
  const fills = new Map<string, { time: number; trade: Trade }>();
  for (const row of [...raw.trades, ...raw.positionTrades.flatMap((group) => group.trades)]) {
    const id = text(row.tradeId);
    const symbol = text(row.symbol);
    const side = row.side === "BUY" ? "buy" : row.side === "SELL" ? "sell" : undefined;
    const quantity = number(row.qty);
    const price = number(row.price);
    const time = number(row.ctime);
    if (!id || !symbol || !side || quantity === undefined || quantity <= 0 || price === undefined || price <= 0 ||
      time === undefined || !Number.isSafeInteger(time) || time <= 0 || time > 8_640_000_000_000_000) continue;
    checkMarginCoin(row);
    const fee = number(row.fee);
    if (row.fee != null && fee === undefined) fail("Bitunix returned an unreadable fill fee");
    const trade: Trade = { symbol, side, quantity, price, executedAt: new Date(time).toISOString(), assetClass: "futures", ...(fee !== undefined ? { fee } : {}) };
    if (row.positionMode === "HEDGE") {
      const position = groups.get(keyOf(row));
      if (!position) fail("Bitunix hedge fill has no matching position; available history may be incomplete");
      const positionSide = direction(position.side)!;
      const positionEffect = (side === "buy") === (positionSide === "long") ? "open" : "close";
      if (row.reduceOnly === true && positionEffect !== "close") fail("Bitunix reduce-only fill conflicts with its position side");
      trade.positionSide = positionSide;
      trade.positionEffect = positionEffect;
      trade.positionId = text(position.positionId)!;
    } else if (row.positionMode === "ONE_WAY") {
      // A non-reduce-only one-way fill can reverse a position: don't call it an opening.
      if (row.reduceOnly === true) trade.positionEffect = "close";
    } else {
      fail("Bitunix returned an unknown position mode");
    }
    const key = keyOf(row);
    const old = fills.get(key);
    if (old && JSON.stringify(old.trade) !== JSON.stringify(trade)) fail("Bitunix returned conflicting facts for the same fill ID");
    fills.set(key, { time, trade });
  }
  // Native IDs are identities, not an execution sequence. Equal timestamps retain source order.
  return [...fills.values()].sort((a, b) => a.time - b.time).map((fill) => fill.trade);
};

const normalize = (raw: BitunixRaw): Account[] => {
  checkMarginCoin(raw.account);
  if (raw.account.marginCoin !== "USDT") fail("Bitunix returned no USDT account");
  const components = ["available", "frozen", "margin", "crossUnrealizedPNL", "isolationUnrealizedPNL"].map((key) => number(raw.account[key]));
  if (components.some((value) => value === undefined)) fail("Bitunix returned incomplete account equity components");
  // Available + locked funds + unrealized P&L; bonus is not added again.
  const equity = components.reduce<number>((sum, value) => sum + value!, 0);
  if (!Number.isFinite(equity)) fail("Bitunix returned invalid account equity");
  const byId = positionsById(raw);
  const positions: Position[] = [];
  const seen = new Set<string>();
  for (const row of raw.pendingPositions) {
    const id = text(row.positionId);
    const symbol = text(row.symbol);
    const side = direction(row.side);
    const qty = number(row.qty);
    if (!id || !symbol || !side || qty === undefined || qty === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    if (row.positionMode !== "HEDGE" && row.positionMode !== "ONE_WAY") fail("Bitunix returned an unknown position mode");
    const averageEntryPrice = number(row.avgOpenPrice);
    positions.push({
      symbol, positionId: id, quantity: Math.abs(qty) * (side === "long" ? 1 : -1), assetClass: "futures",
      ...(row.positionMode === "HEDGE" ? { positionSide: side } : {}),
      ...(averageEntryPrice !== undefined && averageEntryPrice > 0 ? { averageEntryPrice } : {}),
    });
  }
  return [{ id: "bitunix-usdt-futures", name: "Bitunix USDT futures", currency: "USDT", equity, positions, trades: parseTrades(raw, byId) }];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fetchRaw = async (credentials: Credentials, ctx: FetchContext): Promise<{ raw: BitunixRaw }> => {
  const { apiKey, apiSecret } = credentials;
  if (!apiKey || !apiSecret || /[\s\x00-\x1f\x7f]/.test(apiKey + apiSecret)) {
    throw new MissingCredentialsError("bitunix", "Bitunix needs its read-only API key and secret");
  }
  const now = Date.now();
  const since = ctx.historySince === undefined ? undefined : Date.parse(ctx.historySince);
  if (since !== undefined && (!Number.isFinite(since) || since < 0 || since > now)) fail("Bitunix historySince must be a valid past ISO timestamp");
  let first = true;
  const call = async (kind: keyof typeof PATHS, params: Record<string, string>): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      // The private endpoints allow 10 requests/sec/uid. Requests are serial.
      if (!first) await sleep(110);
      first = false;
      const timestamp = String(Date.now());
      const nonce = randomUUID().replaceAll("-", ""); // documented maximum is less than 64 characters
      let response: Response;
      try {
        response = await ctx.fetch(`${HOST}${PATHS[kind]}?${new URLSearchParams(params)}`, {
          method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
          headers: { "api-key": apiKey, nonce, timestamp, sign: bitunixSignature(params, apiKey, apiSecret, nonce, timestamp), language: "en-US" },
        });
      } catch {
        if (attempt >= MAX_RETRIES) fail("Bitunix request failed or timed out");
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        const seconds = Number.parseFloat(response.headers.get("retry-after") ?? "");
        await sleep(Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 60_000) : 1000 * 2 ** attempt);
        continue;
      }
      if (!response.ok) rejectResponse("bitunix", "Bitunix", response);
      let body: unknown;
      try { body = await response.json(); } catch { return fail("Bitunix returned invalid JSON"); }
      if (!isRow(body) || typeof body.code !== "number") fail("Bitunix returned an invalid response envelope");
      if ([403, 10003, 10004, 10007].includes(body.code as number)) throw new BrokerAuthError("bitunix", `Bitunix rejected the key, signature or IP scope (code ${body.code})`);
      if ([10001, 10005, 10006].includes(body.code as number) && attempt < MAX_RETRIES) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (body.code !== 0) fail(`Bitunix request failed (code ${body.code}); check API permissions, parameters and clock synchronization`);
      return body.data;
    }
  };
  const list = async (kind: "history" | "trades", params: Record<string, string>, field: string): Promise<Row[]> => {
    const rows: Row[] = [];
    const pages = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await call(kind, { ...params, skip: String(page * PAGE_SIZE), limit: String(PAGE_SIZE) });
      if (!isRow(data) || !Array.isArray(data[field])) fail("Bitunix returned an invalid history page");
      const batch = data[field] as unknown[];
      if (batch.length > PAGE_SIZE || !batch.every(isRow)) fail("Bitunix returned an invalid history list");
      const total = number(data.total);
      if (data.total != null && (total === undefined || !Number.isSafeInteger(total) || total < 0)) fail("Bitunix returned an invalid history total");
      const fingerprint = sha256(JSON.stringify(batch));
      if (batch.length && pages.has(fingerprint)) fail("Bitunix repeated a history page; sync would be incomplete");
      pages.add(fingerprint);
      rows.push(...batch as Row[]);
      if (batch.length < PAGE_SIZE) {
        if (total !== undefined && total > (page * PAGE_SIZE + batch.length)) fail("Bitunix history ended before its reported total");
        return rows;
      }
    }
    return fail("Bitunix history exceeded the page safety limit; sync was not committed");
  };
  const data = await call("account", { marginCoin: "USDT" });
  const account = Array.isArray(data) ? data.find((row: unknown) => isRow(row) && row.marginCoin === "USDT") : data;
  if (!isRow(account)) fail("Bitunix returned no USDT account");
  const pending = await call("pending", { includeSubAccounts: "false" });
  if (!Array.isArray(pending) || !pending.every(isRow)) fail("Bitunix returned an invalid pending-position list");
  // Do not filter position discovery by creation time: an old position may close today.
  const historyPositions = await list("history", {}, "positionList");
  const window = { endTime: String(now), ...(since !== undefined ? { startTime: String(since) } : { startTime: "0" }) };
  const raw: BitunixRaw = { account, pendingPositions: pending as Row[], historyPositions, trades: await list("trades", window, "tradeList"), positionTrades: [] };
  for (const [positionId, position] of positionsById(raw)) {
    if (position.positionMode !== "HEDGE") continue;
    const trades = await list("trades", { ...window, positionId, symbol: String(position.symbol) }, "tradeList");
    raw.positionTrades.push({ positionId, trades });
  }
  return { raw };
};

export const bitunix: BrokerAdapter<BitunixRaw> = {
  id: "bitunix", displayName: "Bitunix",
  credentials: [ { key: "apiKey", label: "API key", secret: false }, { key: "apiSecret", label: "API secret", secret: true } ],
  readOnlySetup: "Create a read-only API key for one main Bitunix account, with no trading or withdrawal permissions. Reads available USDT futures history and Hedge positions; funding is not included in trade P&L.",
  fetchRaw, normalize,
};
