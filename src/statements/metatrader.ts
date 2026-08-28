/*
  Adapted from LuxAlgo/prop-firm-sim packages/core/src/import/adapters/metatrader.ts (MIT).

  MetaTrader statement rows: MT4 account statements (CSV or the HTML report,
  which is MetaTrader's only export button) and MT5 history reports'
  Positions section. One row per closed trade with a Ticket/Position id,
  duplicated Time/Price pairs, S/L, and signed Commission / Taxes / Swap
  columns. Each closed row becomes TWO fills: the entry leg on the trade's
  own side, the exit leg on the opposite side. The Profit and S/L values are
  dropped (broker-sdk computes stats from the fills; risk semantics stay on
  the simulation side); the summed costs (commission + taxes + swap) attach
  to the closing fill as its fee.

  Pending orders (buy limit, sell stop, ...) and balance/credit ledger rows
  are skipped and counted. An "Open Trades" section contributes only entry
  fills — its close-leg cells hold the CURRENT price and floating P&L, not
  an execution. "Working Orders" sections are never read.
*/

import type { AdapterBuildResult, AdapterContext, AdapterMatch, StatementAdapter, StatementDoc } from "./adapter.js";
import { sortByExecutedAt } from "./adapter.js";
import { normalizedNames, type TableSection } from "./aliases.js";
import { cleanCell, neutralizeText, parseNumberCell, parseVolumeCell } from "./text.js";
import { buildTimestampParser, toExecutedAt, type BoundTimestampParser } from "./timestamps.js";
import { addIssue, type StatementTrade } from "./types.js";

function sectionMatches(section: TableSection): boolean {
  const fields = section.plan.fields;
  return (
    fields.tradeId !== undefined &&
    fields.stopPrice !== undefined &&
    fields.pnl !== undefined &&
    fields.entryPrice !== undefined &&
    fields.exitPrice !== undefined &&
    fields.entryTime !== undefined &&
    fields.direction !== undefined
  );
}

/** A title row like "Open Trades:" within the few rows above a header. */
function titledOpenSection(rows: readonly string[][], headerIndex: number): boolean {
  for (let back = 1; back <= 3; back++) {
    const row = rows[headerIndex - back];
    if (row === undefined) break;
    const cells = row.filter((cell) => cell.trim() !== "");
    if (cells.length === 0) continue;
    if (cells.length <= 2 && /open/i.test(cells[0]!)) return true;
  }
  return false;
}

type RowKind = "trade" | "pending" | "ledger" | "unknown";

function classifyType(raw: string): RowKind {
  const v = cleanCell(raw).toLowerCase();
  if (/^(buy|sell)$/.test(v)) return "trade";
  if (/^(buy|sell)\s+(limit|stop|stop\s*limit)$/.test(v)) return "pending";
  if (/^(balance|credit|deposit|withdrawal|rebate|correction)/.test(v)) return "ledger";
  return "unknown";
}

/** Statement preambles disclose the account ("Account: 12345 ... Currency:
 *  USD"). Read, never guessed: no match, no tag. */
function scanAccountMetadata(rows: readonly string[][], beforeRow: number): { id?: string; currency?: string } {
  let id: string | undefined;
  let currency: string | undefined;
  for (let index = 0; index < beforeRow; index++) {
    const text = rows[index]!.join(" ");
    if (id === undefined) {
      const m = /\baccount\s*[:#]\s*([A-Za-z0-9][A-Za-z0-9-]*)/i.exec(text);
      if (m !== null) id = neutralizeText(m[1]!);
    }
    if (currency === undefined) {
      const m = /\b[Cc]urrency\s*:?\s*([A-Z]{3})\b/.exec(text);
      if (m !== null) currency = m[1]!;
    }
  }
  return { ...(id !== undefined ? { id } : {}), ...(currency !== undefined ? { currency } : {}) };
}

export const metatraderAdapter: StatementAdapter = {
  id: "metatrader",
  label: "MetaTrader 4/5 account statement",

  detect(doc: StatementDoc): AdapterMatch | null {
    for (let tableIndex = 0; tableIndex < doc.tables.length; tableIndex++) {
      for (const section of doc.tables[tableIndex]!.sections) {
        if (!sectionMatches(section)) continue;
        if (titledOpenSection(doc.tables[tableIndex]!.rows, section.headerIndex)) continue; // never claim Open Trades first
        const names = normalizedNames(section.plan.header);
        const idName = names.has("ticket") ? "Ticket" : names.has("position") ? "Position" : "id";
        return {
          table: tableIndex,
          section,
          signals: [
            `statement columns matched (${idName}, duplicated Time/Price, S/L, Profit)`,
            "buy/sell values found in the Type column",
          ],
        };
      }
    }
    return null;
  },

  build(doc: StatementDoc, match: AdapterMatch, ctx: AdapterContext): AdapterBuildResult {
    const table = doc.tables[match.table]!;
    const account = scanAccountMetadata(table.rows, match.section.headerIndex);
    const accountId = account.id;

    const closed = buildSectionFills(table, match.section, ctx, "closed", accountId);
    const trades = [...closed.trades];
    let skippedRows = closed.skippedRows;

    // A subsequent matching section titled "Open Trades" contributes entry
    // fills only; its exit-leg cells are a mark, not an execution.
    for (const section of table.sections) {
      if (section === match.section || !sectionMatches(section)) continue;
      if (!titledOpenSection(table.rows, section.headerIndex)) continue;
      const open = buildSectionFills(table, section, ctx, "open", accountId);
      if (open.trades.length > 0) {
        addIssue(
          ctx.issues,
          "info",
          "open-trades-in-source",
          `${open.trades.length} position(s) in the Open Trades section contributed entry fills only; ` +
            "they have not closed, so no exit fills exist.",
        );
      }
      trades.push(...open.trades);
      skippedRows += open.skippedRows;
      break;
    }

    return {
      trades: sortByExecutedAt(trades),
      skippedRows,
      ...(account.id !== undefined || account.currency !== undefined ? { account } : {}),
    };
  },
};

function buildSectionFills(
  table: { rows: string[][]; rowNumbers: number[] },
  section: TableSection,
  ctx: AdapterContext,
  status: "closed" | "open",
  accountId: string | undefined,
): { trades: StatementTrade[]; skippedRows: number } {
  const fields = section.plan.fields;
  const rows = table.rows.slice(section.start, section.end);
  const rowNumbers = table.rowNumbers.slice(section.start, section.end);

  const timeSamples: string[] = [];
  for (const row of rows) {
    if (fields.entryTime !== undefined) timeSamples.push(row[fields.entryTime] ?? "");
    if (fields.exitTime !== undefined) timeSamples.push(row[fields.exitTime] ?? "");
  }
  const parser: BoundTimestampParser = buildTimestampParser(timeSamples, ctx.dateOrder, ctx.issues);

  const trades: StatementTrade[] = [];
  let skippedRows = 0;
  let pendingRows = 0;
  let ledgerRows = 0;
  let feesAttached = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const sourceRow = rowNumbers[i] ?? section.start + i + 1;
    if (row.every((cell) => cell.trim() === "")) continue;

    const cell = (index: number | undefined): string => (index === undefined ? "" : (row[index] ?? ""));
    const kind = classifyType(cell(fields.direction));
    if (kind === "pending") {
      pendingRows++;
      skippedRows++;
      continue;
    }
    if (kind === "ledger") {
      ledgerRows++;
      skippedRows++;
      continue;
    }
    if (kind === "unknown") {
      addIssue(
        ctx.issues,
        "warning",
        "row-unrecognized-type",
        `Row skipped: unrecognized order type "${cleanCell(cell(fields.direction))}".`,
        { row: sourceRow },
      );
      skippedRows++;
      continue;
    }

    const entrySide: StatementTrade["side"] = cleanCell(cell(fields.direction)).toLowerCase() === "buy" ? "buy" : "sell";
    const entryTime = parser.parse(cell(fields.entryTime));
    const entryPrice = parseNumberCell(cell(fields.entryPrice));
    const quantity = parseVolumeCell(cell(fields.quantity));
    if (!Number.isFinite(entryTime) || entryPrice === null || entryPrice <= 0 || quantity === null || quantity <= 0) {
      addIssue(ctx.issues, "warning", "row-bad-values", "Row skipped: unreadable open time, price, or volume.", {
        row: sourceRow,
      });
      skippedRows++;
      continue;
    }

    const symbol = neutralizeText(cell(fields.symbol)).toUpperCase();
    if (symbol === "") {
      addIssue(ctx.issues, "warning", "row-bad-values", "Row skipped: no symbol.", { row: sourceRow });
      skippedRows++;
      continue;
    }

    // Commission / Taxes / Swap are signed by the file (costs negative).
    let adjustment = 0;
    for (const feeIndex of section.plan.feeColumns) {
      const value = parseNumberCell(row[feeIndex] ?? "");
      if (value !== null) adjustment += value;
    }
    const swap = fields.swap !== undefined ? parseNumberCell(cell(fields.swap)) : null;
    if (swap !== null) adjustment += swap;
    const cost = -adjustment; // positive cost; negative would be a rebate

    const tag = accountId !== undefined ? { accountId } : {};

    if (status === "open") {
      // Costs on an open row are still accruing, so they ride the entry fill.
      trades.push({
        symbol,
        side: entrySide,
        quantity,
        price: entryPrice,
        ...(cost !== 0 ? { fee: cost } : {}),
        executedAt: toExecutedAt(entryTime),
        ...tag,
      });
      continue;
    }

    const exitTime = parser.parse(cell(fields.exitTime));
    const exitPrice = parseNumberCell(cell(fields.exitPrice));
    if (!Number.isFinite(exitTime) || exitPrice === null || exitPrice <= 0) {
      addIssue(
        ctx.issues,
        "warning",
        "row-bad-values",
        "Row skipped: a closed trade without a readable close time and price.",
        { row: sourceRow },
      );
      skippedRows++;
      continue;
    }

    trades.push({ symbol, side: entrySide, quantity, price: entryPrice, executedAt: toExecutedAt(entryTime), ...tag });
    trades.push({
      symbol,
      side: entrySide === "buy" ? "sell" : "buy",
      quantity,
      price: exitPrice,
      ...(cost !== 0 ? { fee: cost } : {}),
      executedAt: toExecutedAt(exitTime),
      ...tag,
    });
    if (cost !== 0) feesAttached++;
  }

  if (feesAttached > 0) {
    addIssue(
      ctx.issues,
      "info",
      "fees-on-closing-fill",
      `The statement reports one combined commission/taxes/swap figure per trade; it was attached to the ` +
        `closing fill of each of the ${feesAttached} trade(s) carrying one.`,
    );
  }
  if (pendingRows > 0) {
    addIssue(
      ctx.issues,
      "info",
      "pending-orders-skipped",
      `${pendingRows} pending order row(s) (buy/sell limit or stop) were skipped: they are not trades.`,
    );
  }
  if (ledgerRows > 0) {
    addIssue(ctx.issues, "info", "ledger-rows-skipped", `${ledgerRows} balance/credit ledger row(s) were skipped.`);
  }

  return { trades, skippedRows };
}
