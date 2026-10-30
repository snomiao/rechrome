#!/usr/bin/env bash
# Build the patched playwright-core in the lib/playwright submodule (the fork the CLI runs).
# Release CI runs this before `bun install`; devs run it after bumping the submodule pin.
# Slow (~10 min cold: full monorepo `npm ci` + esbuild bundles). Skips when already built unless
# --force, so re-running is cheap. See CLAUDE.md "Building & verifying" for why the bundle matters.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PW="$ROOT/lib/playwright"
BUILT="$PW/packages/playwright-core/lib/tools/cli-client/program.js"

if [[ ! -f "$PW/package.json" ]]; then
  echo "build-playwright: lib/playwright is not checked out — run: git submodule update --init lib/playwright lib/playwright-cli" >&2
  exit 1
fi
if [[ -f "$BUILT" && "${1:-}" != "--force" ]]; then
  echo "build-playwright: already built (pass --force to rebuild)"
  exit 0
fi

(cd "$PW" && npm ci --ignore-scripts && node utils/build/build.js)
echo "build-playwright: built $(git -C "$PW" rev-parse --short HEAD)"
