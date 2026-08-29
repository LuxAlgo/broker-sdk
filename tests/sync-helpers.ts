/* Shared builders for tests — plain objects, no network, no SDK adapters. */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Account, BrokerSnapshot, Position, Trade } from "../src/index.js";

export const makeTrade = (overrides: Partial<Trade> = {}): Trade => ({
  symbol: "AAPL",
  side: "buy",
  quantity: 10,
  price: 200,
  executedAt: "2026-08-28T10:00:00.000Z",
  ...overrides,
});

export const makePosition = (overrides: Partial<Position> = {}): Position => ({
  symbol: "AAPL",
  quantity: 10,
  ...overrides,
});

export const makeAccount = (overrides: Partial<Account> = {}): Account => ({
  id: "acct-1",
  name: "Main",
  currency: "USD",
  equity: 10_000,
  positions: [],
  trades: [],
  ...overrides,
});

export const makeSnapshot = (overrides: Partial<BrokerSnapshot> = {}): BrokerSnapshot => ({
  broker: "alpaca",
  fetchedAt: "2026-08-28T12:00:00.000Z",
  accounts: [makeAccount()],
  ...overrides,
});

export const makeTmpDir = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), "broker-sync-test-"));
