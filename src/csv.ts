import { createHash } from "node:crypto";

import type { Trade } from "./schema.js";
export { positionsFromTrades } from "./stats.js";

/*
  Statement import — the universal fallback "broker". Paste or upload a
  trade-history CSV from any institution and the parser maps its columns by
  name. Tolerant on purpose — brokers disagree on headers — but strict on
  rows: anything without a symbol, a recognizable side, and finite
  quantity/price is skipped and counted, never guessed at.
*/

const HEADER_ALIASES: Record<"symbol" | "side" | "quantity" | "price" | "fee" | "executedAt", string[]> = {
  symbol: ["symbol", "ticker", "instrument", "asset", "pair", "market", "product"],
  side: ["side", "type", "direction", "action", "buy/sell", "order type"],
  quantity: ["quantity", "qty", "size", "units", "filled", "amount", "shares", "volume"],
  price: ["price", "avg price", "average price", "fill price", "execution price", "rate", "price per unit"],
  fee: ["fee", "fees", "commission", "commissions"],
  executedAt: ["date", "time", "datetime", "date/time", "timestamp", "executed at", "filled at", "close time"],
};

const splitCsvLine = (line: string): string[] => {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
};

const findColumn = (headers: string[], aliases: string[]): number =>
  headers.findIndex((header) => aliases.includes(header));

const parseSide = (raw: string): Trade["side"] | null => {
  const value = raw.toLowerCase();
  if (value.includes("buy") || value.includes("long") || value === "b") return "buy";
  if (value.includes("sell") || value.includes("short") || value === "s") return "sell";
  return null;
};

const parseNumber = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const value = Number.parseFloat(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(value) ? value : null;
};

export type ParsedStatement = {
  trades: Trade[];
  skippedRows: number;
  /** Content hash — a stable account id, so re-imports upsert instead of duplicating. */
  contentHash: string;
};

export const parseStatementCsv = (csv: string): ParsedStatement => {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const headerLine = lines[0];
  const contentHash = createHash("sha256").update(csv).digest("hex").slice(0, 16);
  if (!headerLine) return { trades: [], skippedRows: 0, contentHash };

  const headers = splitCsvLine(headerLine).map((header) => header.toLowerCase());
  const columns = {
    symbol: findColumn(headers, HEADER_ALIASES.symbol),
    side: findColumn(headers, HEADER_ALIASES.side),
    quantity: findColumn(headers, HEADER_ALIASES.quantity),
    price: findColumn(headers, HEADER_ALIASES.price),
    fee: findColumn(headers, HEADER_ALIASES.fee),
    executedAt: findColumn(headers, HEADER_ALIASES.executedAt),
  };
  if (columns.symbol < 0 || columns.side < 0 || columns.quantity < 0 || columns.price < 0) {
    return { trades: [], skippedRows: lines.length - 1, contentHash };
  }

  const trades: Trade[] = [];
  let skippedRows = 0;
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const symbol = cells[columns.symbol]?.toUpperCase();
    const side = parseSide(cells[columns.side] ?? "");
    const quantity = parseNumber(cells[columns.quantity]);
    const price = parseNumber(cells[columns.price]);
    if (!symbol || !side || quantity === null || quantity <= 0 || price === null || price <= 0) {
      skippedRows += 1;
      continue;
    }
    const fee = columns.fee >= 0 ? parseNumber(cells[columns.fee]) : null;
    const executedAtRaw = columns.executedAt >= 0 ? cells[columns.executedAt] : undefined;
    const executedAt =
      executedAtRaw && !Number.isNaN(Date.parse(executedAtRaw)) ? new Date(executedAtRaw).toISOString() : undefined;
    trades.push({
      symbol,
      side,
      quantity,
      price,
      ...(fee !== null && fee >= 0 ? { fee } : {}),
      ...(executedAt ? { executedAt } : {}),
    });
  }

  return { trades, skippedRows, contentHash };
};
