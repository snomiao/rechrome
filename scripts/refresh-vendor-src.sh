#!/usr/bin/env bash
# DEV-ONLY: regenerate the committed vendor-src/ inputs from the lib/ submodules.
# Run this whenever the playwright-cli / playwright-core fork changes, then commit vendor-src/.
#
# vendor-src/ (committed) decouples publishing from a heavy playwright build: the release CI does
# not check out submodules or build playwright-core — scripts/vendor-cli.sh just unpacks these.
#
#   vendor-src/playwright-core.tgz   <- npm-packed patched playwright-core (honors its .npmignore)
#   vendor-src/playwright-cli.js     <- thin multi-tab CLI wrapper
#
# Requires the lib/ submodules checked out and playwright-core already built.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE_SRC="$ROOT/lib/playwright/packages/playwright-core"
WRAPPER_SRC="$ROOT/lib/playwright-cli/playwright-cli.js"
SRC="$ROOT/vendor-src"

if [[ ! -f "$WRAPPER_SRC" || ! -f "$CORE_SRC/lib/tools/cli-client/program.js" ]]; then
  echo "refresh-vendor-src: missing lib/ submodules or unbuilt playwright-core" >&2
  echo "  expected: $WRAPPER_SRC" >&2
  echo "       and: $CORE_SRC/lib/tools/cli-client/program.js" >&2
  exit 1
fi

rm -rf "$SRC"
mkdir -p "$SRC"
cp "$WRAPPER_SRC" "$SRC/playwright-cli.js"
TGZ="$(cd "$CORE_SRC" && npm pack --pack-destination "$SRC" --silent | tail -1)"
mv "$SRC/$TGZ" "$SRC/playwright-core.tgz"

echo "refresh-vendor-src: wrote vendor-src/playwright-core.tgz ($(du -h "$SRC/playwright-core.tgz" | cut -f1)) + playwright-cli.js"
echo "  -> commit vendor-src/ so the release picks it up"
