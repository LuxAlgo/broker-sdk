import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { adapters, getAdapter, type BrokerId } from "../src/adapters/index.js";
import type { Account } from "../src/schema.js";

/*
  The conformance gate. Every adapter — including every community-
  contributed one — must ship at least one vector here and pass it before
  merge. A vector is a raw provider payload (what `fetchRaw` gathers)
  paired with the exact normalized accounts `normalize` must produce.
*/

const VECTORS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "conformance", "vectors");

type Vector = {
  broker: string;
  description: string;
  raw: unknown;
  expected: Account[];
};

const vectorFiles = readdirSync(VECTORS_DIR).filter((file) => file.endsWith(".json"));

describe("conformance vectors", () => {
  it("cover every registered adapter", () => {
    const covered = new Set(
      vectorFiles.map((file) => (JSON.parse(readFileSync(join(VECTORS_DIR, file), "utf8")) as Vector).broker),
    );
    for (const id of Object.keys(adapters)) {
      expect(covered, `adapter "${id}" has no conformance vector`).toContain(id);
    }
  });

  for (const file of vectorFiles) {
    const vector = JSON.parse(readFileSync(join(VECTORS_DIR, file), "utf8")) as Vector;

    it(`${vector.broker}: ${vector.description}`, () => {
      const adapter = getAdapter(vector.broker as BrokerId);
      expect(adapter, `vector "${file}" names unknown broker "${vector.broker}"`).toBeTruthy();
      const accounts = adapter!.normalize(vector.raw as never);
      expect(accounts).toEqual(vector.expected);
    });
  }
});
