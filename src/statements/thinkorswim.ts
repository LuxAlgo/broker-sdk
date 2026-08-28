/*
  Adapted from LuxAlgo/prop-firm-sim packages/core/src/import/adapters/thinkorswim.ts (MIT).

  ThinkOrSwim / Schwab "Account Statement" exports: one CSV with titled
  sections (Cash Balance, Futures Statements, Account Order History, Account
  Trade History, Equities, Profits and Losses, ...).

  The trustworthy trade data:
  - "Account Trade History": one row per FILL (Exec Time, Side, signed Qty,
    Pos Effect, Symbol, Price) for stock legs — a near-direct mapping to
    `Trade` fills.
  - "Cash Balance": TRD rows carry the fees (Misc Fees, Commissions & Fees)
    and a description ("SOLD -500 TZA @3.81") matched back to fills by
    timestamp and symbol. When the Trade History section is missing, the
    TRD descriptions themselves rebuild the fills.

  Order History is never read for trades: it holds working, cancelled, and
  rejected orders. Non-stock legs (options, futures, forex) are refused
  loudly: their contract multipliers are not in the file, and a wrong
  number is worse than none.
*/

import type { AdapterBuildResult, AdapterContext, AdapterMatch, StatementAdapter, StatementDoc } from "./adapter.js";
import { sortByExecutedAt } from "./adapter.js";
import { buildHeaderPlan, normalizeHeader, type HeaderPlan } from "./aliases.js";
import { cleanCell, neutralizeText, parseNumberCell } from "./text.js";
import { buildTimestampParser, mergeDateTimeCells, toExecutedAt, type BoundTimestampParser } from "./timestamps.js";
import { addIssue, type StatementTrade } from "./types.js";

type TitledSection = {
  titleRow: number;
  headerIndex: number;
  plan: HeaderPlan;
  start: number;
  end: number;
};

function firstNonEmpty(row: readonly string[]): string {
  for (const cell of row) {
    const trimmed = cell.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

function findTitledSection(rows: readonly string[][], title: string): TitledSection | null {
  const wanted = title.toLowerCase();
  for (let index = 0; index < rows.length; index++) {
    if (firstNonEmpty(rows[index]!).toLowerCase() !== wanted) continue;
    let headerIndex = index + 1;
    while (headerIndex < rows.length && rows[headerIndex]!.every((cell) => cell.trim() === "")) headerIndex++;
    if (headerIndex >= rows.length) return null;
    const header = rows[headerIndex]!;
    if (header.filter((cell) => cell.trim() !== "").length < 3) return null;
    let end = headerIndex + 1;
    while (end < rows.length) {
      const row = rows[end]!;
      const nonEmpty = row.filter((cell) => cell.trim() !== "").length;
      if (nonEmpty === 0) break;
      if (nonEmpty === 1) break; // the next section title (or a lone total line)
      end++;
    }
    const plan = buildHeaderPlan(header, rows.slice(headerIndex + 1, end));
    return { titleRow: index, headerIndex, plan, start: headerIndex + 1, end };
  }
  return null;
}

const DESCRIPTION_FILL = /^(BOT|SOLD)\s+([+-]?[\d,]+(?:\.\d+)?)\s+(\S+)\s+@([\d.,]+)/i;
const ACCOUNT_BANNER = /^account statement for\s+(\S+)/i;

function scanAccount(rows: readonly string[][]): string | undefined {
  for (const row of rows) {
    const m = ACCOUNT_BANNER.exec(firstNonEmpty(row));
    if (m !== null) {
      const id = neutralizeText(m[1]!);
      return id === "" ? undefined : id;
    }
  }
  return undefined;
}

export const thinkorswimAdapter: StatementAdapter = {
  id: "thinkorswim",
  label: "ThinkOrSwim account statement",

  detect(doc: StatementDoc): AdapterMatch | null {
    for (let tableIndex = 0; tableIndex < doc.tables.length; tableIndex++) {
      const rows = doc.tables[tableIndex]!.rows;
      const hasBanner = rows.some((row) => ACCOUNT_BANNER.test(firstNonEmpty(row)));
      if (!hasBanner) continue;
      const tradeHistory = findTitledSection(rows, "Account Trade History");
      const cashBalance = findTitledSection(rows, "Cash Balance");
      const chosen = tradeHistory ?? cashBalance;
      if (chosen === null) continue;
      const signals = ['the "Account Statement for ..." banner is present'];
      if (tradeHistory !== null) signals.push("an Account Trade History section was found (fills)");
      else signals.push("a Cash Balance section was found (TRD rows rebuild the fills)");
      return {
        table: tableIndex,
        signals,
        section: { headerIndex: chosen.headerIndex, plan: chosen.plan, start: chosen.start, end: chosen.end },
      };
    }
    return null;
  },

  build(doc: StatementDoc, match: AdapterMatch, ctx: AdapterContext): AdapterBuildResult {
    const table = doc.tables[match.table]!;
    const rows = table.rows;
    const tradeHistory = findTitledSection(rows, "Account Trade History");
    const cashBalance = findTitledSection(rows, "Cash Balance");
    const accountId = scanAccount(rows);

    const result =
      tradeHistory !== null
        ? buildFromTradeHistory(table, tradeHistory, cashBalance, ctx, accountId)
        : cashBalance !== null
          ? buildFromCashBalance(table, cashBalance, ctx, accountId)
          : null;
    if (result === null) {
      addIssue(
        ctx.issues,
        "error",
        "no-trade-section",
        "Neither an Account Trade History nor a Cash Balance section holds readable trades.",
      );
      return { trades: [], skippedRows: 0 };
    }
    return {
      ...result,
      ...(accountId !== undefined ? { account: { id: accountId } } : {}),
    };
  },
};

/** Fee lookup from Cash Balance TRD rows, keyed by "epochMs|SYMBOL". */
function collectCashFees(
  table: { rows: string[][] },
  cash: TitledSection,
  parser: BoundTimestampParser,
): Map<string, number> {
  const fees = new Map<string, number>();
  const plan = cash.plan;
  const typeIndex = plan.header.findIndex((cell) => normalizeHeader(cell) === "type");
  const descriptionIndex = plan.header.findIndex((cell) => normalizeHeader(cell) === "description");
  if (plan.entryTimeParts === null || descriptionIndex === -1) return fees;
  const [dateIndex, timeIndex] = plan.entryTimeParts;

  for (let index = cash.start; index < cash.end; index++) {
    const row = table.rows[index]!;
    if (typeIndex !== -1 && cleanCell(row[typeIndex] ?? "").toUpperCase() !== "TRD") continue;
    const description = cleanCell(row[descriptionIndex] ?? "");
    const fill = DESCRIPTION_FILL.exec(description);
    if (fill === null) continue;
    const time = parser.parse(mergeDateTimeCells(row[dateIndex] ?? "", row[timeIndex] ?? ""));
    if (!Number.isFinite(time)) continue;
    let cost = 0;
    for (const feeIndex of plan.feeColumns) {
      const value = parseNumberCell(row[feeIndex] ?? "");
      if (value !== null) cost += -value; // the statement signs fees negative
    }
    if (cost === 0) continue;
    const key = `${time}|${neutralizeText(fill[3]!).toUpperCase()}`;
    fees.set(key, (fees.get(key) ?? 0) + cost);
  }
  return fees;
}

function buildFromTradeHistory(
  table: { rows: string[][]; rowNumbers: number[] },
  section: TitledSection,
  cash: TitledSection | null,
  ctx: AdapterContext,
  accountId: string | undefined,
): AdapterBuildResult {
  const plan = section.plan;
  const fields = plan.fields;
  const spreadIndex = plan.header.findIndex((cell) => normalizeHeader(cell) === "spread");
  const timeIndex = fields.entryTime;

  const timeSamples: string[] = [];
  for (let index = section.start; index < section.end; index++) {
    if (timeIndex !== undefined) timeSamples.push(table.rows[index]![timeIndex] ?? "");
  }
  if (cash !== null && cash.plan.entryTimeParts !== null) {
    const [dateIndex] = cash.plan.entryTimeParts;
    for (let index = cash.start; index < cash.end; index++) timeSamples.push(table.rows[index]![dateIndex] ?? "");
  }
  const parser = buildTimestampParser(timeSamples, ctx.dateOrder, ctx.issues);
  const cashFees = cash !== null ? collectCashFees(table, cash, parser) : new Map<string, number>();

  const trades: StatementTrade[] = [];
  let skippedRows = 0;
  let nonStock = 0;

  for (let index = section.start; index < section.end; index++) {
    const row = table.rows[index]!;
    const sourceRow = table.rowNumbers[index] ?? index + 1;
    if (row.every((cell) => cell.trim() === "")) continue;

    const cell = (i: number | undefined): string => (i === undefined ? "" : (row[i] ?? ""));
    if (spreadIndex !== -1 && cleanCell(row[spreadIndex] ?? "").toUpperCase() !== "STOCK") {
      nonStock++;
      skippedRows++;
      continue;
    }
    const time = parser.parse(cell(timeIndex));
    const price = parseNumberCell(cell(fields.entryPrice));
    const quantity = parseNumberCell(cell(fields.quantity));
    const side = cleanCell(cell(fields.direction)).toUpperCase();
    if (!Number.isFinite(time) || price === null || price <= 0 || quantity === null || quantity === 0) {
      addIssue(ctx.issues, "warning", "row-bad-values", "Fill skipped: unreadable time, price, or quantity.", {
        row: sourceRow,
      });
      skippedRows++;
      continue;
    }
    if (side === "BUY" && quantity < 0) {
      addIssue(ctx.issues, "warning", "side-quantity-mismatch", "Fill skipped: a BUY row carries a negative quantity.", {
        row: sourceRow,
      });
      skippedRows++;
      continue;
    }
    if (side !== "BUY" && side !== "SELL") {
      addIssue(ctx.issues, "warning", "row-unrecognized-type", `Fill skipped: unrecognized side "${side}".`, {
        row: sourceRow,
      });
      skippedRows++;
      continue;
    }
    const symbol = neutralizeText(cell(fields.symbol)).toUpperCase();
    if (symbol === "") {
      addIssue(ctx.issues, "warning", "row-bad-values", "Fill skipped: no symbol.", { row: sourceRow });
      skippedRows++;
      continue;
    }
    const fee = cashFees.get(`${time}|${symbol}`);
    trades.push({
      symbol,
      side: side === "BUY" ? "buy" : "sell",
      quantity: Math.abs(quantity),
      price,
      ...(fee !== undefined ? { fee } : {}),
      executedAt: toExecutedAt(time),
      ...(accountId !== undefined ? { accountId } : {}),
    });
  }

  if (nonStock > 0) {
    addIssue(
      ctx.issues,
      "warning",
      "unsupported-instrument",
      `${nonStock} non-stock leg(s) (options, futures, or forex) were refused: the statement does not ` +
        "carry their contract multipliers, and a scaled-wrong number is worse than none.",
    );
  }

  return { trades: sortByExecutedAt(trades), skippedRows };
}

function buildFromCashBalance(
  table: { rows: string[][]; rowNumbers: number[] },
  cash: TitledSection,
  ctx: AdapterContext,
  accountId: string | undefined,
): AdapterBuildResult {
  const plan = cash.plan;
  const typeIndex = plan.header.findIndex((cell) => normalizeHeader(cell) === "type");
  const descriptionIndex = plan.header.findIndex((cell) => normalizeHeader(cell) === "description");
  if (plan.entryTimeParts === null || descriptionIndex === -1) {
    addIssue(
      ctx.issues,
      "error",
      "no-trade-section",
      "The Cash Balance section is missing its DATE/TIME or DESCRIPTION columns.",
    );
    return { trades: [], skippedRows: 0 };
  }
  const [dateIndex, timeIndex] = plan.entryTimeParts;

  const timeSamples: string[] = [];
  for (let index = cash.start; index < cash.end; index++) timeSamples.push(table.rows[index]![dateIndex] ?? "");
  const parser = buildTimestampParser(timeSamples, ctx.dateOrder, ctx.issues);

  const trades: StatementTrade[] = [];
  let skippedRows = 0;
  let unparsedTrd = 0;

  for (let index = cash.start; index < cash.end; index++) {
    const row = table.rows[index]!;
    const sourceRow = table.rowNumbers[index] ?? index + 1;
    if (row.every((cell) => cell.trim() === "")) continue;
    const type = typeIndex === -1 ? "" : cleanCell(row[typeIndex] ?? "").toUpperCase();
    if (type !== "TRD") continue; // balances, journals, totals

    const description = cleanCell(row[descriptionIndex] ?? "");
    const fill = DESCRIPTION_FILL.exec(description);
    if (fill === null) {
      unparsedTrd++;
      skippedRows++;
      continue;
    }
    const time = parser.parse(mergeDateTimeCells(row[dateIndex] ?? "", row[timeIndex] ?? ""));
    const quantityRaw = parseNumberCell(fill[2]!);
    const price = parseNumberCell(fill[4]!);
    if (!Number.isFinite(time) || quantityRaw === null || quantityRaw === 0 || price === null || price <= 0) {
      addIssue(ctx.issues, "warning", "row-bad-values", "TRD row skipped: unreadable time, quantity, or price.", {
        row: sourceRow,
      });
      skippedRows++;
      continue;
    }
    const bot = fill[1]!.toUpperCase() === "BOT";
    let cost = 0;
    for (const feeIndex of plan.feeColumns) {
      const value = parseNumberCell(row[feeIndex] ?? "");
      if (value !== null) cost += -value;
    }
    trades.push({
      symbol: neutralizeText(fill[3]!).toUpperCase(),
      side: bot ? "buy" : "sell",
      quantity: Math.abs(quantityRaw),
      price,
      ...(cost !== 0 ? { fee: cost } : {}),
      executedAt: toExecutedAt(time),
      ...(accountId !== undefined ? { accountId } : {}),
    });
  }

  if (unparsedTrd > 0) {
    addIssue(
      ctx.issues,
      "warning",
      "unsupported-instrument",
      `${unparsedTrd} TRD row(s) did not match the "BOT/SOLD <qty> <symbol> @<price>" stock pattern ` +
        "(options and futures descriptions carry strikes and multipliers this parser refuses to guess).",
    );
  }

  return { trades: sortByExecutedAt(trades), skippedRows };
}
