import { describe, expect, it } from "vitest";

import { toUsd } from "../src/fx.js";

describe("converting amounts into USD totals", () => {
  it("scales foreign-currency amounts by the daily rate and leaves USD untouched", () => {
    const rates = { EUR: 0.9, CAD: 1.35 };
    expect(toUsd(90, "EUR", rates)).toBeCloseTo(100);
    expect(toUsd(135, "CAD", rates)).toBeCloseTo(100);
    expect(toUsd(100, "USD", rates)).toBe(100);
    expect(toUsd(100, "usd", rates)).toBe(100);
  });

  it("passes an amount through unchanged rather than losing it when no rate exists", () => {
    expect(toUsd(500, "XYZ", { EUR: 0.9 })).toBe(500);
    expect(toUsd(500, "EUR", {})).toBe(500);
  });
});
