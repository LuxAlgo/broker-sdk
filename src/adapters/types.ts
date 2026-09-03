import type { Account, Bar, BarsRequest, CredentialField } from "../schema.js";

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
 * position, and history endpoints — never trading ones. The optional
 * `fetchBars` extends that list with the broker's own market-data
 * endpoints, which are read-only too; adapters whose broker has no such
 * endpoints simply leave it undefined.
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
  /**
   * Historical OHLCV bars for one symbol, using the same read-only
   * credentials. Only present when the broker exposes market-data
   * endpoints; `connect()` turns its absence into an
   * `UnsupportedCapabilityError` so callers can feature-detect either way.
   */
  fetchBars?: (credentials: Credentials, symbol: string, request: BarsRequest, ctx: FetchContext) => Promise<Bar[]>;
};
