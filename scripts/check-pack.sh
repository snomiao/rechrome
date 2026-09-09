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
const path = require("path");
// Derive the entrypoints from package.json rather than hardcoding names. A hardcoded list
// silently goes BLIND when a file is renamed: it would check fewer files, find nothing missing,
// and pass green — the failure this guard exists to catch, reintroduced by the guard itself.
// bin[] is what actually runs; files[] catches modules shipped alongside them.
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
// POPULATION. files[] mixes plain files with DIRECTORIES (extension/, vendor/), so filtering the
// literal names to *.ts/js counted only top-level modules — 3 of them, while 423 shipped JS/TS
// files sat inside those directories, unexamined. The check was sound within the set it chose;
// the set was wrong. So walk shipped directories too, and say out loud what was counted.
//
// vendor/ is deliberately excluded, and this is a claim about resolution, not a convenience: it
// carries its own node_modules/playwright-core, so its requires resolve inside its own subtree and
// a "does the tarball ship this sibling" question does not apply there. Every other shipped path
// is in scope.
const SKIP = new Set(["vendor"]);
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = dir + "/" + e.name;
    if (e.isDirectory()) { if (!SKIP.has(full)) walk(full, out); }
    else if (/\.(ts|js|mjs|cjs)$/.test(e.name)) out.push(full);
  }
  return out;
}
const named = [...new Set([...Object.values(pkg.bin ?? {}), ...(pkg.files ?? [])]
  .map(f => String(f).replace(/^\.\//, "")))].filter(f => fs.existsSync(f));
const entries = [...new Set(named.flatMap(f =>
  SKIP.has(f) ? []
  : fs.statSync(f).isDirectory() ? walk(f, [])
  : (/\.(ts|js|mjs|cjs)$/.test(f) ? [f] : [])))];
if (!entries.length) {
  console.error("check-pack: found no entrypoints in package.json bin/files — refusing to pass vacuously.");
  process.exit(1);
}
const missing = new Set();
for (const entry of entries) {
  const src = fs.readFileSync(entry, "utf8");
  for (const m of src.matchAll(/["'"'"'](\.\.?\/[A-Za-z0-9._\/-]+)["'"'"']/g)) {
    // Resolve against the directory of the IMPORTING FILE, not the package root. Root-relative was
    // only ever correct because the population happened to be top-level files; the moment nested
    // modules entered the set it reported extension/lib/ui/connect.js -> ./authToken.js as
    // missing while the tarball plainly contained extension/lib/ui/authToken.js.
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(entry), m[1]));
    // Only local MODULE imports matter here; a data file read at runtime is not resolved by Node.
    if (!/\.(ts|js|mjs|cjs|json)$/.test(rel)) continue;
    if (!packed.includes(rel)) missing.add(`${entry} imports "${m[1]}" (resolves to ${rel}), which the tarball does not contain`);
  }
}
if (missing.size) {
  console.error("check-pack: the tarball is missing modules its own entrypoints import:");
  for (const m of missing) console.error("  - " + m);
  console.error("Add them to package.json files[] (and emit the .js form in prepublishOnly).");
  process.exit(1);
}
console.log(`check-pack: ok — scanned ${entries.length} shipped module(s) (files[] + bin[], recursing into shipped dirs; vendor/ excluded: self-contained). Every relative import they make is in the tarball.`);
' "$PACKED"
