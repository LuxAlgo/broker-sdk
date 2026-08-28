/*
  Adapted from LuxAlgo/prop-firm-sim packages/core/src/import/csv.ts (MIT).

  Delimited-text machinery for statement imports: encoding repair, byte
  decoding at file boundaries, delimiter sniffing, a quote-aware tokenizer
  that survives malformed input, and defensive cell parsing for the number
  formats real exports actually contain (currency symbols, parentheses
  negatives, Unicode minus, thousands separators in three conventions,
  Excel ="..." text guards).
*/

import { addIssue, isEmptyCell, type StatementIssue } from "./types.js";

export type Delimiter = "," | ";" | "\t" | "|";

/* ---- Encoding ---------------------------------------------------------- */

/**
 * Repair text that was decoded with the wrong charset. The one real-world
 * case: MetaTrader saves every report as UTF-16LE, and a naive UTF-8 read
 * yields NUL-interleaved ASCII, often led by U+FFFD replacement pairs from
 * the BOM. Detect that shape, strip the interleaved NULs, and say so. Also
 * strips a plain UTF-8 BOM.
 */
export function repairEncoding(input: string, issues: StatementIssue[]): string {
  let text = input;

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const probe = text.slice(0, 4096);
  let nulCount = 0;
  for (let i = 0; i < probe.length; i++) if (probe.charCodeAt(i) === 0) nulCount++;
  const leadingReplacement = /^��?/.test(text);
  if (probe.length > 0 && (nulCount / probe.length > 0.2 || (leadingReplacement && nulCount > 0))) {
    text = text.replace(/^�+/, "").replace(/\u0000/g, "");
    addIssue(
      issues,
      "warning",
      "encoding-repaired",
      "The text looks like a UTF-16 file read as UTF-8 (NUL-interleaved characters). It was repaired " +
        "in place; if anything below looks garbled, re-save or re-upload the original file.",
    );
  }

  return text;
}

/**
 * Decode raw statement-file bytes by BOM: FF FE = UTF-16LE, FE FF = UTF-16BE,
 * anything else UTF-8. MetaTrader reports are UTF-16LE and naive UTF-8 reads
 * mangle them. UTF-16 is decoded manually so no environment support is assumed.
 */
export function decodeStatementBytes(bytes: Uint8Array): {
  text: string;
  encoding: "utf-8" | "utf-16le" | "utf-16be";
} {
  if (bytes.length >= 2) {
    const b0 = bytes[0]!;
    const b1 = bytes[1]!;
    if (b0 === 0xff && b1 === 0xfe) return { text: decodeUtf16(bytes.subarray(2), true), encoding: "utf-16le" };
    if (b0 === 0xfe && b1 === 0xff) return { text: decodeUtf16(bytes.subarray(2), false), encoding: "utf-16be" };
  }
  return { text: new TextDecoder("utf-8").decode(bytes), encoding: "utf-8" };
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  const units = new Array<number>(Math.floor(bytes.length / 2));
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    units[i / 2] = littleEndian ? bytes[i]! | (bytes[i + 1]! << 8) : (bytes[i]! << 8) | bytes[i + 1]!;
  }
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < units.length; i += CHUNK) {
    out += String.fromCharCode(...units.slice(i, i + CHUNK));
  }
  return out;
}

/* ---- Delimiter sniffing ------------------------------------------------- */

const DELIMITERS: Delimiter[] = [",", ";", "\t", "|"];

/** Count cells of one line under a delimiter, respecting double quotes. */
function countCells(line: string, delimiter: Delimiter): number {
  let count = 1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === delimiter && !inQuotes) count++;
  }
  return count;
}

/**
 * Pick the delimiter whose column counts are most consistent across the
 * first non-empty lines. Multi-section statements have varying widths, so
 * the score rewards the modal count, not perfect uniformity.
 */
export function sniffDelimiter(text: string, sampleLines = 40): Delimiter {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(0, sampleLines);
  let best: Delimiter = ",";
  let bestScore = 0;
  for (const delimiter of DELIMITERS) {
    const counts = new Map<number, number>();
    for (const line of lines) {
      const cells = countCells(line, delimiter);
      if (cells > 1) counts.set(cells, (counts.get(cells) ?? 0) + 1);
    }
    let modalCount = 0;
    let modalLines = 0;
    for (const [cells, occurrences] of counts) {
      if (occurrences > modalLines || (occurrences === modalLines && cells > modalCount)) {
        modalLines = occurrences;
        modalCount = cells;
      }
    }
    const score = modalLines * modalCount;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

/* ---- Tokenizer ---------------------------------------------------------- */

export type TokenizedText = {
  rows: string[][];
  /** 1-based source line each row STARTS on (quoted cells can span lines). */
  rowLines: number[];
};

/**
 * Tokenize delimited text with full quote handling: quoted cells may contain
 * the delimiter, doubled quotes, and newlines. An unterminated quote at end
 * of input is recovered (the rest becomes the cell) and reported instead of
 * thrown. Raw cell text is preserved; cleaning happens in cleanCell.
 */
export function tokenizeDelimited(text: string, delimiter: Delimiter, issues: StatementIssue[]): TokenizedText {
  const rows: string[][] = [];
  const rowLines: number[] = [];

  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;
  let rowSaw = false;

  const pushCell = (): void => {
    row.push(cell);
    cell = "";
  };
  const pushRow = (): void => {
    pushCell();
    rows.push(row);
    rowLines.push(rowStartLine);
    row = [];
    rowStartLine = line;
    rowSaw = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line++;
        if (ch !== "\r") cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      rowSaw = true;
      continue;
    }
    if (ch === delimiter) {
      pushCell();
      rowSaw = true;
      continue;
    }
    if (ch === "\n") {
      line++;
      pushRow();
      continue;
    }
    if (ch !== "\r") {
      cell += ch;
      rowSaw = true;
    }
  }
  if (inQuotes) {
    addIssue(
      issues,
      "warning",
      "unterminated-quote",
      "A quoted cell never closes; the rest of the input was read as that cell. Check the file for a " +
        'stray double quote (").',
      { row: rowStartLine },
    );
  }
  if (cell.length > 0 || row.length > 0 || rowSaw) pushRow();

  return { rows, rowLines };
}

/* ---- Cell cleaning and defensive numbers -------------------------------- */

/**
 * Normalize one raw cell: trim, unwrap the Excel text guard (="00123") and
 * turn non-breaking spaces into spaces.
 */
export function cleanCell(raw: string): string {
  let s = raw.replace(/\u00a0/g, " ").trim();
  const guard = /^="(.*)"$/.exec(s);
  if (guard !== null) s = guard[1]!.trim();
  return s;
}

const CURRENCY_CHARS = /[$€£¥₣₹]/g;
const CURRENCY_CODE_SUFFIX = /\s+(usd|usdt|usdc|eur|gbp|jpy|aud|cad|chf|nzd)$/i;

/**
 * Parse one numeric cell defensively. Handles currency symbols and trailing
 * currency codes, parentheses negatives, Unicode minus (U+2212), percent
 * suffixes, and thousands separators in the three real conventions:
 * "1,234.56", "1.234,56", and "1 000.00". A single dot is ALWAYS a decimal
 * point (217.131 is a GBPJPY price, not 217131): dots become thousands
 * separators only with two or more dot groups or a decimal comma present.
 * Returns null for empty/placeholder cells and anything non-finite.
 */
export function parseNumberCell(raw: string): number | null {
  let s = cleanCell(raw);
  if (isEmptyCell(s)) return null;

  let negative = false;
  const parens = /^\((.*)\)$/.exec(s);
  if (parens !== null) {
    negative = true;
    s = parens[1]!.trim();
  }
  s = s.replace(/−/g, "-").replace(CURRENCY_CHARS, "").replace(CURRENCY_CODE_SUFFIX, "").trim();
  s = s.replace(/\s*[%]$/, "").trim();
  s = s.replace(/ /g, "");
  if (s === "" || s === "-" || s === "+") return null;

  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;
  if (dots > 0 && commas > 0) {
    const decimalSep = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    const thousandsSep = decimalSep === "." ? "," : ".";
    s = s.split(thousandsSep).join("");
    if (decimalSep === ",") s = s.replace(",", ".");
  } else if (commas > 0) {
    if (commas > 1) {
      s = s.split(",").join("");
    } else {
      const after = s.length - s.indexOf(",") - 1;
      if (after === 3) s = s.replace(",", "");
      else s = s.replace(",", ".");
    }
  } else if (dots >= 2) {
    s = s.split(".").join("");
  }

  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/**
 * Parse a volume cell that may render as "filled / ordered" ("0.06 / 0.06",
 * MetaTrader 5 deals): the first number is the filled volume.
 */
export function parseVolumeCell(raw: string): number | null {
  const s = cleanCell(raw);
  const slash = s.indexOf("/");
  return parseNumberCell(slash >= 0 ? s.slice(0, slash) : s);
}

/**
 * Neutralize spreadsheet formula injection in a RETAINED text field (symbol,
 * account id): a leading =, @, tab, or CR, or a +/- prefix on non-numeric
 * content, turns the cell into a formula when the result is re-exported to a
 * spreadsheet. Strips the dangerous prefix.
 */
export function neutralizeText(raw: string): string {
  let s = cleanCell(raw);
  while (s.length > 0) {
    const first = s[0]!;
    if (first === "=" || first === "@" || first === "\t" || first === "\r") {
      s = s.slice(1).trimStart();
      continue;
    }
    if ((first === "+" || first === "-") && !/^[+-]\d/.test(s)) {
      s = s.slice(1).trimStart();
      continue;
    }
    break;
  }
  return s;
}
