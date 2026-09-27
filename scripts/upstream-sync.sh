#!/usr/bin/env bash
# Mirror official upstream into a review branch; never modify the fork's main.
set -euo pipefail

component="${1:?Usage: upstream-sync.sh playwright|playwright-cli [--dry-run]}"
case "$component" in
  playwright|playwright-cli) ;;
  *) echo 'Unsupported component' >&2; exit 1 ;;
esac
mode="${2:-}"
if [[ -n "$mode" && "$mode" != '--dry-run' ]]; then
  echo 'Only --dry-run is supported as the second argument' >&2
  exit 1
fi
if [[ -z "${GH_TOKEN:-}" && "$mode" != '--dry-run' ]]; then
  echo 'Set UPSTREAM_SYNC_TOKEN with contents and pull-request write access to snomiao/playwright and snomiao/playwright-cli.' >&2
  exit 1
fi

fork="snomiao/$component"
upstream="microsoft/$component"
branch='automation/official-upstream'
base=$(gh api "repos/$fork" --jq '.default_branch')
upstream_base=$(gh api "repos/$upstream" --jq '.default_branch')
upstream_sha=$(gh api "repos/$upstream/commits/$upstream_base" --jq '.sha')
# Comparing immutable upstream SHA avoids accidentally reviewing a later fetch.
ahead=$(gh api "repos/$fork/compare/$base...$upstream_sha" --jq '.ahead_by')
if [[ "$ahead" == 0 ]]; then
  echo "$fork already contains $upstream@$upstream_sha"
  exit 0
fi
echo "$fork: $ahead upstream commits to review from $upstream@$upstream_sha"
if [[ "$mode" == '--dry-run' ]]; then exit 0; fi

sync_dir=$(mktemp -d)
trap 'rm -rf "$sync_dir"' EXIT
gh auth setup-git --hostname github.com
git init --bare "$sync_dir/repo.git" >/dev/null
git -C "$sync_dir/repo.git" fetch --no-tags "https://github.com/$upstream.git" "$upstream_sha"
# Ordinary push only: upstream history rewrites or reviewer commits must not be
# overwritten. A rejected update requires a maintainer to review the branch.
git -C "$sync_dir/repo.git" push "https://github.com/$fork.git" "FETCH_HEAD:refs/heads/$branch"

pr=$(gh pr list --repo "$fork" --base "$base" --head "$branch" --state open --json number --jq '.[0].number // empty')
if [[ -n "$pr" ]]; then
  echo "Updated existing PR: https://github.com/$fork/pull/$pr"
else
  cat > "$sync_dir/body.md" <<EOF
Review official upstream changes from [$upstream](https://github.com/$upstream) into this fork.

This branch mirrors upstream. Merge this PR to retain the fork's existing commits;
do not squash or rebase it, since future syncs rely on upstream ancestry.
Merge conflicts require manual resolution. No automatic merge is enabled.

Before updating snomiao/rechrome:
- Resolve conflicts while preserving rechrome patches.
- Run the relevant fork tests, including extension token-bypass coverage when affected.
- Recheck bundled licenses and notices.
- After merging, update the submodule pin in a separate rechrome PR, rebuild the
  extension and vendored CLI/core artifacts, and run rechrome tests.

Maintained by the weekly upstream-sync workflow in snomiao/rechrome.
EOF
  gh pr create --repo "$fork" --base "$base" --head "$branch" \
    --title "chore: merge official $component upstream" --body-file "$sync_dir/body.md"
fi
