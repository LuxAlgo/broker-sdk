import { BrokerAuthError, BrokerRequestError } from "../errors.js";

/**
 * Turn a non-OK response into the right typed error: 401/403 mean the
 * credentials were rejected, anything else is a request failure.
 */
export const rejectResponse = (broker: string, displayName: string, response: Response): never => {
  if (response.status === 401 || response.status === 403) {
    throw new BrokerAuthError(broker, `${displayName} rejected the credentials (${response.status})`);
  }
  throw new BrokerRequestError(broker, `${displayName} rejected the request (${response.status})`, response.status);
};

/** Parse a string into a finite number, or undefined. */
export const asFiniteNumber = (value: string | number | undefined | null): number | undefined => {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Parse a date-ish string into an ISO timestamp, or undefined. */
export const asIsoTimestamp = (value: string | undefined | null): string | undefined => {
  if (!value || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
};
