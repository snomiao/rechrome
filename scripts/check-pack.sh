#!/usr/bin/env bash
# Fail the publish if an entrypoint imports a local module the tarball does not ship.
#
# This exists because rechrome@1.24.0 shipped and then died at first run with
#   Cannot find module './daemon-manager.ts'
# rech.ts and serve.ts both import ./daemon-manager.ts, but package.json's files[] never listed
# it, so npm packed an installable tarball that could not start. Nothing in the pipeline
# compared "what we import" against "what we ship" — `npm publish` succeeded, and the breakage
# was only observable by installing the published package.
#
# --ignore-scripts is required: `npm pack` would otherwise re-run prepublishOnly, which calls
# this script, which calls npm pack... forever.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PACKED="$(npm pack --dry-run --json --ignore-scripts 2>/dev/null)"

node -e '
const packed = JSON.parse(process.argv[1])[0].files.map(f => f.path);
const fs = require("fs");
// Derive the entrypoints from package.json rather than hardcoding names. A hardcoded list
// silently goes BLIND when a file is renamed: it would check fewer files, find nothing missing,
// and pass green — the failure this guard exists to catch, reintroduced by the guard itself.
// bin[] is what actually runs; files[] catches modules shipped alongside them.
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const entries = [...new Set([...Object.values(pkg.bin ?? {}), ...(pkg.files ?? [])])]
  .map(f => String(f).replace(/^\.\//, ""))
  .filter(f => /\.(ts|js|mjs|cjs)$/.test(f))
  .filter(f => fs.existsSync(f));
if (!entries.length) {
  console.error("check-pack: found no entrypoints in package.json bin/files — refusing to pass vacuously.");
  process.exit(1);
}
const missing = new Set();
for (const entry of entries) {
  const src = fs.readFileSync(entry, "utf8");
  for (const m of src.matchAll(/["'"'"'](\.\/[A-Za-z0-9._\/-]+)["'"'"']/g)) {
    const rel = m[1].replace(/^\.\//, "");
    // Only local MODULE imports matter here; a data file read at runtime is not resolved by Node.
    if (!/\.(ts|js|mjs|cjs|json)$/.test(rel)) continue;
    if (!packed.includes(rel)) missing.add(`${entry} imports ./${rel}, which the tarball does not contain`);
  }
}
if (missing.size) {
  console.error("check-pack: the tarball is missing modules its own entrypoints import:");
  for (const m of missing) console.error("  - " + m);
  console.error("Add them to package.json files[] (and emit the .js form in prepublishOnly).");
  process.exit(1);
}
console.log(`check-pack: ok — every local import of ${entries.length} entrypoint(s) is present in the tarball.`);
' "$PACKED"
