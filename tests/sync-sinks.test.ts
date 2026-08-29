import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SyncEvent } from "../src/sync/events.js";
import {
  createConsoleSink,
  createJsonlSink,
  createWebhookSink,
  SIGNATURE_HEADER,
  signBody,
  type WebhookFetch,
} from "../src/sync/sinks.js";
import { makeTmpDir } from "./sync-helpers.js";

const events: SyncEvent[] = [
  {
    type: "balance_changed",
    broker: "alpaca",
    accountId: "acct-1",
    at: "2026-08-28T12:00:00.000Z",
    equity: 110,
    previousEquity: 100,
    delta: 10,
  },
  { type: "sync_completed", at: "2026-08-28T12:00:00.000Z", brokers: ["alpaca"], failures: [] },
];

type CapturedRequest = { url: string; init: { method: "POST"; headers: Record<string, string>; body: string } };

const capturingFetch = (
  responses: { ok: boolean; status: number }[] | ((call: number) => { ok: boolean; status: number } | Error),
): { fetch: WebhookFetch; requests: CapturedRequest[] } => {
  const requests: CapturedRequest[] = [];
  const fetch: WebhookFetch = async (url, init) => {
    const call = requests.length;
    requests.push({ url, init });
    const outcome = typeof responses === "function" ? responses(call) : (responses[call] ?? { ok: true, status: 200 });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { fetch, requests };
};

const noSleep = async (): Promise<void> => {};

describe("webhook sink", () => {
  it("POSTs the events as one JSON array with the JSON content type", async () => {
    const { fetch, requests } = capturingFetch([{ ok: true, status: 200 }]);
    const sink = createWebhookSink({ url: "https://example.test/hook", fetch, sleep: noSleep });

    await sink.deliver(events);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://example.test/hook");
    expect(requests[0]?.init.method).toBe("POST");
    expect(requests[0]?.init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(requests[0]?.init.body ?? "")).toEqual(events);
  });

  it("signs the raw body with hex HMAC-SHA256 of the configured secret", async () => {
    const { fetch, requests } = capturingFetch([{ ok: true, status: 200 }]);
    const secret = "shhh-very-secret";
    const sink = createWebhookSink({ url: "https://example.test/hook", secret, fetch, sleep: noSleep });

    await sink.deliver(events);

    const body = requests[0]?.init.body ?? "";
    const expected = createHmac("sha256", secret).update(body, "utf8").digest("hex");
    expect(requests[0]?.init.headers[SIGNATURE_HEADER]).toBe(expected);
    expect(signBody(secret, body)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends no signature header when no secret is configured", async () => {
    const { fetch, requests } = capturingFetch([{ ok: true, status: 200 }]);
    const sink = createWebhookSink({ url: "https://example.test/hook", fetch, sleep: noSleep });

    await sink.deliver(events);

    expect(requests[0]?.init.headers[SIGNATURE_HEADER]).toBeUndefined();
  });

  it("retries failed deliveries with doubling backoff and succeeds", async () => {
    const sleeps: number[] = [];
    const { fetch, requests } = capturingFetch((call) =>
      call === 0 ? new Error("ECONNREFUSED") : call === 1 ? { ok: false, status: 503 } : { ok: true, status: 200 },
    );
    const sink = createWebhookSink({
      url: "https://example.test/hook",
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await sink.deliver(events);

    expect(requests).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("treats non-2xx responses as failures", async () => {
    const errors: string[] = [];
    const { fetch, requests } = capturingFetch(() => ({ ok: false, status: 401 }));
    const sink = createWebhookSink({
      url: "https://example.test/hook",
      fetch,
      sleep: noSleep,
      logError: (message) => errors.push(message),
    });

    await sink.deliver(events);

    expect(requests).toHaveLength(3); // 1 attempt + 2 retries
    expect(errors[0]).toContain("HTTP 401");
  });

  it("fails soft: never throws, logs after the retries are exhausted", async () => {
    const errors: string[] = [];
    const { fetch, requests } = capturingFetch(() => new Error("network down"));
    const sink = createWebhookSink({
      url: "https://example.test/hook",
      fetch,
      sleep: noSleep,
      logError: (message) => errors.push(message),
    });

    await expect(sink.deliver(events)).resolves.toBeUndefined();
    expect(requests).toHaveLength(3);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("failed after 3 attempt(s)");
    expect(errors[0]).toContain("network down");
  });

  it("honors a custom retry count", async () => {
    const { fetch, requests } = capturingFetch(() => new Error("nope"));
    const sink = createWebhookSink({
      url: "https://example.test/hook",
      retries: 0,
      fetch,
      sleep: noSleep,
      logError: () => {},
    });

    await sink.deliver(events);
    expect(requests).toHaveLength(1);
  });

  it("sends nothing for an empty batch", async () => {
    const { fetch, requests } = capturingFetch([{ ok: true, status: 200 }]);
    const sink = createWebhookSink({ url: "https://example.test/hook", fetch, sleep: noSleep });

    await sink.deliver([]);
    expect(requests).toHaveLength(0);
  });
});

describe("jsonl sink", () => {
  it("appends one JSON event per line across deliveries", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "events.jsonl");
    const sink = createJsonlSink({ path: filePath });

    await sink.deliver(events);
    await sink.deliver([{ type: "broker_error", broker: "kraken", at: "2026-08-28T12:05:00.000Z", message: "401" }]);

    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => (JSON.parse(line) as SyncEvent).type)).toEqual([
      "balance_changed",
      "sync_completed",
      "broker_error",
    ]);
  });

  it("writes nothing for an empty batch", async () => {
    const appended: string[] = [];
    const sink = createJsonlSink({
      path: "unused.jsonl",
      append: async (_path, data) => {
        appended.push(data);
      },
    });
    await sink.deliver([]);
    expect(appended).toEqual([]);
  });
});

describe("console sink", () => {
  it("logs one JSON line per event", async () => {
    const lines: string[] = [];
    const sink = createConsoleSink({ log: (line) => lines.push(line) });

    await sink.deliver(events);

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toEqual(events[0]);
    expect(JSON.parse(lines[1] ?? "")).toEqual(events[1]);
  });

  it("defaults to console.log", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await createConsoleSink().deliver([events[1] as SyncEvent]);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
