# rechrome — repo-scoped Claude rules

## NEVER restart / quit the user's Chrome without explicit approval

Do **not** run `osascript -e 'quit app "Google Chrome"'`, `pkill`/`kill` on Chrome, or anything that
closes/relaunches the user's Chrome — it destroys their live browsing session. This includes "just to
reload the extension." If a patched unpacked extension needs to be reloaded, **ask the user to reload it**
(chrome://extensions → reload, or the extension's own reload), or find a non-destructive path. Only quit/
restart Chrome when the user has explicitly approved it in the current request.

## Never modify node_modules

This repo has **vendored forks** in `./lib/`:

- `lib/playwright/` — fork of `microsoft/playwright`
- `lib/playwright-cli/` — fork of `microsoft/playwright-cli`
- `lib/playwright-multi-tab/` — fork of `microsoft/playwright-multi-tab` (contains its own nested `lib/playwright/` and `lib/playwright-cli/`)

**Rule:** when a fix is needed in playwright / playwright-core / playwright-cli source, edit it in `./lib/<fork>/` (the patched source). **Never** edit anything under `node_modules/` — those copies are regenerated on install and patches there are lost.

If a `node_modules/.../playwright-core/lib/...` file appears to be the one actually being executed, the fix is to:
1. Edit the corresponding source in `./lib/<fork>/` (e.g. `lib/playwright/packages/playwright-core/src/...`)
2. Ensure the build/link wires the fork into whatever consumes it (rebuild, `npm link`, vendored copy refresh, etc.)
3. Verify the live runtime picks up the patched code

If the consumer is the globally-installed `playwright-cli-multi-tab` binary, that binary points outside this repo — switch the daemon to invoke a CLI from this repo's `./lib/` instead.
