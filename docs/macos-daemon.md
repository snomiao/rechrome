# Keeping `rech serve` running on macOS

## Why a background daemon can fail on macOS

macOS privacy protection (TCC) guards `~/Library/Application Support/Google/Chrome`.
A process started from Terminal or an agent session inherits that app's privacy
grants. A process started by **launchd** (a LaunchAgent, or a process manager such
as oxmgr that runs outside a terminal) gets `EPERM` on that folder unless its own
binary has **Full Disk Access**.

`rech serve` reads that folder at two points:

- Resolving a profile email to its folder (`Profile 2`). The daemon now resolves
  registered profiles from `~/.rechrome/profiles.yaml` first, so this step no
  longer needs the Chrome folder.
- Before connecting, the Playwright relay checks that the extension is installed in
  the profile. Without access it reports `Playwright Extension not found`, even
  when the extension is installed.

When the daemon cannot read the folder, it says so in three places, naming the
binary that needs the grant:

- the serve log at startup: `cannot read …/Google/Chrome (EPERM …). macOS privacy settings (TCC) block <bun> …`
- `rech status`: `chrome:   ⚠ daemon cannot read …`
- the failing `rech open`: `[rech] the extension is probably installed; this daemon cannot read …`

## Option A (recommended): grant Full Disk Access, then run serve under launchd

1. Find the binary that runs serve. This is the bun executable, not the `rech`
   symlink. The serve log names it. You can also run `bun -e 'console.log(process.execPath)'`;
   it is usually `~/.bun/bin/bun`.
2. Open System Settings → Privacy & Security → Full Disk Access and click **+**.
   Press ⌘⇧G, paste the path, and click **Open**. Make sure the switch is on.
3. Restart the daemon (`oxmgr restart rechrome`), or install the LaunchAgent below.
4. Check `rech status`. The `chrome: ⚠` line should be gone, and `rech open` should
   connect.

Full Disk Access is how macOS lifts this restriction for a command-line binary.
The full launchd → Chrome connection with the grant in place has not been tested
end to end yet. If `rech open` still fails after step 4, use option B.

`~/Library/LaunchAgents/dev.rechrome.serve.plist`. Replace `/Users/YOU` and check
the `PATH` (serve needs `node` for the Playwright CLI):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.rechrome.serve</string>
  <key>ProgramArguments</key><array>
    <string>/Users/YOU/.bun/bin/bun</string>
    <string>/Users/YOU/.bun/bin/rech</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/Users/YOU/.local/bin:/Users/YOU/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>WorkingDirectory</key><string>/Users/YOU</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/Users/YOU/.rechrome/logs/launchd.err</string>
</dict></plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.rechrome.serve.plist
launchctl kickstart -k gui/$(id -u)/dev.rechrome.serve   # restart after an upgrade
```

Run only one serve per port. Stop the oxmgr entry or the keep-alive loop before
you switch to the LaunchAgent.

## Option B: keep serve under a terminal session

If you do not want to grant Full Disk Access, run serve from a process tree that
already has the grant, such as a Terminal tab, tmux, or an agent session. A
restart loop keeps it up across daemon self-restarts:

```sh
#!/bin/zsh
# ~/.rechrome/serve-keepalive.sh — run it from Terminal, not from launchd.
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME"
while true; do rech serve; sleep 3; done
```

The loop stops when that terminal session ends, for example at logout or when
the tmux server is killed.

## Idle self-exit

A serve started directly by an agent shuts itself down after 5 idle minutes once
its parent has died (its ppid becomes 1), so a leaked serve does not live forever.
These cases never self-exit:

- a LaunchAgent serve: it starts with ppid 1 and launchd's job label in
  `XPC_SERVICE_NAME`
- `RECH_SERVE_MANAGED=1`. `rech setup` sets this for the oxmgr or pm2 daemon. Set
  it yourself for any other supervisor.
- `RECH_SERVE_IDLE_TIMEOUT_MS=0`, which disables idle self-exit. Before this
  change, `0` was treated as unset and the 5-minute default still applied.

The keep-alive loop in option B keeps serve as its own child, so serve's ppid is
never 1.
