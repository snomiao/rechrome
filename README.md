# rechrome — Remote Chrome

[![npm](https://img.shields.io/npm/v/rechrome)](https://www.npmjs.com/package/rechrome)

CLI proxy for running [Playwright](https://playwright.dev/) commands on a shared remote browser. Run a server on a machine with a browser, then send commands from any client.

Built on top of [playwright-multi-tab](https://github.com/snomiao/playwright-multi-tab) — a patched Playwright fork with multi-tab and multi-session browser automation.

## Features

- **Session isolation** — clients are automatically namespaced by git repo or hostname
- **File transfer** — screenshots and PDFs are automatically downloaded to the client
- **Hot-reload config** — `.env.local` changes are picked up without restart
- **Security** — bearer auth, path traversal protection, env allowlisting for child processes

## Prerequisites

- [Bun](https://bun.sh/) ≥ 1.0

The patched multi-tab playwright CLI that drives Chrome (with multi-tab, multi-session, and
per-profile `PLAYWRIGHT_MCP_PROFILE_DIRECTORY` support) is **bundled inside the package** — no
separate install, no `playwright` browser-binary download. `bun i -g rechrome` is enough for
`rechrome setup` to work out of the box.

> **Advanced:** override the bundled CLI with `PLAYWRIGHT_CLI=<cmd>` in your `.env.local` (e.g. to
> point at a local checkout of the [playwright-cli fork](https://github.com/snomiao/playwright-cli)).

## Install

```bash
# From npm
bunx rechrome --help

# Or clone and link globally
git clone https://github.com/snomiao/rechrome.git
cd rechrome
bun install
bun link
```

Now `rechrome` (or `rech`) is available globally.

`rech profile` and `rech profiles` are aliases that list installed Chrome profiles and registered managed test profiles together.
Both also accept `ls` or `list`, for example `rechrome profiles ls`.
The connection column checks each profile's default session for the current worktree without
opening a browser: **Connected**, **Registered / idle**, **Registered / unknown** (the check
could not complete), or **Not set up**. Sessions opened with a custom `-s` or from another
worktree are outside this check. Managed test profiles are labeled separately from real Chrome.

## Quick start

Agents setting up Chrome on macOS can use the [rechrome setup skill](skills/rechrome-setup/SKILL.md), which covers native extension installation with Computer Use and CLI connection verification.
`rech setup` detects Codex and Claude Code environment hints and prints agent-specific guidance before the setup prompts. Set `RECH_SETUP_AGENT=codex`, `claude`, or `none` to override detection. Detection changes guidance only; desktop automation still follows the available tools and approval rules.

### 0. One-command setup (recommended)

`rech setup` configures the daemon, Chrome extension, and connection URL in one pass:

If no supported daemon manager is available, setup asks before installing `oxmgr` globally
(default: No). It uses `bun i -g oxmgr` when launched with bunx and `npm i -g oxmgr`
when launched with npx. Pass `--yes` to approve this installation without prompting,
for example `bunx rechrome setup --profile Default --yes`.

```bash
rech setup                          # choose a network, then a Chrome profile
rech setup --profile you@email.com  # non-interactive profile selection
rech setup --listen tailscale --profile you@email.com
```

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

### 1. Start the server

On the machine with a browser:

```bash
rechrome serve
```

This auto-generates a connection URL in `.env.local` (with an auth key).

### 2. Run commands from a client

Copy the `RECHROME_URL` from the server's `.env.local` to the client's project `.env.local`:

```bash
# .env.local in your project directory
RECHROME_URL=http://YOUR_KEY@server-host:13775

# Open a URL
rech open https://example.com

# Take a screenshot
rech screenshot

# List open tabs
rech tab-list

# Any playwright-cli command works
rech --help
```

rechrome walks up from the current working directory to find `.env.local`, so each project can have its own connection URL, Chrome profile, and extension token. Explicit environment variables take priority: `RECHROME_URL='http://KEY@host:13775' rech status` overrides the saved URL for that command.

## Configuration

Profiles are stored in `~/.rechrome/profiles.yaml`. Existing `profiles.json` registries are also supported and automatically migrated on first read; the original JSON is retained as a private backup. YAML takes precedence when both exist. Registry writes are atomic and use owner-only permissions because entries contain Playwright bridge tokens. Invalid YAML fails explicitly instead of falling back to potentially stale JSON credentials.

Connection parameters also accept URL fragments:

```sh
RECHROME_URL='https://your-host.ts.net/rechrome/?profile=qa#key=DAEMON_KEY' rech status
```

`rech setup` prints and saves this URI format. Retrieve it later with `rech url qa` (alias: `rech profile qa --print-uri`), or omit `qa` to use the configured profile. `profiles` remains an alias. The command prints only the URI to stdout, using the configured `RECHROME_URL` endpoint; `--listener local` selects a local listener instead. For example: `rech profile qa --print-uri --listener local`. The output contains a secret daemon key.

Direct connections use the root path, such as `http://127.0.0.1:13775/?profile=qa#key=DAEMON_KEY`. A prefix is optional and only added when explicitly configured with `--prefix`, for example for a proxy mounted at `/rechrome/`. Tailscale can also serve at the root without a prefix.

Setup generates this format: the profile is in the query and the daemon listener's bearer `key` is in the fragment. The daemon looks up the registered profile's separate Playwright bridge token and browser paths locally. Advanced clients can still supply the bridge credential as `token` (for example `#key=DAEMON_KEY&token=BRIDGE_TOKEN`). Fragment parameters override matching query parameters; fragment `key` overrides legacy `KEY@host`. Both `#?key=…` and `#key=…` work. The CLI reads these locally and sends the daemon key as an Authorization header; fragments are omitted from HTTP request URLs. Opening the URL in a browser does not configure a client or display a dashboard. Fragments can still be stored in browser history and copied links, so treat the complete connection URL as a secret.

Copy `.env.example` to `.env.local` and edit:

```bash
cp .env.example .env.local
```

| Variable                            | Description                                                                                                                         | Default          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `RECHROME_URL`                      | Connection URL (auto-generated by `rech serve`). Also accepts `?extension_id=`, `?token=`, `?profile=` query params                 | —                |
| `PLAYWRIGHT_CLI`                    | Override the playwright-cli command/path (defaults to the bundled `@playwright/cli`; set this only for a custom or forked CLI)       | bundled `@playwright/cli` |
| `RECH_HOST`                         | Legacy bind address, used only before listeners.json is configured                                                                  | `127.0.0.1`      |
| `PLAYWRIGHT_MCP_EXTENSION_ID`       | Chrome extension ID (client overrides server)                                                                                       | —                |
| `PLAYWRIGHT_MCP_EXTENSION_TOKEN`    | Chrome extension token — profile-specific, get it from the extension's status page (client overrides server)                        | —                |
| `PLAYWRIGHT_MCP_USER_DATA_DIR`      | Chrome user data directory — use to pin connections to a specific Chrome install (client overrides server)                          | —                |
| `PLAYWRIGHT_MCP_PROFILE_DIRECTORY`  | Chrome profile — accepts directory name (`Profile 2`), display name (`Snowstar`), or **email** (`you@example.com`) (client overrides server) | —         |

> **Multi-profile tip:** Each project's `.env.local` can specify a different Chrome profile via the `?profile=` query param in `RECHROME_URL`. The server resolves display names and email addresses to the actual Chrome profile directory automatically (reads `~/Library/Application Support/Google/Chrome/Local State`).
>
> ```
> # .env.local for a work project
> RECHROME_URL="http://KEY@server:13775?token=TOKEN&extension_id=EXT_ID&profile=taku%40company.com"
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
rech listener add qa --listen tailscale --profile qamac-remote --port 13776
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

#### Sharing a profile through a reverse proxy

rechrome does not depend on a particular proxy. Put a scoped **loopback** listener behind
any reverse proxy (Tailscale Serve, Caddy, nginx, cloudflared…), record where it is
reachable, and share the printed URL. The commands are the same in bash, PowerShell and
`cmd.exe`: you choose the port, so there is nothing to substitute.

On the host (the machine with Chrome):

```bash
rech listener add share --listen local --prefix=rechrome --port 13776 --profile you@example.com
tailscale serve --bg --set-path=/rechrome 13776          # or any proxy to 127.0.0.1:13776
rech listener set share --public-url https://host.example.ts.net/rechrome/
rech url you@example.com --listener share                # prints the URL to share (secret)
```

`rech listener add` prints these next steps with your port filled in, and
`rech listener port share` prints the port for scripts, e.g. in bash or PowerShell
`tailscale serve --bg --set-path=/rechrome $(rech listener port share)`.
A prefixed listener accepts requests with or without the prefix, so the proxy may strip
the mount path (bare port target) or keep it (`http://127.0.0.1:13776/rechrome`).

On a client:

```bash
rech connect 'https://host.example.ts.net/rechrome/?profile=you%40example.com#key=…'
rech open https://example.com
```

`rech connect` checks that the URL answers and allows the profile, then saves it as
`RECHROME_URL` in the project's `.rechrome/.env.local` (git-ignored). `rech url ls` lists
every listener and profile with local and public URLs, keys hidden. `rech status` shows the
URL in use and which listener answered.

`--prefix=rechrome` and `--prefix=/rechrome/` both normalize to `/rechrome/`. `rech setup
--listen local --prefix=rechrome` also creates such a listener; when a Tailscale Serve route
for it already exists, setup prints the remote URL. Never proxy the unrestricted management
listener. The setup guide remains a temporary local page owned by the setup process; it is
not published through a proxy.

Existing installations retain the legacy listener until `rech setup` initializes the new
configuration. The first migration restarts only the daemon to load the new source. Existing
remote access is retained for currently registered profiles with a **new scoped key**; remote
clients need the new listener credentials. Browser processes are left running.

## Session namespacing

Each client gets an isolated browser session based on:

1. **Git repo URL + branch** (if in a git repo)
2. **Hostname + working directory** (fallback)

Clients can also pass `-s=name` to create named sub-sessions within their namespace.

## Development

```bash
bun install
bun test
```

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
