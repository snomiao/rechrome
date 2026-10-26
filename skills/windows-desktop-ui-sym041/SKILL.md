---
name: windows-desktop-ui-sym041
description: Operate the Windows desktop on sym041 through the vault lane's winrpc client on symubu, especially to install the rechrome Bridge in an explicitly selected Chrome profile. Use for authorized native Windows UI work, not ordinary browser commands once rech works.
---

# Windows desktop UI on sym041

## Route and scope

Use the vault lane **[dede] on symubu** as the winrpc executor. The controlling lane sends small, exact AHK v2 scripts; dede runs each request and returns its result and a private screenshot path. `WINRPC_URL` and `WINRPC_TOKEN` stay on symubu. Do not copy them to sym003, print them, include them in messages, or invoke CLI help with credential-bearing arguments (a client previously echoed a token in help output). Have dede read the existing private environment in-process and issue HTTP requests without logging authorization headers.

Begin **every outgoing `ay` message with `[rechrome]`**, including status, instructions, and review requests. Identify the requesting host/worktree on first contact. Resolve the current coordinator and vault lane IDs instead of assuming an old PID still belongs to them. Example, with the verified current lane ID:

```sh
ssh symubu 'PATH="$HOME/.bun/bin:/usr/bin:/bin" ay send --force <lane-id> "[rechrome] Request and exact next step..."'
```

An `ay` result of `QUEUED` means accepted; do not resend. If the executor is waiting on unrelated approval, tell the coordinator rather than answering that approval yourself.

Obtain authorization for the target profile, extension and task. Existing task authorization covers its routine steps; do not repeatedly ask the user to click things or reapprove them. Ask for permission or missing information when scope must change. Never assume authorization to restart Chrome, enable debugging flags, alter policy, access logins, create credentials, or change other profiles. Do not read unrelated tab contents.

## Preflight and locking

- Windows SSH gives a non-interactive session, often session 0. It is suitable for diagnostics and CLI calls, not launching GUI automation directly. winrpc must already run on the interactive desktop; use `POST /ahk-eval?gui=1` through dede.
- Read the installed winrpc README and implementation when its behavior is uncertain. The observed installation was `C:\tmp\winrpc`; the source is [symval/winrpc](https://github.com/symval/winrpc).
- Check `GET /health` and `GET /lock`. Normal `/ahk-eval` requests acquire the cross-process `C:\tmp\im-ui.lock` automatically. The observed TTL was 60 seconds; keep scripts short. Never force-unlock or use `readonly=1` to bypass locking for UI actions.
- The observed API has no acquire/hold endpoint across requests. Use per-action locks, passive screenshots between actions, and coordinator-confirmed exclusive desktop access. If someone requires a continuous lock, explain this limitation before proceeding. Do not silently claim the lock is held between calls. Passive screenshots do not acquire it.
- Take a screenshot **before** any action. After each small action, capture another screenshot and inspect it before sending the next action. Send scripts as exact UTF-8 files: semicolons in AHK start comments, so do not flatten scripts into semicolon-separated chat prose.
- The observed `/screenshot` captured only 1280x720 of a 1920x1080 desktop at 150% scaling. If edges are missing, have dede use a DPI-aware passive capture through `/shell`; do not change display settings. Confirm bounds and scaling before using coordinates. In AHK, use `SetThreadDpiAwarenessContext(-4)` and `CoordMode("Mouse", "Screen")` for coordinates measured from a physical-pixel capture.

## Prove the Chrome profile

Do not infer the profile from the foreground window or its display-name chip. Navigate the intended window to `chrome://version` and inspect **Profile Path**. For the established task it ended in `User Data\Profile 1`; future tasks must use their explicitly requested folder. Record that window's HWND and Chrome PID for this run. Never reuse old handles or PIDs from this runbook.

To navigate reliably, activate the verified HWND, wait about 500 ms, press Ctrl+L, wait about 300 ms, then paste the exact URL from the clipboard. Preserve the previous clipboard with `ClipboardAll()`, wait for the paste to complete, and restore it without printing its contents. Capture and inspect the address bar **before Enter**. Press Enter only when it contains the intended URL exactly and the same verified window remains active.

Direct `SendText` immediately after Ctrl+L lost the initial `chr` from `chrome://extensions/` during the observed run and submitted a search. Clipboard paste with focus delays worked. Never click the resulting search results as a workaround.

## Load only the requested extension

1. In the verified profile, navigate to `chrome://extensions/` using the paste/check/Enter sequence. Inspect the extension list and Developer mode state. Leave Developer mode unchanged if already enabled; otherwise enable it only as part of the authorized unpacked-install task.
2. Confirm the extension is not already installed; do not blindly add or reload it. For rechrome, verify the installed manifest and expected ID. The observed Bridge ID was `mmlmfjhmonkocbjadbfplnigmagldckm`.
3. Click **Load unpacked** once and capture the native folder picker. The observed directory was `C:\Users\taku\.rechrome\extension`, not `.rechrome\ext`; verify the actual manifest path before selecting it.
4. Identify the picker before entering text. A Windows Chrome file picker can be a **different Chrome PID** from the main browser. The observed picker was class `#32770`, had its own HWND/PID, and its owner was the verified Profile 1 HWND. Guard on the freshly observed dialog HWND, exact localized title, class, `chrome.exe`, and **owner HWND**, rather than requiring equality with the main browser PID. `DllCall("GetWindow", "ptr", dialogHwnd, "uint", 4, "ptr")` obtains `GW_OWNER`. For a title mismatch, a read-only title-codepoint probe can distinguish encoding artifacts from a different dialog. If the owner chain is unfamiliar, inspect it rather than weakening the guard.
5. Paste the exact directory into the **Folder** field, restoring the clipboard afterward. Do not submit yet. Capture and verify the entire path; Japanese fonts may render backslashes as yen signs.
6. Click **Select Folder** once. Capture the result: correct extension name/ID, enabled state, and no load error. A successful AHK exit alone proves none of these.

## Finish setup and verify

Keep setup output private: it can contain bearer URLs and extension tokens. Do not capture the setup guide indiscriminately. Report sanitized milestones instead.

Run `rech setup --profile "Profile 1" --listen local` for the established local-only task; preserve the requested listener scope for other tasks. If setup must open GUI pages, run it in the user's interactive session through a **user-level Interactive scheduled task**, not session 0. Use the actual Windows identity SID for the principal; `USERDOMAIN` was `WORKGROUP` and was not a valid account domain. Keep the process alive through token detection, Bridge verification, and registration. Back up configuration before changing its save destination; do not overwrite unrelated defaults or create remote sharing without authorization.

Rechrome 1.35.1 passed unsupported `--wait none` to its bundled CLI's setup probe. The corrected probe is `open about:blank` in an isolated session, followed by cleanup of that session. If an old build reports `Unknown option: --wait`, use the reviewed corrected package/source; reloading the extension does not fix this parser error. Never patch `node_modules` in place.

After setup verifies the Bridge and saves registration, run **one harmless open** using the installed client and selected profile, for example:

```powershell
rech --profile "Profile 1" -s=sym041-install-check open https://example.com
```

Use a fresh verification session name when appropriate. Confirm exit 0 and the expected page title. Report the host, exact profile selector, installed version, and whether sharing/defaults changed. A loopback listener on sym041 is usable by a CLI over SSH on sym041; it is not automatically accessible to a symubu client. Do not publish a credential-bearing link in the report. Retain only necessary installation/verification evidence and remove other temporary screenshots.

## Stop and recovery rules

Stop before acting on another profile, a login/security prompt, an unfamiliar dialog, or unexpected user activity. Preserve the screen, release only locks owned by the request, and report what happened. Do not dismiss prompts, restart Chrome, retry blindly, or change policy. A failed identity guard permits read-only diagnostics within the authorized task; correct the guard only after evidence establishes the dialog's relationship to the verified browser. Respect any stricter retry limit in the current request. If further scope or permission is needed, ask for it; do not default to asking taku to perform routine UI steps manually.

## Routes that did not solve persistent unpacked installation

- **CDP `Extensions.loadUnpacked`:** requires the appropriate remote-debugging/unsafe-extension flags. Current Chromium [marks the install as CDP-created](https://github.com/chromium/chromium/blob/main/chrome/browser/devtools/protocol/extensions_handler.cc), then [removes CDP-created extension preferences at startup](https://github.com/chromium/chromium/blob/main/extensions/browser/extension_prefs.cc) (`CleanUpCdpInstalledExtensions`). This is not the persistent install path for the user's existing browser. Do not restart it to test persistence.
- **`--load-extension`:** branded Chrome removed this switch beginning in Chrome 137; Chromium/Chrome for Testing behavior is different. See the [Chrome team's announcement](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY). Do not replace the user's browser/profile with a managed test browser to evade this constraint.
- **Registry/enterprise policy:** not a single-profile arbitrary unpacked-folder installation mechanism. [External installation](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions) uses update URLs; enterprise distribution requires a separate deployment design. Do not add machine-wide policy, host a CRX, or forge Secure Preferences for this task.

These constraints were researched during the sym041 repair on 2026-10-26. Recheck upstream sources if browser behavior changes; the successful route was the normal GUI Load unpacked flow, driven through winrpc.
