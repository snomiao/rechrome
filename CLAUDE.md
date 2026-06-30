# rechrome — repo-scoped Claude rules

## NEVER restart / quit the user's Chrome without explicit approval

Do **not** run `osascript -e 'quit app "Google Chrome"'`, `pkill`/`kill` on Chrome, or anything that
closes/relaunches the user's Chrome — it destroys their live browsing session. This includes "just to
reload the extension." If a patched unpacked extension needs to be reloaded, **ask the user to reload it**
(chrome://extensions → reload, or the extension's own reload), or find a non-destructive path. Only quit/
restart Chrome when the user has explicitly approved it in the current request.

## Session identity — bucket by WORKTREE ROOT, decouple key from label

Which browser session a client reuses is decided by a **session key**. The key is the realpath of the
**git worktree root** (`getClientIdentity`/`deriveIdentity` in `rech.ts`), NOT the git branch. This is the
predictability contract: a human can tell which browser they're driving from where they `cd`'d.

- **Why not branch** (the old `<remote>/tree/<branch>` key): (1) two worktrees on the same branch
  collided into one session; (2) `git checkout` silently swapped the session under you; (3) detached
  HEAD (the submodule default) degraded the key. Path keying fixes all three.
- **Why not raw cwd**: `cd repo/sub` would fragment the session. We normalize cwd → worktree root.
- **Submodules roll up** to the outermost superproject (`git rev-parse --show-superproject-working-tree`,
  looped) so submodule work shares the parent worktree's browser. This is deliberate (monorepo workflow).
- **KEY is decoupled from LABEL.** The server hashes the *key* (path-based); the pretty
  `<remote>#<basename>@<branch>` *label* is render-only (logs, `identity:` line, tab-group name via
  `shortClientLabel`). Never key on the label. Profile is mixed into the hash via a NUL separator, kept
  out of the label.
- **`RECH_IDENTITY`** selects the mode: `worktree` (default) | `branch` (legacy opt-in, restores the old
  key) | `cwd`. Don't hard-flip the default — changing the key orphans live sessions.
- **`rech --isolate <args>`** is sugar for `-s=<random>` — a throwaway session for fragile single-shot
  flows (OAuth/login) that must not share tabs with the worktree's default session.
- **Profile precedence**: an explicit `?profile=` in `RECHROME_URL` wins over the
  `PLAYWRIGHT_MCP_PROFILE_DIRECTORY` env var; a mismatch warns once (`resolveEffectiveProfile`). A silent
  mismatch is how an OAuth flow can target the WRONG account.

The `rech serve` daemon is **local** — sessions never cross machines, so a machine-independent/branch key
buys nothing functional; the path key is strictly better. A `serve` change needs `oxmgr restart
rechrome-serve` to take effect (see the build/verify section below).

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

## `rech setup` & profile provisioning (token + extension)

How a profile gets its auth token and extension, and the platform constraints behind the design:

- **Token lives in the extension's `localStorage['auth-token']`** (per-profile, lazily minted on
  first load of `status.html`/`connect.html`; random 32-byte base64url). The daemon's token-bypass
  connect compares `?token=` against this value (`extension/src/ui/connect.tsx`).
- **`rech setup` auto-reads the token** straight from the profile's `Local Storage/leveldb`
  (`readExtensionTokenFromProfile` in `rech.ts`) — read-only, never takes LevelDB's lock, safe while
  the user's Chrome runs. It anchors on the `auth-token` marker + `\x01`+43-char base64url value
  shape (LevelDB prefix-compression can split the origin string, so don't match the full origin).
  Verified to extract the exact registry token for every installed profile. So setup needs **no
  manual paste**; `--token`/`RECH_TOKEN` still override for headless edge cases.
- **Extension install still needs a one-time GUI "Load unpacked"** in the target profile. There is no
  non-GUI install path for the user's real Chrome: Secure Preferences is HMAC-signed (can't forge an
  install entry), and **branded Google Chrome 149+ rejects `--load-extension`** outright (stderr:
  `--load-extension is not allowed in Google Chrome, ignoring`). setup opens the install guide in the
  *correct* profile (`openInChromeProfile` via `--profile-directory`) — a new tab, never a restart.
- **`rech provision-profile <name> --experimental`** is the only fully-automated path: it runs on
  **Chromium / Chrome for Testing** (which still honors `--load-extension`), launches headless with
  `--load-extension`, seeds the token into `localStorage` over CDP (`provisionExtensionToken`), and
  registers it. Managed profiles carry `load_extension=<dist>` in `RECHROME_URL`; the daemon forwards
  it as `PLAYWRIGHT_MCP_LOAD_EXTENSION`, and the patched `cdpRelay.ts` re-adds `--load-extension` and
  **forces the Chromium executable** on every launch (branded Chrome would ignore the flag). This is
  a clean browser (no logins) — gated behind `--experimental`, not the default.
- **The relay-side `cdpRelay.ts` patch is NOT pinned on `main`.** It lives on the `lib/playwright`
  submodule branch **`sno-dev`** (commit `9fd8e2dd5` re-adds `--load-extension` + forces Chromium for
  `PLAYWRIGHT_MCP_LOAD_EXTENSION`); the pre-existing tip is preserved as tag `sno-dev-old-b6cc8dd`.
  `main` keeps the submodule pinned at the upstream-fetchable commit so fresh clones / CI don't break
  on an unpushed pin. So `rech setup` (the default real-Chrome flow) works from a clean checkout, but
  **`--experimental` needs the relay patch applied first**: in `lib/playwright/`, `git checkout
  sno-dev` then rebuild (`node utils/build/build.js`) so the patched `coreBundle.js` is what runs.
  Without that, a managed profile is seeded fine but `rech open` launches without re-loading the
  extension and the token-bypass connect fails. If the fork ever gets a pushed remote, pin `main` to
  `sno-dev` and drop this caveat.

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

## Driving rech as a client (screenshotting a page)

For an agent that just wants to *use* rech to open/verify a URL in the user's Chrome:

- **Package is `rechrome`, CLI alias `rech` — `bunx rech` 404s.** Not on PATH; run `bun rech.ts <cmd>`
  from this repo (or `bunx rechrome <cmd>`).
- **Env:** `PLAYWRIGHT_CLI="bunx playwright-cli" PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright"`
  (npm `playwright-cli` works when the vendored fork isn't checked out). It auto-loads `RECHROME_URL`
  from the nearest `.env.local` (walks cwd→root and **overwrites** `process.env`, so a URL passed on the
  CLI is ignored — edit the file).
- **`bun rech.ts status` first.** "bearer key rejected" = the `<KEY>@host` userinfo rotated (it does so
  every Mac serve restart) → ask the user for a fresh `RECHROME_URL`; can't SSH into the Mac.
- **Commands:** `open <url>` · `screenshot [--full-page] [--filename x.png]` · `resize <w> <h>` ·
  `eval "() => …"`. Screenshots download to `./.playwright-cli-multi-tab/` (gitignored).
- **Each call is a SEPARATE session.** An `eval` that scrolls does NOT persist into the next
  `screenshot` (it re-opens at top) — but **`resize` DOES** persist (it's a window property). To shoot
  below the fold on a page that scrolls an inner container (where `--full-page` only captures the
  viewport): `resize` the window tall so everything lays out without inner-scroll, `eval` the target's
  `getBoundingClientRect()` for its y, `screenshot`, then crop (e.g. PIL). Mobile view = `resize` to a
  phone width.
- **It's the user's real Chrome:** `resize` back to a normal size when done, and never quit/restart it
  (see the top rule). Browser HTTP cache is real — add a `?cb=<ts>` cache-buster after a deploy.
