import { readListeners, listenerAddress, authorizeProfileRequest, canReadProfileFile, profileOutputPrefix, normalizePrefix, resolveAllowedProfile, type Listener } from "./listeners.ts";
import { file } from "bun";
import { createHash, X509Certificate } from "crypto";
import { mkdirSync, lstatSync, chmodSync, unlinkSync, accessSync, readdirSync, realpathSync, constants as fsConstants } from "fs";
import { join, resolve, relative, isAbsolute } from "path";
import { tmpdir } from "os";
import {
  log,
  parseUrl,
  getOrCreateUrl,
  authCheck,
  RECH_DIR,
  LEGACY_RECH_DIR,
  migrateLegacyDataDir,
  HOME,
  PASSTHROUGH_ENV_KEYS,
  resolvePlaywrightCli,
  readTokenRegistry,
  readChromeProfileCache,
  checkTailscaleServe,
} from "./rechrome.ts";
import { SecretMasker, parseFillSecretWire, fillSecretOnSession } from "./fill-secret.ts";

const TAILSCALE_BIN = process.env.TAILSCALE_BIN || "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const CERT_RENEW_THRESHOLD_DAYS = 7;

// Short label for a client identity, used as the Chrome tab-group name (the tab strip is
// space-constrained, so cap at 7 chars). Handles the current label shape and the legacy gitUrl:
//   "host/owner/repo#<basename>@<branch>" -> "bas:bra" (3+3)   (current)
//   "host/owner/repo/tree/branch"         -> "rep:bra" (3+3)   (legacy gitUrl)
//   "host:/path/to/dir"                   -> "dir"             (non-git)
//   bare host/IP                          -> as-is
export const MAX_GROUP_LABEL_LEN = 7;
export function shortClientLabel(raw: string): string {
  if (!raw) return raw;
  const join3 = (a: string, b?: string) => (b ? `${a.slice(0, 3)}:${b.slice(0, 3)}` : a);
  // Current label: "[remote#]<worktree-basename>[@<branch>]"
  if (raw.includes("#") || (raw.includes("@") && !raw.startsWith("http"))) {
    const afterHash = raw.includes("#") ? raw.slice(raw.indexOf("#") + 1) : raw;
    const [base, branch] = afterHash.split("@");
    return join3(base, branch).slice(0, MAX_GROUP_LABEL_LEN);
  }
  // Legacy gitUrl: ".../owner/repo/tree/branch"
  const git = raw.match(/^https?:\/\/[^/]+\/[^/]+\/([^/]+?)(?:\/tree\/(.+))?$/);
  if (git) return join3(git[1], git[2]).slice(0, MAX_GROUP_LABEL_LEN);
  // "host:/path/to/dir" -> basename
  const hostCwd = raw.match(/^[^:]+:(.+)$/);
  const label = hostCwd ? (hostCwd[1].split("/").filter(Boolean).pop() || raw) : raw;
  return label.slice(0, MAX_GROUP_LABEL_LEN);
}

// --isolate sessions (`rech --isolate ...` -> `-s=iso-<rand>`) are throwaway, single-flow
// buckets. We reap them on an idle TTL so an OAuth/login drive can't leak an orphaned browser
// context. A TTL (not close-on-exit-per-command) is required because the flows are multi-step
// (open -> click -> consent): closing after each command would break them. The reaper runs the
// CLI's `close` for the specific iso session only — it never touches the user's other sessions
// or quits Chrome.
const ISO_SESSION_TTL_MS = Number(process.env.RECH_ISOLATE_TTL_MS) || 15 * 60_000;
const ISO_REAP_INTERVAL_MS = 60_000;
const isoLastUsed = new Map<string, number>();

export function isIsoSession(namespacedSession: string): boolean {
  return /(?:^|-)iso-[0-9a-f]+$/.test(namespacedSession);
}

// --- Relay health / self-heal ---------------------------------------------------------
// The daemon spawns a short-lived CLI child per command, but all commands share a long-lived
// per-session cliDaemon and a single extension↔relay path. Under sustained multi-session load
// the relay can wedge: navigations (`open`) hang to the 60s cap while cheap calls still return,
// and — critically — the wedge PERSISTS (every later command reuses the same broken cliDaemon),
// so historically only a manual `oxmgr restart rechrome` cleared it. We heal automatically on
// two layers, driven by real command timeouts (no synthetic probe → Chrome is never touched):
//   - per-session: after SESSION_CLOSE_TIMEOUTS consecutive timeouts on ONE session, run the
//     CLI `close` for it so the next command respawns a clean cliDaemon.
//   - global: after WATCHDOG_TIMEOUTS consecutive timeouts across ALL sessions with no success
//     in between (= the shared relay is dead), exit(1); oxmgr's `--restart always` respawns us
//     clean and the extension WS reconnects. Each timeout burns 60s of wall time, so this can't
//     spin faster than ~once/minute even under concurrent load.
const SESSION_CLOSE_TIMEOUTS = Number(process.env.RECH_SESSION_CLOSE_TIMEOUTS) || 2;
const WATCHDOG_TIMEOUTS = Number(process.env.RECH_WATCHDOG_TIMEOUTS) || 3;
let consecutiveTimeouts = 0;                       // global; reset on any non-timeout /run
const sessionTimeouts = new Map<string, number>(); // per-session consecutive-timeout streak
// Most-recently-used non-iso sessions, so the deep health probe can target something real
// instead of spawning a fresh session (which could open a browser window).
const recentSessions = new Map<string, number>();
// Values typed by `fill-secret`, masked in every output, log line and served text file for a
// while afterwards: snapshots echo input values (passwords included). See fill-secret.ts.
const secretMasker = new SecretMasker();
const TEXT_OUTPUT = /\.(?:ya?ml|json|md|txt|log)$/i;
function noteSession(sess: string, now: number): void {
  recentSessions.set(sess, now);
  if (recentSessions.size > 64) {
    let oldestKey: string | undefined, oldestAt = Infinity;
    for (const [k, t] of recentSessions) if (t < oldestAt) { oldestAt = t; oldestKey = k; }
    if (oldestKey) recentSessions.delete(oldestKey);
  }
}

/**
 * Did this returned command actually prove the relay is answering?
 *
 * The watchdog above clears its streaks whenever a command returns instead of timing out,
 * on the reasoning that a reply — even a failing one — means the relay is alive. That holds
 * for errors produced BY the browser, but not for ones the CLI raises locally before it ever
 * opens a connection. `Browser '<id>' is not open` is the important case: it is emitted the
 * instant a session is missing, which is precisely the state the per-session heal CREATES by
 * closing a wedged session. So the sequence was:
 *
 *   timeout, timeout      → per-session heal closes the session
 *   "browser is not open" → returned fast, counted as success, globalStreak reset to 0
 *   timeout, timeout      → heal again … forever
 *
 * WATCHDOG_TIMEOUTS (3) could therefore never be reached on a genuinely dead relay, and the
 * daemon-level restart that exists to fix exactly that never fired — leaving `oxmgr restart
 * rechrome` by hand as the only cure (observed 2026-08-05: three manual restarts in one
 * session, each buying only a handful of commands).
 *
 * Returning false here does NOT count against the relay; it just refuses to forgive the
 * timeouts already recorded.
 */
export function provesRelayAlive(o: { stdout: string; stderr: string }): boolean {
  const out = `${o.stdout ?? ""}\n${o.stderr ?? ""}`;
  // Both spellings the CLI uses for "no such session" (cli-client/output.ts).
  if (/Browser '[^']*' is not open/i.test(out)) return false;
  if (/is not open, please run open first/i.test(out)) return false;
  return true;
}

export function inferSilentExtensionFailure(options: {
  status: number;
  stdout: string;
  stderr: string;
  isOpenCommand: boolean;
  hasExtensionCredentials: boolean;
  elapsedMs: number;
  handshakeTimeoutMs: number;
}): string {
  const { status, stdout, stderr, isOpenCommand, hasExtensionCredentials, elapsedMs, handshakeTimeoutMs } = options;
  if (stderr || status === 0 || stdout.trim() || !isOpenCommand || !hasExtensionCredentials)
    return stderr;
  if (elapsedMs < Math.max(1_000, handshakeTimeoutMs - 1_000))
    return stderr;
  return `Extension connection timeout after ${handshakeTimeoutMs}ms. Automatic recovery retry failed; reload the Playwright MCP Bridge extension at chrome://extensions and retry.\n`;
}

// Every CLI child must agree on its socket namespace, including probes and reapers.
export function playwrightCliEnv(
  overrides: Record<string, string | undefined> = {},
  runtime = { env: process.env, platform: process.platform, uid: process.getuid?.() },
): Record<string, string | undefined> {
  const source = runtime.env;
  const env: Record<string, string | undefined> = {
    PATH: source.PATH,
    HOME: source.HOME || HOME,
    USERPROFILE: source.USERPROFILE,
    TMPDIR: source.TMPDIR,
    DISPLAY: source.DISPLAY,
    XDG_RUNTIME_DIR: source.XDG_RUNTIME_DIR,
    DEBUG: source.DEBUG,
    PWDEBUG: source.PWDEBUG,
    ...overrides,
    PLAYWRIGHT_SOCKETS_DIR: source.PLAYWRIGHT_SOCKETS_DIR,
  };
  if (runtime.platform === "darwin") {
    if (runtime.uid === undefined) throw new Error("Cannot determine socket directory owner");
    const dir = source.PLAYWRIGHT_SOCKETS_DIR || `/tmp/pw-${runtime.uid}`;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== runtime.uid)
      throw new Error(`Refusing unsafe Playwright socket directory: ${dir}`);
    chmodSync(dir, 0o700);
    env.PLAYWRIGHT_SOCKETS_DIR = dir;
  }
  return env;
}

export function tmpSocketRoot(env = playwrightCliEnv()): string {
  // Match the shipped coreBundle makeSocketPath('cli', session). CLI children do
  // not inherit USER/USERNAME, so the vendor's fallback username is "default".
  const userHash = createHash("sha1").update(env.USERNAME || env.USER || "default").digest("hex").slice(0, 8);
  return join(env.PLAYWRIGHT_SOCKETS_DIR || join(env.TMPDIR || tmpdir(), `pw-${userHash}`), "cli");
}

// On startup, adopt any iso-* sessions a previous daemon left behind so they still get reaped
// (in-memory tracking alone would miss pre-restart orphans). Best-effort: a mis-derived session
// just yields a harmless no-op `close`. Socket files are named with the session as their prefix.
function adoptOrphanedIsoSessions(): void {
  try {
    const root = tmpSocketRoot();
    for (const f of readdirSync(root)) {
      const sess = f.endsWith(".sock") ? f.slice(0, -5) : "";
      if (isIsoSession(sess) && !isoLastUsed.has(sess)) {
        isoLastUsed.set(sess, Date.now());
        log(`adopted orphaned isolated session for reaping: ${sess}`);
      }
    }
  } catch {
    // socket dir may not exist yet — nothing to adopt
  }
}

function reapIdleIsoSessions(bin: string, binArgs: string[], workDir: string): void {
  const now = Date.now();
  for (const [sess, last] of isoLastUsed) {
    if (now - last < ISO_SESSION_TTL_MS) continue;
    isoLastUsed.delete(sess);
    try {
      Bun.spawn([bin, ...binArgs, "close", `-s=${sess}`], {
        cwd: workDir,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true, // hide the CLI child's console; the user's Chrome (a GUI grandchild) stays visible
        env: playwrightCliEnv(),
      });
      log(`reaped idle isolated session (idle ${Math.round((now - last) / 1000)}s): ${sess}`);
    } catch (e) {
      log(`reap failed for ${sess}: ${e}`);
    }
  }
}

async function renewCertIfNeeded(certPath: string, keyPath: string): Promise<boolean> {
  const certContent = await file(certPath).text().catch(() => null);
  if (!certContent) return false;
  try {
    const cert = new X509Certificate(certContent);
    const daysLeft = (new Date(cert.validTo).getTime() - Date.now()) / 86_400_000;
    if (daysLeft > CERT_RENEW_THRESHOLD_DAYS) return false;
    const domain = cert.subjectAltName?.match(/DNS:([^\s,]+)/)?.[1];
    if (!domain) { log("TLS cert renewal: could not determine domain"); return false; }
    log(`TLS cert expires in ${Math.floor(daysLeft)} days, renewing ${domain}...`);
    const proc = Bun.spawn([TAILSCALE_BIN, "cert", "--cert-file", certPath, "--key-file", keyPath, domain], {
      stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    const [status, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (status !== 0) { log(`TLS cert renewal failed: ${stderr.trim()}`); return false; }
    log(`TLS cert renewed for ${domain}`);
    return true;
  } catch (e) {
    log(`TLS cert check error: ${e}`);
    return false;
  }
}

export function isUnderDir(base: string, candidate: string): boolean {
  // Use path.relative rather than string-prefix: resolve() yields backslash paths on
  // Windows, so a "absBase + '/'" prefix check never matched there (every file was
  // rejected). A candidate is under base iff the relative path neither escapes (..) nor
  // is absolute (different drive).
  const rel = relative(resolve(base), resolve(base, candidate));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// Tokenize a command string into argv, honoring double-quoted segments so an interpreter
// path containing spaces (e.g. a quoted Windows "C:\Program Files\…\node.exe") survives.
// PLAYWRIGHT_CLI is space-joined by the installer; a plain split(" ") would shatter such paths.
export function splitCommand(cmd: string): string[] {
  return (cmd.match(/"[^"]*"|\S+/g) ?? []).map(t =>
    t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t);
}

async function resolveProfileDirectory(nameOrEmail: string): Promise<string> {
  if (/^(Default|Profile \d+)$/i.test(nameOrEmail)) return nameOrEmail;
  const home = HOME || "~";
  const candidates = [
    join(home, "Library/Application Support/Google/Chrome/Local State"),
    join(home, ".config/google-chrome/Local State"),
    join(home, "AppData/Local/Google/Chrome/User Data/Local State"),
  ];
  for (const statePath of candidates) {
    const f = file(statePath);
    if (!(await f.exists())) continue;
    const data = JSON.parse(await f.text());
    const cache: Record<string, any> = data?.profile?.info_cache ?? {};
    for (const [dir, info] of Object.entries(cache)) {
      if ([info.name, info.user_name, info.gaia_name].includes(nameOrEmail))
        return dir;
    }
  }
  return nameOrEmail;
}

// Free the listening port from stale daemon holders before retrying a failed bind.
// On Windows the listening socket (created inheritable by Bun.serve) is swept into the
// detached cliDaemon grandchild via bInheritHandles, so an orphaned cliDaemon from a
// previous `serve` keeps the port in LISTEN after the old serve dies — the fresh serve
// then crash-loops on EADDRINUSE. A clean restart releases the port, so a failed bind
// only happens when such a stale holder exists; killing orphaned daemon holders here is
// safe because a freshly-starting serve owns no live sessions of its own yet (the user's
// Chrome tabs persist regardless — the cliDaemon only drives them).
// Command lines freeStalePort may kill: a previous rech serve, or a cliDaemon started from
// THIS install's playwright (lib/ or vendor/ under this directory) — never another app's
// Playwright daemon, which runs from its own node_modules.
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const OWN_CLI_DAEMON = import.meta.dir.split(/[\\/]/).map(escapeRegex).join(String.raw`[\\/]`) + String.raw`[\\/].*cliDaemon\.js`;
const RECH_SERVE = String.raw`rech(rome)?(\.ts)?"?\s+serve`;
const STALE_HOLDER_PATTERN = `${OWN_CLI_DAEMON}|${RECH_SERVE}`;
// A leaked socket (or a wedged serve) accepts connections but never answers. Anything that
// responds at an address is a live server there — possibly a healthy rech serve — so it is
// never killed. Both schemes: the holder's TLS setting may differ from this serve's.
async function answersAt(address: string, port: number): Promise<boolean> {
  const host = address === "0.0.0.0" || address === "*" ? "127.0.0.1"
    : address === "::" ? "[::1]"
    : address.includes(":") ? `[${address}]` : address;
  const probe = (scheme: string) => fetch(`${scheme}://${host}:${port}/`, {
    signal: AbortSignal.timeout(1500), tls: { rejectUnauthorized: false },
  } as RequestInit).then(() => true, () => false);
  return (await Promise.all([probe("http"), probe("https")])).includes(true);
}

type PortHolder = { address: string; pid: number; alive: boolean; command: string };

// Listeners on `port` that conflict with binding `host`: the same address, or a wildcard of
// its family (a wildcard bind conflicts with every address of the family). Never this serve's
// own sockets, which may already hold other addresses on the same port from this startup.
function conflictingHolders(port: number, host: string): PortHolder[] {
  let holders: PortHolder[] = [];
  if (process.platform === "win32") {
    const ps = [
      "$ErrorActionPreference='SilentlyContinue';",
      `$r=@(Get-NetTCPConnection -LocalPort ${port} -State Listen | ForEach-Object {`,
      "  $p=Get-CimInstance Win32_Process -Filter \"ProcessId=$($_.OwningProcess)\";",
      "  [pscustomobject]@{ address=[string]$_.LocalAddress; pid=[int]$_.OwningProcess; alive=[bool]$p; command=[string]$p.CommandLine } });",
      "ConvertTo-Json -Compress -InputObject $r",
    ].join(" ");
    const out = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true }).stdout?.toString().trim();
    try { holders = out ? [JSON.parse(out)].flat() : []; } catch { holders = []; }
  } else {
    const out = Bun.spawnSync(["sh", "-c", `lsof -nP -iTCP:${port} -sTCP:LISTEN -Fpn 2>/dev/null`]).stdout?.toString() ?? "";
    let pid = 0;
    for (const line of out.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n") && pid) {
        const address = line.slice(1).replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
        const command = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]).stdout?.toString().trim() ?? "";
        holders.push({ address, pid, alive: true, command });
      }
    }
  }
  const v6 = (a: string) => a.includes(":");
  const wildcard = (a: string) => a === "0.0.0.0" || a === "::" || a === "*";
  // A `::` listener is dual-stack on Windows and most Linux setups: it conflicts with IPv4 binds too.
  return holders.filter(h => h.pid !== process.pid && (
    wildcard(host) ? (h.address === "*" || h.address === "::" || host === "::" || !v6(h.address))
      : h.address === host || h.address === "*" || h.address === "::" || (h.address === "0.0.0.0" && !v6(host))));
}

// Free the conflicting address from stale rech holders before retrying a failed bind.
// Narrow-first: (1) kill each conflicting owner that is a live rech serve / this install's
// cliDaemon AND doesn't answer at its own address — never an unrelated app, never a healthy
// server; (2) only if the address is STILL held by owners that are all dead — the
// inherited-handle case, where the socket lives in a child while netstat attributes it to a
// now-dead owner — sweep orphaned cliDaemons (Windows). That sweep is the only recovery for
// the case (the live holder can't be mapped from the port), so it is a logged last resort.
async function freeStalePort(port: number, host: string): Promise<void> {
  try {
    const stale = new RegExp(STALE_HOLDER_PATTERN, process.platform === "win32" ? "i" : "");
    for (const h of conflictingHolders(port, host)) {
      if (!h.alive) continue;
      if (!stale.test(h.command)) { log(`freeStalePort: port ${port} is held by an unrelated process (${h.pid}); not killing it`); continue; }
      if (await answersAt(h.address, port)) { log(`freeStalePort: ${h.address}:${port} is served by a live process (${h.pid}); not killing it`); continue; }
      log(`freeStalePort: killing stale rech holder ${h.pid} of ${h.address}:${port}`);
      try { process.kill(h.pid, "SIGKILL"); } catch {}
    }
    await new Promise(r => setTimeout(r, 400));
    const remaining = conflictingHolders(port, host);
    if (process.platform === "win32" && remaining.length && remaining.every(h => !h.alive)) {
      const q = (text: string) => text.replaceAll("'", "''");
      const ps = [
        "$ErrorActionPreference='SilentlyContinue';",
        // A cliDaemon's parent (playwright-cli) exits right after spawning it, so a live one
        // can't be told from an orphan by ancestry. They are only provably orphaned when no
        // other rech serve is running: exclude this serve and its own wrappers (oxmgr, cmd).
        `$self=@(); $x=${process.pid}; while($x){ $self+=$x; $x=(Get-CimInstance Win32_Process -Filter \"ProcessId=$x\").ParentProcessId; if($self -contains $x){ break } };`,
        `$live=@(Get-CimInstance Win32_Process | Where-Object { $self -notcontains $_.ProcessId -and $_.ProcessId -ne $PID -and $_.CommandLine -match '${q(RECH_SERVE)}' });`,
        "if($live.Count){ Write-Output (\"freeStalePort: port still held, but another rech serve is running (\" + ($live.ProcessId -join ',') + \"); not sweeping cliDaemons\") }",
        "else {",
        // Exclude this PowerShell itself: its own command line contains the pattern.
        `  $d=Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match '${q(OWN_CLI_DAEMON)}' };`,
        "  Write-Output (\"freeStalePort: port still held; killing orphaned cliDaemon holders: \" + ($d.ProcessId -join ','));",
        "  $d | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
        "}",
      ].join(" ");
      const out = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true }).stdout?.toString().trim();
      if (out) log(out);
    }
  } catch {
    // best effort — the retry will surface a clear error if the port is still held
  }
  await new Promise(r => setTimeout(r, 800)); // let the OS release the socket before retry
}

// --- Foreground/orphan self-exit ---------------------------------------------------
// A foreground `rech serve` (run directly by an agent, NOT under oxmgr/pm2) has no
// process-manager safety net: when the agent that spawned it exits, the OS re-parents
// the orphan to init (ppid 1) and it lives forever — the resource leak behind
// PERFORMANCE-EVENT.md. The managed daemon (oxmgr `--restart always`) keeps the
// process as its own child, so its ppid is stable and non-1 and it is never flagged.
// Once a serve is orphaned AND has had no real /run for the idle timeout, it exits so
// the leak self-heals. /ping is deliberately NOT activity (the tray polls it every 2s
// and would otherwise keep an orphan alive forever).
const ORPHAN_POLL_INTERVAL_MS = 15_000;
const ORPHAN_IDLE_EXIT_MS = Number(process.env.RECH_SERVE_IDLE_TIMEOUT_MS) || 5 * 60_000;

// Pure decision predicate (testable). idleTimeoutMs <= 0 disables orphan self-exit.
export function shouldExitOrphanedServe(opts: {
  orphaned: boolean;
  idleMs: number;
  idleTimeoutMs: number;
}): boolean {
  return opts.idleTimeoutMs > 0 && opts.orphaned && opts.idleMs >= opts.idleTimeoutMs;
}

export const LANDING_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/**
 * The page a shared connection URL shows in a browser: two install-and-connect lines to copy,
 * identical for every shell. It is static; the script reads the full URL (with its #key) from the address
 * bar, shows it with the key masked, and copies it whole.
 */
export function landingPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to a shared Chrome · rechrome</title>
<style>
:root { --bg:#fff; --fg:#1d1d1f; --muted:#6e6e73; --card:#f5f5f7; --line:#d2d2d7; --accent:#0a66c2; --warn:#b25000; }
@media (prefers-color-scheme: dark) { :root { --bg:#161617; --fg:#f5f5f7; --muted:#a1a1a6; --card:#232325; --line:#3a3a3c; --accent:#4c9bff; --warn:#ffb86b; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 40px 16px 56px; }
h1 { font-size: 1.6rem; margin: 0 0 8px; }
p { margin: 0 0 16px; color: var(--muted); }
.row { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin: 0 0 12px; }
.cmd { display: flex; gap: 10px; align-items: flex-start; }
code { flex: 1; font: 13px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; word-break: break-all; white-space: pre-wrap; }
button { flex: none; font: inherit; font-size: .9rem; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.warn { color: var(--warn); font-weight: 600; }
.small { font-size: .85rem; }
#plist { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; }
#plist button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); font-weight: 600; }
a { color: var(--accent); }
</style></head>
<body><main>
<h1>Connect to a shared Chrome</h1>
<p>Someone shared a Chrome profile with you through <a href="https://github.com/snomiao/rechrome">rechrome</a>.
On your computer, inside the project folder that should use it, run these two lines
(the same in macOS/Linux terminals, PowerShell and cmd):</p>
<p id="nokey" class="warn" hidden>This link is missing its key (the part after #key=). Ask for the full link from <code>rech share</code>.</p>
<div id="cmds"></div>
<div id="profiles" hidden><p>Profiles this link can use (pick one to make it the default in the command above):</p><div id="plist"></div></div>
<p class="small">Needs <a href="https://bun.sh">Bun</a>. Then try <code>rechrome open https://example.com</code>.
This link contains a secret key: anyone with it can use this browser profile, so share it privately.</p>
</main>
<script>
(() => {
  let url = location.href;
  const key = (location.hash.match(/[#&]key=([^&]*)/) || [])[1];
  if (!/[#&?]key=/.test(location.hash)) document.getElementById("nokey").hidden = false;
  // One command for every shell: two lines (no && vs ; split), one double-quoted URL. Characters a
  // shell expands inside double quotes ($ \` " \\ !) are percent-encoded, which the URL reads the same;
  // %40 goes back to a readable @ (valid in a query, and one less % for cmd to try to expand).
  const quote = s => '"' + s.replace(/%40/g, "@").replace(/[$\`"\\\\!]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase()) + '"';
  const build = u => "bun i -g rechrome\\nrechrome connect " + quote(u);
  const mask = s => s.replace(/(key=)[^&"\\n]+/, "$1…");
  const root = document.getElementById("cmds");
  const row = document.createElement("div"); row.className = "row";
  const line = document.createElement("div"); line.className = "cmd";
  const code = document.createElement("code");
  const entry = { text: "", update() { this.text = build(url); code.textContent = mask(this.text); } };
  entry.update();
  const button = document.createElement("button"); button.type = "button"; button.textContent = "Copy";
  button.setAttribute("aria-label", "Copy the commands");
  button.addEventListener("click", async () => {
    const text = entry.text;
    try { await navigator.clipboard.writeText(text); }
    catch {
      // Plain-HTTP pages (e.g. a LAN address) have no clipboard API: copy via a hidden textarea.
      const area = document.createElement("textarea"); area.value = text; document.body.append(area);
      area.select(); document.execCommand("copy"); area.remove();
    }
    button.textContent = "Copied"; setTimeout(() => { button.textContent = "Copy"; }, 1500);
  });
  line.append(code, button); row.append(line); root.append(row);
  // The key never leaves the browser except to this listener's own /ping, which lists what it
  // allows. Picking a profile only rewrites ?profile= in the command (the key works for all).
  if (!key || typeof fetch !== "function") return;
  const path = location.href.split("#")[0].split("?")[0], base = path.endsWith("/") ? path : path + "/";
  fetch(base + "ping", { headers: { Authorization: "Bearer " + decodeURIComponent(key) } })
    .then(r => r.ok ? r.json() : null)
    .then(body => {
      const profiles = body && Array.isArray(body.profiles) ? body.profiles : [];
      if (!profiles.length) return;
      const list = document.getElementById("plist"), buttons = [];
      const select = p => {
        const u = new URL(url); u.searchParams.set("profile", p); url = u.href;
        for (const b of buttons) b.setAttribute("aria-pressed", String(b.textContent === p));
        entry.update();
      };
      const current = new URL(url).searchParams.get("profile");
      for (const p of profiles) {
        const b = document.createElement("button"); b.type = "button"; b.textContent = p;
        b.setAttribute("aria-pressed", String(p === current));
        b.addEventListener("click", async () => select(p));
        buttons.push(b); list.append(b);
      }
      document.getElementById("profiles").hidden = false;
    })
    .catch(() => {});
})();
</script>
</body></html>
`;
}

export async function serve() {
  // The daemon owns logs/ and output/, so it migrates them before writing anything.
  const migrated = migrateLegacyDataDir();
  const url = await getOrCreateUrl();
  const { key, port } = parseUrl(url);

  const workDir = join(RECH_DIR, "output");
  mkdirSync(workDir, { recursive: true });
  if (migrated.length) log(`Moved ${migrated.length} legacy entries from ${LEGACY_RECH_DIR} to ${RECH_DIR}`);

  // Foreground/orphan self-exit: a serve whose parent has been re-parented to init
  // (ppid 1) is a leaked foreground serve. Poll for that, track the last real /run,
  // and exit once orphaned + idle so an agent that died without shutting us down
  // doesn't leave a daemon behind.
  let orphaned = false;
  let idleSince = Date.now();
  const markActivity = () => { idleSince = Date.now(); };
  setInterval(() => {
    if (process.ppid === 1) orphaned = true;
    if (shouldExitOrphanedServe({ orphaned, idleMs: Date.now() - idleSince, idleTimeoutMs: ORPHAN_IDLE_EXIT_MS })) {
      log(`orphaned foreground serve idle ${Math.round((Date.now() - idleSince) / 1000)}s — exiting (spawning agent is gone)`);
      process.exit(0);
    }
  }, ORPHAN_POLL_INTERVAL_MS);

  // Reap idle --isolate sessions so single-shot OAuth/login drives don't leak browser contexts.
  adoptOrphanedIsoSessions();
  setInterval(() => {
    const [bin, ...binArgs] = splitCommand(resolvePlaywrightCli());
    reapIdleIsoSessions(bin, binArgs, workDir);
  }, ISO_REAP_INTERVAL_MS);

  const listenHost = process.env.RECH_HOST || "127.0.0.1";
  const canRead = (p?: string) => { try { accessSync(p!, fsConstants.R_OK); return true; } catch { return false; } };
  const certPath = canRead(process.env.RECH_TLS_CERT) ? process.env.RECH_TLS_CERT : undefined;
  const keyPath = canRead(process.env.RECH_TLS_KEY) ? process.env.RECH_TLS_KEY : undefined;
  if (certPath && keyPath) {
    const renewed = await renewCertIfNeeded(certPath, keyPath);
    if (renewed) { log("Restarting to load renewed TLS cert..."); process.exit(0); }
    // Check daily; the process manager (oxmgr --restart always, or pm2) restarts cleanly after exit(0)
    setInterval(async () => {
      if (await renewCertIfNeeded(certPath, keyPath)) { log("Restarting to load renewed TLS cert..."); process.exit(0); }
    }, 86_400_000);
  }
  const tls = certPath && keyPath ? { cert: Bun.file(certPath), key: Bun.file(keyPath) } : undefined;
  const legacy: Listener = { name: "legacy", host: listenHost, port, key, profiles: "*" };
  const policies = new Map<string, Listener>();
  const servers = new Map<string, ReturnType<typeof Bun.serve>>();
  const startServer = (initial: Listener, reusePort = false) => Bun.serve({
    hostname: initial.host,
    port: initial.port,
    // reusePort is used only as a last-resort fallback (see bindAtStartup below): if an orphaned
    // holder can't be killed, binding with SO_REUSEADDR keeps serve up (degraded, port-shared)
    // instead of crash-looping on EADDRINUSE. The normal path binds a clean, exclusive socket.
    reusePort,
    tls,
    error(err) {
      log(`unhandled error: ${err.message}`);
      return Response.json({ status: 1, stdout: "", stderr: err.message }, { status: 500 });
    },
    async fetch(req, server) {
      const listener = policies.get(listenerAddress(initial));
      if (!listener) return new Response("Listener removed", { status: 403 });
      const key = listener.key;
      const listenHost = listener.host;
      const scoped = listener.profiles !== "*";
      const reqUrl = new URL(req.url);
      const prefix = normalizePrefix(listener.prefix);
      // Accept the path with or without the prefix, so a proxy works whether it keeps the
      // mount path (target .../rechrome) or strips it (bare port). The key, not the prefix,
      // guards every route.
      if (prefix !== "/") {
        if (reqUrl.pathname === prefix.slice(0, -1)) reqUrl.pathname = "/";
        else if (reqUrl.pathname.startsWith(prefix)) reqUrl.pathname = "/" + reqUrl.pathname.slice(prefix.length);
      }

      // Serve files from output dir
      if (reqUrl.pathname.startsWith("/files/")) {
        const denied = authCheck(req, key);
        if (denied) return denied;
        const name = decodeURIComponent(reqUrl.pathname.slice(7));
        if (!isUnderDir(workDir, name)) return new Response("Forbidden", { status: 403 });
        if (!canReadProfileFile(listener, name)) return new Response("Forbidden", { status: 403 });
        const resolved = resolve(workDir, name);
        const f = file(resolved);
        if (!(await f.exists())) return new Response("Not found", { status: 404 });
        const real = realpathSync(resolved);
        if (!isUnderDir(realpathSync(workDir), real) || !canReadProfileFile(listener, relative(realpathSync(workDir), real).replaceAll("\\", "/"))) return new Response("Forbidden", { status: 403 });
        if (secretMasker.active && TEXT_OUTPUT.test(real)) return new Response(secretMasker.mask(await f.text()));
        return new Response(f);
      }

      if (reqUrl.pathname === "/ping") {
        const denied = authCheck(req, key);
        if (denied) return denied;
        // Shallow ping proves only that the HTTP listener is up (it stayed up through past
        // relay wedges). `degraded` surfaces the passive timeout streak from real traffic so
        // clients / `rech status` can see trouble without an active probe.
        const degraded = consecutiveTimeouts > 0;
        if (scoped || !reqUrl.searchParams.get("deep"))
          return Response.json({ ok: true, bind: listenHost, listener: listener.name, profiles: listener.profiles, multiListener: true, consecutiveTimeouts, degraded });
        // Deep probe: exercise the relay read-only via `tab-list` (opens nothing) against the
        // most-recently-used session — never a fresh one, which could spawn a browser window.
        const target = [...recentSessions.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (!target)
          return Response.json({ ok: true, bind: listenHost, relay: "idle", consecutiveTimeouts, degraded });
        const [pbin, ...pbinArgs] = splitCommand(resolvePlaywrightCli());
        const probe = Bun.spawn([pbin, ...pbinArgs, "tab-list", `-s=${target}`], {
          cwd: workDir, stdin: "ignore", stdout: "ignore", stderr: "ignore",
          windowsHide: true,
          env: playwrightCliEnv(),
        });
        const probeStatus = await Promise.race([
          probe.exited,
          new Promise<number>((r) => setTimeout(() => { probe.kill(); r(-1); }, 5000)),
        ]);
        const healthy = probeStatus !== -1;
        return Response.json({
          ok: healthy, bind: listenHost, relay: healthy ? "healthy" : "degraded",
          consecutiveTimeouts, degraded: degraded || !healthy,
        });
      }
      // A browser opening a shared URL gets copyable connect instructions. The key stays in the
      // #fragment, which browsers never send, so the page is static and the key never reaches here.
      if (reqUrl.pathname === "/" && req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html"))
        return new Response(landingPage(), { headers: LANDING_HEADERS });
      if (reqUrl.pathname !== "/run") return new Response("rech server\n");
      const denied = authCheck(req, key);
      if (denied) return denied;
      markActivity(); // a real command: this serve is not idle

      const body = await req.json();
      let scopedProfile: string | undefined;
      let profileEnv: Record<string, string> = {};
      if (scoped) {
        try {
          const registry = await readTokenRegistry();
          // The client sends whatever the user typed (`rech --profile work`); resolve it here,
          // among this listener's profiles only, to one canonical key BEFORE authorization and
          // session hashing, so aliases of one profile share a session and a remote client needs
          // no registry of its own.
          if (body && !Array.isArray(body) && typeof body.identity === "object" && body.identity) {
            const chromeNames = Object.fromEntries(Object.entries(await readChromeProfileCache().catch(() => null) ?? {}).map(([dir, info]) => [dir, info.name ?? ""]).filter(([, name]) => name));
            const allowed = listener.profiles as string[];
            body.identity.profile = resolveAllowedProfile(body.identity.profile ?? body.env?.PLAYWRIGHT_MCP_PROFILE_DIRECTORY, allowed, registry, chromeNames);
            if (typeof body.env?.PLAYWRIGHT_MCP_PROFILE_DIRECTORY === "string")
              body.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY = resolveAllowedProfile(body.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY, allowed, registry, chromeNames);
          }
          scopedProfile = authorizeProfileRequest(listener, body);
          const entry = registry[scopedProfile];
          if (!entry?.token || !entry?.extensionId || !entry?.profileDir) throw new Error("Profile is not registered on this server");
          profileEnv = {
            PLAYWRIGHT_MCP_PROFILE_DIRECTORY: entry.profileDir,
            PLAYWRIGHT_MCP_EXTENSION_ID: entry.extensionId,
            PLAYWRIGHT_MCP_EXTENSION_TOKEN: entry.token,
            PLAYWRIGHT_MCP_USER_DATA_DIR: entry.userDataDir || "",
            PLAYWRIGHT_MCP_LOAD_EXTENSION: entry.loadExtension || "",
          };
          body.identity.key = `scoped:${body.identity.key}`;
          body.env = {}; // Server-owned profile configuration wins over every client override.
        } catch (error) { return Response.json({ status: 1, stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n` }, { status: 403 }); }
      }
      const outputPrefix = scopedProfile ? profileOutputPrefix(scopedProfile) : "";
      const runWorkDir = scopedProfile ? join(workDir, outputPrefix) : workDir;
      mkdirSync(runWorkDir, { recursive: true });
      let args: string[];
      let sessionId: string;
      let clientName = "";
      let clientEnv: Record<string, string> = {};
      if (Array.isArray(body)) {
        args = body;
        const clientAddr = `${req.headers.get("x-forwarded-for") || server.requestIP(req)?.address || "unknown"}`;
        sessionId = createHash("sha256").update(clientAddr).digest("hex").slice(0, 8);
        clientName = clientAddr;
        log(`session from client IP: ${clientAddr} -> ${sessionId}`);
      } else {
        args = body.args;
        const id = body.identity as
          | { key?: string; label?: string; gitUrl?: string; hostname?: string; cwd?: string; profile?: string }
          | undefined;
        // New clients send {key,label} (key = worktree-root-based, decoupled from the pretty
        // label). Fall back to the legacy {gitUrl|hostname:cwd} shape for older clients.
        const legacy = id?.gitUrl || (id?.hostname && id?.cwd ? `${id.hostname}:${id.cwd}` : null);
        const keyBase = id?.key || legacy;
        const labelBase = id?.label || legacy || keyBase;
        if (keyBase) {
          // Hash the key (+ profile via a NUL separator that never appears in a label).
          const hashInput = id?.profile ? `${keyBase}\u0000${id.profile}` : keyBase;
          sessionId = createHash("sha256").update(hashInput).digest("hex").slice(0, 8);
          clientName = labelBase || keyBase;
          log(`session from identity: ${clientName}${id?.profile ? ` profile:${id.profile}` : ""} [${keyBase}] -> ${sessionId}`);
        } else {
          const clientAddr = `${req.headers.get("x-forwarded-for") || server.requestIP(req)?.address || "unknown"}`;
          sessionId = createHash("sha256").update(clientAddr).digest("hex").slice(0, 8);
          clientName = clientAddr;
          log(`session from client IP fallback: ${clientAddr} -> ${sessionId}`);
        }
        // Extract allowlisted env vars from client (client overrides server)
        if (body.env && typeof body.env === "object") {
          for (const key of PASSTHROUGH_ENV_KEYS) {
            if (typeof body.env[key] === "string") clientEnv[key] = body.env[key];
          }
        }
      }

      let clientSession = "";
      const filteredArgs = args.filter((a) => {
        const m = a.match(/^-s=(.+)$/);
        if (m) {
          clientSession = m[1];
          return false;
        }
        return true;
      });
      const namespacedSession = clientSession ? `${sessionId}-${clientSession}` : sessionId;
      // Track --isolate sessions so the idle-TTL reaper can close them later.
      const nowMs = Date.now();
      if (isIsoSession(namespacedSession)) isoLastUsed.set(namespacedSession, nowMs);
      else noteSession(namespacedSession, nowMs); // for the deep health probe to target

      // daemonInstall bakes PLAYWRIGHT_CLI into the daemon env; resolvePlaywrightCli() is the
      // fallback for a standalone `serve` (it re-runs the same env > fork > @playwright/cli > legacy chain).
      const [bin, ...binArgs] = splitCommand(resolvePlaywrightCli());

      if (filteredArgs.length === 0) {
        filteredArgs.push("--help");
      }

      log(`run: rech ${filteredArgs.join(" ")} (session=${namespacedSession})`);

      // fill-secret: the value arrives in body.secret, never in args; it is handed to the live
      // session over its socket (no child argv) and never logged. See fill-secret.ts.
      if (filteredArgs[0] === "fill-secret") {
        const secret = !Array.isArray(body) && typeof body.secret === "string" ? body.secret : "";
        try {
          const { ref, allowDomains, submit, totp } = parseFillSecretWire(filteredArgs);
          if (!secret) throw new Error("fill-secret: the request carried no secret (this client is older than the daemon?)");
          secretMasker.add(secret, totp ? undefined : Infinity);
          const reply = await fillSecretOnSession({ socketRoot: tmpSocketRoot(), session: namespacedSession, cwd: runWorkDir, ref, value: secret, allowDomains, submit });
          // Drop the echoed run-code body (it embeds the value, masked or not, and is noise).
          const text = secretMasker.mask(reply.text).replace(/### Ran Playwright code\n```js\n[\s\S]*?\n```\n?/, "").trim();
          const status = reply.isError ? 1 : 0;
          log(`exit: ${status} | fill-secret ${ref}`);
          return Response.json(reply.isError ? { status, stdout: "", stderr: `${text}\n`, files: [] } : { status, stdout: `${text}\n`, stderr: "", files: [] });
        } catch (error) {
          const message = secretMasker.mask(secret ? (error instanceof Error ? error.message : String(error)).replaceAll(secret, "***") : (error instanceof Error ? error.message : String(error)));
          log(`exit: 1 | fill-secret: ${message.split("\n")[0]}`);
          return Response.json({ status: 1, stdout: "", stderr: `[rech] ${message}\n`, files: [] });
        }
      }

      // For open commands, default to about:blank to avoid leaving connect.html visible
      const isOpenCmd = filteredArgs[0] === "open";
      const isOpenNoUrl = isOpenCmd && filteredArgs.length === 1;
      if (isOpenNoUrl) filteredArgs.push("about:blank");

      // Merge passthrough env: server .env.local defaults, then client overrides
      const passthroughEnv: Record<string, string | undefined> = {};
      for (const key of PASSTHROUGH_ENV_KEYS) {
        if (process.env[key]) passthroughEnv[key] = process.env[key];
      }
      Object.assign(passthroughEnv, clientEnv, profileEnv);

      // Resolve profile name/email → directory name
      if (!scoped && passthroughEnv.PLAYWRIGHT_MCP_PROFILE_DIRECTORY) {
        const resolved = await resolveProfileDirectory(passthroughEnv.PLAYWRIGHT_MCP_PROFILE_DIRECTORY);
        if (resolved !== passthroughEnv.PLAYWRIGHT_MCP_PROFILE_DIRECTORY)
          log(`profile resolved: "${passthroughEnv.PLAYWRIGHT_MCP_PROFILE_DIRECTORY}" → "${resolved}"`);
        passthroughEnv.PLAYWRIGHT_MCP_PROFILE_DIRECTORY = resolved;
      }

      // Never fall back silently: without extension credentials (a registered profile) or a managed
      // user-data dir, `open` would launch a separate headless browser with a throwaway profile —
      // the command "succeeds" and nothing shows up in the user's Chrome.
      const extensionMode = !!(passthroughEnv.PLAYWRIGHT_MCP_EXTENSION_ID && passthroughEnv.PLAYWRIGHT_MCP_EXTENSION_TOKEN);
      // Checked before the existing-session shortcuts below: reusing a leftover headless session
      // (bare `open` answered with its tab list, or `open <url>` rewritten to goto) is the same
      // silent fallback.
      if (isOpenCmd && !extensionMode && !passthroughEnv.PLAYWRIGHT_MCP_USER_DATA_DIR) {
        const requested = passthroughEnv.PLAYWRIGHT_MCP_PROFILE_DIRECTORY;
        const registered = Object.keys(await readTokenRegistry().catch(() => ({})));
        const known = registered.length ? `Registered here: ${registered.join(", ")}` : "No profiles are registered here yet: rech setup";
        const stderr = requested
          ? `[rech] profile "${requested}" has no extension token on this machine, so rech would open a separate headless browser instead of your Chrome. Refusing.\n  Register it: rech setup --profile ${JSON.stringify(requested)}\n  ${known}\n`
          : `[rech] no Chrome profile selected, so rech would open a separate headless browser instead of your Chrome. Refusing.\n  Pick one: rech --profile <email> open <url>, or add ?profile=<email> to RECHROME_URL\n  ${known}\n`;
        log(`refused open without a profile (session=${namespacedSession}, requested=${requested ?? "-"})`);
        return Response.json({ status: 1, stdout: "", stderr, files: [] });
      }

      // open against an existing session: bare `open` returns a tab-list hint; `open <url>`
      // converts to `goto` to reuse the live browser. (Guarding on filteredArgs.length===1
      // was dead — about:blank/<url> is already appended above, so length is always >=2.)
      if (isOpenCmd) {
        try {
          const listProc = Bun.spawn([bin, ...binArgs, "tab-list", `-s=${namespacedSession}`], {
            cwd: runWorkDir,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true, // hide the CLI child's console; the user's Chrome (a GUI grandchild) stays visible
            env: playwrightCliEnv(),
          });
          const [listStatus, listOut] = await Promise.race([
            Promise.all([listProc.exited, new Response(listProc.stdout).text()]),
            new Promise<[number, string]>((resolve) =>
              setTimeout(() => { listProc.kill(); resolve([1, ""]); }, 5000)
            ),
          ]);
          if (listStatus === 0 && listOut.trim()) {
            if (isOpenNoUrl) {
              log(`session ${namespacedSession} already has tabs, returning tab-list hint`);
              return Response.json({
                status: 0,
                stdout: listOut,
                stderr: `[rech] session "${namespacedSession}" already has open tabs:\n`,
                files: [],
                existingSession: true,
              });
            }
            // URL specified: navigate to it instead of returning tab-list
            log(`session ${namespacedSession} already has tabs, converting open to goto`);
            filteredArgs[0] = "goto";
          }
        } catch (e) {
          log(`tab-list check failed: ${e}`);
        }
      }

      const childEnv: Record<string, string | undefined> = {
        ...(clientName ? { PLAYWRIGHT_MCP_CLIENT_NAME: shortClientLabel(clientName) } : {}),
        ...passthroughEnv,
        // Enable extension bridge when credentials are present
        ...(passthroughEnv.PLAYWRIGHT_MCP_EXTENSION_ID && passthroughEnv.PLAYWRIGHT_MCP_EXTENSION_TOKEN
          ? { PLAYWRIGHT_MCP_EXTENSION: "1" }
          : {}),
      };
      // Only a remaining open needs cleanup; a successful probe converted it to
      // goto and its live daemon socket must remain reachable.
      if (filteredArgs[0] === "open") {
        const socketRoot = tmpSocketRoot();
        try {
          for (const f of readdirSync(socketRoot)) {
            if (f === `${namespacedSession}.sock`) {
              const sockPath = join(socketRoot, f);
              try { unlinkSync(sockPath); log(`Removed stale socket: ${sockPath}`); } catch {}
            }
          }
        } catch {}
      }

      const commandStartedAt = Date.now();
      const proc = Bun.spawn([bin, ...binArgs, ...filteredArgs, `-s=${namespacedSession}`], {
        cwd: runWorkDir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true, // hide the CLI child's console; the user's Chrome (a GUI grandchild) stays visible
        env: playwrightCliEnv(childEnv),
      });

      const TIMEOUT = 60_000;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
          reject(new Error("timeout"));
        }, TIMEOUT);
      });
      let [status, stdout, rawStderr] = await Promise.race([
        Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]),
        timeout.then(() => [1, "", ""] as [number, string, string]),
      ]).catch(
        () => [1, "", `Command timed out after ${TIMEOUT / 1000}s\n`] as [number, string, string],
      ) as [number, string, string];
      clearTimeout(timer);

      const configuredHandshakeTimeout = Number(childEnv.PWMCP_TEST_CONNECTION_TIMEOUT);
      const handshakeTimeoutMs = Number.isFinite(configuredHandshakeTimeout) && configuredHandshakeTimeout > 0
        ? configuredHandshakeTimeout
        : 30_000;
      let stderr = inferSilentExtensionFailure({
        status,
        stdout,
        stderr: rawStderr,
        isOpenCommand: isOpenCmd,
        hasExtensionCredentials: !!(passthroughEnv.PLAYWRIGHT_MCP_EXTENSION_ID && passthroughEnv.PLAYWRIGHT_MCP_EXTENSION_TOKEN),
        elapsedMs: Date.now() - commandStartedAt,
        handshakeTimeoutMs,
      });

      if (secretMasker.active) { stdout = secretMasker.mask(stdout); stderr = secretMasker.mask(stderr); }
      log(`exit: ${status}${stdout.trim() ? ` | ${stdout.trim().slice(0, 200)}` : ""}`);

      // Relay self-heal (see notes at SESSION_CLOSE_TIMEOUTS). A command that RETURNS usually
      // proves the relay answered — but NOT when the CLI short-circuited locally without ever
      // reaching it (provesRelayAlive). Treating those as success reset the global streak on
      // every per-session heal, so WATCHDOG_TIMEOUTS could never be reached. See that helper.
      if (timedOut) {
        consecutiveTimeouts++;
        const streak = (sessionTimeouts.get(namespacedSession) ?? 0) + 1;
        sessionTimeouts.set(namespacedSession, streak);
        log(`timeout: session=${namespacedSession} sessionStreak=${streak} globalStreak=${consecutiveTimeouts}`);
        if (streak >= SESSION_CLOSE_TIMEOUTS) {
          log(`session ${namespacedSession} wedged (${streak} consecutive timeouts) — closing so the next command respawns a clean cliDaemon`);
          try {
            Bun.spawn([bin, ...binArgs, "close", `-s=${namespacedSession}`], {
              cwd: runWorkDir, stdin: "ignore", stdout: "ignore", stderr: "ignore",
              windowsHide: true,
              env: playwrightCliEnv(),
            });
          } catch {}
          sessionTimeouts.delete(namespacedSession);
        }
        if (consecutiveTimeouts >= WATCHDOG_TIMEOUTS) {
          log(`relay wedged: ${consecutiveTimeouts} consecutive timeouts, no success between — exiting for oxmgr (--restart always) to respawn clean; extension WS will reconnect (Chrome untouched)`);
          setTimeout(() => process.exit(1), 100); // brief delay to flush this response
        }
      } else if (provesRelayAlive({ stdout, stderr })) {
        consecutiveTimeouts = 0;
        sessionTimeouts.delete(namespacedSession);
      } else {
        // Returned, but proved nothing about the relay (local short-circuit). Leave BOTH
        // streaks untouched: not a timeout, so don't punish it — but don't let it forgive
        // the timeouts that came before, which is the bug this branch exists to fix.
        log(`inconclusive: session=${namespacedSession} did not reach the relay — streaks kept (globalStreak=${consecutiveTimeouts})`);
      }

      // Detect files mentioned in output
      const filePattern = /[\w./-]+\.(?:png|jpe?g|pdf|json|yml)\b/gi;
      const mentionedFiles = [
        ...new Set(
          [...stdout.matchAll(filePattern), ...stderr.matchAll(filePattern)].map((m) => m[0]),
        ),
      ];
      const outputFiles: string[] = [];
      for (const f of mentionedFiles) {
        if (!isUnderDir(runWorkDir, f)) continue;
        if (await file(join(runWorkDir, f)).exists()) {
          outputFiles.push(f);
        } else {
          const basename = f.split("/").pop()!;
          for (const subdir of [".playwright-cli", ".playwright-cli-multi-tab"]) {
            // Forward-slash for the wire: join() would use "\" on the Windows daemon, which
            // a POSIX client can't treat as a separator (it builds a literal-backslash path).
            const subpath = `${subdir}/${basename}`;
            if (await file(join(runWorkDir, subpath)).exists()) {
              outputFiles.push(subpath);
              break;
            }
          }
        }
      }

      // Snapshot files echo input values: scrub them on disk too, not only on download.
      if (secretMasker.active) for (const f of outputFiles) {
        if (!TEXT_OUTPUT.test(f)) continue;
        const path = join(runWorkDir, f);
        const text = await file(path).text().catch(() => null);
        if (text !== null && secretMasker.mask(text) !== text) await Bun.write(path, secretMasker.mask(text));
      }

      const rebrand = (s: string) => s.replaceAll("npx playwright-cli", "rech");
      return Response.json({
        status,
        stdout: rebrand(stdout),
        stderr: rebrand(stderr),
        // Normalize any platform separators to "/" so relative paths are portable across
        // a cross-OS daemon↔client (e.g. Windows daemon serving a Linux container client).
        files: outputFiles.map((p) => (outputPrefix + p).replaceAll("\\", "/")),
      });
    },
  });

  // A leaked listening-socket handle in an orphaned cliDaemon can keep a port in LISTEN after a
  // prior serve exits: Bun.serve creates the socket inheritable and Bun.spawn sweeps it into the
  // detached daemon grandchild via bInheritHandles, so the socket outlives its creating serve.
  // netstat then attributes the port to the now-dead *creator*, not the live holder, so we can't
  // map port -> killable PID — freeStalePort kills the orphan by its cliDaemon signature instead.
  // Startup only: a freshly-starting serve owns no live sessions, so clearing stale holders is
  // safe. Hot reloads never kill anything (see reconcile). As an absolute last resort, bind with
  // reusePort so a holder we genuinely can't kill degrades to "up but sharing the port" rather
  // than a permanent EADDRINUSE crash-loop.
  const isEaddrInUse = (e: any) => String(e?.code ?? e?.message ?? "").includes("EADDRINUSE");
  const MAX_BIND_ATTEMPTS = 4;
  const bindAtStartup = async (listener: Listener) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return startServer(listener);
      } catch (e: any) {
        if (!isEaddrInUse(e)) throw e;
        // Something answers at this exact address: a live server (never killed, never port-shared).
        if (await answersAt(listener.host, listener.port)) {
          log(`port ${listener.port} is held by a live server that answers requests — not touching it`);
          throw e;
        }
        if (attempt === MAX_BIND_ATTEMPTS) {
          log(`port ${listener.port} still held after ${attempt - 1} cleanup attempts — binding with reusePort (last resort)`);
          return startServer(listener, true);
        }
        log(`port ${listener.port} in use — clearing stale daemon holders and retrying (attempt ${attempt}/${MAX_BIND_ATTEMPTS - 1})`);
        await freeStalePort(listener.port, listener.host);
      }
    }
  };

  // Stage all new sockets before changing policy. Bind failure leaves existing
  // listeners and browser sessions intact; never kill a process holding another port
  // once serving (stale-holder recovery runs only at startup).
  const reconcile = async (listeners: Listener[], startup = false) => {
    const staged = new Map<string, ReturnType<typeof Bun.serve>>();
    try {
      for (const listener of listeners) {
        const address = listenerAddress(listener);
        if (!servers.has(address)) staged.set(address, startup ? await bindAtStartup(listener) : startServer(listener));
      }
    } catch (error) {
      for (const server of staged.values()) server.stop(true);
      throw error;
    }
    policies.clear();
    for (const listener of listeners) policies.set(listenerAddress(listener), listener);
    for (const [address, server] of staged) { servers.set(address, server); log(`listening on ${address}`); }
    for (const [address, server] of servers) {
      if (!policies.has(address)) { server.stop(false); servers.delete(address); log(`listener removed: ${address}`); }
    }
  };
  let applied = "";
  let configured = false;
  const reload = async (startup = false) => {
    const config = await readListeners();
    if (!config && configured) throw new Error("listeners.json disappeared; refusing to restore unrestricted legacy access");
    const listeners = config?.listeners ?? [legacy];
    const fingerprint = JSON.stringify(listeners);
    if (applied === fingerprint) return;
    await reconcile(listeners, startup);
    configured ||= !!config;
    applied = fingerprint;
  };
  await reload(true);
  let reloading = false;
  let lastError = "";
  setInterval(async () => {
    if (reloading) return;
    reloading = true;
    try { await reload(); lastError = ""; }
    catch (error) {
      const message = String(error);
      if (message !== lastError) log(`listener reload rejected; previous configuration retained: ${message}`);
      lastError = message;
    } finally { reloading = false; }
  }, 1000);
  log("Connection credentials remain in local configuration; listener changes reload automatically");
  // Keep Tailscale Serve routes on the listeners' current ports: right away, after every listener
  // change, and every few minutes (routes can be edited by hand). Each finding is logged once.
  let checkedFor = "", lastReport = "", lastCheck = 0, checking = false;
  setInterval(async () => {
    if (checking || (applied === checkedFor && Date.now() - lastCheck < 5 * 60_000)) return;
    checking = true;
    try {
      const listeners = JSON.parse(applied || "[]") as Listener[];
      const lines = await checkTailscaleServe(listeners);
      const report = lines.join("\n");
      if (report && report !== lastReport) for (const line of lines) log(line);
      lastReport = report; checkedFor = applied; lastCheck = Date.now();
    } catch (error) { log(`tailscale serve health check failed: ${error}`); }
    finally { checking = false; }
  }, 2000);
}
