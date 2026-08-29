#!/usr/bin/env node
/*
  The `broker-sync` command. Credentials come from BROKERS_* env vars (same
  convention as the LuxAlgo MCP server) and/or a JSON config file; sinks and
  timing come from flags or the file. Startup and shutdown chatter goes to
  stderr only — stdout belongs to the console sink. No secrets are ever
  printed: the startup line names broker ids and sink kinds, nothing else.
*/
import process from "node:process";
import { openConnections, resolveConfig, type CliOverrides } from "./config.js";
import { createSyncDaemon } from "./daemon.js";
import { createConsoleSink, createJsonlSink, createWebhookSink, type Sink } from "./sinks.js";

const USAGE = `Usage: broker-sync [options]

Polls your broker connections on an interval, diffs each snapshot against
the previous one, and emits events to your configured sinks.

Options:
  --config <path>            JSON config file
  --interval <seconds>       Sweep interval (default 300, minimum 30)
  --state <path>             State file (default ./broker-sync-state.json)
  --webhook-url <url>        POST each sweep's events to this URL
  --webhook-secret <secret>  Sign webhook bodies (X-BrokerSync-Signature)
  --jsonl <path>             Append one JSON event per line to this file
  --help                     Show this help

Credentials come from BROKERS_<BROKER>_<FIELD> environment variables
(e.g. BROKERS_ALPACA_API_KEY, BROKERS_KRAKEN_API_SECRET) or from
"connections" entries in the config file.
`;

type CliArgs = {
  help: boolean;
  configPath?: string;
  overrides: CliOverrides;
};

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = { help: false, overrides: {} };

  const takeValue = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}.`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--config":
        args.configPath = takeValue(flag, index);
        index += 1;
        break;
      case "--interval": {
        const value = Number(takeValue(flag, index));
        if (!Number.isFinite(value)) throw new Error("--interval must be a number of seconds.");
        args.overrides.intervalSeconds = value;
        index += 1;
        break;
      }
      case "--state":
        args.overrides.statePath = takeValue(flag, index);
        index += 1;
        break;
      case "--webhook-url":
        args.overrides.webhookUrl = takeValue(flag, index);
        index += 1;
        break;
      case "--webhook-secret":
        args.overrides.webhookSecret = takeValue(flag, index);
        index += 1;
        break;
      case "--jsonl":
        args.overrides.jsonlPath = takeValue(flag, index);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option "${flag}". Run broker-sync --help for usage.`);
    }
  }

  return args;
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  const config = await resolveConfig({
    ...(args.configPath !== undefined ? { configPath: args.configPath } : {}),
    overrides: args.overrides,
    env: process.env,
  });

  if (config.connections.length === 0) {
    process.stderr.write(
      "broker-sync: no broker connections configured.\n" +
        "Set BROKERS_<BROKER>_<FIELD> environment variables (e.g. BROKERS_ALPACA_API_KEY,\n" +
        "BROKERS_ALPACA_API_SECRET) or pass --config with \"connections\" entries.\n",
    );
    process.exitCode = 1;
    return;
  }

  const connections = openConnections(config.connections);

  const sinks: Sink[] = [];
  const sinkNames: string[] = [];
  if (config.webhook) {
    sinks.push(createWebhookSink(config.webhook));
    sinkNames.push("webhook");
  }
  if (config.jsonlPath !== undefined) {
    sinks.push(createJsonlSink({ path: config.jsonlPath }));
    sinkNames.push("jsonl");
  }
  if (sinks.length === 0) {
    sinks.push(createConsoleSink());
    sinkNames.push("console");
  }

  // stderr only — stdout belongs to the console sink. Broker ids, never keys.
  console.error(
    `broker-sync: watching ${connections.length} connection(s): ${connections
      .map((connection) => connection.broker)
      .join(", ")} — every ${config.intervalSeconds}s to ${sinkNames.join(", ")} (state: ${config.statePath})`,
  );

  const daemon = createSyncDaemon({
    connections,
    sinks,
    statePath: config.statePath,
    intervalSeconds: config.intervalSeconds,
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.error(`broker-sync: ${signal} received, finishing in-flight sweep and stopping`);
    void daemon.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await daemon.start();
};

main().catch((error: unknown) => {
  console.error(`broker-sync: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
