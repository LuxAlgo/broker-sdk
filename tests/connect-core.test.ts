import { describe, expect, it, vi } from "vitest";
import {
  createConnectFlow,
  filterBrokers,
  isOptionalField,
  requiredFields,
  type BrokerInfo,
  type ConnectStep,
} from "../src/connect/core.js";

const noop = () => {};

/** Deterministic fixtures (real SDK ids, made-up fields) for the field logic. */
const fakeBrokers: BrokerInfo[] = [
  {
    id: "alpaca",
    displayName: "Fake Alpaca",
    credentials: [
      { key: "apiKey", label: "API key ID", secret: false },
      { key: "apiSecret", label: "API secret key", secret: true },
      { key: "note", label: "Connection note (optional)", secret: false },
    ],
    readOnlySetup: "Create a read-only key in the fake dashboard.",
    supportsBars: true,
  },
  {
    id: "kraken",
    displayName: "Fake Kraken",
    credentials: [{ key: "apiKey", label: "API key", secret: true }],
    readOnlySetup: "Read-only scope only.",
    supportsBars: false,
  },
];

const loadFakes = () => fakeBrokers;

const recordSteps = (flow: ReturnType<typeof createConnectFlow>): ConnectStep[] => {
  const steps: ConnectStep[] = [];
  flow.subscribe(() => steps.push(flow.getState().step));
  return steps;
};

describe("createConnectFlow", () => {
  it("starts on pick with the SDK's live broker list", () => {
    const flow = createConnectFlow({ onComplete: noop });
    const state = flow.getState();
    expect(state.step).toBe("pick");
    expect(state.brokers.length).toBeGreaterThan(0);
    const alpaca = state.brokers.find((broker) => broker.id === "alpaca");
    expect(alpaca).toBeDefined();
    expect(alpaca?.displayName).toBeTruthy();
    expect(alpaca?.credentials.length).toBeGreaterThan(0);
    expect(alpaca?.readOnlySetup).toBeTruthy();
    expect(state.selectedBroker).toBeNull();
    expect(state.values).toEqual({});
    expect(state.error).toBeNull();
  });

  it("applies the brokers allowlist against the live SDK list", () => {
    const flow = createConnectFlow({ onComplete: noop, brokers: ["kraken", "alpaca"] });
    const ids = flow.getState().brokers.map((broker) => broker.id);
    expect([...ids].sort()).toEqual(["alpaca", "kraken"]);
  });

  it("ignores selectBroker for ids outside the allowlist", () => {
    const flow = createConnectFlow({ onComplete: noop, brokers: ["alpaca"], loadBrokers: loadFakes });
    flow.selectBroker("kraken");
    expect(flow.getState().step).toBe("pick");
    flow.selectBroker("not-a-broker");
    expect(flow.getState().step).toBe("pick");
    flow.selectBroker("alpaca");
    expect(flow.getState().step).toBe("credentials");
    expect(flow.getState().selectedBroker?.id).toBe("alpaca");
  });

  it("gates submit on required fields and names the missing ones", async () => {
    const onComplete = vi.fn();
    const flow = createConnectFlow({ onComplete, loadBrokers: loadFakes });
    flow.selectBroker("alpaca");

    await flow.submit();
    expect(onComplete).not.toHaveBeenCalled();
    expect(flow.getState().step).toBe("credentials");
    expect(flow.getState().error).toContain("API key ID");
    expect(flow.getState().error).toContain("API secret key");
    expect(flow.getState().error).not.toContain("Connection note");

    flow.setValue("apiKey", "PK123");
    await flow.submit();
    expect(onComplete).not.toHaveBeenCalled();
    expect(flow.getState().error).toContain("API secret key");
    expect(flow.getState().error).not.toContain("API key ID");
  });

  it("treats whitespace-only values as missing", async () => {
    const onComplete = vi.fn();
    const flow = createConnectFlow({ onComplete, loadBrokers: loadFakes });
    flow.selectBroker("kraken");
    flow.setValue("apiKey", "   ");
    await flow.submit();
    expect(onComplete).not.toHaveBeenCalled();
    expect(flow.getState().error).toContain("API key");
  });

  it("lets optional fields be skipped", async () => {
    const onComplete = vi.fn();
    const flow = createConnectFlow({ onComplete, loadBrokers: loadFakes });
    flow.selectBroker("alpaca");
    flow.setValue("apiKey", "PK123");
    flow.setValue("apiSecret", "shh");
    await flow.submit();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("alpaca", { apiKey: "PK123", apiSecret: "shh" });
    expect(flow.getState().step).toBe("done");
  });

  it("hands onComplete the exact values entered, optional fields included", async () => {
    const onComplete = vi.fn();
    const flow = createConnectFlow({ onComplete, loadBrokers: loadFakes });
    flow.selectBroker("alpaca");
    flow.setValue("apiKey", "  PK with spaces  ");
    flow.setValue("apiSecret", "s3cr3t");
    flow.setValue("note", "my paper account");
    await flow.submit();
    expect(onComplete).toHaveBeenCalledWith("alpaca", {
      apiKey: "  PK with spaces  ",
      apiSecret: "s3cr3t",
      note: "my paper account",
    });
  });

  it("skips the validating step when no validate is provided", async () => {
    const flow = createConnectFlow({ onComplete: noop, loadBrokers: loadFakes });
    const steps = recordSteps(flow);
    flow.selectBroker("kraken");
    flow.setValue("apiKey", "k");
    await flow.submit();
    expect(steps).not.toContain("validating");
    expect(flow.getState().step).toBe("done");
  });

  it("passes through validating to done when validate resolves", async () => {
    const seen: Array<[string, Record<string, string>]> = [];
    const flow = createConnectFlow({
      onComplete: noop,
      validate: async (brokerId, credentials) => {
        seen.push([brokerId, credentials]);
      },
      loadBrokers: loadFakes,
    });
    const steps = recordSteps(flow);
    flow.selectBroker("kraken");
    flow.setValue("apiKey", "k");
    await flow.submit();
    expect(seen).toEqual([["kraken", { apiKey: "k" }]]);
    expect(steps).toContain("validating");
    expect(flow.getState().step).toBe("done");
  });

  it("surfaces a validate failure and returns to credentials", async () => {
    const onComplete = vi.fn();
    let attempts = 0;
    const flow = createConnectFlow({
      onComplete,
      validate: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("That key was rejected by the broker.");
      },
      loadBrokers: loadFakes,
    });
    flow.selectBroker("kraken");
    flow.setValue("apiKey", "bad");
    await flow.submit();
    expect(flow.getState().step).toBe("credentials");
    expect(flow.getState().error).toBe("That key was rejected by the broker.");
    expect(onComplete).not.toHaveBeenCalled();

    // Fix the field and resubmit: the same flow recovers.
    flow.setValue("apiKey", "good");
    expect(flow.getState().error).toBeNull();
    await flow.submit();
    expect(flow.getState().step).toBe("done");
    expect(onComplete).toHaveBeenCalledWith("kraken", { apiKey: "good" });
  });

  it("moves to the error step when onComplete throws, and back() recovers", async () => {
    const flow = createConnectFlow({
      onComplete: () => {
        throw new Error("Persistence failed.");
      },
      loadBrokers: loadFakes,
    });
    flow.selectBroker("kraken");
    flow.setValue("apiKey", "k");
    await flow.submit();
    expect(flow.getState().step).toBe("error");
    expect(flow.getState().error).toBe("Persistence failed.");

    flow.back();
    expect(flow.getState().step).toBe("credentials");
    expect(flow.getState().error).toBeNull();
    expect(flow.getState().values).toEqual({ apiKey: "k" });
  });

  it("back() from credentials returns to pick and drops entered values", () => {
    const flow = createConnectFlow({ onComplete: noop, loadBrokers: loadFakes });
    flow.selectBroker("alpaca");
    flow.setValue("apiSecret", "shh");
    flow.back();
    const state = flow.getState();
    expect(state.step).toBe("pick");
    expect(state.selectedBroker).toBeNull();
    expect(state.values).toEqual({});
  });

  it("clears values once done, and back() restarts at pick", async () => {
    const flow = createConnectFlow({ onComplete: noop, loadBrokers: loadFakes });
    flow.selectBroker("kraken");
    flow.setValue("apiKey", "k");
    await flow.submit();
    expect(flow.getState().step).toBe("done");
    expect(flow.getState().values).toEqual({});
    flow.back();
    expect(flow.getState().step).toBe("pick");
    expect(flow.getState().selectedBroker).toBeNull();
  });

  it("notifies subscribers on every change and honors unsubscribe", () => {
    const flow = createConnectFlow({ onComplete: noop, loadBrokers: loadFakes });
    const listener = vi.fn();
    const unsubscribe = flow.subscribe(listener);
    flow.selectBroker("alpaca");
    flow.setValue("apiKey", "PK");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    flow.back();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("field helpers", () => {
  it("detects optional fields by the SDK's label convention", () => {
    expect(isOptionalField({ key: "a", label: "OAuth access token (optional, auto-refreshed)", secret: true })).toBe(true);
    expect(isOptionalField({ key: "b", label: "API key ID", secret: false })).toBe(false);
    const alpaca = fakeBrokers[0]!;
    expect(requiredFields(alpaca).map((field) => field.key)).toEqual(["apiKey", "apiSecret"]);
  });

  it("filters brokers by display name or id, case-insensitively", () => {
    expect(filterBrokers(fakeBrokers, "").length).toBe(2);
    expect(filterBrokers(fakeBrokers, "  KRAK ").map((broker) => broker.id)).toEqual(["kraken"]);
    expect(filterBrokers(fakeBrokers, "alpaca").map((broker) => broker.id)).toEqual(["alpaca"]);
    expect(filterBrokers(fakeBrokers, "zzz")).toEqual([]);
  });
});
