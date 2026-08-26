import { BrokerError } from "../errors.js";

/*
  Shared write-layer contract. Every broker's trading connection normalizes
  into these shapes, mirroring how the read side works. See docs/orders-rfc.md
  for the safety posture and per-broker rollout.
*/

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";
export type TimeInForce = "day" | "gtc" | "ioc" | "fok";
export type OrderStatus =
  | "open"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "expired"
  | "rejected"
  | "pending";

/** Which environment a trading connection reaches. Never inferred, always proven. */
export type TradingEnvironment = "paper" | "sandbox" | "live";

export type OrderRequest = {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  /** Units to trade. Exactly one of `quantity` or `notional` is required. */
  quantity?: number;
  /** Currency amount to trade (market orders only, where the broker supports it). */
  notional?: number;
  /** Required for limit orders. */
  limitPrice?: number;
  /** Defaults to "day". */
  timeInForce?: TimeInForce;
  /**
   * Idempotency key: resubmitting with the same id must not create a second
   * order. Strongly recommended for anything automated.
   */
  clientOrderId?: string;
};

export type Order = {
  id: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  quantity?: number;
  notional?: number;
  limitPrice?: number;
  filledQuantity: number;
  filledAvgPrice?: number;
  submittedAt?: string;
};

export type TradingConnection = {
  readonly broker: string;
  readonly environment: TradingEnvironment;
  placeOrder: (request: OrderRequest) => Promise<Order>;
  getOrder: (orderId: string) => Promise<Order>;
  listOrders: (options?: { status?: "open" | "closed" | "all"; limit?: number }) => Promise<Order[]>;
  cancelOrder: (orderId: string) => Promise<void>;
};

/** Raised when credentials would reach a live account without the explicit acknowledgement. */
export class LiveTradingBlockedError extends BrokerError {
  constructor(broker: string, message: string) {
    super(broker, message);
    this.name = "LiveTradingBlockedError";
  }
}

/** Validate before any network call; broker capabilities differ only in notional support. */
export const validateOrderRequest = (
  broker: string,
  request: OrderRequest,
  capabilities: { notional: boolean },
): void => {
  const hasQuantity = request.quantity !== undefined;
  const hasNotional = request.notional !== undefined;
  if (hasNotional && !capabilities.notional) {
    throw new BrokerError(broker, `${broker} does not support notional sizing — use quantity`);
  }
  if (hasQuantity === hasNotional) {
    throw new BrokerError(broker, "Provide exactly one of quantity or notional");
  }
  if (hasQuantity && (!Number.isFinite(request.quantity) || request.quantity! <= 0)) {
    throw new BrokerError(broker, "quantity must be a positive finite number");
  }
  if (hasNotional && (!Number.isFinite(request.notional) || request.notional! <= 0)) {
    throw new BrokerError(broker, "notional must be a positive finite number");
  }
  if (request.type === "limit" && (request.limitPrice === undefined || !(request.limitPrice > 0))) {
    throw new BrokerError(broker, "limit orders need a positive limitPrice");
  }
  if (hasNotional && request.type !== "market") {
    throw new BrokerError(broker, "notional sizing is only supported for market orders");
  }
  if (!request.symbol) {
    throw new BrokerError(broker, "symbol is required");
  }
};
