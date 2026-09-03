import { adapters, getAdapter, type AnyBrokerAdapter, type BrokerId } from "./adapters/index.js";
import type { Credentials, FetchContext } from "./adapters/types.js";
import { BrokerError, UnsupportedCapabilityError } from "./errors.js";
import type { Bar, BarsRequest, BrokerSnapshot, CredentialField } from "./schema.js";

export * from "./schema.js";
export * from "./errors.js";
export { adapters, getAdapter } from "./adapters/index.js";
export type { AnyBrokerAdapter, BrokerAdapter, BrokerId } from "./adapters/index.js";
export type { Credentials, FetchContext } from "./adapters/types.js";

/** The exact credential fields each broker needs, typed per broker. */
export type BrokerCredentials = {
  alpaca: { apiKey: string; apiSecret: string };
  binance: { apiKey: string; apiSecret: string };
  bybit: { apiKey: string; apiSecret: string };
  coinbase: { clientId: string; clientSecret: string; refreshToken: string; accessToken?: string; expiresAt?: string };
  "crypto-com": { apiKey: string; apiSecret: string };
  etrade: {
    consumerKey: string;
    consumerSecret: string;
    accessToken: string;
    accessTokenSecret: string;
    environment?: "production" | "sandbox";
  };
  gemini: { apiKey: string; apiSecret: string };
  hyperliquid: { walletAddress: string };
  "ibkr-flex": { flexToken: string; flexQueryId: string };
  kraken: { apiKey: string; apiSecret: string };
  kucoin: { apiKey: string; apiSecret: string; passphrase: string };
  okx: { apiKey: string; apiSecret: string; passphrase: string };
  public: { apiKey: string };
  questrade: { refreshToken: string };
  "robinhood-crypto": { apiKey: string; privateKey: string };
  schwab: { clientId: string; clientSecret: string; refreshToken: string; accessToken?: string; expiresAt?: string };
  tastytrade: { login: string; password: string; rememberToken?: string };
  topstep: { userName: string; apiKey: string };
  tradestation: { clientId: string; clientSecret: string; refreshToken: string; accessToken?: string; expiresAt?: string };
  tradier: { accessToken: string };
  trading212: { apiKey: string };
  webull: { apiKey: string; apiSecret: string };
};

export type ConnectOptions<B extends BrokerId = BrokerId> = {
  broker: B;
  credentials: BrokerCredentials[B];
  /** Your own display label for this connection. */
  label?: string;
  /** Custom fetch (proxies, instrumentation, tests). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /**
   * Called when a fetch rotates the stored credentials (e.g. Questrade
   * refresh tokens are single-use). Persist the new value here, or the next
   * fetch fails.
   */
  onCredentialsRotated?: (credentials: Credentials) => void | Promise<void>;
};

export type BrokerConnection = {
  readonly broker: BrokerId;
  readonly label: string;
  /** Current credentials — reflects rotation after each fetch. */
  readonly credentials: Credentials;
  /** Fetch a fresh normalized snapshot straight from the broker. */
  fetchSnapshot: () => Promise<BrokerSnapshot>;
  /**
   * Historical OHLCV bars from the broker's own market-data endpoints, with
   * the same read-only credentials. Always present on the object; rejects
   * with `UnsupportedCapabilityError` when the broker has no such endpoints
   * (check ahead with `supportsBars(broker)`).
   */
  fetchBars: (symbol: string, request: BarsRequest) => Promise<Bar[]>;
};

/** Whether a broker's adapter can serve historical bars. */
export const supportsBars = (broker: BrokerId): boolean => typeof getAdapter(broker)?.fetchBars === "function";

/**
 * Open a connection to one broker with the user's own credentials.
 * Stateless by design: nothing is stored anywhere until you persist the
 * returned snapshots yourself.
 */
export const connect = <B extends BrokerId>(options: ConnectOptions<B>): BrokerConnection => {
  const adapter = getAdapter(options.broker);
  if (!adapter) {
    throw new BrokerError(options.broker, `Unknown broker "${options.broker}"`);
  }
  return createConnection(adapter, options);
};

const createConnection = (adapter: AnyBrokerAdapter, options: ConnectOptions): BrokerConnection => {
  let credentials: Credentials = { ...(options.credentials as Credentials) };
  const ctx: FetchContext = { fetch: options.fetch ?? globalThis.fetch };

  const fetchSnapshot = async (): Promise<BrokerSnapshot> => {
    const result = await adapter.fetchRaw(credentials, ctx);
    if (result.rotatedCredentials) {
      credentials = { ...credentials, ...result.rotatedCredentials };
      await options.onCredentialsRotated?.(credentials);
    }
    return {
      broker: adapter.id,
      fetchedAt: new Date().toISOString(),
      accounts: adapter.normalize(result.raw),
    };
  };

  const fetchBars = async (symbol: string, request: BarsRequest): Promise<Bar[]> => {
    if (!adapter.fetchBars) {
      throw new UnsupportedCapabilityError(
        adapter.id,
        "fetchBars",
        `${adapter.displayName} exposes no market-data endpoint for historical bars`,
      );
    }
    return adapter.fetchBars(credentials, symbol, request, ctx);
  };

  return {
    broker: adapter.id as BrokerId,
    label: options.label ?? adapter.displayName,
    get credentials() {
      return { ...credentials };
    },
    fetchSnapshot,
    fetchBars,
  };
};

export type PortfolioFetchResult = {
  snapshots: BrokerSnapshot[];
  /** Connections that failed, with the error — one bad key never hides the rest. */
  failures: { broker: BrokerId; label: string; error: Error }[];
};

export type Portfolio = {
  readonly connections: readonly BrokerConnection[];
  add: <B extends BrokerId>(options: ConnectOptions<B>) => BrokerConnection;
  /** Fetch every connection concurrently; failures are collected, not thrown. */
  fetchAll: () => Promise<PortfolioFetchResult>;
};

/** A set of connections fetched together — your whole portfolio in one call. */
export const createPortfolio = (): Portfolio => {
  const connections: BrokerConnection[] = [];

  return {
    get connections() {
      return [...connections];
    },
    add: (options) => {
      const connection = connect(options);
      connections.push(connection);
      return connection;
    },
    fetchAll: async () => {
      const settled = await Promise.allSettled(connections.map((connection) => connection.fetchSnapshot()));
      const snapshots: BrokerSnapshot[] = [];
      const failures: PortfolioFetchResult["failures"] = [];
      settled.forEach((result, index) => {
        const connection = connections[index];
        if (!connection) return;
        if (result.status === "fulfilled") {
          snapshots.push(result.value);
        } else {
          const error = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
          failures.push({ broker: connection.broker, label: connection.label, error });
        }
      });
      return { snapshots, failures };
    },
  };
};

export type BrokerInfo = {
  id: BrokerId;
  displayName: string;
  credentials: CredentialField[];
  readOnlySetup: string;
  /** True when `connection.fetchBars` is backed by a real market-data endpoint. */
  supportsBars: boolean;
};

/** Every supported broker with its credential fields and read-only setup guide. */
export const listBrokers = (): BrokerInfo[] =>
  (Object.keys(adapters) as BrokerId[]).map((id) => {
    const adapter = adapters[id];
    return {
      id,
      displayName: adapter.displayName,
      credentials: adapter.credentials,
      readOnlySetup: adapter.readOnlySetup,
      supportsBars: typeof adapter.fetchBars === "function",
    };
  });
