import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  connectionsFromEnv,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_STATE_PATH,
  envVarName,
  MIN_INTERVAL_SECONDS,
  parseFileConfig,
  resolveConfig,
} from "../src/sync/config.js";
import { makeTmpDir } from "./sync-helpers.js";

describe("envVarName", () => {
  it("uppercases the broker id and turns dashes into underscores", () => {
    expect(envVarName("alpaca", "apiKey")).toBe("BROKERS_ALPACA_API_KEY");
    expect(envVarName("crypto-com", "apiSecret")).toBe("BROKERS_CRYPTO_COM_API_SECRET");
    expect(envVarName("ibkr-flex", "flexQueryId")).toBe("BROKERS_IBKR_FLEX_FLEX_QUERY_ID");
  });

  it("turns camelCase credential keys into UPPER_SNAKE", () => {
    expect(envVarName("hyperliquid", "walletAddress")).toBe("BROKERS_HYPERLIQUID_WALLET_ADDRESS");
    expect(envVarName("okx", "passphrase")).toBe("BROKERS_OKX_PASSPHRASE");
    expect(envVarName("etrade", "accessTokenSecret")).toBe("BROKERS_ETRADE_ACCESS_TOKEN_SECRET");
  });
});

describe("connectionsFromEnv", () => {
  it("picks up brokers whose env vars are all present", () => {
    const specs = connectionsFromEnv({
      BROKERS_ALPACA_API_KEY: "key",
      BROKERS_ALPACA_API_SECRET: "secret",
      BROKERS_HYPERLIQUID_WALLET_ADDRESS: "0xabc",
    });
    expect(specs.map((spec) => spec.broker).sort()).toEqual(["alpaca", "hyperliquid"]);
    expect(specs.find((spec) => spec.broker === "alpaca")?.credentials).toEqual({
      apiKey: "key",
      apiSecret: "secret",
    });
  });

  it("skips brokers with incomplete or blank credentials", () => {
    const specs = connectionsFromEnv({
      BROKERS_ALPACA_API_KEY: "key", // missing BROKERS_ALPACA_API_SECRET
      BROKERS_KRAKEN_API_KEY: "key",
      BROKERS_KRAKEN_API_SECRET: "   ", // blank
    });
    expect(specs).toEqual([]);
  });
});

describe("resolveConfig", () => {
  it("applies defaults with zero config (env-only)", async () => {
    const config = await resolveConfig({
      env: { BROKERS_TRADIER_ACCESS_TOKEN: "tok" },
    });
    expect(config.intervalSeconds).toBe(DEFAULT_INTERVAL_SECONDS);
    expect(config.statePath).toBe(DEFAULT_STATE_PATH);
    expect(config.webhook).toBeUndefined();
    expect(config.jsonlPath).toBeUndefined();
    expect(config.connections).toEqual([{ broker: "tradier", credentials: { accessToken: "tok" } }]);
  });

  it("clamps the interval to the minimum", async () => {
    const config = await resolveConfig({ overrides: { intervalSeconds: 5 }, env: {} });
    expect(config.intervalSeconds).toBe(MIN_INTERVAL_SECONDS);
  });

  it("rejects a non-positive interval", async () => {
    await expect(resolveConfig({ overrides: { intervalSeconds: 0 }, env: {} })).rejects.toThrow(/positive/);
  });

  it("reads the config file and lets CLI overrides win", async () => {
    const dir = await makeTmpDir();
    const configPath = path.join(dir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        intervalSeconds: 60,
        statePath: "./from-file.json",
        jsonlPath: "./from-file.jsonl",
        webhook: { url: "https://file.test/hook", secret: "file-secret" },
        connections: [{ broker: "tradier", credentials: { accessToken: "tok" }, label: "Main" }],
      }),
      "utf8",
    );

    const fromFile = await resolveConfig({ configPath, env: {} });
    expect(fromFile.intervalSeconds).toBe(60);
    expect(fromFile.statePath).toBe("./from-file.json");
    expect(fromFile.jsonlPath).toBe("./from-file.jsonl");
    expect(fromFile.webhook).toEqual({ url: "https://file.test/hook", secret: "file-secret" });
    expect(fromFile.connections).toEqual([
      { broker: "tradier", credentials: { accessToken: "tok" }, label: "Main" },
    ]);

    const overridden = await resolveConfig({
      configPath,
      overrides: { intervalSeconds: 45, statePath: "./cli.json", webhookUrl: "https://cli.test/hook" },
      env: {},
    });
    expect(overridden.intervalSeconds).toBe(45);
    expect(overridden.statePath).toBe("./cli.json");
    expect(overridden.webhook?.url).toBe("https://cli.test/hook");
  });

  it("merges env connections with file connections, file entry winning per broker", async () => {
    const dir = await makeTmpDir();
    const configPath = path.join(dir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        connections: [{ broker: "tradier", credentials: { accessToken: "file-token" } }],
      }),
      "utf8",
    );

    const config = await resolveConfig({
      configPath,
      env: {
        BROKERS_TRADIER_ACCESS_TOKEN: "env-token",
        BROKERS_TRADING212_API_KEY: "t212",
      },
    });

    expect(config.connections).toHaveLength(2);
    expect(config.connections.find((spec) => spec.broker === "tradier")?.credentials).toEqual({
      accessToken: "file-token",
    });
    expect(config.connections.find((spec) => spec.broker === "trading212")?.credentials).toEqual({
      apiKey: "t212",
    });
  });

  it("rejects a webhook secret without a webhook url", async () => {
    await expect(resolveConfig({ overrides: { webhookSecret: "s" }, env: {} })).rejects.toThrow(
      /secret .*without a webhook url/,
    );
  });
});

describe("parseFileConfig", () => {
  it("rejects invalid JSON and non-object roots", () => {
    expect(() => parseFileConfig("nope{", "config.json")).toThrow(/not valid JSON/);
    expect(() => parseFileConfig("[1,2]", "config.json")).toThrow(/must be a JSON object/);
  });

  it("rejects unknown broker ids with the list of known ones", () => {
    const raw = JSON.stringify({ connections: [{ broker: "not-a-broker", credentials: { apiKey: "x" } }] });
    expect(() => parseFileConfig(raw, "config.json")).toThrow(/unknown broker "not-a-broker"/);
    expect(() => parseFileConfig(raw, "config.json")).toThrow(/alpaca/);
  });

  it("rejects a webhook without a url and wrong field types", () => {
    expect(() => parseFileConfig(JSON.stringify({ webhook: {} }), "c.json")).toThrow(/string "url"/);
    expect(() => parseFileConfig(JSON.stringify({ intervalSeconds: "60" }), "c.json")).toThrow(/must be a number/);
    expect(() => parseFileConfig(JSON.stringify({ connections: [{ broker: "alpaca" }] }), "c.json")).toThrow(
      /connections\[0\]/,
    );
  });
});
