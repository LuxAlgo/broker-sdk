import { BrokerError } from "../errors.js";

/** Validated once per connection/parser call; never infer a zone from the exchange. */
export const ibkrTimeZone = (value: string | undefined): string => {
  if (value === undefined) return "UTC";
  try {
    if (typeof value !== "string" || !value.trim() || /^[+-]/.test(value)) throw new Error("invalid timezone");
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new BrokerError("ibkr-flex", "Enter a valid IANA statement timezone for IBKR Flex.");
  }
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const utc = (year: number, month: number, day: number, hour: number, minute: number, second: number, ms = 0): number => {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, ms);
  return date.getTime();
};

/** A statement-scoped parser keeps formatter/offset work bounded by its distinct days. */
export const ibkrTimestampParser = (timeZone: string): ((raw: string | undefined) => string | undefined) => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const wallAt = (instant: number): number => {
    const parts = formatter.formatToParts(new Date(instant));
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value);
    return utc(get("year"), get("month"), get("day"), get("hour"), get("minute"), get("second"));
  };
  const offsetsByDay = new Map<number, Set<number>>();

  return (raw) => {
    if (!raw) return undefined;
    const text = raw.trim();
    // Existing compact Flex formats and ISO timestamps with an optional explicit offset.
    const match = text.match(/^(\d{4})(\d{2})(\d{2})(?:[;, ](\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?\s*(Z|[+-]\d{2}:?\d{2})?)?$/)
      ?? text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/);
    if (!match) return undefined;
    const [, y, mo, d, h = "00", mi = "00", s = "00", fraction = "", zone] = match;
    const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number);
    const milliseconds = Number(fraction.padEnd(3, "0"));
    const wall = utc(year!, month!, day!, hour!, minute!, second!, milliseconds);
    const check = new Date(wall);
    if (year! < 1 || check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month
      || check.getUTCDate() !== day || check.getUTCHours() !== hour
      || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) return undefined;

    if (zone) {
      let offset = 0;
      if (zone !== "Z") {
        const digits = zone.slice(1).replace(":", "");
        const hours = Number(digits.slice(0, 2));
        const minutes = Number(digits.slice(2));
        if (hours > 23 || minutes > 59) return undefined;
        offset = (hours * 60 + minutes) * 60_000 * (zone[0] === "+" ? 1 : -1);
      }
      return new Date(wall - offset).toISOString();
    }
    if (timeZone === "UTC") return check.toISOString();

    const dayStart = Math.floor(wall / DAY) * DAY;
    let offsets = offsetsByDay.get(dayStart);
    if (!offsets) {
      offsets = new Set<number>();
      // Observe both sides of the local day, including whole-day timezone jumps.
      for (let hours = -36; hours <= 60; hours += 6) {
        const instant = dayStart + hours * HOUR;
        offsets.add(wallAt(instant) - instant);
      }
      offsetsByDay.set(dayStart, offsets);
    }
    const matches = [...offsets]
      .map(offset => wall - offset)
      .filter(instant => wallAt(instant - milliseconds) === wall - milliseconds);
    // A gap has no matching instant; a repeated hour has two. Neither can be guessed.
    return matches.length === 1 ? new Date(matches[0]!).toISOString() : undefined;
  };
};
