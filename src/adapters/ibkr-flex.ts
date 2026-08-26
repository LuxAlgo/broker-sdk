import { BrokerRequestError, MissingCredentialsError } from "../errors.js";
import type { Account, AssetClass, Position, Trade } from "../schema.js";
import { asFiniteNumber, rejectResponse } from "./http.js";
import type { BrokerAdapter, Credentials, FetchContext } from "./types.js";

/*
  Interactive Brokers via the Flex Web Service — real US equities/futures/
  forex coverage with no aggregator and no OAuth approval process. The user
  creates a Flex Query (Trades + Open Positions + Cash Report sections) and
  a Flex Web Service token in IBKR Account Management; both are read-only
  report credentials by design. Two-step fetch: SendRequest issues a
  reference code, GetStatement returns the XML report (with a short
  "generation in progress" window we retry through).
*/

const FLEX_BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";
const STATEMENT_RETRIES = 3;
const STATEMENT_RETRY_DELAY_MS = 2_500;

/** IBKR assetCategory attribute → normalized class ("CASH" is forex pairs). */
const FLEX_ASSET_CLASSES: Record<string, AssetClass> = {
  STK: "equity",
  OPT: "option",
  FOP: "option",
  FUT: "futures",
  CASH: "forex",
  CRYPTO: "crypto",
  CFD: "other",
  WAR: "other",
};

const attr = (attrs: Record<string, string>, ...names: string[]): string | undefined => {
  for (const name of names) {
    const value = attrs[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
};

/** Every attribute map for self-closing/opening tags with the given name. */
const elements = (xml: string, tag: string): Record<string, string>[] => {
  const matches = xml.matchAll(new RegExp(`<${tag}\\s([^>]*?)/?>`, "g"));
  const parsed: Record<string, string>[] = [];
  for (const match of matches) {
    const attrs: Record<string, string> = {};
    for (const pair of (match[1] ?? "").matchAll(/([\w-]+)="([^"]*)"/g)) {
      const key = pair[1];
      if (key !== undefined) attrs[key] = pair[2] ?? "";
    }
    parsed.push(attrs);
  }
  return parsed;
};

const tagText = (xml: string, tag: string): string | undefined => {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match?.[1]?.trim() || undefined;
};

/** "20260815" or "20260815;101530" → ISO timestamp. */
const flexDateToIso = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})(?:[;, ](\d{2})(\d{2})(\d{2}))?$/);
  if (!match) return undefined;
  const [, year, month, day, hours = "00", minutes = "00", seconds = "00"] = match;
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.000Z`;
};

export type ParsedFlexStatement = {
  accountId: string | null;
  trades: Trade[];
  positions: Position[];
  /** Base-currency ending cash, when the query includes a Cash Report. */
  cash: number | null;
};

/**
 * Pure parser for a Flex statement. Tolerant on purpose — the sections
 * present depend on how the user configured the query, so anything missing
 * simply yields an empty list rather than an error.
 */
export const parseFlexStatement = (xml: string): ParsedFlexStatement => {
  const statement = elements(xml, "FlexStatement")[0];
  const accountId = statement ? (attr(statement, "accountId") ?? null) : null;

  const trades: Trade[] = [];
  for (const trade of elements(xml, "Trade")) {
    const symbol = attr(trade, "symbol");
    const side = attr(trade, "buySell")?.toUpperCase();
    const quantityRaw = asFiniteNumber(attr(trade, "quantity"));
    const price = asFiniteNumber(attr(trade, "tradePrice"));
    if (!symbol || (side !== "BUY" && side !== "SELL") || quantityRaw === undefined || price === undefined) {
      continue;
    }
    // IBKR reports sells as negative quantities; sides carry the direction.
    const quantity = Math.abs(quantityRaw);
    if (quantity <= 0 || price <= 0) continue;
    const commission = asFiniteNumber(attr(trade, "ibCommission"));
    const executedAt = flexDateToIso(attr(trade, "dateTime", "tradeDate"));
    trades.push({
      symbol,
      side: side === "BUY" ? "buy" : "sell",
      quantity,
      price,
      ...(commission !== undefined ? { fee: Math.abs(commission) } : {}),
      ...(executedAt ? { executedAt } : {}),
    });
  }

  const positions: Position[] = [];
  for (const position of elements(xml, "OpenPosition")) {
    const symbol = attr(position, "symbol");
    const quantity = asFiniteNumber(attr(position, "position"));
    if (!symbol || quantity === undefined || quantity === 0) continue;
    const markPrice = asFiniteNumber(attr(position, "markPrice"));
    const marketValue = markPrice !== undefined ? quantity * markPrice : undefined;
    const averageEntryPrice = asFiniteNumber(attr(position, "costBasisPrice", "openPrice"));
    const assetCategory = attr(position, "assetCategory");
    const assetClass = assetCategory ? FLEX_ASSET_CLASSES[assetCategory] : undefined;
    positions.push({
      symbol,
      quantity,
      ...(marketValue !== undefined ? { marketValue } : {}),
      ...(averageEntryPrice !== undefined ? { averageEntryPrice } : {}),
      ...(assetClass ? { assetClass } : {}),
    });
  }

  let cash: number | null = null;
  for (const report of elements(xml, "CashReportCurrency")) {
    if (attr(report, "currency") === "BASE_SUMMARY") {
      const endingCash = asFiniteNumber(attr(report, "endingCash"));
      if (endingCash !== undefined) cash = endingCash;
    }
  }

  return { accountId, trades, positions, cash };
};

const flexError = (xml: string): string | null => {
  const code = tagText(xml, "ErrorCode") ?? tagText(xml, "code");
  const message = tagText(xml, "ErrorMessage") ?? tagText(xml, "message");
  if (!code && !message) return null;
  return message ?? `Flex error ${code}`;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type IbkrFlexRaw = {
  statementXml: string;
};

const normalize = (raw: IbkrFlexRaw): Account[] => {
  const parsed = parseFlexStatement(raw.statementXml);
  const positionsValue = parsed.positions.reduce((sum, position) => sum + (position.marketValue ?? 0), 0);
  const equity = positionsValue + (parsed.cash ?? 0);

  return [
    {
      id: parsed.accountId ?? "ibkr-flex",
      name: parsed.accountId ? `Interactive Brokers ${parsed.accountId}` : "Interactive Brokers",
      currency: "USD",
      equity,
      ...(parsed.cash !== null ? { cash: parsed.cash } : {}),
      positions: parsed.positions,
      trades: parsed.trades,
    },
  ];
};

const fetchRaw = async (credentials: Credentials, ctx: FetchContext) => {
  const { flexToken, flexQueryId } = credentials;
  if (!flexToken || !flexQueryId) {
    throw new MissingCredentialsError("ibkr-flex", "Interactive Brokers connection is missing its Flex token or query ID");
  }

  const requestUrl = `${FLEX_BASE}/SendRequest?t=${encodeURIComponent(flexToken)}&q=${encodeURIComponent(flexQueryId)}&v=3`;
  const requestResponse = await ctx.fetch(requestUrl);
  if (!requestResponse.ok) rejectResponse("ibkr-flex", "Interactive Brokers", requestResponse);
  const requestXml = await requestResponse.text();
  if (tagText(requestXml, "Status") !== "Success") {
    throw new BrokerRequestError("ibkr-flex", flexError(requestXml) ?? "Interactive Brokers rejected the Flex request");
  }
  const referenceCode = tagText(requestXml, "ReferenceCode");
  const statementBase = tagText(requestXml, "Url") ?? `${FLEX_BASE}/GetStatement`;
  if (!referenceCode) {
    throw new BrokerRequestError("ibkr-flex", "Interactive Brokers did not return a statement reference");
  }

  let statementXml = "";
  for (let attempt = 0; attempt < STATEMENT_RETRIES; attempt += 1) {
    const statementResponse = await ctx.fetch(
      `${statementBase}?t=${encodeURIComponent(flexToken)}&q=${encodeURIComponent(referenceCode)}&v=3`,
    );
    if (!statementResponse.ok) rejectResponse("ibkr-flex", "Interactive Brokers", statementResponse);
    statementXml = await statementResponse.text();
    // 1019: statement generation still in progress — wait and re-ask.
    const stillGenerating =
      statementXml.includes("1019") && flexError(statementXml) !== null && !statementXml.includes("<FlexStatement");
    if (!stillGenerating) break;
    await sleep(STATEMENT_RETRY_DELAY_MS);
  }

  if (!statementXml.includes("<FlexStatement")) {
    throw new BrokerRequestError("ibkr-flex", flexError(statementXml) ?? "Interactive Brokers returned no statement");
  }

  return { raw: { statementXml } };
};

export const ibkrFlex: BrokerAdapter<IbkrFlexRaw> = {
  id: "ibkr-flex",
  displayName: "Interactive Brokers",
  credentials: [
    { key: "flexToken", label: "Flex Web Service token", secret: true },
    { key: "flexQueryId", label: "Flex query ID", secret: false },
  ],
  readOnlySetup:
    "In IBKR Account Management, create a Flex Query (Trades + Open Positions + Cash Report sections) and a Flex Web Service token — both are read-only report credentials by design.",
  fetchRaw,
  normalize,
};
