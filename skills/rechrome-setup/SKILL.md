---
name: rechrome-setup
description: Set up or repair rechrome access to a selected Chrome profile, especially on macOS, using Computer Use for the one-time Load unpacked flow and the CLI for token detection and connection verification.
---

# Rechrome setup on macOS

Use this workflow when the user requests rechrome setup for an existing Chrome profile. Complete the CLI and browser steps together; opening the guide alone is not completion.

## Choose the browser and profile

- Preserve the user's browser choice. Installed Google Chrome profiles belong to the user; do not rename, create, delete, or replace them as part of setup.
- If the user wants an isolated Playwright browser, do not send them through real-Chrome extension installation. Playwright can control its own browser directly. Check the current CLI help for available managed-browser support: the legacy `provision-profile --experimental` flow still uses a bridge and may require the vendored relay patch described in the repo's `AGENTS.md`. Do not present a proposed direct-browser mode as implemented.
- Run `rech profile ls` and resolve the exact email, display name, or folder. For no-email profiles, use the folder (for example `Profile 7`) to avoid ambiguity. A requested display name such as `taku3` is also accepted with `--profile`.
- Use `rech` or `rechrome` if installed; from a checkout use `bun rechrome.ts`. The package is `rechrome`, not `rech`: use `bunx rechrome`, never `bunx rech`.

## Start and retain the setup process

Run `rech setup --profile "<selector>"` in a retained terminal session, preferably with a TTY. A bare positional selector such as `rech setup taku3` is not supported by the current CLI.

- The listen choice applies to the selected profile. Local is the default and removes that profile from remote allowlists; choose LAN or Tailscale when requested. Other profiles keep their exposure. The menu shows Tailscale only when detected. Use `rech listener ls` and `rech profile ls` to review configured bindings. Listener changes reload in one daemon without restarting Chrome; first migration may restart only the daemon.
- Keep the terminal session handle and poll it while working in Chrome. Non-TTY mode also works, but input is read until EOF before setup starts: provide all prompt answers and close stdin. EOF does not stop the guide server.
- The guide is served by this setup process on a random loopback port. Cancelling setup, a process timeout, or setup finishing makes the server unavailable. Keep the process running during installation; a restarted setup produces a new guide URL. Do not keep retrying an old guide tab.
- For a Tailscale path mount, use `--listen local --prefix=rechrome --port=13776` (or another free port). This creates a profile-scoped backend at `/rechrome/`, separate from management. Setup prints the Serve command without executing it. Follow the available Tailscale Serve skill before changing routes, preserve existing mounts, and include `/rechrome` in both `--set-path` and the proxy target. Remote connection URLs must retain the prefix; the temporary setup guide stays local.
- Respect tool escalation for opening Chrome, localhost networking, and writes under the user's home. A sandbox networking failure is not proof that the daemon is broken.
- Setup manages the daemon through the configured manager, normally oxmgr. Check `rech status` and `oxmgr status` when necessary. Do not replace the user's service configuration or reinstall repeatedly just because a restricted probe failed.

## Install the extension with Computer Use

Load the available **Computer Use** skill (`computer-use:computer-use`, or its installed equivalent) and follow its runtime instructions. Use its supported accessibility/screenshot tools for Chrome's native UI and the macOS folder picker. This workflow does not depend on rechrome already controlling the target profile.

If a browser skill must be loaded before browser interactions, follow that routing first. Use Computer Use for native controls or surfaces the browser tool cannot access. Do not improvise an alternate UI automation mechanism when the required tool is unavailable: leave setup running and give the user the remaining manual step.

1. Inspect the active Chrome window and verify the selected profile. The setup guide identifies the target, and setup opens it in that profile. Do not assume the frontmost Chrome window belongs to it.
2. The guide should follow an Extensions tab. Switch to the previous tab with **Command+Shift+[** on macOS (or select the observed Extensions tab). Use `chrome://extensions/` via the address bar if needed. Clicking or dragging a `chrome://` hyperlink can produce `about:blank#blocked`.
3. Enable **Developer mode** if needed and locate **Load unpacked**. Follow the Computer Use skill's confirmation rules immediately before installing an extension. Explain that this installs the local rechrome bridge into the selected profile; do not invent a requirement for administrator access.
4. Click **Load unpacked**. In the native folder picker, press **Command+Shift+G**, enter the exact extension directory shown in the guide, and press Return. The usual path is `~/.rechrome/extension`; resolve the current user's home rather than copying another machine's username. Select/Open that directory to finish.
5. Inspect the result: the extension should appear without a load error. Return to the guide and monitor the terminal. If the extension already exists, inspect its state instead of adding a second copy. Reload a patched extension only with the user's authorization.

Use fresh accessibility state after actions, and screenshots when the picker or Chrome controls are not exposed clearly. Do not select a different profile to get past a blocked installation.

Never quit, kill, or restart the user's Chrome to complete setup. Never modify Chrome's Preferences, Secure Preferences, or LevelDB files to force an installation or rename. Branded Chrome does not offer a supported silent unpacked-install path through this CLI; do not promise `--load-extension` will install into a running real-Chrome profile.

## Verify and finish

- Setup detects the extension and reads its token automatically. If initialization is needed, open the extension status URL shown by the guide in the same profile. Do not rely on a visible toolbar icon.
- Let the CLI complete its bridge connection check. Use manual token entry only when automatic detection fails, and keep tokens out of tool output, screenshots, chat, and committed files. Do not replace the token reader with raw LevelDB byte scans.
- At the save prompt, use the destination requested by the user. When merely adding access to a profile, choose **Skip saving URL (register profile only)** to avoid replacing the project's default profile. Choose no additional profiles unless requested.
- Report completion only after the CLI confirms the bridge check and registration. `Registered` alone does not prove a working connection. `rech profile ls` checks the current worktree's default session; a successful setup probe is separate, so an idle listing after setup is not necessarily failure.
- Report verifiable milestones as `○ pending` or `✓ verified`, following the CLI and guide checks. Token detection does not verify the bridge, and a successful bridge check does not mean registration has been saved. Never mark manual instructions complete based only on having displayed them.
- If installation or verification fails, report the concrete error and remaining action. Leave a waiting setup process alive when handing the GUI step to the user; stop it when they cancel that setup. Say explicitly when it has been stopped so the guide's unreachable message is understandable.

The completion response should identify the profile, whether verification succeeded, and whether the default connection configuration changed. Do not print the bearer URL or auth token.
