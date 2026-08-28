/* PORT PENDING: full adapter to be written on this branch. */
import type { BrokerAdapter } from "./types.js";

export type GeminiRaw = unknown;

export const gemini: BrokerAdapter<GeminiRaw> = {
  id: "gemini",
  displayName: "Gemini",
  credentials: [{ key: "pending", label: "pending", secret: false }],
  readOnlySetup: "pending",
  fetchRaw: async () => {
    throw new Error("gemini adapter pending");
  },
  normalize: () => {
    throw new Error("gemini adapter pending");
  },
};
