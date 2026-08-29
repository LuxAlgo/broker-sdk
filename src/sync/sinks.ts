/*
  Where events go. Every sink implements the same one-method interface and
  receives the full batch of events one sweep produced.

  Delivery is fail-soft by design: the webhook sink retries with backoff and
  then logs to stderr instead of throwing, and the daemon additionally wraps
  every sink call — a broken sink never stops the sweep loop, and the next
  sweep diffs against saved state, not against what a sink acknowledged.
*/
import { createHmac } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { SyncEvent } from "./events.js";

export type Sink = {
  deliver: (events: SyncEvent[]) => Promise<void>;
};

/** Header carrying the hex HMAC-SHA256 of the raw webhook request body. */
export const SIGNATURE_HEADER = "X-BrokerSync-Signature";

/** Hex HMAC-SHA256 of the raw request body — what the signature header carries. */
export const signBody = (secret: string, body: string): string =>
  createHmac("sha256", secret).update(body, "utf8").digest("hex");

/**
 * The slice of fetch the webhook sink needs. `globalThis.fetch` satisfies
 * it; tests can inject a plain capturing function.
 */
export type WebhookFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export type WebhookSinkOptions = {
  url: string;
  /** When set, every request carries X-BrokerSync-Signature over the raw body. */
  secret?: string;
  /** Retries after the first failed attempt. Default 2. */
  retries?: number;
  /** Base backoff in milliseconds, doubled on each further retry. Default 500. */
  backoffMs?: number;
  /** Injectable for tests/proxies. Defaults to global fetch. */
  fetch?: WebhookFetch;
  /** Injectable for tests. Defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests. Defaults to console.error. */
  logError?: (message: string) => void;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POSTs each sweep's events as one JSON array. Non-2xx responses and thrown
 * fetch errors are retried with exponential backoff; after the final
 * attempt the failure is logged to stderr and swallowed (fail-soft).
 */
export const createWebhookSink = (options: WebhookSinkOptions): Sink => {
  const retries = options.retries ?? 2;
  const backoffMs = options.backoffMs ?? 500;
  const fetchFn: WebhookFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const logError = options.logError ?? ((message: string) => console.error(message));

  return {
    deliver: async (events) => {
      if (events.length === 0) return;
      const body = JSON.stringify(events);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (options.secret !== undefined) headers[SIGNATURE_HEADER] = signBody(options.secret, body);

      let lastFailure = "unknown error";
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
        try {
          const response = await fetchFn(options.url, { method: "POST", headers, body });
          if (response.ok) return;
          lastFailure = `HTTP ${response.status}`;
        } catch (error) {
          lastFailure = error instanceof Error ? error.message : String(error);
        }
      }
      logError(`broker-sync: webhook delivery failed after ${retries + 1} attempt(s): ${lastFailure}`);
    },
  };
};

export type JsonlSinkOptions = {
  path: string;
  /** Injectable for tests. Defaults to node:fs/promises appendFile. */
  append?: (path: string, data: string) => Promise<void>;
};

/** Appends one JSON event per line to a local file. */
export const createJsonlSink = (options: JsonlSinkOptions): Sink => {
  const append =
    options.append ??
    (async (filePath: string, data: string) => {
      await appendFile(filePath, data, "utf8");
    });
  return {
    deliver: async (events) => {
      if (events.length === 0) return;
      await append(options.path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    },
  };
};

export type ConsoleSinkOptions = {
  /** Injectable for tests. Defaults to console.log. */
  log?: (line: string) => void;
};

/** Prints one JSON event per line to stdout. */
export const createConsoleSink = (options: ConsoleSinkOptions = {}): Sink => {
  const log = options.log ?? ((line: string) => console.log(line));
  return {
    deliver: async (events) => {
      for (const event of events) log(JSON.stringify(event));
    },
  };
};
