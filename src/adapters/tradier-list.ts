/**
 * Normalize Tradier's object-or-array-or-null collections to an array.
 * Tradier quirk: single-element collections come back as a bare object
 * instead of an array, empty ones as null or the string "null".
 */
export const tradierList = <T>(value: T | T[] | null | undefined | "null"): T[] => {
  if (value === null || value === undefined || value === "null") return [];
  return Array.isArray(value) ? value : [value];
};
