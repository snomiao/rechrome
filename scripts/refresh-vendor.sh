#!/usr/bin/env bash
# Bump lib/playwright + lib/playwright-cli to their forks' main, rebuild, refresh vendor-src/, and
# open (or update) a PR — but only when something changed: a fork moved past its pin, or vendor-src/
# was not built from the pins. Otherwise exits in seconds without building.
# Run weekly by .github/workflows/refresh-vendor.yml. --dry-run only reports what would change.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mode="${1:-}"
SUBS=(playwright playwright-cli)
BRANCH=automation/refresh-vendor

declare -A latest
stale=0
for sub in "${SUBS[@]}"; do
  url="$(git config -f .gitmodules --get "submodule.lib/$sub.url")"
  latest[$sub]="$(git ls-remote "$url" HEAD | awk '{print $1}')"
  pinned="$(git ls-tree HEAD "lib/$sub" | awk '{print $3}')"
  built="$(awk -v s="$sub" '$1 == s {print $2}' vendor-src/SOURCE 2>/dev/null || true)"
  if [[ "${latest[$sub]}" == "$pinned" && "$pinned" == "$built" ]]; then
    echo "lib/$sub: up to date at ${pinned:0:10}"
  else
    echo "lib/$sub: pinned ${pinned:0:10}, fork main ${latest[$sub]:0:10}, vendor-src built from ${built:0:10}"
    stale=1
  fi
done
if [[ $stale -eq 0 ]]; then echo "refresh-vendor: nothing to do"; exit 0; fi
if [[ "$mode" == --dry-run ]]; then exit 0; fi

for sub in "${SUBS[@]}"; do
  git submodule update --init --depth 1 "lib/$sub"
  git -C "lib/$sub" fetch --depth 1 origin "${latest[$sub]}"
  git -C "lib/$sub" checkout -q FETCH_HEAD
done
bash scripts/build-playwright.sh --force
bash scripts/refresh-vendor-src.sh

summary="$(for sub in "${SUBS[@]}"; do echo "- lib/$sub → snomiao/$sub@${latest[$sub]:0:10}"; done)"
git switch -q -C "$BRANCH"
git add "${SUBS[@]/#/lib/}" vendor-src
git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit -q -m "chore(vendor): bump playwright forks and refresh vendor-src

$summary"
bash scripts/check-vendor-src.sh  # the same guard release CI runs
# The branch is regenerated from main on every run, so overwriting it is intended.
git push -q --force origin "$BRANCH"

pr="$(gh pr list --base main --head "$BRANCH" --state open --json number --jq '.[0].number // empty')"
if [[ -n "$pr" ]]; then
  echo "refresh-vendor: updated PR #$pr"
else
  gh pr create --base main --head "$BRANCH" --title "chore(vendor): bump playwright forks and refresh vendor-src" --body "$(cat <<BODY
The pinned Playwright forks moved (or vendor-src/ was stale), so this bumps the pins and rebuilds
the bundled CLI inputs in vendor-src/:

$summary

Release CI refuses to publish while vendor-src/SOURCE and the pins disagree
(scripts/check-vendor-src.sh), so merge this to ship the fork changes.
Opened by the weekly refresh-vendor workflow.
BODY
)"
fi
