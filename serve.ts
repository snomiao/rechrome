import { file } from "bun";
import { createHash, X509Certificate } from "crypto";
import { mkdirSync, unlinkSync, accessSync, constants as fsConstants } from "fs";
import { join, resolve, relative, isAbsolute } from "path";
import {
  log,
  parseUrl,
  getOrCreateUrl,
  authCheck,
  RECH_DIR,
  HOME,
  PASSTHROUGH_ENV_KEYS,
} from "./rech.ts";

const TAILSCALE_BIN = process.env.TAILSCALE_BIN || "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const CERT_RENEW_THRESHOLD_DAYS = 7;

// Short label for a client identity, used as the Chrome tab-group name (the tab
// strip is space-constrained, so cap at 7 chars). gitUrl ".../owner/repo/tree/branch"
// -> "rep:bra" (3+3); "host:/path/to/dir" -> "dir"; bare host/IP -> as-is. Strips a
// trailing "@profile" suffix first.
const MAX_GROUP_LABEL_LEN = 7;
function shortClientLabel(raw: string): string {
  if (!raw) return raw;
  const baseId = raw.includes("@") ? raw.slice(0, raw.indexOf("@")) : raw;
  const git = baseId.match(/^https?:\/\/[^/]+\/[^/]+\/([^/]+?)(?:\/tree\/(.+))?$/);
  let label: string;
  if (git)
    label = git[2] ? `${git[1].slice(0, 3)}:${git[2].slice(0, 3)}` : git[1];
  else {
    const hostCwd = baseId.match(/^[^:]+:(.+)$/);
    label = hostCwd ? (hostCwd[1].split("/").filter(Boolean).pop() || baseId) : baseId;
  }
  return label.slice(0, MAX_GROUP_LABEL_LEN);
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
      stdout: "pipe", stderr: "pipe",
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
  const absBase = resolve(base) + "/";
  const absCandidate = resolve(base, candidate);
  return absCandidate.startsWith(absBase);
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
      const r = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps]);
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

export async function serve() {
  const url = await getOrCreateUrl();
  const { key, port } = parseUrl(url);

  const workDir = join(RECH_DIR, "output");
  mkdirSync(workDir, { recursive: true });

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
  const startServer = () => Bun.serve({
    hostname: listenHost,
    port,
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
        return Response.json({ ok: true, bind: listenHost });
      }
      if (reqUrl.pathname !== "/run") return new Response("rech server\n");
      const denied = authCheck(req, key);
      if (denied) return denied;

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
          | { gitUrl?: string; hostname?: string; cwd?: string; profile?: string }
          | undefined;
        const baseId = id?.gitUrl || (id?.hostname && id?.cwd ? `${id.hostname}:${id.cwd}` : null);
        const raw = baseId && id?.profile ? `${baseId}@${id.profile}` : baseId;
        if (raw) {
          sessionId = createHash("sha256").update(raw).digest("hex").slice(0, 8);
          clientName = raw;
          log(`session from identity: ${raw} -> ${sessionId}`);
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

      const [bin, ...binArgs] = (process.env.PLAYWRIGHT_CLI || "playwright-cli-multi-tab").split(" ");

      if (filteredArgs.length === 0) {
        filteredArgs.push("--help");
      }

      log(`run: rech ${filteredArgs.join(" ")} (session=${namespacedSession})`);

      // For open commands, default to about:blank to avoid leaving connect.html visible
      const isOpenCmd = filteredArgs[0] === "open";
      const isOpenNoUrl = isOpenCmd && filteredArgs.length === 1;
      if (isOpenNoUrl) filteredArgs.push("about:blank");

      // bare `rech open` with no URL: warn if session already has tabs
      if (isOpenCmd && filteredArgs.length === 1) {
        try {
          const listProc = Bun.spawn([bin, ...binArgs, "tab-list", `-s=${namespacedSession}`], {
            cwd: workDir,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
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

      const proc = Bun.spawn([bin, ...binArgs, ...filteredArgs, `-s=${namespacedSession}`], {
        cwd: workDir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: childEnv,
      });

      const TIMEOUT = 60_000;
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => {
          proc.kill();
          reject(new Error("timeout"));
        }, TIMEOUT),
      );
      const [status, stdout, stderr] = await Promise.race([
        Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]),
        timeout.then(() => [1, "", ""] as [number, string, string]),
      ]).catch(
        () => [1, "", `Command timed out after ${TIMEOUT / 1000}s\n`] as [number, string, string],
      ) as [number, string, string];

      log(`exit: ${status}${stdout.trim() ? ` | ${stdout.trim().slice(0, 200)}` : ""}`);

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
            const subpath = join(subdir, basename);
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
        files: outputFiles,
      });
    },
  });

  // A leaked listening-socket handle in an orphaned cliDaemon can keep the port held after a
  // prior serve exits; on EADDRINUSE, clear stale holders once and retry rather than crash-loop.
  let server: ReturnType<typeof startServer>;
  try {
    server = startServer();
  } catch (e: any) {
    if (!String(e?.code ?? e?.message ?? "").includes("EADDRINUSE")) throw e;
    log(`port ${port} in use — clearing stale daemon holders and retrying`);
    await freeStalePort(port);
    server = startServer();
  }

  log(`serving on ${tls ? "https" : "http"}://${server.hostname}:${server.port}`);
  log(`Connection URL set (use .env.local to view)`);
}
