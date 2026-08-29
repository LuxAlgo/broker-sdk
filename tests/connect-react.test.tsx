// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { listBrokers } from "../src/index.js";
import { BrokerConnect, isOptionalField } from "../src/connect/index.js";

afterEach(cleanup);

const alpaca = listBrokers().find((broker) => broker.id === "alpaca");
if (!alpaca) throw new Error("The installed SDK no longer exposes alpaca");

describe("<BrokerConnect />", () => {
  it("renders the picker, guides credential entry, and hands credentials to onComplete", async () => {
    const onComplete = vi.fn();
    render(<BrokerConnect onComplete={onComplete} />);

    // Picker step: title, filter box, reassurance line, live broker grid.
    expect(screen.getByRole("heading", { name: "Connect your broker" })).toBeTruthy();
    expect(screen.getByLabelText("Filter brokers")).toBeTruthy();
    expect(screen.getAllByText(/read-only keys only/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: alpaca.displayName }));

    // Credentials step: the SDK's read-only setup sentence shown prominently.
    expect(screen.getByText(alpaca.readOnlySetup)).toBeTruthy();
    expect(screen.getAllByText(/read-only keys only/i).length).toBeGreaterThan(0);

    // One labelled input per field; password type for secrets.
    const entered: Record<string, string> = {};
    for (const field of alpaca.credentials) {
      const input = screen.getByLabelText(field.label) as HTMLInputElement;
      expect(input.type).toBe(field.secret ? "password" : "text");
      if (!isOptionalField(field)) {
        entered[field.key] = `value-${field.key}`;
        fireEvent.change(input, { target: { value: `value-${field.key}` } });
      }
    }

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete).toHaveBeenCalledWith("alpaca", entered);
    expect(await screen.findByRole("heading", { name: /connected/i })).toBeTruthy();
  });

  it("filters the broker grid from the search box", () => {
    render(<BrokerConnect onComplete={vi.fn()} brokers={["alpaca", "kraken"]} />);
    expect(screen.getAllByRole("listitem").length).toBe(2);
    fireEvent.change(screen.getByLabelText("Filter brokers"), { target: { value: "alpa" } });
    expect(screen.getByRole("button", { name: alpaca.displayName })).toBeTruthy();
    expect(screen.getAllByRole("listitem").length).toBe(1);
  });

  it("honors the title prop and the brokers allowlist", () => {
    render(<BrokerConnect onComplete={vi.fn()} title="Link your account" brokers={["alpaca"]} />);
    expect(screen.getByRole("heading", { name: "Link your account" })).toBeTruthy();
    expect(screen.getAllByRole("listitem").length).toBe(1);
    expect(screen.getByRole("button", { name: alpaca.displayName })).toBeTruthy();
  });

  it("shows a validate failure as an alert and stays on the form", async () => {
    const onComplete = vi.fn();
    const validate = vi.fn().mockRejectedValue(new Error("Broker said no."));
    render(<BrokerConnect onComplete={onComplete} validate={validate} />);

    fireEvent.click(screen.getByRole("button", { name: alpaca.displayName }));
    for (const field of alpaca.credentials) {
      if (isOptionalField(field)) continue;
      fireEvent.change(screen.getByLabelText(field.label), { target: { value: "x" } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Broker said no.");
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByText(alpaca.readOnlySetup)).toBeTruthy();
  });

  it("blocks submission and explains when required fields are empty", async () => {
    const onComplete = vi.fn();
    render(<BrokerConnect onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: alpaca.displayName }));

    // Submit the form directly: the flow itself gates, not just HTML validation.
    const connect = screen.getByRole("button", { name: "Connect" });
    fireEvent.submit(connect.closest("form") as HTMLFormElement);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/missing required/i);
    expect(onComplete).not.toHaveBeenCalled();
  });
});
