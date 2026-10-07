import { describe, expect, it, vi } from "vitest";

import { asPreciseIsoTimestamp } from "../src/timestamps.js";
import { parseTopstepTrades } from "../src/adapters/topstep.js";
import { BrokerAuthError, connect } from "../src/index.js";

const fill = {
  contractId: "CON.F.US.MNQ.Z26",
  side: 1,
  size: 2,
  price: 20000,
  creationTimestamp: "2026-10-06T14:00:00Z",
};

describe("Topstep execution identity", () => {
  it("preserves three separate fills inside one millisecond without reordering them", () => {
    const rows = ["246377", "246373", "246367"].map((fraction, index) => ({
      ...fill,
      id: 100 + index,
      creationTimestamp: `2026-10-06T14:45:36.${fraction}+00:00`,
    }));
    const trades = parseTopstepTrades(rows);
    expect(trades.map((trade) => trade.executionId)).toEqual(["100", "101", "102"]);
    expect(trades.map((trade) => trade.executionTieBreak)).toEqual([100, 101, 102]);
    expect(trades.map((trade) => trade.executedAt)).toEqual(
      rows.map((row) => row.creationTimestamp.replace("+00:00", "Z")),
    );
    expect(trades.every((trade) => trade.instrumentId === fill.contractId)).toBe(true);
  });

  it.each([0, 42, Number.MAX_SAFE_INTEGER])("uses safe numeric ID %s as identity and tie-break key", (id) => {
    expect(parseTopstepTrades([{ ...fill, id }])[0]).toMatchObject({
      executionId: String(id),
      executionTieBreak: id,
    });
  });

  it.each(["native-fill", "00042", "9007199254740993", -1])("preserves ID %s without inferring an order key", (id) => {
    const trade = parseTopstepTrades([{ ...fill, id }])[0];
    expect(trade?.executionId).toBe(String(id));
    expect(trade).not.toHaveProperty("executionTieBreak");
  });

  it.each([undefined, "", 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
    "omits unusable ID %s without dropping the fill",
    (id) => {
      const row = { ...fill, ...(id !== undefined ? { id } : {}), orderId: 7 };
      const trades = parseTopstepTrades([row]);
      expect(trades).toHaveLength(1);
      expect(trades[0]).not.toHaveProperty("executionId");
      expect(trades[0]).not.toHaveProperty("executionTieBreak");
    },
  );

  it("keeps separate contract identities when display symbols match", () => {
    const trades = parseTopstepTrades([fill, { ...fill, contractId: "CON.F.US.MNQ.H27" }]);
    expect(trades.map((trade) => trade.symbol)).toEqual(["MNQ", "MNQ"]);
    expect(trades.map((trade) => trade.instrumentId)).toEqual([fill.contractId, "CON.F.US.MNQ.H27"]);
  });

  it("still filters voided and unreadable executions", () => {
    expect(parseTopstepTrades([
      { ...fill, voided: true },
      { ...fill, side: 9 },
      { ...fill, size: 0 },
      { ...fill, price: 0 },
      { ...fill, contractId: "" },
    ])).toEqual([]);
  });
});

describe("precise UTC timestamps", () => {
  it("never passes extended fractions to the engine's date parser", () => {
    const parse = Date.parse;
    const parser = vi.spyOn(Date, "parse").mockImplementation((value) =>
      /\.\d{4,}/.test(value) ? NaN : parse(value));
    try {
      expect(asPreciseIsoTimestamp("2026-10-06T08:45:36.123456789012-0600"))
        .toBe("2026-10-06T14:45:36.123456789012Z");
      expect(parser).toHaveBeenCalledExactlyOnceWith("2026-10-06T08:45:36.123-06:00");
    } finally {
      parser.mockRestore();
    }
  });

  it.each([
    ["2026-10-06T08:45:36.000007-06:00", "2026-10-06T14:45:36.000007Z"],
    ["2026-10-06T00:15:36.1234567+01:30", "2026-10-05T22:45:36.1234567Z"],
    ["2026-10-06T08:45:36.987654321-0600", "2026-10-06T14:45:36.987654321Z"],
    ["2026-10-06T14:45:36.000000Z", "2026-10-06T14:45:36.000000Z"],
    ["2026-10-06T14:45:36.12Z", "2026-10-06T14:45:36.120Z"],
    ["2026-10-06T14:45:36Z", "2026-10-06T14:45:36.000Z"],
  ])("normalizes %s without losing source precision", (source, expected) => {
    expect(asPreciseIsoTimestamp(source)).toBe(expected);
  });

  it.each([undefined, null, "", "not a timestamp", "2026-10-06T25:00:00.123456Z", "2026-10-06T14:45:36.123456"])(
    "omits invalid, missing or offset-less timestamp %s",
    (value) => expect(asPreciseIsoTimestamp(value)).toBeUndefined(),
  );
});

describe("Topstep reported costs and P&L", () => {
  it("adds fees and commissions and preserves reported gross P&L", () => {
    expect(parseTopstepTrades([{ ...fill, fees: 0.72, commissions: 0.5, profitAndLoss: 40 }])[0])
      .toMatchObject({ fee: 1.22, reportedGrossPnl: 40 });
  });

  it("preserves explicit zero costs and zero gross P&L", () => {
    expect(parseTopstepTrades([{ ...fill, fees: 0, commissions: 0, profitAndLoss: 0 }])[0])
      .toMatchObject({ fee: 0, reportedGrossPnl: 0 });
  });

  it.each([
    [{ fees: 0.72 }, 0.72],
    [{ commissions: 0.5 }, 0.5],
    [{ fees: 0 }, 0],
    [{ commissions: 0 }, 0],
    [{ fees: 0.72, commissions: 0.5 }, 1.22],
    [{ fees: NaN, commissions: 0.5 }, 0.5],
  ])("uses reported cost components %j", (costs, expected) => {
    expect(parseTopstepTrades([{ ...fill, ...costs }])[0]?.fee).toBe(expected);
  });

  it.each([
    { fees: -0.72 },
    { commissions: -0.5 },
    { fees: 0.72, commissions: -0.5 },
    { fees: -0.72, commissions: 0.5 },
  ])("omits costs with unexplained negative components %j", (costs) => {
    expect(parseTopstepTrades([{ ...fill, ...costs }])[0]).not.toHaveProperty("fee");
  });

  it("omits unknown or non-finite costs and null gross P&L", () => {
    for (const costs of [{}, { fees: NaN, commissions: Infinity }]) {
      const trade = parseTopstepTrades([{ ...fill, ...costs, profitAndLoss: null }])[0];
      expect(trade).not.toHaveProperty("fee");
      expect(trade).not.toHaveProperty("reportedGrossPnl");
    }
  });

  it("preserves losses and omits non-finite gross P&L", () => {
    expect(parseTopstepTrades([{ ...fill, profitAndLoss: -40 }])[0]?.reportedGrossPnl).toBe(-40);
    expect(parseTopstepTrades([{ ...fill, profitAndLoss: NaN }])[0]).not.toHaveProperty("reportedGrossPnl");
  });
});

describe("Topstep fetch responses", () => {
  it.each([null, [], 42, "invalid"])("rejects malformed HTTP-200 response %j with a typed error", async (body) => {
    const connection = connect({
      broker: "topstep",
      credentials: { userName: "synthetic", apiKey: "synthetic" },
      fetch: async () => Response.json(body),
    });
    await expect(connection.fetchSnapshot()).rejects.toMatchObject({
      name: "BrokerRequestError",
      message: "Topstep returned an invalid response for /Auth/loginKey",
    });
  });

  it("classifies HTTP authentication failures without guessing endpoint business error codes", async () => {
    const connection = connect({
      broker: "topstep",
      credentials: { userName: "synthetic", apiKey: "synthetic" },
      fetch: async (input) => String(input).endsWith("loginKey")
        ? Response.json({ success: true, token: "synthetic" })
        : Response.json({}, { status: 401 }),
    });
    await expect(connection.fetchSnapshot()).rejects.toThrow(BrokerAuthError);
  });

  it.each(["/Account/search", "/Position/searchOpen", "/Trade/search"])(
    "rejects HTTP 200 with success false from %s",
    async (failedPath) => {
      const connection = connect({
        broker: "topstep",
        credentials: { userName: "synthetic", apiKey: "synthetic" },
        fetch: async (input) => {
          const path = new URL(String(input)).pathname.replace(/^\/api/, "");
          if (path === failedPath) return Response.json({ success: false, errorMessage: "History unavailable" });
          if (path === "/Auth/loginKey") return Response.json({ success: true, token: "synthetic" });
          if (path === "/Account/search") return Response.json({ success: true, accounts: [{ id: 1 }] });
          return Response.json({ success: true, positions: [], trades: [] });
        },
      });
      await expect(connection.fetchSnapshot()).rejects.toMatchObject({
        name: "BrokerRequestError",
        message: "History unavailable",
      });
    },
  );

  it("uses a useful fallback when the provider omits its error message", async () => {
    const connection = connect({
      broker: "topstep",
      credentials: { userName: "synthetic", apiKey: "synthetic" },
      fetch: async (input) => Response.json(String(input).endsWith("loginKey")
        ? { success: true, token: "synthetic" }
        : { success: false, errorMessage: null }),
    });
    await expect(connection.fetchSnapshot()).rejects.toThrow("Topstep rejected /Account/search");
  });

  it("keeps failed login responses as authentication errors", async () => {
    const connection = connect({
      broker: "topstep",
      credentials: { userName: "synthetic", apiKey: "synthetic" },
      fetch: async () => Response.json({ success: false, token: "unusable", errorMessage: "Invalid key" }),
    });
    await expect(connection.fetchSnapshot()).rejects.toThrow(BrokerAuthError);
  });

  it("fetches every returned account and preserves its identity", async () => {
    const requestedAccounts: number[] = [];
    const connection = connect({
      broker: "topstep",
      credentials: { userName: "synthetic", apiKey: "synthetic" },
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("loginKey")) return Response.json({ success: true, token: "synthetic" });
        if (path.endsWith("Account/search")) return Response.json({ success: true, accounts: [{ id: 1 }, { id: 2 }] });
        if (path.endsWith("Trade/search")) {
          const { accountId } = JSON.parse(String(init?.body)) as { accountId: number };
          requestedAccounts.push(accountId);
          return Response.json({ success: true, trades: [{ ...fill, id: accountId }] });
        }
        return Response.json({ success: true, positions: [] });
      },
    });
    const snapshot = await connection.fetchSnapshot();
    expect(requestedAccounts).toEqual([1, 2]);
    expect(snapshot.accounts.map((account) => account.id)).toEqual(["1", "2"]);
    expect(snapshot.accounts.map((account) => account.trades[0]?.executionId)).toEqual(["1", "2"]);
  });
});
