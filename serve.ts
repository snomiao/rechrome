import { file } from "bun";
import { createHash, X509Certificate } from "crypto";
import { mkdirSync, unlinkSync, accessSync, readdirSync, constants as fsConstants } from "fs";
import { join, resolve, relative, isAbsolute } from "path";
import {
  log,
  parseUrl,
  getOrCreateUrl,
  authCheck,
  RECH_DIR,
  HOME,
  PASSTHROUGH_ENV_KEYS,
  resolvePlaywrightCli,
} from "./rechrome.ts";

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

function tmpSocketRoot(): string {
  return `${(process.env.TMPDIR || "/tmp").replace(/\/$/, "")}/playwright-cli`;
}

// On startup, adopt any iso-* sessions a previous daemon left behind so they still get reaped
// (in-memory tracking alone would miss pre-restart orphans). Best-effort: a mis-derived session
// just yields a harmless no-op `close`. Socket files are named with the session as their prefix.
function adoptOrphanedIsoSessions(): void {
  try {
    const root = tmpSocketRoot();
    for (const sub of readdirSync(root)) {
      let entries: string[];
      try { entries = readdirSync(`${root}/${sub}`); } catch { continue; }
      for (const f of entries) {
        const m = f.match(/^([0-9a-f]+-iso-[0-9a-f]+)/) || f.match(/^(iso-[0-9a-f]+)/);
        if (m && !isoLastUsed.has(m[1])) {
          isoLastUsed.set(m[1], Date.now());
          log(`adopted orphaned isolated session for reaping: ${m[1]}`);
        }
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
        env: { PATH: process.env.PATH, HOME: HOME, USERPROFILE: process.env.USERPROFILE },
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
async function freeStalePort(port: number): Promise<void> {
  try {
    if (process.platform === "win32") {
      // Two-phase, narrow-first: (1) kill the port's actual listed owner if it's a live
      // process; (2) only if the port is STILL held — the inherited-handle case, where the
      // socket lives in a child while netstat attributes it to a now-dead owner — fall back
      // to killing orphaned cliDaemon holders. The fallback is the only recovery for that
      // case (the live holder can't be mapped from the port), but it runs only when the
      // precise kill failed, so the broad sweep is a logged last resort, not the default.
      const ps = [
        "$ErrorActionPreference='SilentlyContinue';",
        `$o=(Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess;`,
        "if($o -and (Get-Process -Id $o)){ Stop-Process -Id $o -Force; Start-Sleep -Milliseconds 400 };",
        `if(Get-NetTCPConnection -LocalPort ${port} -State Listen){`,
        "  $h=Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*cliDaemon.js*' };",
        "  Write-Output (\"freeStalePort: port still held; killing cliDaemon holders: \" + ($h.ProcessId -join ','));",
        "  $h | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
        "}",
      ].join(" ");
      const r = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
      const out = r.stdout?.toString().trim();
      if (out) log(out);
    } else {
      Bun.spawnSync(["sh", "-c", `fuser -k ${port}/tcp 2>/dev/null || (lsof -ti tcp:${port} | xargs -r kill -9) 2>/dev/null || true`]);
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

export async function serve() {
  const url = await getOrCreateUrl();
  const { key, port } = parseUrl(url);

  const workDir = join(RECH_DIR, "output");
  mkdirSync(workDir, { recursive: true });

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
    // Check daily; pm2 restarts cleanly after exit(0)
    setInterval(async () => {
      if (await renewCertIfNeeded(certPath, keyPath)) { log("Restarting to load renewed TLS cert..."); process.exit(0); }
    }, 86_400_000);
  }
  const tls = certPath && keyPath ? { cert: Bun.file(certPath), key: Bun.file(keyPath) } : undefined;
  const startServer = (reusePort = false) => Bun.serve({
    hostname: listenHost,
    port,
    // reusePort is used only as a last-resort fallback (see the bind loop below): if an orphaned
    // holder can't be killed, binding with SO_REUSEADDR keeps serve up (degraded, port-shared)
    // instead of crash-looping on EADDRINUSE. The normal path binds a clean, exclusive socket.
    reusePort,
    tls,
    error(err) {
      log(`unhandled error: ${err.message}`);
      return Response.json({ status: 1, stdout: "", stderr: err.message }, { status: 500 });
    },
    async fetch(req) {
      const reqUrl = new URL(req.url);

      // Serve files from output dir
      if (reqUrl.pathname.startsWith("/files/")) {
        const denied = authCheck(req, key);
        if (denied) return denied;
        const name = decodeURIComponent(reqUrl.pathname.slice(7));
        if (!isUnderDir(workDir, name)) return new Response("Forbidden", { status: 403 });
        const resolved = resolve(workDir, name);
        const f = file(resolved);
        if (!(await f.exists())) return new Response("Not found", { status: 404 });
        return new Response(f);
      }

      if (reqUrl.pathname === "/ping") {
        const denied = authCheck(req, key);
        if (denied) return denied;
        // Shallow ping proves only that the HTTP listener is up (it stayed up through past
        // relay wedges). `degraded` surfaces the passive timeout streak from real traffic so
        // clients / `rech status` can see trouble without an active probe.
        const degraded = consecutiveTimeouts > 0;
        if (!reqUrl.searchParams.get("deep"))
          return Response.json({ ok: true, bind: listenHost, consecutiveTimeouts, degraded });
        // Deep probe: exercise the relay read-only via `tab-list` (opens nothing) against the
        // most-recently-used session — never a fresh one, which could spawn a browser window.
        const target = [...recentSessions.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (!target)
          return Response.json({ ok: true, bind: listenHost, relay: "idle", consecutiveTimeouts, degraded });
        const [pbin, ...pbinArgs] = splitCommand(resolvePlaywrightCli());
        const probe = Bun.spawn([pbin, ...pbinArgs, "tab-list", `-s=${target}`], {
          cwd: workDir, stdin: "ignore", stdout: "ignore", stderr: "ignore",
          windowsHide: true,
          env: { PATH: process.env.PATH, HOME: HOME, USERPROFILE: process.env.USERPROFILE },
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
      if (reqUrl.pathname !== "/run") return new Response("rech server\n");
      const denied = authCheck(req, key);
      if (denied) return denied;
      markActivity(); // a real command: this serve is not idle

      const body = await req.json();
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

      // For open commands, default to about:blank to avoid leaving connect.html visible
      const isOpenCmd = filteredArgs[0] === "open";
      const isOpenNoUrl = isOpenCmd && filteredArgs.length === 1;
      if (isOpenNoUrl) filteredArgs.push("about:blank");

      // open against an existing session: bare `open` returns a tab-list hint; `open <url>`
      // converts to `goto` to reuse the live browser. (Guarding on filteredArgs.length===1
      // was dead — about:blank/<url> is already appended above, so length is always >=2.)
      if (isOpenCmd) {
        try {
          const listProc = Bun.spawn([bin, ...binArgs, "tab-list", `-s=${namespacedSession}`], {
            cwd: workDir,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true, // hide the CLI child's console; the user's Chrome (a GUI grandchild) stays visible
            env: { PATH: process.env.PATH, HOME: HOME, USERPROFILE: process.env.USERPROFILE },
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

      // Merge passthrough env: server .env.local defaults, then client overrides
      const passthroughEnv: Record<string, string | undefined> = {};
      for (const key of PASSTHROUGH_ENV_KEYS) {
        if (process.env[key]) passthroughEnv[key] = process.env[key];
      }
      Object.assign(passthroughEnv, clientEnv);

      // Resolve profile name/email → directory name
      if (passthroughEnv.PLAYWRIGHT_MCP_PROFILE_DIRECTORY) {
        const resolved = await resolveProfileDirectory(passthroughEnv.PLAYWRIGHT_MCP_PROFILE_DIRECTORY);
        if (resolved !== passthroughEnv.PLAYWRIGHT_MCP_PROFILE_DIRECTORY)
          log(`profile resolved: "${passthroughEnv.PLAYWRIGHT_MCP_PROFILE_DIRECTORY}" → "${resolved}"`);
        passthroughEnv.PLAYWRIGHT_MCP_PROFILE_DIRECTORY = resolved;
      }

      const childEnv: Record<string, string | undefined> = {
        PATH: process.env.PATH,
        HOME: HOME,
        USERPROFILE: process.env.USERPROFILE,
        TMPDIR: process.env.TMPDIR,
        DISPLAY: process.env.DISPLAY,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        DEBUG: process.env.DEBUG, // forward debug namespaces (e.g. pw:mcp:relay) for diagnostics
        PWDEBUG: process.env.PWDEBUG,
        ...(clientName ? { PLAYWRIGHT_MCP_CLIENT_NAME: shortClientLabel(clientName) } : {}),
        ...passthroughEnv,
        // Enable extension bridge when credentials are present
        ...(passthroughEnv.PLAYWRIGHT_MCP_EXTENSION_ID && passthroughEnv.PLAYWRIGHT_MCP_EXTENSION_TOKEN
          ? { PLAYWRIGHT_MCP_EXTENSION: "1" }
          : {}),
      };
      // For open commands: clean up stale sockets so a closed browser can be reopened
      if (isOpenCmd) {
        const tmpDir = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
        const playwrightTmpDir = `${tmpDir}/playwright-cli`;
        try {
          const { readdirSync } = await import("fs");
          for (const sub of readdirSync(playwrightTmpDir)) {
            const subDir = `${playwrightTmpDir}/${sub}`;
            for (const f of readdirSync(subDir)) {
              if (f.startsWith(namespacedSession)) {
                const sockPath = `${subDir}/${f}`;
                try { unlinkSync(sockPath); log(`Removed stale socket: ${sockPath}`); } catch {}
              }
            }
          }
        } catch {}
      }

      const commandStartedAt = Date.now();
      const proc = Bun.spawn([bin, ...binArgs, ...filteredArgs, `-s=${namespacedSession}`], {
        cwd: workDir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true, // hide the CLI child's console; the user's Chrome (a GUI grandchild) stays visible
        env: childEnv,
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
      const [status, stdout, rawStderr] = await Promise.race([
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
      const stderr = inferSilentExtensionFailure({
        status,
        stdout,
        stderr: rawStderr,
        isOpenCommand: isOpenCmd,
        hasExtensionCredentials: !!(passthroughEnv.PLAYWRIGHT_MCP_EXTENSION_ID && passthroughEnv.PLAYWRIGHT_MCP_EXTENSION_TOKEN),
        elapsedMs: Date.now() - commandStartedAt,
        handshakeTimeoutMs,
      });

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
              cwd: workDir, stdin: "ignore", stdout: "ignore", stderr: "ignore",
              windowsHide: true,
              env: { PATH: process.env.PATH, HOME: HOME, USERPROFILE: process.env.USERPROFILE },
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
        if (!isUnderDir(workDir, f)) continue;
        if (await file(join(workDir, f)).exists()) {
          outputFiles.push(f);
        } else {
          const basename = f.split("/").pop()!;
          for (const subdir of [".playwright-cli", ".rech-multi-tab"]) {
            // Forward-slash for the wire: join() would use "\" on the Windows daemon, which
            // a POSIX client can't treat as a separator (it builds a literal-backslash path).
            const subpath = `${subdir}/${basename}`;
            if (await file(join(workDir, subpath)).exists()) {
              outputFiles.push(subpath);
              break;
            }
          }
        }
      }

      const rebrand = (s: string) => s.replaceAll("npx playwright-cli", "rech");
      return Response.json({
        status,
        stdout: rebrand(stdout),
        stderr: rebrand(stderr),
        // Normalize any platform separators to "/" so relative paths are portable across
        // a cross-OS daemon↔client (e.g. Windows daemon serving a Linux container client).
        files: outputFiles.map((p) => p.replaceAll("\\", "/")),
      });
    },
  });

  // A leaked listening-socket handle in an orphaned cliDaemon can keep the port in LISTEN after a
  // prior serve exits: Bun.serve creates the socket inheritable and Bun.spawn sweeps it into the
  // detached daemon grandchild via bInheritHandles, so the socket outlives its creating serve.
  // netstat then attributes the port to the now-dead *creator*, not the live holder, so we can't
  // map port -> killable PID — freeStalePort kills the orphan by its cliDaemon signature instead.
  // Retry a bounded number of times: the old single retry crash-looped whenever the OS hadn't yet
  // released the socket after the kill (pm2 then restarts serve into the same race). As an absolute
  // last resort, bind with reusePort so a holder we genuinely can't kill degrades to "up but sharing
  // the port" rather than a permanent EADDRINUSE crash-loop.
  const isEaddrInUse = (e: any) => String(e?.code ?? e?.message ?? "").includes("EADDRINUSE");
  const MAX_BIND_ATTEMPTS = 4;
  let server: ReturnType<typeof startServer> | undefined;
  for (let attempt = 1; attempt <= MAX_BIND_ATTEMPTS; attempt++) {
    try {
      server = startServer();
      break;
    } catch (e: any) {
      if (!isEaddrInUse(e)) throw e;
      if (attempt === MAX_BIND_ATTEMPTS) {
        log(`port ${port} still held after ${attempt - 1} cleanup attempts — binding with reusePort (last resort)`);
        server = startServer(true);
        break;
      }
      log(`port ${port} in use — clearing stale daemon holders and retrying (attempt ${attempt}/${MAX_BIND_ATTEMPTS - 1})`);
      await freeStalePort(port);
    }
  }
  if (!server) throw new Error(`failed to bind port ${port}`);

  log(`serving on ${tls ? "https" : "http"}://${server.hostname}:${server.port}`);
  log(`Connection URL set (use .env.local to view)`);
}
