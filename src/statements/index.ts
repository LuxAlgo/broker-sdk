import { createHash } from "node:crypto";

import { parseStatementCsv } from "../csv.js";
import type { AdapterBuildResult, StatementAdapter, StatementDoc } from "./adapter.js";
import { findTableSections } from "./aliases.js";
import { extractHtmlTables } from "./html.js";
import { metatraderAdapter } from "./metatrader.js";
import { mt5DealsAdapter } from "./mt5-deals.js";
import { decodeStatementBytes, repairEncoding, sniffDelimiter, tokenizeDelimited } from "./text.js";
import { thinkorswimAdapter } from "./thinkorswim.js";
import { tradingviewAdapter } from "./tradingview.js";
import {
  addIssue,
  DEFAULT_MAX_ROWS,
  type ParsedStatementFile,
  type ParseStatementOptions,
  type StatementIssue,
} from "./types.js";

/*
  Statement import — real-world broker exports, not just clean CSVs.
  `parseStatement` fingerprints the file against the format registry below
  and emits the SDK's own `Trade` fills, with `parseStatementCsv` as the
  generic fallback for well-headed CSVs. Detection is a hard fingerprint per
  format (header names plus sample values), never a fuzzy score; registry
  order breaks ties. Zero network, zero telemetry; never throws — every
  outcome is a `ParsedStatementFile` with typed issues.

  ThinkOrSwim leads because its fingerprint is document-level (the account
  banner). The MetaTrader statement parser runs BEFORE the deals parser on
  purpose: an MT5 history report carries both a Positions and a Deals
  section, and Positions must win (each row carries both legs of the round
  trip); a tester report has no Positions section, so it still lands on
  Deals.
*/

export const STATEMENT_ADAPTERS: readonly StatementAdapter[] = [
  thinkorswimAdapter,
  tradingviewAdapter,
  metatraderAdapter,
  mt5DealsAdapter,
];

/** Statement format ids and labels, for help text and refusals. */
export function listStatementFormats(): Array<{ id: string; label: string }> {
  return [
    ...STATEMENT_ADAPTERS.map((adapter) => ({ id: adapter.id, label: adapter.label })),
    { id: "generic-csv", label: "generic trade-history CSV (column names matched by alias)" },
  ];
}

/**
 * Parse a statement file into `Trade` fills. Accepts the raw bytes (decoded
 * by BOM: MetaTrader saves reports as UTF-16LE) or already-decoded text.
 * Never throws; unreadable rows are skipped and counted, never guessed at.
 */
export function parseStatement(input: string | Uint8Array, options: ParseStatementOptions = {}): ParsedStatementFile {
  const issues: StatementIssue[] = [];
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else {
    const decoded = decodeStatementBytes(input);
    text = decoded.text;
    if (decoded.encoding !== "utf-8") {
      addIssue(
        issues,
        "info",
        "decoded-by-bom",
        `The file bytes carry a ${decoded.encoding.toUpperCase()} byte-order mark and were decoded accordingly ` +
          "(MetaTrader saves every report as UTF-16LE).",
      );
    }
  }
  return parseStatementText(text, options, issues);
}

function parseStatementText(
  rawText: string,
  options: ParseStatementOptions,
  issues: StatementIssue[],
): ParsedStatementFile {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const text = repairEncoding(rawText, issues);
  const contentHash = createHash("sha256").update(text).digest("hex").slice(0, 16);

  const unrecognized = (message: string): ParsedStatementFile => {
    addIssue(issues, "error", "no-recognized-format", message);
    return {
      format: "unrecognized",
      formatLabel: "unrecognized input",
      signals: [],
      trades: [],
      skippedRows: 0,
      contentHash,
      issues,
    };
  };

  if (text.trim() === "") return unrecognized("The input is empty.");

  // Parse into a document: one table for CSV, one or more for HTML.
  let doc: StatementDoc;
  const head = text.slice(0, 4096);
  if (/^\s*</.test(text) && /<\s*(!doctype|html|head|body|table|meta|div|title)/i.test(head)) {
    const tables = extractHtmlTables(text, issues, { maxRows });
    if (tables.length === 0) {
      return unrecognized("The HTML contains no readable table.");
    }
    doc = {
      kind: "html",
      tables: tables.map((table) => ({
        rows: table.rows,
        rowNumbers: table.rowNumbers,
        sections: findTableSections(table.rows),
      })),
    };
  } else {
    const delimiter = sniffDelimiter(text);
    const tokenized = tokenizeDelimited(text, delimiter, issues);
    let rows = tokenized.rows;
    let rowLines = tokenized.rowLines;
    if (rows.length > maxRows) {
      rows = rows.slice(0, maxRows);
      rowLines = rowLines.slice(0, maxRows);
      addIssue(
        issues,
        "warning",
        "input-truncated",
        `The file exceeds the ${maxRows} row cap and was truncated; rows past the cap were ignored.`,
      );
    }
    doc = { kind: "csv", tables: [{ rows, rowNumbers: rowLines, sections: findTableSections(rows) }] };
  }

  const ctx = { issues, dateOrder: options.dateOrder };

  for (const adapter of STATEMENT_ADAPTERS) {
    const match = adapter.detect(doc);
    if (match === null) continue;
    let build: AdapterBuildResult;
    try {
      build = adapter.build(doc, match, ctx);
    } catch (err) {
      addIssue(
        issues,
        "error",
        "internal-error",
        `The ${adapter.label} parser hit an unexpected condition and stopped: ` +
          `${err instanceof Error ? err.message : String(err)}. No trades were produced. Please report this file shape.`,
      );
      build = { trades: [], skippedRows: 0 };
    }
    if (build.trades.length > 0) {
      addIssue(
        issues,
        "info",
        "times-read-as-utc",
        "Timestamps without an explicit offset were read as UTC. If the file is in another timezone, " +
          "every executedAt shifts by that offset.",
      );
    } else if (!issues.some((issue) => issue.severity === "error")) {
      addIssue(
        issues,
        "error",
        "no-trades-found",
        `The format was recognized (${adapter.label}) but no fills could be built from the rows.`,
      );
    }
    return {
      format: adapter.id as ParsedStatementFile["format"],
      formatLabel: adapter.label,
      signals: match.signals,
      trades: build.trades,
      skippedRows: build.skippedRows,
      contentHash,
      issues,
      ...(build.account !== undefined ? { account: build.account } : {}),
    };
  }

  // No signature matched: the tolerant column-alias CSV parser is the
  // universal fallback, exactly as before.
  if (doc.kind === "csv") {
    const generic = parseStatementCsv(text);
    if (generic.trades.length > 0) {
      return {
        format: "generic-csv",
        formatLabel: "generic trade-history CSV (column names matched by alias)",
        signals: ["no known statement format matched; column names resolved through the generic alias table"],
        trades: generic.trades,
        skippedRows: generic.skippedRows,
        contentHash,
        issues,
      };
    }
  }

  return unrecognized(
    "No known statement format matched and the generic CSV parser found no usable rows. " +
      `Recognized formats: ${listStatementFormats()
        .map((format) => format.label)
        .join("; ")}.`,
  );
}

export { decodeStatementBytes } from "./text.js";
export { metatraderAdapter } from "./metatrader.js";
export { mt5DealsAdapter } from "./mt5-deals.js";
export { thinkorswimAdapter } from "./thinkorswim.js";
export { tradingviewAdapter, TRADINGVIEW_PLACEHOLDER_SYMBOL } from "./tradingview.js";
export { parseStatementCsv, type ParsedStatement } from "../csv.js";
export type { StatementAdapter, StatementDoc, AdapterMatch, AdapterBuildResult, AdapterContext } from "./adapter.js";
export type {
  ParsedStatementFile,
  ParseStatementOptions,
  StatementDateOrder,
  StatementFormatId,
  StatementIssue,
  StatementIssueSeverity,
  StatementTrade,
} from "./types.js";
