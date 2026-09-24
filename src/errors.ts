/** Base class for every error this SDK raises on purpose. */
export class BrokerError extends Error {
  readonly broker: string;

  constructor(broker: string, message: string) {
    super(message);
    this.name = "BrokerError";
    this.broker = broker;
  }
}

/** The connection is missing a required credential field. */
export class MissingCredentialsError extends BrokerError {
  constructor(broker: string, message: string) {
    super(broker, message);
    this.name = "MissingCredentialsError";
  }
}

/** The broker rejected the credentials (bad key, revoked token, wrong scope). */
export class BrokerAuthError extends BrokerError {
  constructor(broker: string, message: string) {
    super(broker, message);
    this.name = "BrokerAuthError";
  }
}

/** The broker answered with a non-OK status or an error payload. */
export class BrokerRequestError extends BrokerError {
  /** HTTP status when the failure was an HTTP one. */
  readonly status?: number;

  constructor(broker: string, message: string, status?: number) {
    super(broker, message);
    this.name = "BrokerRequestError";
    if (status !== undefined) this.status = status;
  }
}

/**
 * The broker refused to serve the request because of where it came from
 * (HTTP 451, "unavailable for legal reasons"), before looking at any
 * credential. Nothing about the key is wrong; the fix is to call from a
 * region the broker serves. Binance.com and Bybit answer this to US IPs.
 */
export class RegionBlockedError extends BrokerError {
  readonly status = 451;

  constructor(broker: string, message: string) {
    super(broker, message);
    this.name = "RegionBlockedError";
  }
}

/**
 * The adapter does not implement an optional capability (e.g. `fetchBars`
 * on a broker with no market-data endpoints), or does not support the
 * requested variant of it (a timeframe the venue cannot serve).
 */
export class UnsupportedCapabilityError extends BrokerError {
  readonly capability: string;

  constructor(broker: string, capability: string, message: string) {
    super(broker, message);
    this.name = "UnsupportedCapabilityError";
    this.capability = capability;
  }
}
