import { asFiniteNumber, asIsoTimestamp, rejectResponse } from "../adapters/http.js";
import { tradierList } from "../adapters/tradier.js";
import { BrokerError, BrokerRequestError, MissingCredentialsError } from "../errors.js";
import { validateOrderRequest, type Order, type OrderStatus, type TradingConnection } from "./types.js";

/*
  Tradier order placement — SANDBOX ONLY in this version. The connection is
  pinned to sandbox.tradier.com, which only accepts sandbox tokens, so live
  orders are impossible by construction (a production token simply fails
  auth). Live enablement follows the acknowledgement design in
  docs/orders-rfc.md once the sandbox surface has soaked.

  Equity orders only. Tradier has no client-order-id dedupe; the `tag`
  field is echoed back for correlation but does NOT prevent duplicates —
  documented rather than pretended away.
*/

const TRADIER_SANDBOX_API = "https://sandbox.tradier.com/v1";

type TradierOrderRow = {
  id?: number | string;
  symbol?: string;
  side?: string;
  type?: string;
  status?: string;
  quantity?: number | string;
  price?: number | string;
  exec_quantity?: number | string;
  avg_fill_price?: number | string;
  create_date?: string;
  tag?: string;
};

const TRADIER_STATUSES: Record<string, OrderStatus> = {
  open: "open",
  submitted: "open",
  calculated: "open",
  accepted: "open",
  pending: "pending",
  partially_filled: "partially_filled",
  filled: "filled",
  canceled: "canceled",
  expired: "expired",
  rejected: "rejected",
  error: "rejected",
};

/** Pure mapper from a Tradier order payload to the normalized Order. */
export const normalizeTradierOrder = (raw: TradierOrderRow): Order => {
  const quantity = asFiniteNumber(raw.quantity);
  const limitPrice = raw.type === "limit" ? asFiniteNumber(raw.price) : undefined;
  const filledAvgPrice = asFiniteNumber(raw.avg_fill_price);
  const submittedAt = asIsoTimestamp(raw.create_date);
  const side = raw.side === "sell" || raw.side === "sell_short" ? "sell" : "buy";
  return {
    id: String(raw.id ?? ""),
    ...(raw.tag ? { clientOrderId: raw.tag } : {}),
    symbol: raw.symbol ?? "",
    side,
    type: raw.type === "limit" ? "limit" : "market",
    status: (raw.status ? TRADIER_STATUSES[raw.status] : undefined) ?? "pending",
    ...(quantity !== undefined ? { quantity } : {}),
    ...(limitPrice !== undefined ? { limitPrice } : {}),
    filledQuantity: asFiniteNumber(raw.exec_quantity) ?? 0,
    ...(filledAvgPrice !== undefined && filledAvgPrice > 0 ? { filledAvgPrice } : {}),
    ...(submittedAt ? { submittedAt } : {}),
  };
};

export type TradierTradingOptions = {
  credentials: {
    /** A SANDBOX access token — production tokens fail against the sandbox host. */
    accessToken: string;
    /** Skip the profile lookup by naming the account directly. */
    accountId?: string;
  };
  fetch?: typeof globalThis.fetch;
};

export const connectTradierTrading = (options: TradierTradingOptions): TradingConnection => {
  const accessToken = options.credentials.accessToken?.trim();
  if (!accessToken) {
    throw new MissingCredentialsError("tradier", "Tradier trading connection is missing its sandbox access token");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetchImpl(`${TRADIER_SANDBOX_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
    });
    if (!response.ok) rejectResponse("tradier", "Tradier", response);
    return (await response.json()) as T;
  };

  let cachedAccountId: string | undefined = options.credentials.accountId;
  const accountId = async (): Promise<string> => {
    if (cachedAccountId) return cachedAccountId;
    type Profile = { profile?: { account?: { account_number?: string } | { account_number?: string }[] } };
    const profile = await call<Profile>("/user/profile");
    const first = tradierList(profile.profile?.account)[0]?.account_number;
    if (!first) {
      throw new BrokerRequestError("tradier", "Tradier returned no accounts for this token");
    }
    cachedAccountId = first;
    return first;
  };

  return {
    broker: "tradier",
    environment: "sandbox",
    placeOrder: async (request) => {
      validateOrderRequest("tradier", request, { notional: false });
      const timeInForce = request.timeInForce ?? "day";
      if (timeInForce !== "day" && timeInForce !== "gtc") {
        throw new BrokerError("tradier", "Tradier supports only day and gtc time-in-force");
      }
      if (request.clientOrderId && !/^[A-Za-z0-9-]{1,255}$/.test(request.clientOrderId)) {
        throw new BrokerError("tradier", "Tradier order tags allow only letters, digits, and dashes");
      }
      const id = await accountId();
      const body = new URLSearchParams({
        class: "equity",
        symbol: request.symbol,
        side: request.side,
        quantity: String(request.quantity),
        type: request.type,
        duration: timeInForce,
        ...(request.limitPrice !== undefined ? { price: String(request.limitPrice) } : {}),
        ...(request.clientOrderId ? { tag: request.clientOrderId } : {}),
      });
      const created = await call<{ order?: { id?: number | string; status?: string } }>(`/accounts/${id}/orders`, {
        method: "POST",
        body: body.toString(),
      });
      const orderId = created.order?.id;
      if (orderId === undefined) {
        throw new BrokerRequestError("tradier", "Tradier returned no order id");
      }
      const placed = await call<{ order?: TradierOrderRow }>(`/accounts/${id}/orders/${orderId}`);
      return normalizeTradierOrder(placed.order ?? { id: orderId, ...(created.order?.status ? { status: created.order.status } : {}) });
    },
    getOrder: async (orderId) => {
      const id = await accountId();
      const body = await call<{ order?: TradierOrderRow }>(`/accounts/${id}/orders/${orderId}`);
      return normalizeTradierOrder(body.order ?? {});
    },
    listOrders: async (listOptions) => {
      const id = await accountId();
      const body = await call<{ orders?: { order?: TradierOrderRow | TradierOrderRow[] } | "null" }>(
        `/accounts/${id}/orders`,
      );
      const rows = typeof body.orders === "object" ? tradierList(body.orders?.order) : [];
      const status = listOptions?.status ?? "open";
      const isOpen = (order: Order) => order.status === "open" || order.status === "partially_filled" || order.status === "pending";
      return rows
        .map(normalizeTradierOrder)
        .filter((order) => (status === "all" ? true : status === "open" ? isOpen(order) : !isOpen(order)))
        .slice(0, listOptions?.limit ?? 100);
    },
    cancelOrder: async (orderId) => {
      const id = await accountId();
      await call<unknown>(`/accounts/${id}/orders/${orderId}`, { method: "DELETE" });
    },
  };
};
