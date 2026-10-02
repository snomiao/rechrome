#!/usr/bin/env bash
# Fail when vendor-src/ was not built from the pinned lib/ submodule commits.
# vendor-src/ once sat 3 months (6 fork commits) behind the pin unnoticed. Reads the pins from the
# git tree, so no submodule checkout or build is needed. Fix a mismatch by running the
# refresh-vendor workflow, or locally: scripts/build-playwright.sh && scripts/refresh-vendor-src.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/vendor-src/SOURCE"
[[ -f "$SOURCE" ]] || { echo "check-vendor-src: missing vendor-src/SOURCE — run scripts/refresh-vendor-src.sh" >&2; exit 1; }

rc=0
for sub in playwright playwright-cli; do
  pinned="$(git -C "$ROOT" ls-tree HEAD "lib/$sub" | awk '{print $3}')"
  built="$(awk -v s="$sub" '$1 == s {print $2}' "$SOURCE")"
  if [[ "$pinned" != "$built" ]]; then
    echo "check-vendor-src: lib/$sub is pinned at ${pinned:-?} but vendor-src/ was built from ${built:-?}" >&2
    rc=1
  fi
done
[[ $rc -eq 0 ]] && echo "check-vendor-src: ok — vendor-src/ matches the lib/ pins"
exit $rc
