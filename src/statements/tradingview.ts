/*
  Adapted from LuxAlgo/prop-firm-sim packages/core/src/import/adapters/tradingview.ts (MIT).

  TradingView strategy-tester "List of trades" exports, both generations:

    gen 1: Trade #,Type,Signal,Date/Time,Price,Contracts,Profit,...
    gen 2: Trade number,Type,Date and time,Signal,Price USD,Size (qty),
           Net PnL USD,... (any currency suffix)

  Two rows per trade share a trade number, the EXIT row is listed first, and
  trade totals are mirrored on BOTH rows. Each leg becomes one fill: the
  entry leg's side matches the position direction, the exit leg is the
  opposite side, so a FIFO replay reconstructs the round trips exactly. An
  open trade has an exit row whose date reads "Open" with an empty price;
  that row is dropped (it is a placeholder, not a fill) and the surviving
  entry stays as an unmatched fill. The P&L columns are dropped: broker-sdk
  computes stats from the fills themselves.

  The export carries no symbol column — a strategy test runs on one chart —
  so every fill is tagged with the disclosed placeholder symbol "UNKNOWN".
*/

import type { AdapterBuildResult, AdapterContext, AdapterMatch, StatementAdapter, StatementDoc } from "./adapter.js";
import { sortByExecutedAt } from "./adapter.js";
import { normalizedNames } from "./aliases.js";
import { cleanCell, parseNumberCell } from "./text.js";
import { buildTimestampParser, toExecutedAt } from "./timestamps.js";
import { addIssue, isEmptyCell, type StatementTrade } from "./types.js";

/** All legs of one strategy test trade the same chart symbol; the export
 *  never names it, so the tag is an explicit placeholder, never a guess. */
export const TRADINGVIEW_PLACEHOLDER_SYMBOL = "UNKNOWN";

function generationOf(names: Set<string>): 1 | 2 | null {
  const hasCore = names.has("type") && names.has("signal");
  if (!hasCore) return null;
  if (names.has("trade") && names.has("datetime")) return 1;
  if (names.has("tradenumber") && names.has("dateandtime")) return 2;
  return null;
}

function directionOf(typeValue: string): "long" | "short" | null {
  const v = typeValue.toLowerCase();
  if (v.includes("long")) return "long";
  if (v.includes("short")) return "short";
  return null;
}

export const tradingviewAdapter: StatementAdapter = {
  id: "tradingview",
  label: "TradingView strategy tester (list of trades)",

  detect(doc: StatementDoc): AdapterMatch | null {
    for (let tableIndex = 0; tableIndex < doc.tables.length; tableIndex++) {
      for (const section of doc.tables[tableIndex]!.sections) {
        const names = normalizedNames(section.plan.header);
        const generation = generationOf(names);
        if (generation === null) continue;
        if (section.plan.fields.eventType === undefined) continue; // Type must hold Entry/Exit values
        return {
          table: tableIndex,
          section,
          signals: [
            `header matches the TradingView strategy tester list of trades (generation ${generation})`,
            'the "Type" column holds Entry/Exit values',
          ],
        };
      }
    }
    return null;
  },

  build(doc: StatementDoc, match: AdapterMatch, ctx: AdapterContext): AdapterBuildResult {
    const table = doc.tables[match.table]!;
    const section = match.section;
    const fields = section.plan.fields;
    const rows = table.rows.slice(section.start, section.end);
    const rowNumbers = table.rowNumbers.slice(section.start, section.end);

    const timeIndex = fields.entryTime;
    const parser = buildTimestampParser(
      timeIndex === undefined ? [] : rows.map((row) => row[timeIndex] ?? ""),
      ctx.dateOrder,
      ctx.issues,
    );

    const trades: StatementTrade[] = [];
    let skippedRows = 0;
    let openExitRows = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const sourceRow = rowNumbers[i] ?? section.start + i + 1;
      if (row.every((cell) => cell.trim() === "")) continue;

      const cell = (index: number | undefined): string => (index === undefined ? "" : (row[index] ?? ""));
      const typeRaw = cleanCell(cell(fields.eventType));
      const typeLower = typeRaw.toLowerCase();
      const eventType = typeLower.startsWith("entry") ? "entry" : typeLower.startsWith("exit") ? "exit" : null;
      if (eventType === null) {
        addIssue(ctx.issues, "warning", "row-unrecognized-type", `Row skipped: "${typeRaw}" is neither an entry nor an exit.`, {
          row: sourceRow,
        });
        skippedRows++;
        continue;
      }

      const timeRaw = cell(timeIndex);
      if (eventType === "exit" && cleanCell(timeRaw).toLowerCase() === "open") {
        openExitRows++; // the placeholder exit row of a still-open trade — not a fill
        continue;
      }
      const time = parser.parse(timeRaw);
      const direction = directionOf(typeRaw);
      const price = isEmptyCell(cell(fields.entryPrice)) ? null : parseNumberCell(cell(fields.entryPrice));
      const quantity = parseNumberCell(cell(fields.quantity));
      if (!Number.isFinite(time) || direction === null || price === null || price <= 0 || quantity === null || quantity <= 0) {
        addIssue(
          ctx.issues,
          "warning",
          "row-bad-values",
          "Row skipped: unreadable date/time, direction, price, or quantity.",
          { row: sourceRow },
        );
        skippedRows++;
        continue;
      }

      // The entry leg trades WITH the position direction; the exit leg
      // trades against it (the exit of a short is a buy).
      const side: StatementTrade["side"] =
        eventType === "entry" ? (direction === "long" ? "buy" : "sell") : direction === "long" ? "sell" : "buy";

      trades.push({
        symbol: TRADINGVIEW_PLACEHOLDER_SYMBOL,
        side,
        quantity,
        price,
        executedAt: toExecutedAt(time),
      });
    }

    if (trades.length > 0) {
      addIssue(
        ctx.issues,
        "info",
        "symbol-missing",
        `TradingView trade lists carry no symbol column, so every fill is tagged "${TRADINGVIEW_PLACEHOLDER_SYMBOL}". ` +
          "All rows belong to the one chart symbol the strategy ran on.",
      );
    }
    if (openExitRows > 0) {
      addIssue(
        ctx.issues,
        "info",
        "open-trades-in-source",
        `${openExitRows} trade(s) are still open in the export (exit date "Open"); their placeholder exit rows ` +
          "were dropped and the entry fills remain unmatched.",
      );
    }

    return { trades: sortByExecutedAt(trades), skippedRows };
  },
};
