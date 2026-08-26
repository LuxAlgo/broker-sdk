// Broker API spec/changelog watcher: fetch each watched source, hash the
// body, and diff against the committed hashes. A changed hash means the
// broker published something — a human (or an AI triage pass) then decides
// whether it touches endpoints we use.
//
// Sources live in docs/watch/sources.json. Only stable machine artifacts
// (raw changelogs, OpenAPI documents) belong there — rendered HTML pages
// change on every request and would make this cry wolf daily.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const SOURCES_PATH = new URL("../docs/watch/sources.json", import.meta.url);
const HASHES_PATH = new URL("../docs/watch/hashes.json", import.meta.url);

const sources = JSON.parse(readFileSync(SOURCES_PATH, "utf8"));
let hashes = {};
try {
  hashes = JSON.parse(readFileSync(HASHES_PATH, "utf8"));
} catch {
  // First run: every source registers as new.
}

const changed = [];
const unreachable = [];

for (const source of sources) {
  try {
    const response = await fetch(source.url);
    if (!response.ok) {
      unreachable.push({ ...source, detail: `HTTP ${response.status}` });
      continue;
    }
    const body = (await response.text()).replace(/\s+/g, " ").trim();
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
    if (hashes[source.url] !== hash) {
      changed.push({ ...source, previous: hashes[source.url] ?? null, hash });
      hashes[source.url] = hash;
    }
  } catch (error) {
    unreachable.push({ ...source, detail: error instanceof Error ? error.message : String(error) });
  }
}

for (const entry of unreachable) {
  console.log(`unreachable: ${entry.broker} ${entry.url} (${entry.detail})`);
}
if (changed.length > 0) {
  writeFileSync(HASHES_PATH, JSON.stringify(hashes, null, 2) + "\n");
  console.log("\nchanged sources:");
  for (const entry of changed) {
    console.log(`- ${entry.broker}: ${entry.url}${entry.previous === null ? " (first observation)" : ""}`);
  }
  // Signal for the workflow: hashes.json is dirty and an issue is warranted
  // (first observations update the baseline but are not worth an issue).
  const noteworthy = changed.filter((entry) => entry.previous !== null);
  writeFileSync(
    new URL("../watch-report.json", import.meta.url),
    JSON.stringify({ changed: noteworthy, firstRun: noteworthy.length === 0 }, null, 2),
  );
} else {
  console.log("no changes");
}
