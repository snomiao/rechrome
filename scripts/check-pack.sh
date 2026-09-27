#!/usr/bin/env bash
# Fail the publish if a shipped module imports a local module the tarball does not contain.
# rechrome@1.24.0 shipped without daemon-manager.* while rech.ts imported it, so every install died
# at startup with `Cannot find module './daemon-manager.ts'` — nothing compared "what we import"
# against "what we ship". Runs from prepublishOnly (after the .js forms are emitted); run it
# directly with `bash scripts/check-pack.sh`.
#
# --ignore-scripts is required: `npm pack` would otherwise re-run prepublishOnly, which calls this.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Take npm's exit status before parsing, and keep its stderr, so a failed pack fails loudly.
PACK_ERR="$(mktemp)"
pack_rc=0
PACKED="$(npm pack --dry-run --json --ignore-scripts 2>"$PACK_ERR")" || pack_rc=$?
if [ "$pack_rc" -ne 0 ] || [ -z "$PACKED" ]; then
  echo "check-pack: \`npm pack\` failed (rc=$pack_rc) — cannot tell what the tarball contains." >&2
  sed "s/^/  npm: /" "$PACK_ERR" >&2
  rm -f "$PACK_ERR"
  exit 1
fi
rm -f "$PACK_ERR"

# The JSON goes to node on stdin, not argv: with vendor/ built it exceeds Windows' command-line limit.
printf '%s' "$PACKED" | node -e '
const fs = require("fs");
const path = require("path");
const packed = new Set(JSON.parse(fs.readFileSync(0, "utf8"))[0].files.map(f => f.path.replace(/\\/g, "/")));
// Entrypoints come from package.json (bin + files, recursing into shipped dirs) rather than a
// hardcoded list, so a rename cannot silently shrink what is checked. vendor/ is excluded: it
// carries its own node_modules/playwright-core, so its requires resolve inside its own subtree.
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const SKIP = new Set(["vendor"]);
const MOD = /\.(ts|js|mjs|cjs)$/;
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = dir + "/" + e.name;
    if (e.isDirectory()) { if (!SKIP.has(full)) walk(full, out); }
    else if (MOD.test(e.name)) out.push(full);
  }
  return out;
}
const named = [...new Set([...Object.values(pkg.bin ?? {}), ...(pkg.files ?? [])]
  .map(f => String(f).replace(/^\.\//, "")))].filter(f => fs.existsSync(f) && !SKIP.has(f));
const entries = [...new Set(named.flatMap(f =>
  fs.statSync(f).isDirectory() ? walk(f, []) : (MOD.test(f) ? [f] : [])))];
if (!entries.length) {
  console.error("check-pack: found no entrypoints in package.json bin/files — refusing to pass vacuously.");
  process.exit(1);
}
const missing = new Set();
for (const entry of entries) {
  if (!packed.has(entry)) continue; // on disk but not shipped (e.g. files[] negation) — not our concern
  const src = fs.readFileSync(entry, "utf8");
  for (const m of src.matchAll(/["\x27](\.\.?\/[A-Za-z0-9._\/-]+)["\x27]/g)) {
    // Resolve against the importing file, not the package root (nested extension/ modules).
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(entry), m[1]));
    if (!/\.(ts|js|mjs|cjs|json)$/.test(rel)) continue; // only module imports, not runtime data paths
    if (!packed.has(rel)) missing.add(`${entry} imports "${m[1]}" (${rel}), which the tarball does not contain`);
  }
}
if (missing.size) {
  console.error("check-pack: the tarball is missing modules its own entrypoints import:");
  for (const m of missing) console.error("  - " + m);
  console.error("Add them to package.json files[] (and emit the .js form in prepublishOnly).");
  process.exit(1);
}
console.log(`check-pack: ok — ${entries.length} shipped module(s) scanned; every relative import is in the tarball.`);
'
