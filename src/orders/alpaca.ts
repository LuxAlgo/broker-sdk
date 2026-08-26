import { alpacaHostForKey } from "../adapters/alpaca.js";
import { asFiniteNumber, asIsoTimestamp, rejectResponse } from "../adapters/http.js";
import { MissingCredentialsError } from "../errors.js";
import {
  LiveTradingBlockedError,
  validateOrderRequest,
  type Order,
  type OrderStatus,
  type TradingConnection,
} from "./types.js";

/*
  Alpaca order placement. Paper keys (PK…) connect without ceremony. Live
  keys connect ONLY when the caller passes the exact acknowledgement
  sentence at construction time — a deliberate, unmistakable, per-connection
  opt-in that cannot be a boolean, a default, or config inheritance.
*/

export const LIVE_TRADING_ACKNOWLEDGEMENT = "I understand this places real orders with real money";

type AlpacaOrder = {
  id?: string;
  client_order_id?: string;
  symbol?: string;
  side?: string;
  type?: string;
  status?: string;
  qty?: string | null;
  notional?: string | null;
  limit_price?: string | null;
  filled_qty?: string;
  filled_avg_price?: string | null;
  submitted_at?: string;
};

const ALPACA_STATUSES: Record<string, OrderStatus> = {
  new: "open",
  accepted: "open",
  pending_new: "open",
  accepted_for_bidding: "open",
  replaced: "open",
  pending_cancel: "open",
  pending_replace: "open",
  partially_filled: "partially_filled",
  filled: "filled",
  canceled: "canceled",
  done_for_day: "canceled",
  stopped: "canceled",
  expired: "expired",
  rejected: "rejected",
  suspended: "rejected",
};

/** Pure mapper from an Alpaca order payload to the normalized Order. */
export const normalizeAlpacaOrder = (raw: AlpacaOrder): Order => {
  const quantity = asFiniteNumber(raw.qty ?? undefined);
  const notional = asFiniteNumber(raw.notional ?? undefined);
  const limitPrice = asFiniteNumber(raw.limit_price ?? undefined);
  const filledAvgPrice = asFiniteNumber(raw.filled_avg_price ?? undefined);
  const submittedAt = asIsoTimestamp(raw.submitted_at);
  return {
    id: raw.id ?? "",
    ...(raw.client_order_id ? { clientOrderId: raw.client_order_id } : {}),
    symbol: raw.symbol ?? "",
    side: raw.side === "sell" ? "sell" : "buy",
    type: raw.type === "limit" ? "limit" : "market",
    status: (raw.status ? ALPACA_STATUSES[raw.status] : undefined) ?? "pending",
    ...(quantity !== undefined ? { quantity } : {}),
    ...(notional !== undefined ? { notional } : {}),
    ...(limitPrice !== undefined ? { limitPrice } : {}),
    filledQuantity: asFiniteNumber(raw.filled_qty) ?? 0,
    ...(filledAvgPrice !== undefined ? { filledAvgPrice } : {}),
    ...(submittedAt ? { submittedAt } : {}),
  };
};

export type AlpacaTradingOptions = {
  credentials: { apiKey: string; apiSecret: string };
  /**
   * Required to trade a LIVE account: the exact sentence
   * `LIVE_TRADING_ACKNOWLEDGEMENT`. Ignored for paper keys.
   */
  acknowledgeLiveTrading?: string;
  fetch?: typeof globalThis.fetch;
};

export const connectAlpacaTrading = (options: AlpacaTradingOptions): TradingConnection => {
  const apiKey = options.credentials.apiKey?.trim();
  const apiSecret = options.credentials.apiSecret?.trim();
  if (!apiKey || !apiSecret) {
    throw new MissingCredentialsError("alpaca", "Alpaca trading connection is missing its API key or secret");
  }
  const host = alpacaHostForKey(apiKey);
  const isPaper = host.includes("paper-api.");
  if (!isPaper) {
    if (options.acknowledgeLiveTrading === undefined) {
      throw new LiveTradingBlockedError(
        "alpaca",
        "These credentials reach a LIVE account. To proceed, pass acknowledgeLiveTrading with the exact acknowledgement sentence (see LIVE_TRADING_ACKNOWLEDGEMENT and docs/orders-rfc.md), or use paper keys.",
      );
    }
    if (options.acknowledgeLiveTrading !== LIVE_TRADING_ACKNOWLEDGEMENT) {
      throw new LiveTradingBlockedError(
        "alpaca",
        `acknowledgeLiveTrading must be exactly: "${LIVE_TRADING_ACKNOWLEDGEMENT}"`,
      );
    }
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetchImpl(`${host}${path}`, {
      ...init,
      headers: {
        "APCA-API-KEY-ID": apiKey,
        "APCA-API-SECRET-KEY": apiSecret,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (!response.ok) rejectResponse("alpaca", "Alpaca", response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };

  return {
    broker: "alpaca",
    environment: isPaper ? "paper" : "live",
    placeOrder: async (request) => {
      validateOrderRequest("alpaca", request, { notional: true });
      const body = {
        symbol: request.symbol,
        side: request.side,
        type: request.type,
        time_in_force: request.timeInForce ?? "day",
        ...(request.quantity !== undefined ? { qty: String(request.quantity) } : {}),
        ...(request.notional !== undefined ? { notional: String(request.notional) } : {}),
        ...(request.limitPrice !== undefined ? { limit_price: String(request.limitPrice) } : {}),
        ...(request.clientOrderId ? { client_order_id: request.clientOrderId } : {}),
      };
      const raw = await call<AlpacaOrder>("/v2/orders", { method: "POST", body: JSON.stringify(body) });
      return normalizeAlpacaOrder(raw);
    },
    getOrder: async (orderId) => normalizeAlpacaOrder(await call<AlpacaOrder>(`/v2/orders/${orderId}`)),
    listOrders: async (listOptions) => {
      const status = listOptions?.status ?? "open";
      const limit = listOptions?.limit ?? 100;
      const raw = await call<AlpacaOrder[]>(`/v2/orders?status=${status}&limit=${limit}`);
      return (Array.isArray(raw) ? raw : []).map(normalizeAlpacaOrder);
    },
    cancelOrder: async (orderId) => {
      await call<undefined>(`/v2/orders/${orderId}`, { method: "DELETE" });
    },
  };
};
