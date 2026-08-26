import { MissingCredentialsError } from "../errors.js";
import type { Account, Position, Trade } from "../schema.js";
import { asFiniteNumber, rejectResponse } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  Hyperliquid, read-only via the user's public wallet address — no API key
  at all. The exchange's public info endpoint serves balances, positions,
  and fills for any address (POST /info with clearinghouseState /
  spotClearinghouseState / userFills, per the official SDK), so the
  connection holds nothing that could ever trade or move funds. Perps and
  spot come back as two accounts.
*/

const HYPERLIQUID_API = "https://api.hyperliquid.xyz";
const WALLET_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

type HlMarginSummary = { accountValue?: string };
type HlClearinghouseState = {
  marginSummary?: HlMarginSummary;
  assetPositions?: { position?: { coin?: string; szi?: string; positionValue?: string } }[];
};
type HlSpotState = { balances?: { coin?: string; total?: string; entryNtl?: string }[] };
type HlFill = {
  coin?: string;
  px?: string;
  sz?: string;
  side?: string;
  time?: number;
  fee?: string;
};

export type HyperliquidRaw = {
  /** Lowercased 0x wallet address the states belong to. */
  address: string;
  perps: HlClearinghouseState;
  spot: HlSpotState;
  fills: HlFill[];
};

/** Pure mapper from Hyperliquid fills ("B" bids buy, "A" asks sell) to trades. */
export const parseHyperliquidFills = (fills: HlFill[]): Trade[] => {
  const trades: Trade[] = [];
  for (const fill of fills) {
    const side = fill.side === "B" ? "buy" : fill.side === "A" ? "sell" : null;
    const quantity = Math.abs(asFiniteNumber(fill.sz) ?? 0);
    const price = asFiniteNumber(fill.px) ?? 0;
    if (!fill.coin || !side || quantity <= 0 || price <= 0) continue;
    const fee = Math.abs(asFiniteNumber(fill.fee) ?? 0);
    trades.push({
      symbol: fill.coin,
      side,
      quantity,
      price,
      ...(fee > 0 ? { fee } : {}),
      ...(fill.time ? { executedAt: new Date(fill.time).toISOString() } : {}),
    });
  }
  return trades;
};

const normalize = (raw: HyperliquidRaw): Account[] => {
  const address = raw.address.toLowerCase();

  const perpsPositions: Position[] = [];
  for (const entry of raw.perps.assetPositions ?? []) {
    const position = entry.position;
    const quantity = asFiniteNumber(position?.szi);
    if (!position?.coin || quantity === undefined || quantity === 0) continue;
    const marketValue = asFiniteNumber(position.positionValue);
    // Perp positions are perpetual futures, whatever the underlying coin.
    perpsPositions.push({
      symbol: position.coin,
      quantity,
      ...(marketValue !== undefined ? { marketValue } : {}),
      assetClass: "futures",
    });
  }

  const spotPositions: Position[] = [];
  let spotEquity = 0;
  for (const balance of raw.spot.balances ?? []) {
    const quantity = asFiniteNumber(balance.total);
    if (!balance.coin || quantity === undefined || quantity === 0) continue;
    // Stables are worth face value; other coins only report entry notional.
    const marketValue =
      balance.coin === "USDC" || balance.coin === "USDT" ? quantity : asFiniteNumber(balance.entryNtl);
    if (marketValue !== undefined) spotEquity += marketValue;
    spotPositions.push({
      symbol: balance.coin,
      quantity,
      ...(marketValue !== undefined ? { marketValue } : {}),
      assetClass: "crypto",
    });
  }

  const shortAddress = `${address.slice(0, 6)}…${address.slice(-4)}`;
  const accounts: Account[] = [
    {
      id: `${address}-perps`,
      name: `Hyperliquid Perps ${shortAddress}`,
      currency: "USD",
      equity: asFiniteNumber(raw.perps.marginSummary?.accountValue) ?? 0,
      positions: perpsPositions,
      trades: parseHyperliquidFills(Array.isArray(raw.fills) ? raw.fills : []),
    },
  ];
  if (spotPositions.length > 0) {
    accounts.push({
      id: `${address}-spot`,
      name: `Hyperliquid Spot ${shortAddress}`,
      currency: "USD",
      equity: spotEquity,
      positions: spotPositions,
      trades: [],
    });
  }

  return accounts;
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext) => {
  const { walletAddress } = credentials;
  if (!walletAddress || !WALLET_ADDRESS_PATTERN.test(walletAddress)) {
    throw new MissingCredentialsError("hyperliquid", "Hyperliquid connection needs a 0x wallet address");
  }
  const address = walletAddress.toLowerCase();

  const info = async <T>(body: Record<string, string>): Promise<T> => {
    const response = await ctx.fetch(`${HYPERLIQUID_API}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) rejectResponse("hyperliquid", "Hyperliquid", response);
    return (await response.json()) as T;
  };

  const [perps, spot, fills] = await Promise.all([
    info<HlClearinghouseState>({ type: "clearinghouseState", user: address }),
    info<HlSpotState>({ type: "spotClearinghouseState", user: address }),
    info<HlFill[]>({ type: "userFills", user: address }),
  ]);

  return { raw: { address, perps, spot, fills } };
};

export const hyperliquid: BrokerAdapter<HyperliquidRaw> = {
  id: "hyperliquid",
  displayName: "Hyperliquid",
  credentials: [{ key: "walletAddress", label: "Wallet address (0x…)", secret: false }],
  readOnlySetup:
    "No API key at all — the public info endpoint serves any wallet address, so the connection holds nothing that could ever trade or move funds.",
  fetchRaw,
  normalize,
};
