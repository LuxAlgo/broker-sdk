/*
  The statement-adapter contract, mirroring the adapter registry in
  LuxAlgo/prop-firm-sim packages/core/src/import/adapters/types.ts (MIT).
  An adapter owns one export format: detect() is a HARD fingerprint (header
  names plus sample values) that returns detection evidence or null, never
  a fuzzy score; build() converts the claimed section into `Trade` fills.
  Registry order breaks ties.
*/

import type { TableSection } from "./aliases.js";
import type { StatementDateOrder, StatementIssue, StatementTrade } from "./types.js";

/** A parsed document: one table for CSV, one or more for HTML. */
export type DocTable = {
  rows: string[][];
  /** 1-based source line (CSV) or <tr> ordinal (HTML) per row. */
  rowNumbers: number[];
  /** Candidate header sections, whole table scanned (computed once). */
  sections: TableSection[];
};

export type StatementDoc = {
  kind: "csv" | "html";
  tables: DocTable[];
};

export type AdapterMatch = {
  /** Human-readable detection evidence for the result's `signals`. */
  signals: string[];
  /** Which table and section the adapter claimed. */
  table: number;
  section: TableSection;
};

export type AdapterContext = {
  issues: StatementIssue[];
  dateOrder: StatementDateOrder | undefined;
};

export type AdapterBuildResult = {
  trades: StatementTrade[];
  skippedRows: number;
  /** Account metadata the statement itself disclosed; never guessed. */
  account?: { id?: string; currency?: string };
};

export type StatementAdapter = {
  id: string;
  label: string;
  detect(doc: StatementDoc): AdapterMatch | null;
  build(doc: StatementDoc, match: AdapterMatch, ctx: AdapterContext): AdapterBuildResult;
};

/** Fills sorted by execution time (stable), so consumers replaying FIFO see
 *  them in order even when the file lists exits first (TradingView). */
export function sortByExecutedAt(trades: StatementTrade[]): StatementTrade[] {
  return trades
    .map((trade, index) => ({ trade, index }))
    .sort((a, b) => {
      const cmp = (a.trade.executedAt ?? "").localeCompare(b.trade.executedAt ?? "");
      return cmp !== 0 ? cmp : a.index - b.index;
    })
    .map((entry) => entry.trade);
}
