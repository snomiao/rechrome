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

## Building & verifying the vendored playwright / extension

Hard-won notes — a source edit not taking effect at runtime is almost always one of these:

- **The one-shot build does NOT transpile `playwright-core` `src/` → `lib/`.** Its tsconfig is
  `noEmit: true`; `lib/` is produced by **esbuild bundles** (`lib/coreBundle.js`, `lib/entry/*.js`,
  `lib/tools/cli-client/*.js`), not tsc. Standalone `lib/.../*.js` files can be stale leftovers and are
  not what runs. After editing core source, rebuild and confirm the change landed in the **bundle** that
  actually runs (`grep` the built `coreBundle.js` / entry bundle), not a same-named standalone file.
- **The extension has two separate vite builds.** `vite.config.mts` builds the UI pages (e.g.
  `connect.*`, `status.*` → `dist/lib/ui/*.js`); `vite.sw.config.mts` builds the **service worker**
  (`background.ts` → `dist/lib/background.mjs`). A background/service-worker change needs the SW build;
  a UI change needs the UI build. Rebuilding the wrong one silently leaves the old code — this also
  produces **false-passing negative controls** (revert + rebuild the *wrong* bundle = the test still
  runs the change).
- **After any extension rebuild**, re-sync the shipped copies (repo-root `extension/` *and*
  `~/.rechrome/extension`) from `lib/playwright/packages/extension/dist`, then the unpacked extension
  must be **reloaded in Chrome** to drop cached code (ask the user; never restart Chrome).
- **Verify extension changes in the isolated test harness, never the user's Chrome.**
  `npm run test-extension` (in `lib/playwright`) launches its own throwaway Chrome via
  `PWTEST_EXTENSION_USER_DATA_DIR` + `--load-extension`. Always run a real negative control (revert the
  fix, rebuild the **correct** bundle, confirm the test fails) before trusting a green run.
- **The connect flow has two paths: token-bypass and Allow-click.** The daemon uses **token-bypass**
  (auto-connect, no UI click). A test that only drives the Allow-click path (`clickAllowAndSelect`)
  misses bypass-only bugs — cover token-bypass explicitly.
- **A daemon (`serve`) change needs the daemon restarted** (`oxmgr restart rechrome-serve`) to take
  effect; the daemon runs the `serve` source directly (no build step). Restarting it does not touch
  Chrome or live browser sessions.
