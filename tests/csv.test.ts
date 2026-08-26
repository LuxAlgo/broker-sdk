import { describe, expect, it } from "vitest";

import { parseStatementCsv } from "../src/csv.js";

describe("importing a broker statement CSV", () => {
  it("reads trades from common broker column names regardless of casing", () => {
    const parsed = parseStatementCsv(
      ["Symbol,Side,Qty,Price,Date", "AAPL,BUY,10,150.50,2026-01-05", "AAPL,SELL,10,155.00,2026-02-01"].join("\n"),
    );
    expect(parsed.trades).toHaveLength(2);
    expect(parsed.trades[0]).toMatchObject({ symbol: "AAPL", side: "buy", quantity: 10, price: 150.5 });
    expect(parsed.skippedRows).toBe(0);
  });

  it("skips rows it cannot read instead of importing wrong numbers", () => {
    const parsed = parseStatementCsv(
      ["symbol,side,quantity,price", "AAPL,buy,10,150", "AAPL,transfer,10,150", "AAPL,buy,not-a-number,150"].join("\n"),
    );
    expect(parsed.trades).toHaveLength(1);
    expect(parsed.skippedRows).toBe(2);
  });

  it("imports nothing when the file lacks the required columns", () => {
    const parsed = parseStatementCsv(["foo,bar", "1,2"].join("\n"));
    expect(parsed.trades).toHaveLength(0);
  });

  it("handles quoted numbers with thousands separators and currency signs", () => {
    const parsed = parseStatementCsv(
      ['symbol,side,quantity,price', 'BTC,buy,"1,500","$0.05"'].join("\n"),
    );
    expect(parsed.trades[0]).toMatchObject({ symbol: "BTC", side: "buy", quantity: 1500, price: 0.05 });
  });

  it("gives the same file the same content hash so re-imports can upsert", () => {
    const csv = ["symbol,side,quantity,price", "AAPL,buy,1,100"].join("\n");
    expect(parseStatementCsv(csv).contentHash).toBe(parseStatementCsv(csv).contentHash);
    expect(parseStatementCsv(csv).contentHash).not.toBe(parseStatementCsv(`${csv}x`).contentHash);
  });
});
