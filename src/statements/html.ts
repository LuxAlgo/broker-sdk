/*
  Adapted from LuxAlgo/prop-firm-sim packages/core/src/import/html.ts (MIT).

  Deterministic HTML statement-table extractor. MetaTrader's only export
  button produces HTML, so this walks tags without being a general HTML
  parser and without dependencies: script/style content is discarded
  wholesale, entities are decoded, tags are stripped to text, colspans are
  padded so column indices survive, and class="hidden" cells and rows are
  dropped ENTIRELY (MT5 embeds an 8-column hidden comment cell in every
  position row that would otherwise shift all columns). Survives malformed
  and truncated markup: everything still open at end of input is closed.
*/

import { addIssue, type StatementIssue } from "./types.js";

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  minus: "−",
  ndash: "–",
  mdash: "—",
  times: "×",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  bull: "•",
  middot: "·",
};

/** Decode named and numeric character references; unknown ones pass through. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return all;
      try {
        return String.fromCodePoint(code);
      } catch {
        return all;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? all;
  });
}

export type HtmlTable = {
  rows: string[][];
  /** 1-based physical <tr> ordinal of each kept row within its table. */
  rowNumbers: number[];
};

type TableContext = {
  rows: string[][];
  rowNumbers: number[];
  row: string[] | null;
  rowHidden: boolean;
  cell: string | null;
  cellHidden: boolean;
  cellColspan: number;
  trOrdinal: number;
};

function attrValue(tag: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  if (m === null) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

function hasHiddenClass(tag: string): boolean {
  const cls = attrValue(tag, "class");
  if (cls === null) return false;
  return cls.toLowerCase().split(/\s+/).includes("hidden");
}

/**
 * Extract every table as rows of decoded cell text. `maxRows` caps the total
 * kept rows across all tables; hitting it truncates with a warning instead
 * of failing.
 */
export function extractHtmlTables(
  html: string,
  issues: StatementIssue[],
  options: { maxRows?: number } = {},
): HtmlTable[] {
  const maxRows = options.maxRows ?? 200_000;
  const tables: HtmlTable[] = [];
  const stack: TableContext[] = [];
  let keptRows = 0;
  let truncated = false;

  const top = (): TableContext | undefined => stack[stack.length - 1];

  const closeCell = (ctx: TableContext): void => {
    if (ctx.cell === null) return;
    if (!ctx.cellHidden && ctx.row !== null) {
      const text = decodeEntities(ctx.cell).replace(/\s+/g, " ").trim();
      ctx.row.push(text);
      for (let pad = 1; pad < ctx.cellColspan; pad++) ctx.row.push("");
    }
    ctx.cell = null;
    ctx.cellHidden = false;
    ctx.cellColspan = 1;
  };

  const closeRow = (ctx: TableContext): void => {
    closeCell(ctx);
    if (ctx.row === null) return;
    ctx.trOrdinal++;
    if (!ctx.rowHidden && !truncated) {
      ctx.rows.push(ctx.row);
      ctx.rowNumbers.push(ctx.trOrdinal);
      keptRows++;
      if (keptRows >= maxRows) truncated = true;
    }
    ctx.row = null;
    ctx.rowHidden = false;
  };

  const closeTable = (): void => {
    const ctx = stack.pop();
    if (ctx === undefined) return;
    closeRow(ctx);
    if (ctx.rows.length > 0) tables.push({ rows: ctx.rows, rowNumbers: ctx.rowNumbers });
  };

  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      const ctx = top();
      if (ctx !== undefined && ctx.cell !== null) ctx.cell += html.slice(i);
      break;
    }
    if (lt > i) {
      const ctx = top();
      if (ctx !== undefined && ctx.cell !== null) ctx.cell += html.slice(i, lt);
    }
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    // Find the tag end, respecting quoted attribute values.
    let j = lt + 1;
    let quote: string | null = null;
    while (j < n) {
      const ch = html[j]!;
      if (quote !== null) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      j++;
    }
    const tag = html.slice(lt + 1, j);
    i = Math.min(j + 1, n);

    const nameMatch = /^\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tag);
    if (nameMatch === null) continue;
    const closing = tag.startsWith("/");
    const name = nameMatch[1]!.toLowerCase();

    if (!closing && (name === "script" || name === "style")) {
      const close = html.toLowerCase().indexOf(`</${name}`, i);
      i = close === -1 ? n : html.indexOf(">", close) + 1 || n;
      continue;
    }

    const ctx = top();
    switch (name) {
      case "table":
        if (closing) closeTable();
        else {
          if (ctx !== undefined) closeCell(ctx); // a nested table never leaks into the outer cell
          stack.push({
            rows: [],
            rowNumbers: [],
            row: null,
            rowHidden: false,
            cell: null,
            cellHidden: false,
            cellColspan: 1,
            trOrdinal: 0,
          });
        }
        break;
      case "tr":
        if (ctx === undefined) break;
        closeRow(ctx);
        if (!closing) {
          ctx.row = [];
          ctx.rowHidden = hasHiddenClass(tag);
        }
        break;
      case "td":
      case "th": {
        if (ctx === undefined) break;
        closeCell(ctx);
        if (!closing) {
          if (ctx.row === null) {
            ctx.row = [];
            ctx.rowHidden = false;
          }
          ctx.cell = "";
          ctx.cellHidden = hasHiddenClass(tag);
          const colspanRaw = attrValue(tag, "colspan");
          const colspan = colspanRaw === null ? 1 : Number.parseInt(colspanRaw, 10);
          ctx.cellColspan = Number.isFinite(colspan) ? Math.min(Math.max(colspan, 1), 50) : 1;
        }
        break;
      }
      case "br":
        if (ctx !== undefined && ctx.cell !== null) ctx.cell += " ";
        break;
      default:
        break;
    }
    if (truncated) break;
  }
  while (stack.length > 0) closeTable();

  if (truncated) {
    addIssue(
      issues,
      "warning",
      "input-truncated",
      "The HTML report exceeds the row cap; only the first part was read. Anything after the cap was ignored.",
    );
  }
  return tables;
}
