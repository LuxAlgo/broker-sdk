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
