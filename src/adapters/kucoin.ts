/* PORT PENDING: full adapter to be written on this branch. */
import type { BrokerAdapter } from "./types.js";

export type KucoinRaw = unknown;

export const kucoin: BrokerAdapter<KucoinRaw> = {
  id: "kucoin",
  displayName: "KuCoin",
  credentials: [{ key: "pending", label: "pending", secret: false }],
  readOnlySetup: "pending",
  fetchRaw: async () => {
    throw new Error("kucoin adapter pending");
  },
  normalize: () => {
    throw new Error("kucoin adapter pending");
  },
};
