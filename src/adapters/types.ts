import type { Account, CredentialField } from "../schema.js";

export type Credentials = Record<string, string>;

/** Injected IO — lets callers supply a custom fetch (proxies, tests). */
export type FetchContext = {
  fetch: typeof globalThis.fetch;
};

export type AdapterFetchResult<Raw> = {
  raw: Raw;
  /**
   * Rotated credentials the caller must persist before the old ones die
   * (e.g. Questrade refresh tokens are single-use).
   */
  rotatedCredentials?: Credentials;
};

/**
 * A broker adapter, split along the IO seam:
 *
 * - `fetchRaw` does nothing but talk to the broker and gather raw payloads.
 * - `normalize` is a pure function from those payloads to normalized
 *   accounts — this is the half the conformance vectors exercise, so every
 *   adapter's mapping is testable without a network or credentials.
 *
 * Read-only by contract: `fetchRaw` must only ever call account, balance,
 * position, and history endpoints — never trading ones.
 */
export type BrokerAdapter<Raw = unknown> = {
  id: string;
  displayName: string;
  /** The credential fields this adapter needs from the user. */
  credentials: CredentialField[];
  /** How to create the key with a read-only scope, in one sentence. */
  readOnlySetup: string;
  fetchRaw: (credentials: Credentials, ctx: FetchContext) => Promise<AdapterFetchResult<Raw>>;
  normalize: (raw: Raw) => Account[];
};
