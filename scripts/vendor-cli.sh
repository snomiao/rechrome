#!/usr/bin/env bash
# Build vendor/ (shipped in the npm tarball) from the committed vendor-src/ inputs.
# Runs at prepublish, and as `prepare` so a fresh checkout's `bun install` has a working CLI.
# Needs NO submodules and NO playwright build, so the release CI just works.
# Regenerate the inputs with scripts/refresh-vendor-src.sh when the fork changes.
#
# Layout produced (resolved by resolvePlaywrightCli() in rechrome.ts, priority 3):
#   vendor/playwright-cli/playwright-cli.js                  <- thin wrapper
#   vendor/playwright-cli/node_modules/playwright-core/...   <- patched core (unpacked tarball)
# The wrapper's `require('playwright-core/lib/tools/cli-client/program')` resolves to the nested
# playwright-core via normal Node module resolution.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/vendor-src"
VENDOR="$ROOT/vendor/playwright-cli"

# npm runs `prepare` on pack/publish too (even under --ignore-scripts), where prepublishOnly already
# builds vendor/ — skip the redundant rebuild, which would also pollute `npm pack --json` stdout.
if [[ "${1:-}" == "--prepare" && ( "${npm_command:-}" == "pack" || "${npm_command:-}" == "publish" ) ]]; then
  exit 0
fi

if [[ ! -f "$SRC/playwright-core.tgz" || ! -f "$SRC/playwright-cli.js" ]]; then
  # `prepare` (bun/npm install in a checkout or git install) passes --prepare. vendor-src/ is not in
  # the npm tarball, so if prepare ever runs on an installed package, skip rather than fail the install.
  if [[ "${1:-}" == "--prepare" ]]; then echo "vendor-cli: no vendor-src/, skipping" >&2; exit 0; fi
  echo "vendor-cli: missing vendor-src/ — run scripts/refresh-vendor-src.sh and commit it" >&2
  exit 1
fi

rm -rf "$ROOT/vendor"
mkdir -p "$VENDOR/node_modules/playwright-core"
cp "$SRC/playwright-cli.js" "$VENDOR/playwright-cli.js"
chmod +x "$VENDOR/playwright-cli.js"  # POSIX execs it via its `#!/usr/bin/env node` shebang
# rechrome's root package.json is "type":"module", which would make this CommonJS wrapper (it uses
# require()) be parsed as ESM. A local package.json without "type" pins the subtree back to CommonJS.
printf '{\n  "name": "rechrome-vendored-playwright-cli",\n  "private": true,\n  "type": "commonjs",\n  "bin": { "playwright-cli-multi-tab": "playwright-cli.js" }\n}\n' > "$VENDOR/package.json"
# Relative paths: GNU tar reads an absolute `C:/...` (as a nested Windows bash can hand it) as host:path.
(cd "$ROOT" && tar xzf vendor-src/playwright-core.tgz -C vendor/playwright-cli/node_modules/playwright-core --strip-components=1)

echo "vendor-cli: built vendor/ from vendor-src ($(du -sh "$ROOT/vendor" | cut -f1))"
