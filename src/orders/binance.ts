import { createHmac } from "node:crypto";

import { asFiniteNumber, rejectResponse } from "../adapters/http.js";
import { BrokerError, MissingCredentialsError } from "../errors.js";
import { validateOrderRequest, type Order, type OrderStatus, type TradingConnection } from "./types.js";

/*
  Binance order placement — SPOT TESTNET ONLY in this version. The connection
  is pinned to testnet.binance.vision (a module constant with no override
  option anywhere in the options type), which only accepts testnet keys, so
  live orders are impossible by construction (a production key simply fails
  auth). Live enablement follows the acknowledgement design in
  docs/orders-rfc.md once the testnet surface has soaked.

  Spot market and limit orders only, quantity-sized. Two Binance quirks are
  surfaced honestly rather than papered over:

  - Binance addresses an order by (symbol, orderId), never orderId alone, so
    the normalized Order.id is the composite "SYMBOL:orderId" (e.g.
    "BTCUSDT:12345") and getOrder/cancelOrder take that composite back. A
    non-numeric id part is sent as origClientOrderId instead of orderId.
  - Binance spot has no "day" time-in-force (only GTC/IOC/FOK). An omitted
    timeInForce on a limit order becomes gtc — a documented deviation from
    the OrderRequest "day" default — and an explicit "day" is rejected
    rather than silently upgraded to an order that never expires.
*/

const BINANCE_TESTNET_API = "https://testnet.binance.vision";

type BinanceOrderRow = {
  symbol?: string;
  orderId?: number | string;
  clientOrderId?: string;
  /** Present on cancel/query responses; the order's original client id. */
  origClientOrderId?: string;
  side?: string;
  type?: string;
  status?: string;
  price?: string;
  origQty?: string;
  executedQty?: string;
  cummulativeQuoteQty?: string;
  /** Epoch ms — `time` on queries, `transactTime` on placements. */
  time?: number;
  transactTime?: number;
};

const BINANCE_STATUSES: Record<string, OrderStatus> = {
  NEW: "open",
  PARTIALLY_FILLED: "partially_filled",
  FILLED: "filled",
  CANCELED: "canceled",
  PENDING_CANCEL: "open",
  REJECTED: "rejected",
  EXPIRED: "expired",
  EXPIRED_IN_MATCH: "expired",
};

/** Pure mapper from a Binance order payload to the normalized Order. */
export const normalizeBinanceOrder = (raw: BinanceOrderRow): Order => {
  const quantity = asFiniteNumber(raw.origQty);
  // Binance reports price "0.00000000" on market orders — a limit price only exists on LIMIT.
  const limitPrice = raw.type === "LIMIT" ? asFiniteNumber(raw.price) : undefined;
  const filledQuantity = asFiniteNumber(raw.executedQty) ?? 0;
  const quoteQty = asFiniteNumber(raw.cummulativeQuoteQty);
  const filledAvgPrice = filledQuantity > 0 && quoteQty !== undefined && quoteQty > 0 ? quoteQty / filledQuantity : undefined;
  const submittedAtMs = raw.time ?? raw.transactTime;
  const clientOrderId = raw.origClientOrderId ?? raw.clientOrderId;
  return {
    id: `${raw.symbol ?? ""}:${raw.orderId ?? ""}`,
    ...(clientOrderId ? { clientOrderId } : {}),
    symbol: raw.symbol ?? "",
    side: raw.side === "SELL" ? "sell" : "buy",
    type: raw.type === "LIMIT" ? "limit" : "market",
    status: (raw.status ? BINANCE_STATUSES[raw.status] : undefined) ?? "pending",
    ...(quantity !== undefined ? { quantity } : {}),
    ...(limitPrice !== undefined && limitPrice > 0 ? { limitPrice } : {}),
    filledQuantity,
    ...(filledAvgPrice !== undefined ? { filledAvgPrice } : {}),
    ...(submittedAtMs ? { submittedAt: new Date(submittedAtMs).toISOString() } : {}),
  };
};

/** Split the composite "SYMBOL:orderId" back into Binance's addressing pair. */
const splitOrderId = (compositeId: string): { symbol: string; idPart: string } => {
  const separator = compositeId.indexOf(":");
  const symbol = separator > 0 ? compositeId.slice(0, separator) : "";
  const idPart = separator > 0 ? compositeId.slice(separator + 1) : "";
  if (!symbol || !idPart) {
    throw new BrokerError("binance", `Binance order ids are "SYMBOL:orderId" composites (got "${compositeId}")`);
  }
  return { symbol, idPart };
};

const idParam = (idPart: string): Record<string, string> =>
  /^\d+$/.test(idPart) ? { orderId: idPart } : { origClientOrderId: idPart };

export type BinanceTradingOptions = {
  credentials: {
    /** SPOT TESTNET keys from testnet.binance.vision — production keys fail against the testnet host. */
    apiKey: string;
    apiSecret: string;
  };
  fetch?: typeof globalThis.fetch;
};

export const connectBinanceTrading = (options: BinanceTradingOptions): TradingConnection => {
  const apiKey = options.credentials.apiKey?.trim();
  const apiSecret = options.credentials.apiSecret?.trim();
  if (!apiKey || !apiSecret) {
    throw new MissingCredentialsError("binance", "Binance trading connection is missing its testnet API key or secret");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;

  // Every call is signed: hex HMAC-SHA256 over the full query string
  // (timestamp included) appended as the trailing signature param.
  const call = async <T>(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string>): Promise<T> => {
    const query = new URLSearchParams({ ...params, recvWindow: "10000", timestamp: String(Date.now()) }).toString();
    const signature = createHmac("sha256", apiSecret).update(query).digest("hex");
    const response = await fetchImpl(`${BINANCE_TESTNET_API}${path}?${query}&signature=${signature}`, {
      method,
      headers: { "X-MBX-APIKEY": apiKey },
    });
    if (!response.ok) rejectResponse("binance", "Binance testnet", response);
    return (await response.json()) as T;
  };

  return {
    broker: "binance",
    environment: "sandbox",
    placeOrder: async (request) => {
      validateOrderRequest("binance", request, { notional: false });
      const timeInForce = request.timeInForce ?? "gtc"; // see header: Binance spot has no day orders
      if (request.type === "limit" && timeInForce === "day") {
        throw new BrokerError("binance", "Binance spot supports only gtc, ioc, and fok time-in-force");
      }
      const raw = await call<BinanceOrderRow>("POST", "/api/v3/order", {
        symbol: request.symbol.toUpperCase(),
        side: request.side.toUpperCase(),
        type: request.type.toUpperCase(),
        quantity: String(request.quantity),
        // MARKET orders take no timeInForce or price on Binance.
        ...(request.type === "limit"
          ? { timeInForce: timeInForce.toUpperCase(), price: String(request.limitPrice) }
          : {}),
        ...(request.clientOrderId ? { newClientOrderId: request.clientOrderId } : {}),
      });
      return normalizeBinanceOrder(raw);
    },
    getOrder: async (orderId) => {
      const { symbol, idPart } = splitOrderId(orderId);
      return normalizeBinanceOrder(await call<BinanceOrderRow>("GET", "/api/v3/order", { symbol, ...idParam(idPart) }));
    },
    listOrders: async (listOptions) => {
      const status = listOptions?.status ?? "open";
      if (status !== "open") {
        throw new BrokerError(
          "binance",
          "Binance lists only open orders across all symbols — closed history needs a per-symbol allOrders query this connection does not expose",
        );
      }
      const raw = await call<BinanceOrderRow[]>("GET", "/api/v3/openOrders", {});
      return (Array.isArray(raw) ? raw : []).map(normalizeBinanceOrder).slice(0, listOptions?.limit ?? 100);
    },
    cancelOrder: async (orderId) => {
      const { symbol, idPart } = splitOrderId(orderId);
      await call<unknown>("DELETE", "/api/v3/order", { symbol, ...idParam(idPart) });
    },
  };
};
