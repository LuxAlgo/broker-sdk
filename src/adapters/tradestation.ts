/* PORT PENDING: full adapter to be written on this branch. */
import type { BrokerAdapter } from "./types.js";

export type TradestationRaw = unknown;

export const tradestation: BrokerAdapter<TradestationRaw> = {
  id: "tradestation",
  displayName: "TradeStation",
  credentials: [{ key: "pending", label: "pending", secret: false }],
  readOnlySetup: "pending",
  fetchRaw: async () => {
    throw new Error("tradestation adapter pending");
  },
  normalize: () => {
    throw new Error("tradestation adapter pending");
  },
};
