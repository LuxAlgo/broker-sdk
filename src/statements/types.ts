import type { Trade } from "../schema.js";

/*
  The statement-import contract. Real-world exports (MetaTrader HTML,
  MT5 deals tables, ThinkOrSwim account statements, TradingView trade
  lists) parse into the SDK's own `Trade` fills plus loud, structured
  diagnostics. Three rules govern every parser in this directory:

  1. Skip bad rows loudly with counts; never guess an ambiguous column.
  2. Disclose every derived value as an issue.
  3. Refuse rather than produce a plausible-looking wrong trade.

  Zero network, zero telemetry: pure string work plus node:crypto for the
  content hash.
*/

/** Severity of one statement diagnostic. Errors mean the file (or a whole
 *  section) was refused; warnings disclose skips and assumptions; info notes
 *  context that changes nothing. `parseStatement` never throws. */
export type StatementIssueSeverity = "error" | "warning" | "info";

/** One structured diagnostic. `code` is a stable machine code (kebab-case)
 *  callers can branch on; `message` is the human explanation. */
export type StatementIssue = {
  severity: StatementIssueSeverity;
  code: string;
  message: string;
  /** 1-based source line (CSV) or table row (HTML) the issue points at. */
  row?: number;
};

/**
 * A fill parsed from a statement: the SDK `Trade` shape, additively tagged
 * with the account the statement disclosed. The tag exists so histories from
 * different accounts are never silently merged — consumers (including
 * prop-firm-sim's importer) refuse arrays carrying distinct tags.
 */
export type StatementTrade = Trade & {
  /** Account identifier the statement itself disclosed. Never guessed. */
  accountId?: string;
};

/** Ids of the bundled statement parsers, plus the two fallthrough labels. */
export type StatementFormatId =
  | "thinkorswim"
  | "tradingview"
  | "metatrader"
  | "mt5-deals"
  | "generic-csv"
  | "unrecognized";

/** What `parseStatement` returns. Field names match `parseStatementCsv`
 *  (`trades`, `skippedRows`, `contentHash`) so callers can treat both alike. */
export type ParsedStatementFile = {
  /** Which parser claimed the file. */
  format: StatementFormatId;
  /** Human-readable format name. */
  formatLabel: string;
  /** Human-readable detection evidence ("header matches ...", ...). */
  signals: string[];
  trades: StatementTrade[];
  /** Rows that looked like data but could not become fills. Counted, never guessed at. */
  skippedRows: number;
  /** Content hash — a stable account id, so re-imports upsert instead of duplicating. */
  contentHash: string;
  issues: StatementIssue[];
  /** Account metadata the statement itself disclosed; absent when it carries none. */
  account?: { id?: string; currency?: string };
};

export type StatementDateOrder = "MDY" | "DMY";

export type ParseStatementOptions = {
  /** Override the per-file slash-date order decision (03/04/2026: month-first
   *  or day-first). Without it the order is proven from the file's own values
   *  where possible, else month-first is assumed with a warning. */
  dateOrder?: StatementDateOrder;
  /** Hard row cap; larger inputs are truncated with a disclosed warning. */
  maxRows?: number;
};

/** Input size default: past this the input is truncated, loudly. */
export const DEFAULT_MAX_ROWS = 200_000;

/** Placeholder cells that mean "no value" in real exports. The dash family
 *  is hyphen, em dash, and en dash. */
const EMPTY_CELL_TOKENS = new Set(["", "-", "—", "–", "n/a", "na", "null", "none", "nan"]);

/** True when a cell is empty or a known no-value placeholder. */
export function isEmptyCell(raw: string): boolean {
  return EMPTY_CELL_TOKENS.has(raw.trim().toLowerCase());
}

/** Issue-list helper: push structured diagnostics in one line. */
export function addIssue(
  issues: StatementIssue[],
  severity: StatementIssueSeverity,
  code: string,
  message: string,
  at?: { row?: number },
): void {
  issues.push({
    severity,
    code,
    message,
    ...(at?.row !== undefined ? { row: at.row } : {}),
  });
}
