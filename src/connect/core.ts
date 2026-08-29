/**
 * The headless connect-flow engine. Zero React, zero DOM: a small
 * subscribable state machine you can drive from any framework, or none.
 *
 * Steps: "pick" → "credentials" → "validating" (only when a `validate`
 * function is provided) → "done" | "error".
 *
 * Credentials never leave this module except through the caller's own
 * `validate` and `onComplete` callbacks. Nothing here stores, transmits,
 * or logs them, and nothing here talks to the network.
 */
import { listBrokers, type BrokerInfo, type CredentialField } from "../index.js";

export type { BrokerInfo, CredentialField };

export type ConnectStep = "pick" | "credentials" | "validating" | "done" | "error";

export type ConnectFlowState = {
  step: ConnectStep;
  /** Brokers available to pick from — live from the SDK, allowlist applied. */
  brokers: BrokerInfo[];
  selectedBroker: BrokerInfo | null;
  /** Credential values entered so far, keyed by `CredentialField.key`. */
  values: Record<string, string>;
  /** Human-readable message for the current failure, or null. */
  error: string | null;
};

export type ConnectFlowOptions = {
  /**
   * Receives the completed credentials exactly as entered. Persist them
   * wherever YOUR code decides — this kit never stores or transmits them.
   */
  onComplete: (brokerId: string, credentials: Record<string, string>) => void | Promise<void>;
  /**
   * Optional pre-completion check (e.g. a test fetch through the SDK).
   * Throw to fail: the thrown message is surfaced as `state.error` and the
   * flow returns to the credentials step. This is the only place a network
   * call can happen during the flow, and it is entirely the caller's code.
   */
  validate?: (brokerId: string, credentials: Record<string, string>) => Promise<void>;
  /** Allowlist of broker ids to offer. Omit for every broker the SDK knows. */
  brokers?: string[];
  /**
   * Broker metadata source. Defaults to the SDK's `listBrokers()`, so new
   * adapters appear automatically when the SDK updates. Override in tests
   * or to decorate the list.
   */
  loadBrokers?: () => BrokerInfo[];
};

export type ConnectFlow = {
  getState: () => ConnectFlowState;
  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
  /** Pick a broker by id (from the "pick" step). Unknown ids are ignored. */
  selectBroker: (id: string) => void;
  /** Set one credential field's value (from the "credentials" step). */
  setValue: (key: string, value: string) => void;
  /** credentials → pick, error → credentials, done → pick. Otherwise a no-op. */
  back: () => void;
  /**
   * Validate required fields, run the caller's optional `validate`, then
   * hand the credentials to `onComplete`. Never throws — failures surface
   * on `state.error`.
   */
  submit: () => Promise<void>;
};

/**
 * A credential field is optional when its label says so, e.g.
 * "OAuth access token (optional, auto-refreshed)" — the SDK's convention.
 */
export const isOptionalField = (field: CredentialField): boolean =>
  field.label.toLowerCase().includes("(optional");

/** The fields that must be filled before `submit()` can proceed. */
export const requiredFields = (broker: BrokerInfo): CredentialField[] =>
  broker.credentials.filter((field) => !isOptionalField(field));

/** Case-insensitive broker search over display name and id, for filter boxes. */
export const filterBrokers = (brokers: BrokerInfo[], query: string): BrokerInfo[] => {
  const q = query.trim().toLowerCase();
  if (!q) return brokers;
  return brokers.filter(
    (broker) => broker.displayName.toLowerCase().includes(q) || broker.id.toLowerCase().includes(q),
  );
};

const toMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() === "" ? "Something went wrong." : message;
};

export const createConnectFlow = (options: ConnectFlowOptions): ConnectFlow => {
  const load = options.loadBrokers ?? listBrokers;
  const allowlist = options.brokers;
  const brokers = allowlist
    ? load().filter((broker) => allowlist.includes(broker.id))
    : load();

  let state: ConnectFlowState = {
    step: "pick",
    brokers,
    selectedBroker: null,
    values: {},
    error: null,
  };

  const listeners = new Set<() => void>();

  const setState = (patch: Partial<ConnectFlowState>): void => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const getState = (): ConnectFlowState => state;

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const selectBroker = (id: string): void => {
    if (state.step !== "pick") return;
    const broker = state.brokers.find((candidate) => candidate.id === id);
    if (!broker) return;
    setState({ step: "credentials", selectedBroker: broker, values: {}, error: null });
  };

  const setValue = (key: string, value: string): void => {
    if (state.step !== "credentials") return;
    setState({ values: { ...state.values, [key]: value }, error: null });
  };

  const back = (): void => {
    if (state.step === "credentials" || state.step === "done") {
      // Leaving the form drops any entered values — nothing lingers.
      setState({ step: "pick", selectedBroker: null, values: {}, error: null });
    } else if (state.step === "error") {
      setState({ step: "credentials", error: null });
    }
  };

  const submit = async (): Promise<void> => {
    if (state.step !== "credentials") return;
    const broker = state.selectedBroker;
    if (!broker) return;

    const missing = requiredFields(broker).filter(
      (field) => (state.values[field.key] ?? "").trim() === "",
    );
    if (missing.length > 0) {
      setState({
        error: `Missing required ${missing.length === 1 ? "field" : "fields"}: ${missing
          .map((field) => field.label)
          .join(", ")}`,
      });
      return;
    }

    // Hand over exactly what was entered — no trimming, no reshaping.
    const credentials = { ...state.values };

    if (options.validate) {
      setState({ step: "validating", error: null });
      try {
        await options.validate(broker.id, credentials);
      } catch (error) {
        setState({ step: "credentials", error: toMessage(error) });
        return;
      }
    }

    try {
      await options.onComplete(broker.id, credentials);
      setState({ step: "done", values: {}, error: null });
    } catch (error) {
      setState({ step: "error", error: toMessage(error) });
    }
  };

  return { getState, subscribe, selectBroker, setValue, back, submit };
};
