/*
  Adapted from LuxAlgo/prop-firm-sim packages/core/src/import/adapters/mt5-deals.ts (MIT).

  MetaTrader 5 "Deals" tables: the only trade data in MT5 strategy-tester
  reports, also present in history reports.

    Time, Deal, Symbol, Type, Direction, Volume, Price, Order, [Cost,]
    Commission, [Fee,] Swap, Profit, Balance, Comment

  Deals are already fill-level, so the mapping is near-direct — but the
  semantics a generic reading gets wrong are still encoded:
  - "Type" (buy/sell) is the FILL side; an "out" deal that sells closes a
    LONG. The fill side is emitted as-is, and the in/out labels are
    cross-checked against a replayed net position so a table that is not
    what it claims gets flagged instead of silently misread.
  - Profit sits on "out" deals GROSS and is dropped (broker-sdk computes
    stats from the fills); commissions sit on both legs and swap on the
    closing leg — they sum into each fill's fee as a positive cost.
  - Balance/credit deals are ledger rows, skipped and counted. Volumes may
    render "0.06 / 0.06" (filled / ordered): the first number is the fill.
*/

import type { AdapterBuildResult, AdapterContext, AdapterMatch, StatementAdapter, StatementDoc } from "./adapter.js";
import { sortByExecutedAt } from "./adapter.js";
import { normalizedNames, type TableSection } from "./aliases.js";
import { cleanCell, neutralizeText, parseNumberCell, parseVolumeCell } from "./text.js";
import { buildTimestampParser, toExecutedAt } from "./timestamps.js";
import { addIssue, type StatementTrade } from "./types.js";

function sectionMatches(section: TableSection): boolean {
  const names = normalizedNames(section.plan.header);
  const fields = section.plan.fields;
  return (
    names.has("deal") &&
    names.has("direction") &&
    names.has("profit") &&
    names.has("time") &&
    fields.direction !== undefined && // Type resolved to buy/sell by values
    fields.eventType !== undefined && // Direction resolved to in/out by values
    fields.quantity !== undefined
  );
}

export const mt5DealsAdapter: StatementAdapter = {
  id: "mt5-deals",
  label: "MetaTrader 5 deals table",

  detect(doc: StatementDoc): AdapterMatch | null {
    for (let tableIndex = 0; tableIndex < doc.tables.length; tableIndex++) {
      for (const section of doc.tables[tableIndex]!.sections) {
        if (!sectionMatches(section)) continue;
        return {
          table: tableIndex,
          section,
          signals: [
            "deals columns matched (Time, Deal, Type, Direction, Volume, Price, Profit)",
            "in/out values found in the Direction column",
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

    const parser = buildTimestampParser(
      rows.map((row) => (fields.entryTime === undefined ? "" : (row[fields.entryTime] ?? ""))),
      ctx.dateOrder,
      ctx.issues,
    );

    const trades: StatementTrade[] = [];
    let skippedRows = 0;
    let ledgerRows = 0;
    let labelMismatches = 0;
    const positions = new Map<string, number>();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const sourceRow = rowNumbers[i] ?? section.start + i + 1;
      if (row.every((cell) => cell.trim() === "")) continue;

      const cell = (index: number | undefined): string => (index === undefined ? "" : (row[index] ?? ""));
      const type = cleanCell(cell(fields.direction)).toLowerCase();
      if (type !== "buy" && type !== "sell") {
        ledgerRows++; // balance / credit / initial deposit deals
        skippedRows++;
        continue;
      }
      const label = cleanCell(cell(fields.eventType))
        .toLowerCase()
        .replace(/[^a-z]/g, "");
      const time = parser.parse(cell(fields.entryTime));
      const price = parseNumberCell(cell(fields.entryPrice));
      const volume = parseVolumeCell(cell(fields.quantity));
      const symbol = neutralizeText(cell(fields.symbol)).toUpperCase();
      if (!Number.isFinite(time) || price === null || price <= 0 || volume === null || volume <= 0 || symbol === "") {
        addIssue(ctx.issues, "warning", "row-bad-values", "Deal skipped: unreadable time, price, volume, or symbol.", {
          row: sourceRow,
        });
        skippedRows++;
        continue;
      }
      const signedQuantity = type === "buy" ? volume : -volume;

      // Cross-check the in/out label against the replayed net position:
      // a mismatch means the table is not what this parser thinks it is.
      const before = positions.get(symbol) ?? 0;
      const after = before + signedQuantity;
      positions.set(symbol, Math.abs(after) < 1e-12 ? 0 : after);
      const crosses = before !== 0 && Math.sign(after) !== Math.sign(before) && after !== 0;
      const reduces = Math.abs(after) < Math.abs(before) || after === 0;
      const labelOk =
        label === "" ||
        (label === "in" && !reduces && !crosses) ||
        (label === "out" && reduces && !crosses) ||
        (label === "inout" && crosses);
      if (!labelOk) labelMismatches++;

      // The file signs costs negative; a fill's fee is a positive cost.
      let costs = 0;
      for (const feeIndex of section.plan.feeColumns) {
        const value = parseNumberCell(row[feeIndex] ?? "");
        if (value !== null) costs += value;
      }
      const swap = fields.swap !== undefined ? parseNumberCell(cell(fields.swap)) : null;
      if (swap !== null) costs += swap;
      const fee = -costs;

      trades.push({
        symbol,
        side: type,
        quantity: volume,
        price,
        ...(fee !== 0 ? { fee } : {}),
        executedAt: toExecutedAt(time),
      });
    }

    if (ledgerRows > 0) {
      addIssue(ctx.issues, "info", "ledger-rows-skipped", `${ledgerRows} balance/credit deal row(s) were skipped.`);
    }
    if (labelMismatches > 0) {
      addIssue(
        ctx.issues,
        "warning",
        "deal-direction-mismatch",
        `${labelMismatches} deal(s) carry an in/out label that contradicts the replayed net position. ` +
          "The fills were kept as stated; check whether this account really runs MT5 netting.",
      );
    }

    return { trades: sortByExecutedAt(trades), skippedRows };
  },
};
