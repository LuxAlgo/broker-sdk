/* PORT PENDING: full adapter to be written on this branch. */
import type { BrokerAdapter } from "./types.js";

export type TastytradeRaw = unknown;

export const tastytrade: BrokerAdapter<TastytradeRaw> = {
  id: "tastytrade",
  displayName: "tastytrade",
  credentials: [{ key: "pending", label: "pending", secret: false }],
  readOnlySetup: "pending",
  fetchRaw: async () => {
    throw new Error("tastytrade adapter pending");
  },
  normalize: () => {
    throw new Error("tastytrade adapter pending");
  },
};
