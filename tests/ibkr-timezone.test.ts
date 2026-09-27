import { describe, expect, it, vi } from "vitest";
import { connect } from "../src/index.js";
import { parseFlexStatement } from "../src/adapters/ibkr-flex.js";

const xml = (raw: string, attribute = "dateTime") =>
  `<FlexQueryResponse><FlexStatement accountId="U_TEST"><Trade symbol="MCL" buySell="BUY" quantity="1" tradePrice="70" ibCommission="-1" ${attribute}="${raw}" /></FlexStatement></FlexQueryResponse>`;
const time = (raw: string, statementTimeZone?: string, attribute?: string) =>
  parseFlexStatement(xml(raw, attribute), statementTimeZone === undefined ? {} : { statementTimeZone }).trades[0]?.executedAt;

describe("IBKR statement timestamps", () => {
  it.each([
    ["20260918;085905", undefined, "2026-09-18T08:59:05.000Z"],
    ["20260918;085905", "UTC", "2026-09-18T08:59:05.000Z"],
    ["20260918;085905", "America/New_York", "2026-09-18T12:59:05.000Z"],
    ["20260918;100830", "America/New_York", "2026-09-18T14:08:30.000Z"],
    ["20260118;085905", "America/New_York", "2026-01-18T13:59:05.000Z"],
    ["20260918;085905", "Europe/Rome", "2026-09-18T06:59:05.000Z"],
    ["20260918;085905", "Pacific/Kiritimati", "2026-09-17T18:59:05.000Z"],
    ["20260918;085905", "Asia/Kathmandu", "2026-09-18T03:14:05.000Z"],
    ["20260918;085905", "US/Eastern", "2026-09-18T12:59:05.000Z"],
    ["20260918,085905", "America/New_York", "2026-09-18T12:59:05.000Z"],
    ["20260918 085905", "America/New_York", "2026-09-18T12:59:05.000Z"],
    ["20260918;085905.125", "America/New_York", "2026-09-18T12:59:05.125Z"],
    ["20260918", "America/New_York", "2026-09-18T04:00:00.000Z"],
    ["20260308;015959", "America/New_York", "2026-03-08T06:59:59.000Z"],
    ["20260308;030000", "America/New_York", "2026-03-08T07:00:00.000Z"],
    ["20261101;020000", "America/New_York", "2026-11-01T07:00:00.000Z"],
  ])("normalizes %s in %s", (raw, zone, expected) => expect(time(raw, zone)).toBe(expected));

  it.each([
    ["20260918;085905Z", "2026-09-18T08:59:05.000Z"],
    ["20260918;085905-0400", "2026-09-18T12:59:05.000Z"],
    ["20260918;085905+05:45", "2026-09-18T03:14:05.000Z"],
    ["2026-09-18T08:59:05.125-04:00", "2026-09-18T12:59:05.125Z"],
    ["2026-11-01T01:30:00-04:00", "2026-11-01T05:30:00.000Z"],
    ["2026-11-01T01:30:00-05:00", "2026-11-01T06:30:00.000Z"],
  ])("honors explicit offsets in %s regardless of the setting", (raw, expected) => {
    for (const zone of ["UTC", "America/New_York", "Pacific/Kiritimati"])
      expect(time(raw, zone)).toBe(expected);
  });

  it.each([
    ["20260308;023000", "America/New_York"],
    ["20261101;013000", "America/New_York"],
    ["20261004;021500", "Australia/Lord_Howe"],
    ["20260405;014500", "Australia/Lord_Howe"],
    ["20111230;120000", "Pacific/Apia"],
  ])("leaves a gap or repeated local time unresolved: %s in %s", (raw, zone) => {
    const trade = parseFlexStatement(xml(raw), { statementTimeZone: zone }).trades[0]!;
    expect(trade).toMatchObject({ symbol: "MCL", quantity: 1, price: 70, fee: 1 });
    expect(trade).not.toHaveProperty("executedAt");
  });

  it.each(["", "20260230;085905", "20260918;240000", "20260918;086005", "20260918;085960",
    "20260918;085905 EST", "20260918;085905 Mars/Olympus", "20260918;085905+24:00",
    "20260918;085905+01:60", "2026-02-30T08:59:05Z", "00000918;085905"])(
    "omits unusable timestamps without inventing an instant: %s", raw => expect(time(raw, "UTC")).toBeUndefined(),
  );

  it("retains the date-only fallback when the time is missing", () => {
    expect(time("20260918", undefined, "tradeDate")).toBe("2026-09-18T00:00:00.000Z");
  });

  it.each(["", "Mars/Olympus", "+01:00", null, 42])("rejects invalid configured zone %s before network access", zone => {
    const fetch = vi.fn();
    const options = { statementTimeZone: zone as string };
    expect(() => parseFlexStatement(xml("20260918;085905"), options)).toThrow(/IANA statement timezone/);
    expect(() => connect({ broker: "ibkr-flex", credentials: { flexToken: "test", flexQueryId: "test" }, fetch, ...options }))
      .toThrow(/IANA statement timezone/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes the configured zone through a real connection and normalization", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("<FlexStatementResponse><Status>Success</Status><ReferenceCode>test</ReferenceCode></FlexStatementResponse>"))
      .mockResolvedValueOnce(new Response(xml("20260918;085905")));
    const snapshot = await connect({ broker: "ibkr-flex", credentials: { flexToken: "test", flexQueryId: "test" },
      statementTimeZone: "America/New_York", fetch }).fetchSnapshot();
    expect(snapshot.accounts[0]!.trades[0]!.executedAt).toBe("2026-09-18T12:59:05.000Z");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not apply statement timezone options to other brokers", () => {
    expect(() => connect({ broker: "alpaca", credentials: { apiKey: "test", apiSecret: "test" }, statementTimeZone: "Mars/Olympus" }))
      .not.toThrow();
  });
});
