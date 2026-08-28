/* PORT PENDING: full adapter to be written on this branch. */
import type { BrokerAdapter } from "./types.js";

export type RobinhoodCryptoRaw = unknown;

export const robinhoodCrypto: BrokerAdapter<RobinhoodCryptoRaw> = {
  id: "robinhood-crypto",
  displayName: "Robinhood Crypto",
  credentials: [{ key: "pending", label: "pending", secret: false }],
  readOnlySetup: "pending",
  fetchRaw: async () => {
    throw new Error("robinhood-crypto adapter pending");
  },
  normalize: () => {
    throw new Error("robinhood-crypto adapter pending");
  },
};
