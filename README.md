# rechrome — Remote Chrome

[![npm](https://img.shields.io/npm/v/rechrome)](https://www.npmjs.com/package/rechrome)

CLI proxy for running [Playwright](https://playwright.dev/) commands on a shared remote browser. Run a server on a machine with a browser, then send commands from any client.

Built on top of [playwright-multi-tab](https://github.com/snomiao/playwright-multi-tab) — a patched Playwright fork with multi-tab and multi-session browser automation.

## Features

- **Your real Chrome, from anywhere** — drive a logged-in Chrome profile from scripts, agents, or other machines
- **Session isolation** — each git worktree gets its own browser session (tab group) automatically
- **Per-project files** — screenshots and downloads land in `<project>/.rechrome/output/`
- **Share through any proxy** — Tailscale Serve, Caddy, nginx, cloudflared; one command on the client to connect
- **Security** — per-listener keys and profile allowlists, scoped remote commands, path traversal protection

## Install

```bash
bun i -g rechrome          # or run once with: bunx rechrome <command>
```

This gives you `rechrome` and its short alias `rech` — the same program. Requires [Bun](https://bun.sh/) ≥ 1.0;
the patched multi-tab Playwright CLI is bundled, with no browser download.

## Tutorial

### 1. Set up Chrome on this machine

```bash
rech setup
```

Setup installs the background daemon, asks which Chrome profile to use, and opens an install
guide **in that profile** for the one manual step Chrome requires: *Load unpacked* the extension
at `chrome://extensions`. It then reads the extension's token itself and verifies the connection.
Pick the profile up front with `rech setup --profile you@example.com`.

Check it:

```bash
rech status            # is it working: the URL in use, the daemon, the current profile
rech profile           # every Chrome profile and whether it is connected
```

The `CONNECTION` column checks each profile's default session for the current worktree without
opening a browser: **Connected**, **Registered / idle**, **Registered / unknown** (the check could
not complete), or **Not set up**. `ACCESS` lists the listeners that serve the profile.

### 2. Drive the browser

```bash
rech open https://example.com
rech screenshot                         # saved to <project>/.rechrome/output/
rech tab-list
rech eval "() => document.title"
rech --profile work@example.com open https://example.com   # another registered profile
rech --isolate open https://accounts.example.com           # throwaway session, e.g. for a login flow
```

Any [playwright-cli](https://github.com/snomiao/playwright-cli) command works after `rech`. When a
name clashes with one of rech's own (`status`, `--version`…), use `rech pw <args>` to forward it
verbatim: `rech --version` prints rechrome's version, `rech pw --version` playwright-cli's.
Commands from the same git worktree share one browser session, so tabs you open persist
between calls; another worktree gets its own. `-s=<name>` opens a named sub-session.

### 3. Where things are kept

| Where | What |
| --- | --- |
| `<project>/.rechrome/` | this project's `.env.local` (its `RECHROME_URL`) and `output/` (screenshots, downloads). Git-ignores itself. |
| `~/.rechrome/` | machine-wide: registered profiles, listeners and keys, the extension, daemon logs |

`<project>` is the git worktree root (submodules count as their parent project), or the current
directory outside git. rechrome reads `RECHROME_URL` from the nearest `.rechrome/.env.local` or
`.env.local` walking up from the current directory; an explicit environment variable wins.
When editing a file by hand, quote the URL (`RECHROME_URL="…#key=…"`): unquoted, a `#` starts a
comment for some .env loaders. rech quotes it when it saves one.

### 4. Use it from another machine

The daemon only listens on this machine until you expose a profile. The recommended way is a
**scoped listener behind a reverse proxy** — shown with Tailscale Serve, but any proxy that
forwards to `127.0.0.1:<port>` works. The commands are identical in bash, PowerShell and
`cmd.exe`.

On the host (the machine with Chrome):

```bash
rech listener add share --listen local --prefix=rechrome --port 13776 --profile you@example.com
tailscale serve --bg --set-path=/rechrome 13776
rech listener set share --public-url https://host.example.ts.net/rechrome/
rech share you@example.com                       # prints the URL to share — it contains a secret key
```

`rech listener add` prints these follow-up lines with your port filled in. For scripts,
`rech listener port share` prints the port (`$(rech listener port share)` in bash or PowerShell).

On the other machine, inside the project that should use it (or just open the link in a
browser: it shows these commands, per shell, with a Copy button):

```bash
rech connect 'https://host.example.ts.net/rechrome/?profile=you%40example.com#key=…'
rech open https://example.com
```

`rech connect` checks that the URL answers and allows the profile, then saves it to the project's
`.rechrome/.env.local`. Remote listeners allow navigation, tabs, snapshots, screenshots and basic
interactions, but not `eval`/`run-code` or filesystem commands (see [Remote access](#remote-access)).

**Share several profiles in one link.** `rech share work@example.com personal team-dev` puts
exactly those profiles on one listener (its own key; running it again reuses it). Add
`--listener <name>` to use a listener that already has a proxy route. Its links then reach
exactly this list, and `rech listener rotate-key <name>` issues a fresh key if old links shouldn't.

**Share every profile at once.** `rech share --all` gives one link for all Chrome profiles
registered on the host. It uses its own listener (`share-all`) and key, so one-profile links you
already handed out never gain access to the others. It is a snapshot: after registering another
profile, run `rech share --all` again. On the other machine, pick a profile per command, and the
host resolves the name (exact, the part of an email before `@`, or a unique 3+ letter prefix):

```bash
rech connect '<url from rech share --all>'
rech profile                                   # the profiles that link shares
rech --profile work@example.com open https://example.com
```

On a trusted LAN without a proxy, `rech setup --listen lan --profile you@example.com` binds the
profile to your LAN address directly (plain HTTP); share the result of `rech share`.

### 5. Manage access

```bash
rech share ls                                 # everything shared: listener × profile, local and public URLs (keys hidden)
rech share you@example.com                    # print one URL again (add --save to use it in this project)
rech listener allow share teammate@example.com
rech listener deny share teammate@example.com
rech listener rotate-key share                # revoke: every URL for this listener stops working
rech listener remove share
rech profile rm old-test-profile              # unregister a profile everywhere (asks first)
```

`rech profile rm <name>` shows its plan and asks before changing anything (`--yes` skips the
question). It removes every alias of the profile from rech's registry and from every listener,
dropping a listener left with no profiles. A managed test profile's own folder goes to the Trash,
and its running window is closed only with your consent (`--close` when not in a terminal). A real
Chrome profile's data is never touched: it is only unregistered from rech.

Changes apply immediately; the daemon reloads its listeners without restarting Chrome.
A link's key opens **every** profile its listener allows (`?profile=` only picks the default),
so give a profile its own listener when a link should reach only that one. `rech share ls`
points out keys that cover several profiles. The local management listener is never shared.

## Setup reference

```bash
rech setup                                        # choose a network, then a Chrome profile
rech setup --profile you@example.com              # non-interactive profile selection
rech setup --listen lan --profile you@example.com # expose the profile on a LAN address
```

If no supported daemon manager is available, setup asks before installing `oxmgr` globally
(default: No). It uses `bun i -g oxmgr` when launched with bunx and `npm i -g oxmgr`
when launched with npx. Pass `--yes` to approve this without prompting,
for example `bunx rechrome setup --profile Default --yes`.

Agents setting up Chrome on macOS can use the [rechrome setup skill](skills/rechrome-setup/SKILL.md),
which covers native extension installation with Computer Use and CLI connection verification.
`rech setup` detects Codex and Claude Code environment hints and prints agent-specific guidance;
set `RECH_SETUP_AGENT=codex`, `claude`, or `none` to override. Detection changes guidance only.

What it does per Chrome profile:

1. **Network** — choose where this profile should be accessible: Local (default),
   LAN, Tailscale (only when detected), or another detected interface. One daemon
   serves multiple addresses; changing this profile's exposure preserves other
   profiles. Listener changes reload without restarting the daemon or Chrome.
2. **Profile** — choose a Chrome profile; automatically select it when only one exists.
3. **Extension** — if the multi-tab extension isn't installed in the chosen profile, it opens an
   install guide **in that exact profile**; load it once via `chrome://extensions → Load unpacked`
   (a one-time manual click — Chrome only allows unpacked extensions through the GUI).
4. **Token and connection** — once the extension is present, the auth token is **read automatically** from the
   profile's `localStorage` (no copy-paste). For headless/agent runs you can also pass it
   explicitly:

   ```bash
   rech setup --profile "Profile 18" --token <PLAYWRIGHT_MCP_EXTENSION_TOKEN>   # or RECH_TOKEN=… rech setup …
   ```

For unattended runs, `--listen local`, `--listen lan`, `--listen tailscale`, or
`--listen <detected-IP>` chooses the network. Multiple LAN addresses require an
explicit IP. Without `--listen`, setup selects local-only access for this profile.
Choosing Local removes this profile from remote listener allowlists. LAN binds to the selected address,
not `0.0.0.0`. Discovery lists IPv4 interfaces; it does not configure port forwarding
or publish through external tunnel providers.

`setup` opens a live guide in the selected profile. On macOS, the Extensions tab
is immediately before the guide: copy the path, switch to the previous tab, choose
Load unpacked, paste the path, and return. Setup monitors installation and reads
the token automatically, then verifies the browser connection. The page updates
without a refresh and offers Retry connection if the handshake fails.

Manual token paste remains available in the guide and interactive terminal;
`--token` / `RECH_TOKEN` also work. Keep the setup process running while using the
guide. Installation/token detection and connection retries each time out after
15 minutes. Non-interactive setup waits for browser installation rather than
prompting for stdin, then uses the default configuration save location.

> **Managed QA profiles (experimental):** `rech provision-profile <name> --experimental` spins up a
> fully isolated profile on **Chrome for Testing** (run `npx playwright install chromium` first) with
> the extension auto-loaded and the token auto-seeded — zero GUI, zero TTY. It is *not* your real
> Chrome (branded Google Chrome 149+ rejects `--load-extension`), so it has no logins/cookies; use it
> for clean QA fixtures, and `rech setup` for your real, logged-in Chrome.
> After provisioning, `rech --profile <name> open https://example.com` automatically launches
> that managed browser with the bridge loaded; no separate browser launch is needed.

## Configuration


Profiles are stored in `~/.rechrome/profiles.yaml`. Existing `profiles.json` registries are also supported and automatically migrated on first read; the original JSON is retained as a private backup. YAML takes precedence when both exist. Registry writes are atomic and use owner-only permissions because entries contain Playwright bridge tokens. Invalid YAML fails explicitly instead of falling back to potentially stale JSON credentials.

Connection parameters also accept URL fragments:

```sh
RECHROME_URL='https://your-host.ts.net/rechrome/?profile=qa#key=DAEMON_KEY' rech status
```

`rech setup` prints and saves this URI format. Retrieve it later with `rech share qa` (alias: `rech profile qa --print-uri`), or omit `qa` to use the configured profile. `profiles` remains an alias. The command prints only the URI to stdout, using the configured `RECHROME_URL` endpoint; `--listener local` selects a local listener instead. For example: `rech profile qa --print-uri --listener local`. The output contains a secret daemon key.

Direct connections use the root path, such as `http://127.0.0.1:13775/?profile=qa#key=DAEMON_KEY`. A prefix is optional and only added when explicitly configured with `--prefix`, for example for a proxy mounted at `/rechrome/`. Tailscale can also serve at the root without a prefix.

Setup generates this format: the profile is in the query and the daemon listener's bearer `key` is in the fragment. The daemon looks up the registered profile's separate Playwright bridge token and browser paths locally. Advanced clients can still supply the bridge credential as `token` (for example `#key=DAEMON_KEY&token=BRIDGE_TOKEN`). Fragment parameters override matching query parameters; fragment `key` overrides legacy `KEY@host`. Both `#?key=…` and `#key=…` work. The CLI reads these locally and sends the daemon key as an Authorization header; fragments are omitted from HTTP request URLs. Opening the URL in a browser does not configure a client or display a dashboard. Fragments can still be stored in browser history and copied links, so treat the complete connection URL as a secret.

To configure by hand instead, copy `.env.example` to `.env.local` and edit:

```bash
cp .env.example .env.local
```

| Variable                            | Description                                                                                                                         | Default          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `RECHROME_URL`                      | Connection URL, saved by `rech setup` / `rech connect` / `rech share --save`. Also accepts `?extension_id=`, `?token=`, `?profile=` query params | —                |
| `PLAYWRIGHT_CLI`                    | Override the playwright-cli command/path (defaults to the bundled `@playwright/cli`; set this only for a custom or forked CLI)       | bundled `@playwright/cli` |
| `RECH_HOST`                         | Legacy bind address, used only before listeners.json is configured                                                                  | `127.0.0.1`      |
| `PLAYWRIGHT_MCP_EXTENSION_ID`       | Chrome extension ID (client overrides server)                                                                                       | —                |
| `PLAYWRIGHT_MCP_EXTENSION_TOKEN`    | Chrome extension token — profile-specific, get it from the extension's status page (client overrides server)                        | —                |
| `PLAYWRIGHT_MCP_USER_DATA_DIR`      | Chrome user data directory — use to pin connections to a specific Chrome install (client overrides server)                          | —                |
| `PLAYWRIGHT_MCP_PROFILE_DIRECTORY`  | Chrome profile — accepts directory name (`Profile 2`), display name (`Snowstar`), or **email** (`you@example.com`) (client overrides server) | —         |

> **Multi-profile tip:** Each project's `.env.local` can specify a different Chrome profile via the `?profile=` query param in `RECHROME_URL`. The server resolves display names and email addresses to the actual Chrome profile directory automatically (reads `~/Library/Application Support/Google/Chrome/Local State`).
>
> ```
> # <project>/.rechrome/.env.local for a work project
> RECHROME_URL="http://127.0.0.1:13775/?profile=you%40company.com#key=KEY"
> ```
>
> Shell-set `PLAYWRIGHT_MCP_*` variables take priority over `.env.local`, so you can always override per-command without editing files.

### Remote access

`rech setup --profile <profile> --listen tailscale` exposes that profile through a
dedicated authenticated listener while retaining local management. The daemon
stores listener addresses, keys, and profile allowlists in `~/.rechrome/listeners.json`
(mode 0600), reloads changes automatically, and rejects invalid changes while keeping
the last working configuration. Each listener has its own bearer key. Use `rech profile ls`
to see configured exposure, and `rech listener ls` to list bindings without credentials.

```bash
rech listener add qa --listen tailscale --profile qa-remote --port 13776
rech listener remove qa
```

Repeat `--profile` to allow several registered profiles. A profile may appear on
multiple listeners; `setup --listen` selects its exposure afresh. Change an existing
listener with `rech listener allow|deny <name> <profile...>`, and replace its key with
`rech listener rotate-key <name>` (URLs carrying the old key stop working). Changes do not terminate
browser sessions; removed listeners reject further requests. An occupied or unavailable
address causes reload to retain the old configuration, so verify reachability after editing.

Remote listeners permit navigation, tabs, snapshots, screenshots, and basic page interactions.
They reject arbitrary `run-code`/`eval`, filesystem commands, global session commands, and
browser/config overrides. Those commands remain available on the unrestricted **loopback
management listener**. Scoped sessions and output directories are separate from management
sessions; a listener cannot download another profile's output. This is an application access
policy, not an OS sandbox for the browser. Never publish the management listener through a
proxy or tunnel to clients that should have restricted access.

LAN traffic is plain HTTP unless TLS is configured. Tailscale provides its private transport;
binding an address does not configure Tailscale ACLs, port forwarding, or public tunnels.

#### Reverse proxies

See [Use it from another machine](#4-use-it-from-another-machine) for the workflow. Details:
a prefixed listener accepts requests with or without its prefix, so the proxy may strip the
mount path (bare port target) or keep it (`http://127.0.0.1:13776/rechrome`).
`--prefix=rechrome` and `--prefix=/rechrome/` both normalize to `/rechrome/`. `rech setup
--listen local --prefix=rechrome` also creates such a listener and, when a matching Tailscale
Serve route exists, prints the remote URL. `rech status` shows the URL in use and which
listener answered. Never proxy the unrestricted management listener. The setup guide is a
temporary local page owned by the setup process; it is not published through a proxy.

Existing installations retain the legacy listener until `rech setup` initializes the new
configuration. The first migration restarts only the daemon to load the new source. Existing
remote access is retained for currently registered profiles with a **new scoped key**; remote
clients need the new listener credentials. Browser processes are left running.

## Session namespacing

Each client gets its own browser session, keyed by the **git worktree root path** (submodules
roll up to their parent), or the current directory outside git. So two worktrees of one repo
get separate sessions, and `git checkout` keeps you in the same one. `RECH_IDENTITY=branch`
restores the older `<remote>/tree/<branch>` keying and `RECH_IDENTITY=cwd` keys on the exact
directory. Pass `-s=<name>` for a named sub-session, or `--isolate` for a throwaway one.

## Development

```bash
git clone https://github.com/snomiao/rechrome.git
cd rechrome
bun install       # `prepare` also builds vendor/ from vendor-src/, so the checkout has a working CLI
bun link          # makes this checkout the global rechrome / rech
bun test ./*.test.ts ./*.spec.ts ./scripts/*.test.ts   # rechrome's own tests (plain `bun test` also finds the vendored forks' suites)
```

To use a different playwright-cli, set `PLAYWRIGHT_CLI=<cmd>` in `.env.local` (for example a
local checkout of the [playwright-cli fork](https://github.com/snomiao/playwright-cli)).

## Why we fork playwright

rechrome depends on [playwright-multi-tab](https://github.com/snomiao/playwright-multi-tab), which is a fork of [microsoft/playwright](https://github.com/microsoft/playwright). We maintain it because the upstream does not yet support several features required for rechrome's use case:

| Feature | Our change | Status |
|---------|-----------|--------|
| Multi-tab control | `playwright-multi-tab` fork adds `tab-new`, `tab-list`, `tab-select`, `tab-close` commands and a persistent session daemon | Not in upstream |
| `PLAYWRIGHT_MCP_EXTENSION_ID` | Lets you specify a custom extension ID instead of the hardcoded default | Not in upstream |
| `PLAYWRIGHT_MCP_PROFILE_DIRECTORY` | Passes `--profile-directory` to Chrome so the correct system profile is used; auto-detects the Chrome user data dir by OS | Not in upstream |

We also fork [playwright-mcp](https://github.com/snomiao/playwright-mcp) (inside `playwright-multi-tab/lib/playwright-mcp`) to support the custom extension ID and multi-tab session routing.

PRs upstream are welcome. Once these features land in the official packages we will drop the forks.

## Related

- [playwright-multi-tab](https://github.com/snomiao/playwright-multi-tab) — the underlying Playwright fork powering rechrome's multi-tab and multi-session browser control
- [microsoft/playwright](https://github.com/microsoft/playwright) — upstream

## License

MIT
