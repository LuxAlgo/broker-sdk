/*
  Configuration resolution. Two credential sources, mergeable:

  - BROKERS_* environment variables, the same convention as the LuxAlgo MCP
    server: BROKERS_<BROKER>_<FIELD>, broker id uppercased with dashes as
    underscores, credential key camelCase as UPPER_SNAKE —
    BROKERS_ALPACA_API_KEY, BROKERS_OKX_PASSPHRASE,
    BROKERS_HYPERLIQUID_WALLET_ADDRESS, BROKERS_CRYPTO_COM_API_SECRET, ...
    A broker is connected when every one of its credential fields is set.

  - An optional JSON config file (--config) for settings plus explicit
    connection entries.

  Precedence: CLI flags override the config file, the config file overrides
  defaults, and for a broker present in both the file entry wins over env.
  Env-only with zero config works out of the box.
*/
import { readFile } from "node:fs/promises";
import {
  connect,
  listBrokers,
  type BrokerConnection,
  type BrokerCredentials,
  type BrokerId,
} from "../index.js";

export const DEFAULT_INTERVAL_SECONDS = 300;
export const MIN_INTERVAL_SECONDS = 30;
export const DEFAULT_STATE_PATH = "./broker-sync-state.json";

export type ConnectionSpec = {
  broker: BrokerId;
  credentials: Record<string, string>;
  label?: string;
};

export type WebhookConfig = {
  url: string;
  secret?: string;
};

export type ResolvedConfig = {
  intervalSeconds: number;
  statePath: string;
  webhook?: WebhookConfig;
  jsonlPath?: string;
  connections: ConnectionSpec[];
};

/** BROKERS_<BROKER>_<FIELD>: dashes to underscores, camelCase to UPPER_SNAKE. */
export const envVarName = (brokerId: string, credentialKey: string): string => {
  const broker = brokerId.toUpperCase().replace(/-/g, "_");
  const field = credentialKey.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  return `BROKERS_${broker}_${field}`;
};

/** Connection specs for every broker whose env vars are all present. */
export const connectionsFromEnv = (env: NodeJS.ProcessEnv): ConnectionSpec[] => {
  const specs: ConnectionSpec[] = [];
  for (const broker of listBrokers()) {
    const credentials: Record<string, string> = {};
    let complete = true;
    for (const field of broker.credentials) {
      const value = env[envVarName(broker.id, field.key)]?.trim();
      if (!value) {
        complete = false;
        break;
      }
      credentials[field.key] = value;
    }
    if (complete) specs.push({ broker: broker.id, credentials });
  }
  return specs;
};

export type FileConfig = {
  intervalSeconds?: number;
  statePath?: string;
  webhook?: WebhookConfig;
  jsonlPath?: string;
  connections?: ConnectionSpec[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");

/** Parse and validate the JSON config file. Throws with a readable message. */
export const parseFileConfig = (raw: string, source: string): FileConfig => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Config file ${source} is not valid JSON.`);
  }
  if (!isRecord(parsed)) throw new Error(`Config file ${source} must be a JSON object.`);

  const config: FileConfig = {};

  if (parsed["intervalSeconds"] !== undefined) {
    if (typeof parsed["intervalSeconds"] !== "number") {
      throw new Error(`Config file ${source}: "intervalSeconds" must be a number.`);
    }
    config.intervalSeconds = parsed["intervalSeconds"];
  }
  if (parsed["statePath"] !== undefined) {
    if (typeof parsed["statePath"] !== "string") {
      throw new Error(`Config file ${source}: "statePath" must be a string.`);
    }
    config.statePath = parsed["statePath"];
  }
  if (parsed["jsonlPath"] !== undefined) {
    if (typeof parsed["jsonlPath"] !== "string") {
      throw new Error(`Config file ${source}: "jsonlPath" must be a string.`);
    }
    config.jsonlPath = parsed["jsonlPath"];
  }
  if (parsed["webhook"] !== undefined) {
    const webhook = parsed["webhook"];
    if (!isRecord(webhook) || typeof webhook["url"] !== "string") {
      throw new Error(`Config file ${source}: "webhook" must be an object with a string "url".`);
    }
    if (webhook["secret"] !== undefined && typeof webhook["secret"] !== "string") {
      throw new Error(`Config file ${source}: "webhook.secret" must be a string.`);
    }
    config.webhook =
      webhook["secret"] !== undefined
        ? { url: webhook["url"], secret: webhook["secret"] as string }
        : { url: webhook["url"] };
  }
  if (parsed["connections"] !== undefined) {
    const connections = parsed["connections"];
    if (!Array.isArray(connections)) {
      throw new Error(`Config file ${source}: "connections" must be an array.`);
    }
    const knownIds = new Set<string>(listBrokers().map((broker) => broker.id));
    config.connections = connections.map((entry, index) => {
      if (!isRecord(entry) || typeof entry["broker"] !== "string" || !isStringRecord(entry["credentials"])) {
        throw new Error(
          `Config file ${source}: connections[${index}] must be {broker, credentials} with string credential values.`,
        );
      }
      if (!knownIds.has(entry["broker"])) {
        throw new Error(
          `Config file ${source}: connections[${index}] has unknown broker "${entry["broker"]}". ` +
            `Known brokers: ${[...knownIds].sort().join(", ")}.`,
        );
      }
      const spec: ConnectionSpec = {
        broker: entry["broker"] as BrokerId,
        credentials: entry["credentials"],
      };
      if (entry["label"] !== undefined) {
        if (typeof entry["label"] !== "string") {
          throw new Error(`Config file ${source}: connections[${index}].label must be a string.`);
        }
        spec.label = entry["label"];
      }
      return spec;
    });
  }

  return config;
};

const resolveInterval = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Interval must be a positive number of seconds, got ${String(value)}.`);
  }
  return Math.max(MIN_INTERVAL_SECONDS, value);
};

export type CliOverrides = {
  intervalSeconds?: number;
  statePath?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  jsonlPath?: string;
};

export type ResolveConfigOptions = {
  configPath?: string;
  overrides?: CliOverrides;
  env?: NodeJS.ProcessEnv;
};

/**
 * Resolve the effective config: defaults < config file < CLI flags, with
 * connections merged from the config file and BROKERS_* env vars (the file
 * entry wins when the same broker appears in both).
 */
export const resolveConfig = async (options: ResolveConfigOptions = {}): Promise<ResolvedConfig> => {
  const env = options.env ?? process.env;
  const overrides = options.overrides ?? {};

  let file: FileConfig = {};
  if (options.configPath !== undefined) {
    file = parseFileConfig(await readFile(options.configPath, "utf8"), options.configPath);
  }

  const intervalSeconds = resolveInterval(
    overrides.intervalSeconds ?? file.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
  );
  const statePath = overrides.statePath ?? file.statePath ?? DEFAULT_STATE_PATH;
  const jsonlPath = overrides.jsonlPath ?? file.jsonlPath;

  const webhookUrl = overrides.webhookUrl ?? file.webhook?.url;
  const webhookSecret = overrides.webhookSecret ?? file.webhook?.secret;
  if (webhookSecret !== undefined && webhookUrl === undefined) {
    throw new Error("A webhook secret was configured without a webhook url.");
  }

  const fileConnections = file.connections ?? [];
  const fileBrokers = new Set<string>(fileConnections.map((spec) => spec.broker));
  const connections = [
    ...fileConnections,
    ...connectionsFromEnv(env).filter((spec) => !fileBrokers.has(spec.broker)),
  ];

  const resolved: ResolvedConfig = { intervalSeconds, statePath, connections };
  if (webhookUrl !== undefined) {
    resolved.webhook = webhookSecret !== undefined ? { url: webhookUrl, secret: webhookSecret } : { url: webhookUrl };
  }
  if (jsonlPath !== undefined) resolved.jsonlPath = jsonlPath;
  return resolved;
};

/** Open real SDK connections for the resolved connection specs. */
export const openConnections = (specs: ConnectionSpec[]): BrokerConnection[] =>
  specs.map((spec) =>
    connect({
      broker: spec.broker,
      credentials: spec.credentials as BrokerCredentials[BrokerId],
      ...(spec.label !== undefined ? { label: spec.label } : {}),
    }),
  );
