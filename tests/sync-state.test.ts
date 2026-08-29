import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emptyState, loadState, saveState, type SyncState } from "../src/sync/state.js";
import { makeAccount, makeSnapshot, makeTmpDir } from "./sync-helpers.js";

describe("state", () => {
  it("returns an empty state when the file does not exist", async () => {
    const dir = await makeTmpDir();
    const state = await loadState(path.join(dir, "missing.json"));
    expect(state).toEqual({ version: 1, snapshots: {} });
  });

  it("round-trips snapshots through save and load", async () => {
    const dir = await makeTmpDir();
    const statePath = path.join(dir, "state.json");
    const state: SyncState = {
      version: 1,
      snapshots: {
        alpaca: makeSnapshot(),
        kraken: makeSnapshot({ broker: "kraken", accounts: [makeAccount({ id: "k-1", currency: "EUR" })] }),
      },
    };

    await saveState(statePath, state);
    const loaded = await loadState(statePath);
    expect(loaded).toEqual(state);
  });

  it("writes atomically: no temp files remain and the file is valid JSON", async () => {
    const dir = await makeTmpDir();
    const statePath = path.join(dir, "state.json");
    await saveState(statePath, emptyState());
    await saveState(statePath, { version: 1, snapshots: { alpaca: makeSnapshot() } });

    const entries = await readdir(dir);
    expect(entries).toEqual(["state.json"]);
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as SyncState;
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.snapshots)).toEqual(["alpaca"]);
  });

  it("creates missing parent directories on save", async () => {
    const dir = await makeTmpDir();
    const statePath = path.join(dir, "nested", "deeper", "state.json");
    await saveState(statePath, emptyState());
    expect(await loadState(statePath)).toEqual(emptyState());
  });

  it("throws a helpful error on corrupt JSON", async () => {
    const dir = await makeTmpDir();
    const statePath = path.join(dir, "state.json");
    await writeFile(statePath, "{ not json", "utf8");
    await expect(loadState(statePath)).rejects.toThrow(/not valid JSON/);
  });

  it("throws on an unrecognized shape (wrong version)", async () => {
    const dir = await makeTmpDir();
    const statePath = path.join(dir, "state.json");
    await writeFile(statePath, JSON.stringify({ version: 2, snapshots: {} }), "utf8");
    await expect(loadState(statePath)).rejects.toThrow(/unrecognized shape/);
  });
});
