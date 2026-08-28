/*
  Adapted from LuxAlgo/prop-firm-sim packages/core/src/import/aliases.ts (MIT).

  Header understanding: normalize raw header cells, map them onto canonical
  fields through an exact alias dictionary (plus a short prefix list), and
  resolve the ambiguities a name alone cannot settle. Three rules learned
  from real files:

  - Ambiguous Type/Side/Action/Direction columns are resolved by INSPECTING
    VALUES (buy/sell/long/short means direction; entry/exit/in/out means
    event type), never by name alone. MetaTrader's "Type" holds buy/sell,
    TradingView's holds "Entry long"/"Exit long", and MT5's "Direction"
    holds in/out; the same word means three different things.
  - An IDENTICAL repeated header maps its second occurrence to the exit leg
    (MetaTrader's "...,Time,Price,...,Time,Price,..."), but different names
    are never promoted: a "Date" plus "Time" pair is ONE timestamp and the
    cells merge instead.
  - Columns that only matter for detection (S/L, Profit) still map, even
    though the fills we emit drop their values: the fingerprint of a
    MetaTrader statement IS those columns.
*/

import { parseNumberCell } from "./text.js";

/** Canonical column meanings the header mapper can assign. */
export type CanonicalField =
  | "tradeId"
  | "orderId"
  | "symbol"
  | "direction"
  | "eventType"
  | "quantity"
  | "entryTime"
  | "exitTime"
  | "entryPrice"
  | "exitPrice"
  | "stopPrice"
  | "pnl"
  | "fees"
  | "swap";

/** Normalize a header cell: lowercase, % becomes pct, strip everything
 *  non-alphanumeric, then strip a trailing currency code ("Net PnL USD" and
 *  "Price USDT" mean the same columns as "Net PnL" and "Price"). */
export function normalizeHeader(raw: string): string {
  let s = raw.toLowerCase().replace(/%/g, "pct");
  s = s.replace(/[^a-z0-9]+/g, "");
  const currency = /(usd|usdt|usdc|eur|gbp|jpy|aud|cad|chf|nzd)$/.exec(s);
  if (currency !== null && s.length > currency[1]!.length + 1) {
    s = s.slice(0, s.length - currency[1]!.length);
  }
  return s;
}

/** Exact normalized-header aliases. Names whose meaning depends on their
 *  values (type, action, direction, ...) are NOT here; they resolve below. */
export const STATEMENT_HEADER_ALIASES: Record<string, CanonicalField> = {
  // trade/position identity
  tradeid: "tradeId",
  trade: "tradeId",
  tradenumber: "tradeId",
  tradeno: "tradeId",
  position: "tradeId",
  positionid: "tradeId",
  ticket: "tradeId",
  id: "tradeId",
  // order/fill identity
  order: "orderId",
  orderid: "orderId",
  ordernumber: "orderId",
  orderno: "orderId",
  deal: "orderId",
  dealid: "orderId",
  execid: "orderId",
  ref: "orderId",
  refno: "orderId",
  refnumber: "orderId",
  // symbol
  symbol: "symbol",
  ticker: "symbol",
  instrument: "symbol",
  item: "symbol",
  market: "symbol",
  pair: "symbol",
  asset: "symbol",
  product: "symbol",
  contract: "symbol", // singular; plural "contracts" is a quantity
  // direction (unambiguous names only)
  side: "direction",
  buysell: "direction",
  bs: "direction",
  longshort: "direction",
  // event type (unambiguous names only)
  eventtype: "eventType",
  entryexit: "eventType",
  poseffect: "eventType",
  positioneffect: "eventType",
  inout: "eventType",
  // quantity
  qty: "quantity",
  quantity: "quantity",
  size: "quantity",
  sizeqty: "quantity",
  volume: "quantity",
  lots: "quantity",
  lot: "quantity",
  contracts: "quantity",
  shares: "quantity",
  units: "quantity",
  filledqty: "quantity",
  // entry time (full timestamps)
  opentime: "entryTime",
  openedat: "entryTime",
  opened: "entryTime",
  entrytime: "entryTime",
  entrydate: "entryTime",
  opendate: "entryTime",
  datetime: "entryTime",
  dateandtime: "entryTime",
  datetimeutc: "entryTime",
  timestamp: "entryTime",
  filltime: "entryTime",
  executiontime: "entryTime",
  boughttimestamp: "entryTime",
  // exit time
  closetime: "exitTime",
  closedat: "exitTime",
  closed: "exitTime",
  exittime: "exitTime",
  exitdate: "exitTime",
  closedate: "exitTime",
  soldtimestamp: "exitTime",
  // entry price
  entryprice: "entryPrice",
  openprice: "entryPrice",
  price: "entryPrice",
  fillprice: "entryPrice",
  avgprice: "entryPrice",
  averageprice: "entryPrice",
  buyprice: "entryPrice",
  // exit price
  exitprice: "exitPrice",
  closeprice: "exitPrice",
  sellprice: "exitPrice",
  // stop (a MetaTrader-statement fingerprint column; its value is dropped)
  sl: "stopPrice",
  stoploss: "stopPrice",
  stop: "stopPrice",
  stopprice: "stopPrice",
  initialstop: "stopPrice",
  slprice: "stopPrice",
  // pnl (a fingerprint column; broker-sdk recomputes P&L FIFO from fills)
  pnl: "pnl",
  netpnl: "pnl",
  profit: "pnl",
  netprofit: "pnl",
  profitloss: "pnl",
  pl: "pnl",
  realizedpnl: "pnl",
  realizedpl: "pnl",
  gainloss: "pnl",
  netgain: "pnl",
  // fees
  fee: "fees",
  fees: "fees",
  commission: "fees",
  commissions: "fees",
  commissionsfees: "fees",
  commissionfees: "fees",
  miscfees: "fees",
  taxes: "fees",
  charges: "fees",
  // swap / financing
  swap: "swap",
  rollover: "swap",
  financing: "swap",
};

/** Header names whose meaning depends on their VALUES. */
const AMBIGUOUS_NAMES = new Set(["type", "action", "direction", "kind"]);

/** Split date/time parts: a "date" column next to a "time" column is one
 *  timestamp. "time" alone (MT5 deals) is a full timestamp. */
const ENTRY_DATE_PARTS = new Set(["date", "execdate", "tradedate"]);
const ENTRY_TIME_PARTS = new Set(["time", "exectime", "timeplaced"]);
const EXIT_DATE_PARTS = new Set(["closedate", "exitdate"]);
const EXIT_TIME_PARTS = new Set(["closetime", "exittime"]);

/** Row-status column (order tables): used to drop cancelled/rejected/working
 *  rows, never mapped to a trade field. */
const STATUS_NAMES = new Set(["status", "orderstatus", "state"]);

/** Known-irrelevant columns: recognized so noise never counts against
 *  detection, and never mapped. Includes the risk/R vocabulary that the
 *  simulation side owns — recognized here only so a header carrying it
 *  still fingerprints cleanly. */
export const IRRELEVANT_HEADERS = new Set([
  "cumulativepnl",
  "cumulativeprofit",
  "cumprofit",
  "cumpnl",
  "runup",
  "drawdown",
  "maxrunup",
  "maxdrawdown",
  "mae",
  "mfe",
  "duration",
  "bars",
  "barsheld",
  "account",
  "accountid",
  "accountnumber",
  "balance",
  "equity",
  "margin",
  "marginreq",
  "marginrequirement",
  "comment",
  "comments",
  "notes",
  "note",
  "description",
  "signal",
  "spread",
  "exp",
  "expiry",
  "expiration",
  "strike",
  "tif",
  "ordertype",
  "tp",
  "takeprofit",
  "tpprice",
  "netprice",
  "markvalue",
  "mark",
  "netliq",
  "plopen",
  "plday",
  "plytd",
  "pldiff",
  "cost",
  "sec",
  "secfee",
  "exchange",
  "venue",
  "currency",
  "leverage",
  "tags",
  "strategy",
  "setup",
  "grosspnl",
  "grossprofit",
  // simulation-side vocabulary, recognized but never emitted
  "r",
  "rmultiple",
  "rmult",
  "rr",
  "result",
  "resultr",
  "realizedr",
  "pnlr",
  "risk",
  "riskamount",
  "riskedamount",
  "amountrisked",
  "riskcash",
  "returnpct",
  "profitpct",
  "gainpct",
  "plpct",
  "changepct",
]);

/** Prefix fallbacks, tried only after exact lookups fail. Short on purpose. */
const PREFIX_ALIASES: Array<[string, CanonicalField]> = [
  ["opentime", "entryTime"],
  ["closetime", "exitTime"],
  ["entryprice", "entryPrice"],
  ["exitprice", "exitPrice"],
  ["stoploss", "stopPrice"],
  ["netpnl", "pnl"],
  ["realizedpnl", "pnl"],
  ["commission", "fees"],
  ["quantity", "quantity"],
];

export type ValueKind = "direction" | "eventType" | null;

const DIRECTION_VALUES = /^(buy|sell|long|short|b|s|bot|sold|buytocover|selltoopen)$/;
const EVENT_VALUES = /^(entry|exit|in|out|inout|open|close|toopen|toclose|entrylong|entryshort|exitlong|exitshort)$/;

/** Classify an ambiguous column by its values: event-type tokens win over
 *  direction tokens because TradingView's "Entry long" carries both. */
export function classifyValueColumn(values: Iterable<string>): ValueKind {
  let direction = 0;
  let event = 0;
  let nonEmpty = 0;
  for (const raw of values) {
    const v = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, "");
    if (v === "") continue;
    nonEmpty++;
    if (EVENT_VALUES.test(v) || /^(entry|exit)/.test(v)) event++;
    else if (DIRECTION_VALUES.test(v) || /^(buy|sell)/.test(v)) direction++;
  }
  if (nonEmpty === 0) return null;
  if (event > 0 && event >= nonEmpty * 0.6) return "eventType";
  if (direction > 0 && direction >= nonEmpty * 0.6) return "direction";
  return null;
}

/** The resolved reading of one header row. Field indices are 0-based columns.
 *  `fees` in `fields` is the first fee column; `feeColumns` has them all. */
export type HeaderPlan = {
  header: string[];
  fields: Partial<Record<CanonicalField, number>>;
  feeColumns: number[];
  entryTimeParts: [number, number] | null;
  exitTimeParts: [number, number] | null;
  statusColumn: number | null;
  /** Columns matched to canonical fields (fee columns count once). */
  matchedFields: CanonicalField[];
  /** All recognized columns, irrelevant ones included: header-location score. */
  knownColumns: number;
};

/** True when a cell would be data, not a header word. */
function looksNumericCell(raw: string): boolean {
  return /\d/.test(raw) && parseNumberCell(raw) !== null;
}

/** Count of numeric-looking cells: a real header row has zero. */
export function numericCellCount(row: readonly string[]): number {
  let count = 0;
  for (const cell of row) if (looksNumericCell(cell)) count++;
  return count;
}

/**
 * Build the reading of one header row against sample data rows (needed to
 * resolve value-dependent columns). Deterministic, first-match-wins, with
 * the two structural rules: identical repeated headers map their second
 * occurrence to the exit leg, and date+time part pairs merge.
 */
export function buildHeaderPlan(header: readonly string[], sampleRows: readonly string[][]): HeaderPlan {
  const fields: Partial<Record<CanonicalField, number>> = {};
  const feeColumns: number[] = [];
  const matchedFields: CanonicalField[] = [];
  let knownColumns = 0;
  let statusColumn: number | null = null;

  const normalized = header.map((cell) => normalizeHeader(cell));
  const seen = new Map<string, number>();
  const entryDatePart: number[] = [];
  const entryTimePart: number[] = [];
  const exitDatePart: number[] = [];
  const exitTimePart: number[] = [];

  const columnValues = (index: number): string[] => {
    const values: string[] = [];
    for (const row of sampleRows) {
      const cell = row[index];
      if (cell !== undefined && cell.trim() !== "") values.push(cell);
      if (values.length >= 30) break;
    }
    return values;
  };

  const assign = (field: CanonicalField, index: number): void => {
    if (field === "fees") {
      feeColumns.push(index);
      if (fields.fees === undefined) {
        fields.fees = index;
        matchedFields.push("fees");
      }
      return;
    }
    if (fields[field] === undefined) {
      fields[field] = index;
      matchedFields.push(field);
    }
  };

  for (let index = 0; index < normalized.length; index++) {
    const name = normalized[index]!;
    if (name === "") continue;

    if (STATUS_NAMES.has(name)) {
      if (statusColumn === null) statusColumn = index;
      knownColumns++;
      continue;
    }

    // Split date/time parts are collected first; they pair up after the loop.
    if (ENTRY_DATE_PARTS.has(name)) {
      entryDatePart.push(index);
      knownColumns++;
      continue;
    }
    if (ENTRY_TIME_PARTS.has(name)) {
      entryTimePart.push(index);
      knownColumns++;
      continue;
    }
    if (EXIT_DATE_PARTS.has(name)) {
      exitDatePart.push(index);
      knownColumns++;
      continue;
    }
    if (EXIT_TIME_PARTS.has(name)) {
      exitTimePart.push(index);
      knownColumns++;
      continue;
    }

    if (AMBIGUOUS_NAMES.has(name)) {
      const kind = classifyValueColumn(columnValues(index));
      knownColumns++;
      if (kind !== null) assign(kind, index);
      continue;
    }

    const previous = seen.get(name);
    seen.set(name, index);

    let field: CanonicalField | undefined = STATEMENT_HEADER_ALIASES[name];
    if (field === undefined) {
      for (const [prefix, prefixField] of PREFIX_ALIASES) {
        if (name.startsWith(prefix)) {
          field = prefixField;
          break;
        }
      }
    }
    if (field === undefined) {
      if (IRRELEVANT_HEADERS.has(name)) knownColumns++;
      continue;
    }
    knownColumns++;

    // The SAME name appearing again maps to the exit leg (MetaTrader's
    // duplicated Time/Price pairs). Different names are never promoted.
    if (previous !== undefined && fields[field] === previous) {
      if (field === "entryTime") {
        assign("exitTime", index);
        continue;
      }
      if (field === "entryPrice") {
        assign("exitPrice", index);
        continue;
      }
    }
    assign(field, index);
  }

  // Pair split parts. A repeated date+time pair (MT5 positions HTML uses
  // Time,...,Time) maps the second pair to the exit leg.
  let entryTimeParts: [number, number] | null = null;
  let exitTimeParts: [number, number] | null = null;
  if (entryDatePart.length > 0 && entryTimePart.length > 0) {
    assign("entryTime", entryDatePart[0]!);
    entryTimeParts = [entryDatePart[0]!, entryTimePart[0]!];
    if (entryDatePart.length > 1 && entryTimePart.length > 1 && fields.exitTime === undefined) {
      assign("exitTime", entryDatePart[1]!);
      exitTimeParts = [entryDatePart[1]!, entryTimePart[1]!];
    }
  } else if (entryDatePart.length > 0) {
    assign("entryTime", entryDatePart[0]!);
    if (entryDatePart.length > 1 && fields.exitTime === undefined) assign("exitTime", entryDatePart[1]!);
  } else if (entryTimePart.length > 0) {
    // "Time" with no date column is a full timestamp (MT5 deals). A second
    // bare Time column is the exit leg (MT4/MT5 statement rows).
    assign("entryTime", entryTimePart[0]!);
    if (entryTimePart.length > 1 && fields.exitTime === undefined) assign("exitTime", entryTimePart[1]!);
  }
  if (exitDatePart.length > 0 && exitTimePart.length > 0) {
    assign("exitTime", exitDatePart[0]!);
    exitTimeParts = [exitDatePart[0]!, exitTimePart[0]!];
  } else if (exitDatePart.length > 0) {
    assign("exitTime", exitDatePart[0]!);
  } else if (exitTimePart.length > 0) {
    assign("exitTime", exitTimePart[0]!);
  }

  return {
    header: [...header],
    fields,
    feeColumns,
    entryTimeParts,
    exitTimeParts,
    statusColumn,
    matchedFields,
    knownColumns,
  };
}

/** One candidate section of a multi-section statement table. */
export type TableSection = {
  headerIndex: number;
  plan: HeaderPlan;
  /** Data rows are rows[start, end). */
  start: number;
  end: number;
};

function nonEmptyCells(row: readonly string[]): number {
  let count = 0;
  for (const cell of row) if (cell.trim() !== "") count++;
  return count;
}

/** Title rows ("Open Trades:", "Orders"), summary rows ("Closed P/L:"), and
 *  blank rows all end a section. */
function isSectionBoundary(row: readonly string[]): boolean {
  const nonEmpty = nonEmptyCells(row);
  if (nonEmpty === 0) return true;
  if (nonEmpty === 1) return true;
  if (nonEmpty <= 3 && row.some((cell) => cell.trim().endsWith(":"))) return true;
  return false;
}

/**
 * Find every candidate section of a statement table: each strong header row
 * (enough known aliases, zero numeric cells) opens a section that runs to
 * the next boundary or the next header. The WHOLE table is scanned: a real
 * MT5 tester report lists tens of thousands of cancelled orders before its
 * Deals section. Adapters claim the first section whose header matches
 * their fingerprint.
 */
export function findTableSections(rows: readonly string[][], options: { minKnown?: number } = {}): TableSection[] {
  const minKnown = options.minKnown ?? 4;
  const headerIndices: Array<{ index: number; plan: HeaderPlan }> = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (nonEmptyCells(row) < 3) continue;
    if (numericCellCount(row) > 0) continue;
    const plan = buildHeaderPlan(row, rows.slice(index + 1, index + 31));
    if (plan.knownColumns >= minKnown) headerIndices.push({ index, plan });
  }
  const sections: TableSection[] = [];
  for (let h = 0; h < headerIndices.length; h++) {
    const { index, plan } = headerIndices[h]!;
    const nextHeader = h + 1 < headerIndices.length ? headerIndices[h + 1]!.index : rows.length;
    let end = index + 1;
    while (end < nextHeader && !isSectionBoundary(rows[end]!)) end++;
    sections.push({ headerIndex: index, plan, start: index + 1, end });
  }
  return sections;
}

/** Shared helper: normalized header-name set of a section. */
export function normalizedNames(header: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const cell of header) {
    const trimmed = cell
      .trim()
      .toLowerCase()
      .replace(/%/g, "pct")
      .replace(/[^a-z0-9]+/g, "");
    if (trimmed !== "") names.add(trimmed);
  }
  return names;
}
