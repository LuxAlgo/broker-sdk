/*
  The sweep loop. Each sweep: fetch every connection concurrently
  (Promise.allSettled — one bad key never hides the rest), diff each new
  snapshot against the saved one, persist the new state, then hand the full
  batch of events to every sink.

  State persists BEFORE delivery, so a crash between the two can drop one
  batch but can never replay one — restarts stay quiet.

  Everything is injectable for tests: prebuilt connections (any object with
  broker/label/fetchSnapshot), sinks, and the clock.
*/
import type { BrokerSnapshot } from "../index.js";
import { diffSnapshots } from "./diff.js";
import type { SyncEvent } from "./events.js";
import type { Sink } from "./sinks.js";
import { loadState, saveState, type SyncState } from "./state.js";

/**
 * What the daemon needs from a connection — the SDK's BrokerConnection
 * satisfies it, and so does any stub with these three members.
 */
export type DaemonConnection = {
  broker: string;
  label: string;
  fetchSnapshot: () => Promise<BrokerSnapshot>;
};

export type SweepResult = {
  events: SyncEvent[];
  /** Broker ids that synced successfully this sweep. */
  brokers: string[];
  failures: { broker: string; message: string }[];
};

export type SyncDaemonOptions = {
  connections: DaemonConnection[];
  sinks: Sink[];
  statePath: string;
  intervalSeconds: number;
  /** Injectable clock for tests. Defaults to () => new Date(). */
  now?: () => Date;
  /** Injectable for tests. Defaults to console.error. */
  logError?: (message: string) => void;
};

export type SyncDaemon = {
  /** Runs an immediate first sweep, then sweeps every intervalSeconds. */
  start: () => Promise<void>;
  /** Stops the schedule and waits for any in-flight sweep to finish. */
  stop: () => Promise<void>;
  /** One sweep: fetch, diff, persist, deliver. Usable standalone. */
  sweep: () => Promise<SweepResult>;
};

export const createSyncDaemon = (options: SyncDaemonOptions): SyncDaemon => {
  const now = options.now ?? (() => new Date());
  const logError = options.logError ?? ((message: string) => console.error(message));

  let statePromise: Promise<SyncState> | null = null;
  const getState = (): Promise<SyncState> => (statePromise ??= loadState(options.statePath));

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<SweepResult> | null = null;

  const runSweep = async (): Promise<SweepResult> => {
    const state = await getState();
    const settled = await Promise.allSettled(options.connections.map((connection) => connection.fetchSnapshot()));

    const events: SyncEvent[] = [];
    const brokers: string[] = [];
    const failures: { broker: string; message: string }[] = [];

    settled.forEach((result, index) => {
      const connection = options.connections[index];
      if (!connection) return;
      if (result.status === "fulfilled") {
        const snapshot = result.value;
        events.push(...diffSnapshots(state.snapshots[snapshot.broker], snapshot));
        state.snapshots[snapshot.broker] = snapshot;
        brokers.push(snapshot.broker);
      } else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failures.push({ broker: connection.broker, message });
        events.push({ type: "broker_error", broker: connection.broker, at: now().toISOString(), message });
      }
    });

    events.push({ type: "sync_completed", at: now().toISOString(), brokers, failures });

    try {
      await saveState(options.statePath, state);
    } catch (error) {
      logError(
        `broker-sync: failed to persist state to ${options.statePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await Promise.all(
      options.sinks.map(async (sink) => {
        try {
          await sink.deliver(events);
        } catch (error) {
          logError(`broker-sync: sink delivery failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );

    return { events, brokers, failures };
  };

  // Sweeps never overlap: a tick that fires mid-sweep joins the running one.
  const sweep = (): Promise<SweepResult> => {
    inFlight ??= runSweep().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    sweep,
    start: async () => {
      if (timer) return;
      await sweep();
      timer = setInterval(() => {
        sweep().catch((error) => {
          logError(`broker-sync: sweep failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, options.intervalSeconds * 1000);
    },
    stop: async () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          // already logged by the sweep itself
        }
      }
    },
  };
};
