import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ParsedStatementFile } from "../src/statements/index.js";
import { parseStatement, STATEMENT_ADAPTERS } from "../src/statements/index.js";

/*
  The conformance gate for statement parsers, mirroring the broker one:
  every parser in the registry must ship at least one vector here and pass
  it before merge. A vector is a raw statement file (base64, so UTF-16LE
  exports survive JSON) paired with the exact fills, skip count, and
  account tag `parseStatement` must produce.
*/

const VECTORS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "conformance", "vectors", "statements");

type Vector = {
  format: string;
  description: string;
  inputBase64: string;
  expected: Pick<ParsedStatementFile, "format" | "trades" | "skippedRows"> & {
    account?: ParsedStatementFile["account"];
  };
};

const vectorFiles = readdirSync(VECTORS_DIR).filter((file) => file.endsWith(".json"));

describe("statement conformance vectors", () => {
  it("cover every registered statement parser", () => {
    const covered = new Set(
      vectorFiles.map((file) => (JSON.parse(readFileSync(join(VECTORS_DIR, file), "utf8")) as Vector).format),
    );
    for (const adapter of STATEMENT_ADAPTERS) {
      expect(covered, `statement parser "${adapter.id}" has no conformance vector`).toContain(adapter.id);
    }
  });

  for (const file of vectorFiles) {
    const vector = JSON.parse(readFileSync(join(VECTORS_DIR, file), "utf8")) as Vector;

    it(`${vector.format}: ${vector.description}`, () => {
      const bytes = new Uint8Array(Buffer.from(vector.inputBase64, "base64"));
      const result = parseStatement(bytes);
      expect(result.format).toBe(vector.expected.format);
      expect(result.trades).toEqual(vector.expected.trades);
      expect(result.skippedRows).toBe(vector.expected.skippedRows);
      expect(result.account).toEqual(vector.expected.account);
    });
  }
});
