/**
 * React bindings for the connect flow: the `useConnectFlow` hook and the
 * drop-in `<BrokerConnect />` component.
 *
 * The component renders the broker picker and guided credential entry, then
 * hands the completed credentials to the caller's `onComplete`. It never
 * stores, transmits, or logs credentials itself, and makes no network calls
 * of its own — only the caller's optional `validate` can touch the network.
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import {
  createConnectFlow,
  filterBrokers,
  isOptionalField,
  type ConnectFlow,
  type ConnectFlowOptions,
  type ConnectFlowState,
} from "./core";

export * from "./core";

/**
 * Wraps the headless core in `useSyncExternalStore`. The flow is created on
 * first render; callbacks always call the latest props, but the `brokers`
 * allowlist, `loadBrokers`, and the presence of `validate` are fixed at
 * mount (remount with a `key` to change them).
 */
export const useConnectFlow = (
  options: ConnectFlowOptions,
): { state: ConnectFlowState; flow: ConnectFlow } => {
  const latest = useRef(options);
  latest.current = options;

  const [flow] = useState<ConnectFlow>(() =>
    createConnectFlow({
      onComplete: (brokerId, credentials) => latest.current.onComplete(brokerId, credentials),
      ...(options.validate
        ? {
            validate: (brokerId: string, credentials: Record<string, string>) =>
              latest.current.validate
                ? latest.current.validate(brokerId, credentials)
                : Promise.resolve(),
          }
        : {}),
      ...(options.brokers ? { brokers: options.brokers } : {}),
      ...(options.loadBrokers ? { loadBrokers: options.loadBrokers } : {}),
    }),
  );

  const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
  return { state, flow };
};

export type BrokerConnectProps = {
  /**
   * Receives the completed credentials exactly as entered. Persist them
   * wherever YOUR code decides — the kit itself keeps nothing.
   */
  onComplete: (brokerId: string, credentials: Record<string, string>) => void | Promise<void>;
  /** Optional pre-completion check; throw to fail with the thrown message. */
  validate?: (brokerId: string, credentials: Record<string, string>) => Promise<void>;
  /** Allowlist of broker ids to offer. Omit for every broker the SDK knows. */
  brokers?: string[];
  /** Heading for the picker step. Defaults to "Connect your broker". */
  title?: string;
};

const REASSURANCE =
  "Read-only keys only. Your credentials are handed straight to this app's own code — never stored here, never sent to LuxAlgo.";

const STYLE_ID = "blc-styles";

const CSS = `
.blc-root {
  --_bg: var(--blc-bg, #0a0a0a);
  --_card: var(--blc-card, #141414);
  --_border: var(--blc-border, #262626);
  --_fg: var(--blc-fg, #ededed);
  --_muted: var(--blc-muted, #a0a0a0);
  --_accent: var(--blc-accent, #4ade80);
  --_radius: var(--blc-radius, 10px);
  box-sizing: border-box;
  max-width: 34rem;
  padding: 1.5rem;
  border: 1px solid var(--_border);
  border-radius: var(--_radius);
  background: var(--_bg);
  color: var(--_fg);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 0.9375rem;
  line-height: 1.5;
}
.blc-root *, .blc-root *::before, .blc-root *::after { box-sizing: inherit; }
.blc-root :focus-visible { outline: 2px solid var(--_accent); outline-offset: 2px; }
.blc-title { margin: 0; font-size: 1.125rem; font-weight: 600; color: var(--_fg); }
.blc-subtitle { margin: 0.375rem 0 0; font-size: 0.8125rem; color: var(--_muted); }
.blc-filter { margin-top: 1rem; }
.blc-grid {
  list-style: none;
  margin: 0.75rem 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
  gap: 0.5rem;
}
.blc-broker {
  width: 100%;
  padding: 0.75rem 0.875rem;
  border: 1px solid var(--_border);
  border-radius: calc(var(--_radius) - 2px);
  background: var(--_card);
  color: var(--_fg);
  font: inherit;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}
.blc-broker:hover { border-color: var(--_accent); }
.blc-empty { margin: 1rem 0 0; color: var(--_muted); }
.blc-setup {
  margin: 1rem 0 0;
  padding: 0.75rem 0.875rem;
  border: 1px solid var(--_border);
  border-left: 3px solid var(--_accent);
  border-radius: calc(var(--_radius) - 2px);
  background: var(--_card);
  color: var(--_fg);
}
.blc-reassure { margin: 0.625rem 0 0; font-size: 0.8125rem; color: var(--_muted); }
.blc-field { margin-top: 0.875rem; }
.blc-label { display: block; margin-bottom: 0.375rem; font-size: 0.8125rem; color: var(--_muted); }
.blc-input {
  width: 100%;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--_border);
  border-radius: calc(var(--_radius) - 2px);
  background: var(--_card);
  color: var(--_fg);
  font: inherit;
}
.blc-input::placeholder { color: var(--_muted); }
.blc-input:disabled { opacity: 0.6; }
.blc-error {
  margin: 0.875rem 0 0;
  padding: 0.625rem 0.75rem;
  border: 1px solid #7f1d1d;
  border-radius: calc(var(--_radius) - 2px);
  background: rgba(127, 29, 29, 0.15);
  color: #fca5a5;
  font-size: 0.8125rem;
}
.blc-actions { display: flex; gap: 0.5rem; margin-top: 1.25rem; }
.blc-button {
  padding: 0.625rem 1rem;
  border: 1px solid var(--_border);
  border-radius: calc(var(--_radius) - 2px);
  background: var(--_card);
  color: var(--_fg);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}
.blc-button:disabled { opacity: 0.6; cursor: default; }
.blc-button--primary {
  border-color: var(--_accent);
  background: var(--_accent);
  color: var(--_bg);
}
.blc-done { margin-top: 1rem; }
.blc-done-mark { color: var(--_accent); font-weight: 600; }
.blc-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  clip: rect(0 0 0 0);
  overflow: hidden;
  white-space: nowrap;
}
`;

/** Injects the kit's stylesheet once per document. */
const useInjectStyles = (): void => {
  useEffect(() => {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    const tag = document.createElement("style");
    tag.id = STYLE_ID;
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }, []);
};

/**
 * Drop-in "connect your broker" UI: broker grid with a filter box, guided
 * credential entry per broker (from the SDK's live metadata), submit/back,
 * error and done states. Dark by default; themeable via `--blc-*` CSS
 * custom properties set on any ancestor.
 */
export const BrokerConnect = (props: BrokerConnectProps) => {
  useInjectStyles();
  const uid = useId();
  const [query, setQuery] = useState("");
  const { state, flow } = useConnectFlow({
    onComplete: props.onComplete,
    ...(props.validate ? { validate: props.validate } : {}),
    ...(props.brokers ? { brokers: props.brokers } : {}),
  });

  const title = props.title ?? "Connect your broker";

  if (state.step === "pick") {
    const visible = filterBrokers(state.brokers, query);
    return (
      <div className="blc-root">
        <h2 className="blc-title">{title}</h2>
        <p className="blc-subtitle">{REASSURANCE}</p>
        <label className="blc-visually-hidden" htmlFor={`${uid}-filter`}>
          Filter brokers
        </label>
        <input
          id={`${uid}-filter`}
          className="blc-input blc-filter"
          type="search"
          placeholder="Filter brokers"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {visible.length === 0 ? (
          <p className="blc-empty">No brokers match "{query}".</p>
        ) : (
          <ul className="blc-grid">
            {visible.map((broker) => (
              <li key={broker.id}>
                <button
                  type="button"
                  className="blc-broker"
                  onClick={() => flow.selectBroker(broker.id)}
                >
                  {broker.displayName}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (state.step === "credentials" || state.step === "validating") {
    const broker = state.selectedBroker;
    if (!broker) return null;
    const busy = state.step === "validating";
    return (
      <div className="blc-root">
        <h2 className="blc-title">Connect {broker.displayName}</h2>
        <p className="blc-setup">{broker.readOnlySetup}</p>
        <p className="blc-reassure">{REASSURANCE}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void flow.submit();
          }}
        >
          {broker.credentials.map((field) => (
            <div className="blc-field" key={field.key}>
              <label className="blc-label" htmlFor={`${uid}-${field.key}`}>
                {field.label}
              </label>
              <input
                id={`${uid}-${field.key}`}
                className="blc-input"
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                required={!isOptionalField(field)}
                disabled={busy}
                value={state.values[field.key] ?? ""}
                onChange={(event) => flow.setValue(field.key, event.target.value)}
              />
            </div>
          ))}
          {state.error !== null && (
            <p className="blc-error" role="alert">
              {state.error}
            </p>
          )}
          <div className="blc-actions">
            <button type="button" className="blc-button" disabled={busy} onClick={flow.back}>
              Back
            </button>
            <button type="submit" className="blc-button blc-button--primary" disabled={busy}>
              {busy ? "Validating…" : "Connect"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  if (state.step === "error") {
    return (
      <div className="blc-root">
        <h2 className="blc-title">Something went wrong</h2>
        {state.error !== null && (
          <p className="blc-error" role="alert">
            {state.error}
          </p>
        )}
        <div className="blc-actions">
          <button type="button" className="blc-button blc-button--primary" onClick={flow.back}>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="blc-root">
      <h2 className="blc-title">
        <span className="blc-done-mark">✓</span> Connected
      </h2>
      <p className="blc-subtitle blc-done">
        {state.selectedBroker
          ? `${state.selectedBroker.displayName} is connected.`
          : "Your broker is connected."}{" "}
        Your credentials were handed to this app and nowhere else.
      </p>
      <div className="blc-actions">
        <button
          type="button"
          className="blc-button"
          onClick={() => {
            setQuery("");
            flow.back();
          }}
        >
          Connect another broker
        </button>
      </div>
    </div>
  );
};
