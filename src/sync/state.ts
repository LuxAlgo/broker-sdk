/*
  Local persistence: the last snapshot per broker, as plain JSON on the
  user's own disk. This is what keeps restarts quiet — the first sweep after
  a restart diffs against the saved snapshots instead of re-emitting all
  history as events.

  Writes are atomic (write to a temp file in the same directory, then
  rename), so a crash mid-write can never leave a half-written state file
  behind. Credentials are NEVER written here: only normalized snapshots.
*/
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrokerSnapshot } from "../index.js";

export type SyncState = {
  version: 1;
  /** Last successfully fetched snapshot, keyed by broker id. */
  snapshots: Record<string, BrokerSnapshot>;
};

export const emptyState = (): SyncState => ({ version: 1, snapshots: {} });

/**
 * Load state from disk. A missing file is a fresh start (empty state); a
 * present-but-unreadable file throws, because silently discarding state
 * would replay history into the user's sinks.
 */
export const loadState = async (statePath: string): Promise<SyncState> => {
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`State file ${statePath} is not valid JSON. Delete it to start from a fresh baseline.`);
  }

  const candidate = parsed as { version?: unknown; snapshots?: unknown };
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    candidate.version !== 1 ||
    typeof candidate.snapshots !== "object" ||
    candidate.snapshots === null ||
    Array.isArray(candidate.snapshots)
  ) {
    throw new Error(`State file ${statePath} has an unrecognized shape. Delete it to start from a fresh baseline.`);
  }

  return parsed as SyncState;
};

/** Atomically persist state: temp file in the same directory, then rename. */
export const saveState = async (statePath: string, state: SyncState): Promise<void> => {
  const directory = path.dirname(statePath);
  await mkdir(directory, { recursive: true });
  const tmpPath = path.join(
    directory,
    `.${path.basename(statePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmpPath, statePath);
};
