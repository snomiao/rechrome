# Official upstream update PRs

The workflow in `snomiao/rechrome` runs each Monday at 02:23 UTC (11:23 JST),
or manually through Actions. It tracks:

| Official source | Fork receiving the review PR | Rechrome submodule |
| --- | --- | --- |
| microsoft/playwright | snomiao/playwright | lib/playwright (extension and core) |
| microsoft/playwright-cli | snomiao/playwright-cli | lib/playwright-cli |

Configure the `UPSTREAM_SYNC_TOKEN` Actions secret on `snomiao/rechrome` with a
fine-grained token granting **Contents: read/write**, **Pull requests: read/write**,
and **Workflows: read/write** to those two forks (upstream changes can include
workflow files). The ordinary GITHUB_TOKEN cannot write to other repositories.
The workflow must be merged into rechrome's default branch to activate the cron.

Each fork gets one `automation/official-upstream` branch and one open PR. Runs
skip sources with no new upstream commits and refresh existing branches without
force-pushing. Conflicts remain visible in the PR; nothing merges automatically.
An upstream history rewrite or reviewer commits on the automation branch cause
the push to fail for manual review. An intentionally closed PR is reopened as a
new PR on a later run if upstream commits are still missing; disable the workflow
to pause updates.

Use merge commits when accepting these PRs. Then update rechrome's submodule pins
and regenerate `extension/` and `vendor-src/` in a separate reviewed change. The
schedule does not publish packages, rebuild unreviewed upstream code, or silently
replace our fork with Microsoft's HEAD. The legacy playwright-multi-tab submodule
is not part of the current CLI/extension update path.

Read-only checks:

```sh
bash scripts/upstream-sync.sh playwright --dry-run
bash scripts/upstream-sync.sh playwright-cli --dry-run
```
