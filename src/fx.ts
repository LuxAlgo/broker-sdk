/*
  Optional USD normalization for aggregate stats across mixed-currency
  accounts. Explicit and opt-in: `getUsdRates` calls frankfurter.dev (daily
  ECB reference rates, keyless) — the SDK never makes this request on its
  own, only when you call it. Fail-soft: with no rate available an amount
  passes through unconverted, which beats making money disappear from a
  total.
*/

const FRANKFURTER_URL = "https://api.frankfurter.dev/v1/latest?base=USD";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

let cached: { rates: Record<string, number>; fetchedAt: number } | null = null;

/**
 * Daily USD reference rates (currency code → units per USD), cached
 * in-process for 12 hours. Returns the stale cache — or `{}` — on failure.
 */
export const getUsdRates = async (fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<Record<string, number>> => {
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.rates;
  }
  try {
    const response = await fetchImpl(FRANKFURTER_URL);
    if (response.ok) {
      const body = (await response.json()) as { rates?: Record<string, number> };
      const rates = body.rates ?? {};
      if (Object.keys(rates).length > 0) {
        cached = { rates, fetchedAt: Date.now() };
      }
    }
  } catch {
    // Stale rates (or none) beat a failed computation.
  }
  return cached?.rates ?? {};
};

/** Pure: scale an amount from `currency` into USD; USD and unknown currencies pass through. */
export const toUsd = (amount: number, currency: string, usdRates: Record<string, number>): number => {
  if (!currency || currency.toUpperCase() === "USD") return amount;
  const rate = usdRates[currency.toUpperCase()];
  return rate !== undefined && Number.isFinite(rate) && rate > 0 ? amount / rate : amount;
};
