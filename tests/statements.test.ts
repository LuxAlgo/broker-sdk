import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseStatement, TRADINGVIEW_PLACEHOLDER_SYMBOL } from "../src/statements/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "statements");
const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));
const fixtureText = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const codes = (result: { issues: { code: string }[] }): string[] => result.issues.map((issue) => issue.code);

describe("MetaTrader statements (MT4 CSV, MT4 HTML, MT5 history Positions)", () => {
  it("turns each closed statement row into an entry fill and an exit fill on opposite sides", () => {
    const result = parseStatement(fixtureText("mt4-statement.csv"));
    expect(result.format).toBe("metatrader");
    expect(result.trades).toHaveLength(6);
    const [entry1, exit1, entry2, exit2, entry3, exit3] = result.trades;
    expect(entry1).toMatchObject({ symbol: "EURUSD", side: "buy", quantity: 0.5, price: 1.085 });
    expect(entry1!.executedAt).toBe("2026-02-02T10:15:00.000Z");
    expect(entry1!.fee).toBeUndefined();
    expect(exit1).toMatchObject({ symbol: "EURUSD", side: "sell", quantity: 0.5, price: 1.09 });
    expect(exit1!.executedAt).toBe("2026-02-02T14:30:00.000Z");
    expect(entry2).toMatchObject({ symbol: "EURUSD", side: "sell", price: 1.092 });
    expect(exit2).toMatchObject({ symbol: "EURUSD", side: "buy", price: 1.0945 });
    expect(entry3).toMatchObject({ symbol: "GBPUSD", side: "buy", quantity: 1, price: 1.265 });
    expect(exit3).toMatchObject({ symbol: "GBPUSD", side: "sell", quantity: 1, price: 1.27 });
  });

  it("attaches the statement's combined commission, taxes, and swap to the closing fill and says so", () => {
    const result = parseStatement(fixtureText("mt4-statement.csv"));
    const exits = result.trades.filter((trade) => trade.fee !== undefined);
    expect(exits.map((trade) => trade.fee)).toEqual([
      expect.closeTo(3.7, 10), // -3.50 commission, -0.20 swap
      expect.closeTo(3.5, 10),
      expect.closeTo(7.3, 10),
    ]);
    expect(codes(result)).toContain("fees-on-closing-fill");
  });

  it("skips pending orders and balance ledger rows loudly instead of importing them as trades", () => {
    const result = parseStatement(fixtureText("mt4-statement.csv"));
    expect(result.skippedRows).toBe(2); // one "buy limit", one "balance"
    expect(codes(result)).toContain("pending-orders-skipped");
    expect(codes(result)).toContain("ledger-rows-skipped");
  });

  it("reads MetaTrader's UTF-16LE HTML report from raw bytes and tags fills with the disclosed account", () => {
    const result = parseStatement(fixtureBytes("mt4-report.html"));
    expect(result.format).toBe("metatrader");
    expect(codes(result)).toContain("decoded-by-bom");
    expect(result.account).toEqual({ id: "12345", currency: "USD" });
    expect(result.trades.every((trade) => trade.accountId === "12345")).toBe(true);
    // 2 closed trades (2 fills each) + 1 open trade (entry fill only).
    expect(result.trades).toHaveLength(5);
    const exit1 = result.trades[1]!;
    expect(exit1).toMatchObject({ symbol: "EURUSD", side: "sell", price: 1.09 });
    expect(exit1.fee).toBeCloseTo(3.5, 10); // &minus;3.50 decodes to Unicode minus
  });

  it("imports an Open Trades section as entry fills only — the close-leg cells are a mark, not an execution", () => {
    const result = parseStatement(fixtureBytes("mt4-report.html"));
    const open = result.trades[result.trades.length - 1]!;
    expect(open).toMatchObject({ symbol: "USDJPY", side: "buy", quantity: 0.25, price: 155.2 });
    expect(open.executedAt).toBe("2026-02-06T09:30:00.000Z");
    expect(result.trades.filter((trade) => trade.symbol === "USDJPY")).toHaveLength(1);
    expect(codes(result)).toContain("open-trades-in-source");
  });

  it("prefers the MT5 history Positions section over its Deals section and survives the hidden comment cell", () => {
    const result = parseStatement(fixtureText("mt5-history.html"));
    expect(result.format).toBe("metatrader");
    expect(result.trades).toHaveLength(4);
    const [entry1, exit1, entry2, exit2] = result.trades;
    expect(entry1).toMatchObject({ symbol: "XAUUSD", side: "buy", quantity: 0.1, price: 2320.5 });
    // A misread hidden cell would shift every column after it.
    expect(exit1).toMatchObject({ symbol: "XAUUSD", side: "sell", quantity: 0.1, price: 2331 });
    expect(exit1!.fee).toBeCloseTo(0.7, 10);
    expect(entry2).toMatchObject({ side: "sell", price: 2340 });
    expect(exit2).toMatchObject({ side: "buy", price: 2335 });
    expect(exit2!.fee).toBeCloseTo(0.8, 10); // commission -0.70 plus swap -0.10
    expect(result.skippedRows).toBe(0);
  });
});

describe("MetaTrader 5 deals tables (the only trade data in tester reports)", () => {
  it("maps each buy/sell deal to one fill and never reads the cancelled-order noise above the Deals section", () => {
    const result = parseStatement(fixtureText("mt5-tester-deals.html"));
    expect(result.format).toBe("mt5-deals");
    expect(result.trades).toHaveLength(5);
    expect(result.trades.map((trade) => trade.side)).toEqual(["buy", "sell", "sell", "buy", "sell"]);
    expect(result.trades.map((trade) => trade.price)).toEqual([1.1, 1.105, 1.108, 1.106, 1.109]);
  });

  it("reads filled/ordered volumes ('0.06 / 0.06') as the filled amount and sums per-deal costs into the fee", () => {
    const result = parseStatement(fixtureText("mt5-tester-deals.html"));
    const [dealIn, dealOut] = result.trades;
    expect(dealIn!.quantity).toBeCloseTo(0.06, 10);
    expect(dealIn!.fee).toBeCloseTo(0.06, 10); // commission only on the opening leg
    expect(dealOut!.fee).toBeCloseTo(0.16, 10); // commission -0.06 plus swap -0.10 on the close
  });

  it("emits a reversal deal (in/out) as the single fill it is — FIFO replay downstream splits it correctly", () => {
    const result = parseStatement(fixtureText("mt5-tester-deals.html"));
    const reversal = result.trades[3]!;
    expect(reversal).toMatchObject({ symbol: "EURUSD", side: "buy" });
    expect(reversal.quantity).toBeCloseTo(0.16, 10);
    expect(codes(result)).not.toContain("deal-direction-mismatch");
  });

  it("skips the initial-deposit balance deal and counts it", () => {
    const result = parseStatement(fixtureText("mt5-tester-deals.html"));
    expect(result.skippedRows).toBe(1);
    expect(codes(result)).toContain("ledger-rows-skipped");
  });
});

describe("ThinkOrSwim account statements", () => {
  it("reads fills from Account Trade History and ignores the seven other sections, order history included", () => {
    const result = parseStatement(fixtureText("thinkorswim-account-statement.csv"));
    expect(result.format).toBe("thinkorswim");
    expect(result.trades).toHaveLength(23); // exactly the Trade History rows; REJECTED/CANCELED orders never counted
    const first = result.trades[0]!;
    expect(first).toMatchObject({ symbol: "TZA", side: "buy", quantity: 500, price: 3.8 });
    expect(first.executedAt).toBe("2026-07-02T13:31:05.000Z");
    expect(result.skippedRows).toBe(0);
  });

  it("matches Cash Balance fees back to fills by timestamp and symbol", () => {
    const result = parseStatement(fixtureText("thinkorswim-account-statement.csv"));
    const feed = result.trades.filter((trade) => trade.fee !== undefined);
    expect(feed).toHaveLength(3);
    expect(feed[0]).toMatchObject({ side: "sell", quantity: 500, price: 3.81 });
    expect(feed[0]!.fee).toBeCloseTo(0.29, 10);
    expect(feed[2]!.fee).toBeCloseTo(0.58, 10);
  });

  it("tags every fill with the account from the statement banner", () => {
    const result = parseStatement(fixtureText("thinkorswim-account-statement.csv"));
    expect(result.account).toEqual({ id: "462XXXXXX" });
    expect(result.trades.every((trade) => trade.accountId === "462XXXXXX")).toBe(true);
  });

  it("discloses that ambiguous 7/2/26 dates were read month-first when nothing in the file proves the order", () => {
    const result = parseStatement(fixtureText("thinkorswim-account-statement.csv"));
    expect(codes(result)).toContain("date-order-assumed");
    const asDayFirst = parseStatement(fixtureText("thinkorswim-account-statement.csv"), { dateOrder: "DMY" });
    expect(asDayFirst.trades[0]!.executedAt).toBe("2026-02-07T13:31:05.000Z");
  });
});

describe("TradingView strategy-tester trade lists", () => {
  it("emits each trade leg as one fill: the entry on the position's side, the exit opposite (gen 2)", () => {
    const result = parseStatement(fixtureText("tradingview-gen2.csv"));
    expect(result.format).toBe("tradingview");
    // Fills come out chronological even though the export lists exits first.
    expect(result.trades.map((trade) => [trade.side, trade.price, trade.quantity])).toEqual([
      ["buy", 86, 3], // trade 1, entry long
      ["sell", 101, 3], // trade 1, exit long
      ["sell", 95, 1], // trade 2, entry short
      ["buy", 105, 1], // trade 2, exit short: buying back
      ["buy", 100.2, 2], // trade 3, entry long
      ["sell", 110, 2], // trade 3, exit long
      ["buy", 102.5, 1], // trade 4, entry of a still-open trade
    ]);
    expect(result.trades[0]!.executedAt).toBe("2026-03-10T13:15:00.000Z");
  });

  it("drops the 'Open' placeholder exit row of a still-open trade but keeps its entry fill, and says so", () => {
    const result = parseStatement(fixtureText("tradingview-gen2.csv"));
    expect(result.trades).toHaveLength(7); // 3 closed trades x 2 legs + 1 open entry
    expect(codes(result)).toContain("open-trades-in-source");
    expect(result.skippedRows).toBe(0);
  });

  it("tags every fill with the disclosed placeholder symbol because the export names none", () => {
    const result = parseStatement(fixtureText("tradingview-gen2.csv"));
    expect(result.trades.every((trade) => trade.symbol === TRADINGVIEW_PLACEHOLDER_SYMBOL)).toBe(true);
    expect(codes(result)).toContain("symbol-missing");
  });

  it("reads the first-generation export the same way", () => {
    const result = parseStatement(fixtureText("tradingview-gen1.csv"));
    expect(result.format).toBe("tradingview");
    expect(result.trades.map((trade) => [trade.side, trade.price])).toEqual([
      ["sell", 1.088], // trade 1, entry short
      ["buy", 1.085], // trade 1, exit short
      ["buy", 1.085], // trade 2, entry long
      ["sell", 1.09], // trade 2, exit long
    ]);
  });
});

describe("fallback and refusal behavior", () => {
  it("falls back to the tolerant generic CSV parser when no statement format matches", () => {
    const result = parseStatement(
      ["Symbol,Side,Qty,Price,Date", "AAPL,BUY,10,150.50,2026-01-05", "AAPL,SELL,10,155.00,2026-02-01"].join("\n"),
    );
    expect(result.format).toBe("generic-csv");
    expect(result.trades).toHaveLength(2);
  });

  it("refuses unrecognizable input with an explanation instead of guessing", () => {
    const result = parseStatement("nothing tabular here\njust words\n");
    expect(result.format).toBe("unrecognized");
    expect(result.trades).toHaveLength(0);
    expect(result.issues.some((issue) => issue.severity === "error" && issue.code === "no-recognized-format")).toBe(
      true,
    );
  });

  it("gives the same file the same content hash so re-imports can upsert", () => {
    const text = fixtureText("mt4-statement.csv");
    expect(parseStatement(text).contentHash).toBe(parseStatement(text).contentHash);
    expect(parseStatement(text).contentHash).not.toBe(parseStatement(`${text}x`).contentHash);
  });

  it("never throws on garbage bytes", () => {
    const garbage = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x02, 0x03]);
    expect(() => parseStatement(garbage)).not.toThrow();
    expect(parseStatement(garbage).trades).toHaveLength(0);
  });
});
