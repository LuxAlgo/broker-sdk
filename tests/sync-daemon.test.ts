import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrokerSnapshot } from "../src/index.js";
import { createSyncDaemon, type DaemonConnection } from "../src/sync/daemon.js";
import type { SyncCompletedEvent, SyncEvent } from "../src/sync/events.js";
import type { Sink } from "../src/sync/sinks.js";
import { loadState } from "../src/sync/state.js";
import { makeAccount, makeSnapshot, makeTmpDir, makeTrade } from "./sync-helpers.js";

const capturingSink = (): Sink & { batches: SyncEvent[][] } => {
  const batches: SyncEvent[][] = [];
  return {
    batches,
    deliver: async (events) => {
      batches.push(events);
    },
  };
};

/** A connection whose snapshot can be swapped between sweeps. */
const stubConnection = (
  broker: string,
  first: BrokerSnapshot,
): DaemonConnection & { setSnapshot: (snapshot: BrokerSnapshot) => void; fetches: number } => {
  let current = first;
  const stub = {
    broker,
    label: broker,
    fetches: 0,
    setSnapshot: (snapshot: BrokerSnapshot) => {
      current = snapshot;
    },
    fetchSnapshot: async () => {
      stub.fetches += 1;
      return current;
    },
  };
  return stub;
};

const fixedNow = (): (() => Date) => () => new Date("2026-08-28T12:00:00.000Z");

afterEach(() => {
  vi.useRealTimers();
});

describe("createSyncDaemon", () => {
  it("emits only sync_completed on the first (baseline) sweep and persists state", async () => {
    const dir = await makeTmpDir();
    const statePath = path.join(dir, "state.json");
    const connection = stubConnection(
      "alpaca",
      makeSnapshot({ accounts: [makeAccount({ trades: [makeTrade()], equity: 5_000 })] }),
    );
    const sink = capturingSink();
    const daemon = createSyncDaemon({
      connections: [connection],
      sinks: [sink],
      statePath,
      intervalSeconds: 60,
      now: fixedNow(),
    });

    const result = await daemon.sweep();

    expect(result.events).toEqual([
      { type: "sync_completed", at: "2026-08-28T12:00:00.000Z", brokers: ["alpaca"], failures: [] },
    ]);
    expect(sink.batches).toEqual([result.events]);

    const state = await loadState(statePath);
    expect(Object.keys(state.snapshots)).toEqual(["alpaca"]);
    expect(state.snapshots["alpaca"]?.accounts[0]?.equity).toBe(5_000);
  });

  it("emits diff events on the second sweep, sync_completed last", async () => {
    const dir = await makeTmpDir();
    const statePath = path.join(dir, "state.json");
    const connection = stubConnection("alpaca", makeSnapshot({ accounts: [makeAccount({ equity: 5_000 })] }));
    const sink = capturingSink();
    const daemon = createSyncDaemon({
      connections: [connection],
      sinks: [sink],
      statePath,
      intervalSeconds: 60,
      now: fixedNow(),
    });

    await daemon.sweep();
    connection.setSnapshot(
      makeSnapshot({
        fetchedAt: "2026-08-28T12:01:00.000Z",
        accounts: [makeAccount({ equity: 5_200, trades: [makeTrade()] })],
      }),
    );
    const result = await daemon.sweep();

    const types = result.events.map((event) => event.type);
    expect(types).toEqual(["trade_executed", "balance_changed", "sync_completed"]);
    expect(result.events.at(-1)?.type).toBe("sync_completed");
    expect(sink.batches).toHaveLength(2);
  });

  it("turns a failing connection into broker_error plus a sync_completed failure, without hiding the rest", async () => {
    const dir = await makeTmpDir();
    const statePath = path.join(dir, "state.json");
    const healthy = stubConnection("alpaca", makeSnapshot());
    const broken: DaemonConnection = {
      broker: "kraken",
      label: "kraken",
      fetchSnapshot: async () => {
        throw new Error("invalid api key");
      },
    };
    const sink = capturingSink();
    const daemon = createSyncDaemon({
      connections: [healthy, broken],
      sinks: [sink],
      statePath,
      intervalSeconds: 60,
      now: fixedNow(),
    });

    const result = await daemon.sweep();

    expect(result.brokers).toEqual(["alpaca"]);
    expect(result.failures).toEqual([{ broker: "kraken", message: "invalid api key" }]);
    expect(result.events).toContainEqual({
      type: "broker_error",
      broker: "kraken",
      at: "2026-08-28T12:00:00.000Z",
      message: "invalid api key",
    });
    const completed = result.events.at(-1) as SyncCompletedEvent;
    expect(completed.type).toBe("sync_completed");
    expect(completed.brokers).toEqual(["alpaca"]);
    expect(completed.failures).toEqual([{ broker: "kraken", message: "invalid api key" }]);
  });

  it("stays quiet across a restart: saved state is the baseline, history is not re-emitted", async () => {
    const dir = await makeTmpDir();
    const statePath = path.join(dir, "state.json");
    const snapshot = makeSnapshot({ accounts: [makeAccount({ trades: [makeTrade()], equity: 5_000 })] });

    const first = createSyncDaemon({
      connections: [stubConnection("alpaca", snapshot)],
      sinks: [],
      statePath,
      intervalSeconds: 60,
      now: fixedNow(),
    });
    await first.sweep();

    // "Restart": a brand new daemon instance pointed at the same state file.
    const sink = capturingSink();
    const second = createSyncDaemon({
      connections: [stubConnection("alpaca", { ...snapshot, fetchedAt: "2026-08-28T13:00:00.000Z" })],
      sinks: [sink],
      statePath,
      intervalSeconds: 60,
      now: fixedNow(),
    });
    const result = await second.sweep();

    expect(result.events.map((event) => event.type)).toEqual(["sync_completed"]);
  });

  it("start() sweeps immediately, then on the interval; stop() halts the loop", async () => {
    // Fake only the interval: the sweep's real fs IO must still settle
    // between ticks, or consecutive ticks join one in-flight sweep.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
    const dir = await makeTmpDir();
    const statePath = path.join(dir, "state.json");
    const connection = stubConnection("alpaca", makeSnapshot());
    const daemon = createSyncDaemon({
      connections: [connection],
      sinks: [],
      statePath,
      intervalSeconds: 60,
      now: fixedNow(),
    });

    await daemon.start();
    expect(connection.fetches).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(connection.fetches).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(connection.fetches).toBe(3);

    await daemon.stop();
    await vi.advanceTimersByTimeAsync(180_000);
    await settle();
    expect(connection.fetches).toBe(3);
  });

  it("delivers to every sink, and one throwing sink does not break the others", async () => {
    const dir = await makeTmpDir();
    const statePath = path.join(dir, "state.json");
    const good = capturingSink();
    const bad: Sink = {
      deliver: async () => {
        throw new Error("sink exploded");
      },
    };
    const errors: string[] = [];
    const daemon = createSyncDaemon({
      connections: [stubConnection("alpaca", makeSnapshot())],
      sinks: [bad, good],
      statePath,
      intervalSeconds: 60,
      now: fixedNow(),
      logError: (message) => errors.push(message),
    });

    const result = await daemon.sweep();

    expect(good.batches).toEqual([result.events]);
    expect(errors.some((message) => message.includes("sink exploded"))).toBe(true);
  });

  it("stamps sweep-level events with the injected clock", async () => {
    const dir = await makeTmpDir();
    const statePath = path.join(dir, "state.json");
    const daemon = createSyncDaemon({
      connections: [
        {
          broker: "alpaca",
          label: "alpaca",
          fetchSnapshot: async () => {
            throw new Error("down");
          },
        },
      ],
      sinks: [],
      statePath,
      intervalSeconds: 60,
      now: () => new Date("2001-02-03T04:05:06.000Z"),
    });

    const result = await daemon.sweep();
    for (const event of result.events) {
      expect(event.at).toBe("2001-02-03T04:05:06.000Z");
    }
  });

  it("joins concurrent sweep calls instead of overlapping", async () => {
    const dir = await makeTmpDir();
    const statePath = path.join(dir, "state.json");
    const connection = stubConnection("alpaca", makeSnapshot());
    const daemon = createSyncDaemon({
      connections: [connection],
      sinks: [],
      statePath,
      intervalSeconds: 60,
      now: fixedNow(),
    });

    const [a, b] = await Promise.all([daemon.sweep(), daemon.sweep()]);
    expect(a).toBe(b);
    expect(connection.fetches).toBe(1);
  });
});
