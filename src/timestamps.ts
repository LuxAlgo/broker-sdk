/** Split offset-bearing ISO timestamps before parsing so engines only see milliseconds. */
const timestampParts = (value: string | undefined | null) => {
  if (!value) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/i.exec(value);
  if (!match) return undefined;
  const fraction = (match[2] ?? "").padEnd(3, "0");
  const zone = match[3]!.toUpperCase().replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const milliseconds = Date.parse(`${match[1]!.toUpperCase()}.${fraction.slice(0, 3)}${zone}`);
  if (!Number.isFinite(milliseconds)) return undefined;
  return { iso: new Date(milliseconds).toISOString(), fraction, milliseconds };
};

/** Canonical UTC timestamp retaining all source fractional digits (at least three). */
export const asPreciseIsoTimestamp = (value: string | undefined | null): string | undefined => {
  const parts = timestampParts(value);
  return parts?.iso.replace(/\.\d{3}Z$/, `.${parts.fraction}Z`);
};

/** Compare instants without losing sub-millisecond digits or misordering shorter fractions. */
export const compareIsoTimestamps = (left: string = "", right: string = ""): number => {
  const a = timestampParts(left);
  const b = timestampParts(right);
  // Preserve the existing ordering of missing or non-ISO timestamps.
  if (!a || !b) return left.localeCompare(right);
  if (a.milliseconds !== b.milliseconds) return a.milliseconds - b.milliseconds;
  const width = Math.max(a.fraction.length, b.fraction.length);
  const aFraction = a.fraction.padEnd(width, "0");
  const bFraction = b.fraction.padEnd(width, "0");
  return aFraction < bFraction ? -1 : aFraction > bFraction ? 1 : 0;
};
