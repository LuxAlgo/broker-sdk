/*
  Dependency license gate. Reads `pnpm licenses list --json` from stdin and
  fails the build if any package (dev deps included) carries a license
  outside the allowlist. Copyleft or unknown licenses must be replaced or
  explicitly cleared by a maintainer before they can land.
*/
const ALLOWED = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
  "CC0-1.0",
  "Unlicense",
]);

let input = "";
for await (const chunk of process.stdin) input += chunk;
const byLicense = JSON.parse(input);

const violations = [];
for (const [license, packages] of Object.entries(byLicense)) {
  if (ALLOWED.has(license)) continue;
  for (const pkg of packages) violations.push(`${pkg.name} (${license})`);
}

if (violations.length > 0) {
  console.error("Disallowed dependency licenses:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`License gate passed: ${Object.values(byLicense).reduce((n, p) => n + p.length, 0)} packages, all allowlisted.`);
