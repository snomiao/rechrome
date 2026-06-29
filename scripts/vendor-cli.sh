#!/usr/bin/env bash
# Build vendor/ (shipped in the npm tarball) from the committed vendor-src/ inputs.
# Runs at prepublish — needs NO submodules and NO playwright build, so the release CI just works.
# Regenerate the inputs with scripts/refresh-vendor-src.sh when the fork changes.
#
# Layout produced (resolved by resolvePlaywrightCli() in rech.ts, priority 3):
#   vendor/playwright-cli/playwright-cli.js                  <- thin wrapper
#   vendor/playwright-cli/node_modules/playwright-core/...   <- patched core (unpacked tarball)
# The wrapper's `require('playwright-core/lib/tools/cli-client/program')` resolves to the nested
# playwright-core via normal Node module resolution.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/vendor-src"
VENDOR="$ROOT/vendor/playwright-cli"

if [[ ! -f "$SRC/playwright-core.tgz" || ! -f "$SRC/playwright-cli.js" ]]; then
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
tar xzf "$SRC/playwright-core.tgz" -C "$VENDOR/node_modules/playwright-core" --strip-components=1

echo "vendor-cli: built vendor/ from vendor-src ($(du -sh "$ROOT/vendor" | cut -f1))"
