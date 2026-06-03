# oxmgr daemon env leak — when stale `.env.local` values haunt every child

## Symptom

`rech` keeps printing:

```
[rech] warning: shell PLAYWRIGHT_MCP_EXTENSION_TOKEN differs from registry
token for "<email>" — using shell value. Run `unset PLAYWRIGHT_MCP_EXTENSION_TOKEN`
to use the registry.
```

`unset` makes the warning go away for the current shell, but the **next**
shell you open prints it again. Variables you cannot find in any of:

- `~/.zshrc` / `~/.zshenv` / `~/.zprofile`
- `/etc/zshenv` / `/etc/zshrc` / `/etc/zprofile`
- `launchctl getenv …`
- the current directory's `.env` / `.env.local`

…are nevertheless present in every fresh shell:

```sh
$ env | grep -E '^(PLAYWRIGHT|RECH_)'
PLAYWRIGHT_CLI=node /Users/<other-user>/ws/snomiao/rechrome/.../playwright-cli.js
PLAYWRIGHT_MCP_EXTENSION_ID=…
PLAYWRIGHT_MCP_EXTENSION_TOKEN=…
PLAYWRIGHT_MCP_PROFILE_DIRECTORY=…
RECH_TLS_CERT=/Users/<other-user>/…
RECH_TLS_KEY=/Users/<other-user>/…
```

The paths reference a user / home that does not exist on the current machine.
TLS-renewal logs show `EACCES: permission denied, open '/Users/<other-user>/…'`.

## Root cause

The vars are pinned in the **oxmgr daemon process's environment**, not in any
shell rc file. oxmgr daemon inherits its env from the shell that first launched
it; that env is then propagated, unchanged, to every managed process tree —
including any vscode `serve-web` / PTY host / interactive shell that runs under
oxmgr.

The original injection happens when the daemon is launched from a directory
whose `.env.local` defines these vars (bun's auto-loader populates
`process.env` before the daemon spawns). Once that happens, even if the
`.env.local` is later moved (e.g. renamed to `.env.bak.local`) or scrubbed,
the daemon's in-memory copy of the env is frozen, and every child it spawns
inherits the stale values. `bunx oxmgr daemon …` from `rechrome/.../.env.local`
is the typical trigger.

Symptoms downstream:

- `rech` reads `process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN` and complains it
  doesn't match `~/.rechrome/profiles.json` (and proceeds with the stale value)
- `serve.ts` reads `process.env.RECH_TLS_CERT` / `RECH_TLS_KEY` and fails to
  open the paths on the wrong machine
- the daemon's `state.json` env field shows only the explicit overrides
  (`HOME`, `PATH`, `RECHROME_URL`) — it does **not** record the inherited
  process env, so the leak is invisible without inspecting the live process

## How to diagnose

1. Find the daemon and dump its actual env:
   ```sh
   pid=$(pgrep -f 'oxmgr.*daemon run')
   ps eww -p "$pid" | tr ' ' '\n' | grep -E '^(PLAYWRIGHT|RECH_|npm_|PWD)'
   ```
   The `PWD=…` and `npm_package_name=…` / `npm_lifecycle_script=…` lines tell
   you *which* directory / package context spawned the daemon.

2. If the registered env in `state.json`
   (`~/Library/Application Support/oxmgr/state.json` on macOS) is clean but
   the live process has extra `PLAYWRIGHT_*` / `RECH_*` lines, the leak is
   inherited, not declared.

3. Cross-check against `.env.local` / `.env.bak.local` in the directory shown
   by `PWD=…`. The stale TOKEN value almost always still matches one of
   those files verbatim.

## Fix

Delete or scrub the offending `.env.local` (or `.env.bak.local`) so it can't
re-poison anything, then restart the oxmgr daemon from a clean environment:

```sh
env -i HOME="$HOME" PATH="$PATH" SHELL="$SHELL" USER="$USER" \
  oxmgr daemon stop
env -i HOME="$HOME" PATH="$PATH" SHELL="$SHELL" USER="$USER" \
  oxmgr daemon start
```

⚠️ The daemon's managed process tree dies with the daemon. If you are running
your editor / agent *inside* one of those trees (e.g. a vscode `serve-web`
PTY launched by oxmgr), run the restart from a separate terminal.

Verify the new daemon is clean:

```sh
ps eww -p "$(pgrep -f 'oxmgr.*daemon run')" \
  | tr ' ' '\n' | grep -E '^(PLAYWRIGHT|RECH_)'
# → empty output
```

## Prevention

- Don't put machine-specific absolute paths in `.env.local` files that may be
  loaded by long-lived daemons. Use `${HOME}` expansion, or compute the path
  at runtime.
- If `rech daemon-install` (`rech.ts:daemonInstall`) is the entrypoint, prefer
  invoking it from a clean shell (`env -i …`) so the daemon's persistent env
  matches what's declared in oxmgr's `state.json`.
- Consider having `serve.ts` log every env var it actually reads on startup
  so the leak surfaces in `rechrome-serve.err.log` instead of going silent.
