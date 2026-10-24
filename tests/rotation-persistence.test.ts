import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { questrade } from "../src/adapters/questrade.js";
import { connect } from "../src/index.js";
import { openConnections } from "../src/sync/config.js";
import { createSyncDaemon } from "../src/sync/daemon.js";
import { loadState } from "../src/sync/state.js";
import { makeTmpDir } from "./sync-helpers.js";

const tokens = {
  access_token: "synthetic-access",
  refresh_token: "synthetic-next",
  api_server: "https://synthetic.invalid/",
};

const accountResponse = (input: Parameters<typeof fetch>[0]): Response => {
  const path = new URL(String(input)).pathname;
  if (path === "/v1/accounts") return Response.json({ accounts: [{ number: "TEST-1" }, { number: "TEST-2" }] });
  if (path.endsWith("/balances")) return Response.json({ combinedBalances: [{ currency: "CAD", totalEquity: 100 }] });
  if (path.endsWith("/positions")) return Response.json({ positions: [] });
  if (path.endsWith("/activities")) return Response.json({ activities: [] });
  throw new Error(`Unexpected synthetic request: ${path}`);
};

describe("Questrade immediate credential rotation", () => {
  it("keeps CLI daemon polls alive in memory, but requires updated credentials on restart", async () => {
    const statePath = path.join(await makeTmpDir(), "state.json");
    const suppliedTokens: (string | null)[] = [];
    let currentToken = "synthetic-old";
    let exchanges = 0;
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("oauth2/token")) {
        const supplied = url.searchParams.get("refresh_token");
        suppliedTokens.push(supplied);
        if (supplied !== currentToken) return Response.json({}, { status: 401 });
        currentToken = `synthetic-next-${++exchanges}`;
        return Response.json({ ...tokens, refresh_token: currentToken });
      }
      return accountResponse(input);
    });
    try {
      const specs = [{ broker: "questrade" as const, credentials: { refreshToken: "synthetic-old" } }];
      const daemon = createSyncDaemon({
        connections: openConnections(specs), sinks: [], statePath, intervalSeconds: 60,
      });
      expect((await daemon.sweep()).failures).toEqual([]);
      expect((await daemon.sweep()).failures).toEqual([]);
      expect(suppliedTokens).toEqual(["synthetic-old", "synthetic-next-1"]);
      expect(JSON.stringify(await loadState(statePath))).not.toContain("synthetic-next");

      const restarted = createSyncDaemon({
        connections: openConnections(specs), sinks: [], statePath, intervalSeconds: 60,
      });
      expect((await restarted.sweep()).failures).toEqual([
        expect.objectContaining({ broker: "questrade" }),
      ]);
    } finally {
      network.mockRestore();
    }
  });

  it("persists the replacement before a later history request fails and reuses it on retry", async () => {
    const events: string[] = [];
    const exchangedTokens: (string | null)[] = [];
    const persist = vi.fn(() => { events.push("persist"); });
    const connection = connect({
      broker: "questrade",
      credentials: { refreshToken: "synthetic-old" },
      onCredentialsRotated: persist,
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("oauth2/token")) {
          exchangedTokens.push(url.searchParams.get("refresh_token"));
          events.push("exchange");
          return Response.json(tokens);
        }
        events.push("request");
        if (url.pathname.endsWith("/activities")) return Response.json({}, { status: 503 });
        return accountResponse(input);
      },
    });
    await expect(connection.fetchSnapshot()).rejects.toThrow("Questrade rejected the request (503)");
    expect(events.slice(0, 3)).toEqual(["exchange", "persist", "request"]);
    expect(persist).toHaveBeenCalledWith({ refreshToken: tokens.refresh_token });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(connection.credentials).toEqual({ refreshToken: tokens.refresh_token });
    await expect(connection.fetchSnapshot()).rejects.toThrow("Questrade rejected the request (503)");
    expect(exchangedTokens).toEqual(["synthetic-old", "synthetic-next"]);
  });

  it("awaits asynchronous persistence before requesting accounts and imports all returned accounts", async () => {
    let finishPersistence!: () => void;
    let startedPersistence!: () => void;
    const started = new Promise<void>((resolve) => { startedPersistence = resolve; });
    const pending = new Promise<void>((resolve) => { finishPersistence = resolve; });
    const network = vi.fn<typeof fetch>(async (input) => String(input).includes("oauth2/token")
      ? Response.json(tokens)
      : accountResponse(input));
    const persist = vi.fn(async () => {
      startedPersistence();
      await pending;
    });
    const connection = connect({
      broker: "questrade",
      credentials: { refreshToken: "synthetic-old" },
      onCredentialsRotated: persist,
      fetch: network,
    });
    const fetching = connection.fetchSnapshot();
    await started;
    expect(connection.credentials).toEqual({ refreshToken: tokens.refresh_token });
    expect(network).toHaveBeenCalledTimes(1);
    finishPersistence();
    const snapshot = await fetching;
    expect(snapshot.accounts.map((account) => account.id)).toEqual(["TEST-1", "TEST-2"]);
    expect(network).toHaveBeenCalledTimes(8);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("aborts further requests when persistence rejects (async: %s)", async (asynchronous) => {
    const network = vi.fn<typeof fetch>(async () => Response.json(tokens));
    const connection = connect({
      broker: "questrade",
      credentials: { refreshToken: "synthetic-old" },
      onCredentialsRotated: () => {
        const error = new Error("Persistence failed");
        if (asynchronous) return Promise.reject(error);
        throw error;
      },
      fetch: network,
    });
    await expect(connection.fetchSnapshot()).rejects.toThrow("Persistence failed");
    expect(connection.credentials).toEqual({ refreshToken: tokens.refresh_token });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("updates in-memory credentials even without an application persistence callback", async () => {
    const connection = connect({
      broker: "questrade",
      credentials: { refreshToken: "synthetic-old" },
      fetch: async (input) => String(input).includes("oauth2/token")
        ? Response.json(tokens)
        : Response.json({}, { status: 503 }),
    });
    await expect(connection.fetchSnapshot()).rejects.toThrow("Questrade rejected the request (503)");
    expect(connection.credentials).toEqual({ refreshToken: tokens.refresh_token });
  });

  it("returns fallback rotatedCredentials to direct adapter consumers without a callback", async () => {
    const result = await questrade.fetchRaw({ refreshToken: "synthetic-old" }, {
      fetch: async (input) => String(input).includes("oauth2/token") ? Response.json(tokens) : accountResponse(input),
    });
    expect(result.rotatedCredentials).toEqual({ refreshToken: tokens.refresh_token });
    expect(questrade.normalize(result.raw).map((account) => account.id)).toEqual(["TEST-1", "TEST-2"]);
  });

  it("does not return rotation twice when direct adapter consumers supply a callback", async () => {
    const persist = vi.fn();
    const result = await questrade.fetchRaw({ refreshToken: "synthetic-old" }, {
      fetch: async (input) => String(input).includes("oauth2/token") ? Response.json(tokens) : accountResponse(input),
      onCredentialsRotated: persist,
    });
    expect(persist).toHaveBeenCalledExactlyOnceWith({ refreshToken: tokens.refresh_token });
    expect(result).not.toHaveProperty("rotatedCredentials");
  });
});
