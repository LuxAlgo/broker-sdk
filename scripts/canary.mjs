// Daily canary: run every adapter with LuxAlgo-held paper/sandbox
// credentials from the environment and assert the normalized output still
// holds its invariants. A broker renaming a field overnight turns this red
// by morning. Requires a build first: `pnpm build && node scripts/canary.mjs`.
//
// Credentials use the same convention as brokers-mcp:
//   BROKERS_<BROKER-ID>_<FIELD>  (BROKERS_ALPACA_API_KEY, …)
// Brokers with no credentials configured are skipped, never failed.

import { appendFileSync } from "node:fs";

import { connect, listBrokers } from "../dist/index.js";

const envVarName = (brokerId, credentialKey) =>
  `BROKERS_${brokerId.toUpperCase().replace(/-/g, "_")}_${credentialKey.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;

const invariantErrors = (snapshot) => {
  const errors = [];
  if (!Array.isArray(snapshot.accounts) || snapshot.accounts.length === 0) {
    errors.push("no accounts returned");
    return errors;
  }
  for (const account of snapshot.accounts) {
    const label = `account ${account.id ?? "<missing id>"}`;
    if (!account.id || typeof account.id !== "string") errors.push(`${label}: missing stable id`);
    if (typeof account.currency !== "string" || !account.currency) errors.push(`${label}: missing currency`);
    if (!Number.isFinite(account.equity)) errors.push(`${label}: equity is not a finite number`);
    for (const position of account.positions ?? []) {
      if (!position.symbol) errors.push(`${label}: position with no symbol`);
      if (!Number.isFinite(position.quantity) || position.quantity === 0)
        errors.push(`${label}: position ${position.symbol} has invalid quantity`);
      if (position.marketValue !== undefined && !Number.isFinite(position.marketValue))
        errors.push(`${label}: position ${position.symbol} has non-finite marketValue`);
    }
    for (const trade of account.trades ?? []) {
      if (!trade.symbol || !(trade.quantity > 0) || !(trade.price > 0))
        errors.push(`${label}: malformed trade ${JSON.stringify(trade)}`);
    }
  }
  return errors;
};

const rows = [];
let failed = 0;
let configured = 0;

for (const broker of listBrokers()) {
  const credentials = {};
  let complete = true;
  for (const field of broker.credentials) {
    const value = process.env[envVarName(broker.id, field.key)]?.trim();
    if (!value) {
      complete = false;
      break;
    }
    credentials[field.key] = value;
  }
  if (!complete) {
    rows.push({ broker: broker.id, status: "skipped", detail: "no credentials configured" });
    continue;
  }
  configured += 1;

  try {
    const snapshot = await connect({ broker: broker.id, credentials }).fetchSnapshot();
    const errors = invariantErrors(snapshot);
    if (errors.length > 0) {
      failed += 1;
      rows.push({ broker: broker.id, status: "FAIL", detail: errors.join("; ") });
    } else {
      const accounts = snapshot.accounts.length;
      const positions = snapshot.accounts.reduce((sum, account) => sum + account.positions.length, 0);
      rows.push({ broker: broker.id, status: "ok", detail: `${accounts} account(s), ${positions} position(s)` });
    }
  } catch (error) {
    failed += 1;
    rows.push({ broker: broker.id, status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
  }
}

const lines = rows.map((row) => `| ${row.broker} | ${row.status} | ${row.detail} |`);
const table = ["| broker | status | detail |", "| --- | --- | --- |", ...lines].join("\n");
console.log(table);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Canary\n\n${table}\n`);
}

if (configured === 0) {
  console.log("\ncanary: no broker credentials configured — nothing verified (set BROKERS_* secrets to arm).");
  process.exit(0);
}
if (failed > 0) {
  console.error(`\ncanary: ${failed} broker(s) failing`);
  process.exit(1);
}
console.log(`\ncanary: all ${configured} configured broker(s) green`);
