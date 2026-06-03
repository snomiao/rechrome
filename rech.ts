#!/usr/bin/env bun

import { file } from "bun";
import { randomBytes } from "crypto";
import { mkdirSync, appendFileSync, existsSync, realpathSync, accessSync, cpSync, constants as fsConstants } from "fs";
import { hostname } from "os";
import { join, basename, dirname } from "path";

export const ENV_KEY = "RECHROME_URL";
export const DEFAULT_PORT = 13775;
export const RECH_DIR = join(import.meta.dir, ".rech");
export const LOG_DIR = join(RECH_DIR, "logs");

const RECH_HOME_DIR = join(process.env.HOME!, ".rechrome");
const TOKENS_FILE = join(RECH_HOME_DIR, "profiles.json");

type TokenEntry = { extensionId: string; token: string; profileDir: string; userDataDir?: string };

async function readTokenRegistry(): Promise<Record<string, TokenEntry>> {
  const raw = await file(TOKENS_FILE).text().catch(() => "{}");
  try { return JSON.parse(raw); } catch { return {}; }
}

async function saveTokenEntry(profileEmail: string, entry: TokenEntry): Promise<void> {
  mkdirSync(RECH_HOME_DIR, { recursive: true });
  const registry = await readTokenRegistry();
  registry[profileEmail] = entry;
  await Bun.write(TOKENS_FILE, JSON.stringify(registry, null, 2) + "\n");
}

const envFile = join(import.meta.dir, ".env.local");
const globalEnvFile = join(process.env.HOME || "~", ".env.local");

// Walk CWD→root loading env files nearest-first; per-key: closest file wins, farther files skip.
// At each level .rechrome/.env.local is checked before .env.local (rechrome-specific overrides general).
export async function loadNearestEnv(extraFallbacks: string[] = []) {
  const seen = new Set<string>();
  const applyFile = async (path: string) => {
    const raw = await file(path).text().catch(() => "");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([^#=\s][^#=]*?)\s*=\s*(.*?)\s*$/);
      if (!m || m[1].startsWith("#")) continue;
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  };

  let dir = process.cwd();
  const dirs: string[] = [];
  while (true) {
    dirs.push(dir);
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  for (const d of dirs) {
    await applyFile(join(d, ".rechrome", ".env.local"));
    await applyFile(join(d, ".env.local"));
  }
  for (const f of extraFallbacks) await applyFile(f);
}

async function loadEnv() {
  await loadNearestEnv();
}
// Shell-set passthrough vars survive .env.local loading
const _shellPassthrough: Record<string, string> = {};
for (const k of ["PLAYWRIGHT_MCP_EXTENSION_ID","PLAYWRIGHT_MCP_EXTENSION_TOKEN","PLAYWRIGHT_MCP_PROFILE_DIRECTORY","PLAYWRIGHT_MCP_USER_DATA_DIR"] as const) {
  if (process.env[k]) _shellPassthrough[k] = process.env[k]!;
}
await loadEnv();
Object.assign(process.env, _shellPassthrough);

import { watch } from "node:fs";
const envWatcher = existsSync(envFile)
  ? watch(envFile, async () => { log(".env.local changed, reloading"); await loadEnv(); })
  : null;


export const PASSTHROUGH_ENV_KEYS = [
  "PLAYWRIGHT_MCP_EXTENSION_ID",
  "PLAYWRIGHT_MCP_EXTENSION_TOKEN",
  "PLAYWRIGHT_MCP_PROFILE_DIRECTORY",
  "PLAYWRIGHT_MCP_USER_DATA_DIR",
  "PWMCP_TEST_CONNECTION_TIMEOUT",
] as const;

function isReadable(p?: string): boolean {
  if (!p) return false;
  try { accessSync(p, fsConstants.R_OK); return true; } catch { return false; }
}

export function log(msg: string) {
  mkdirSync(LOG_DIR, { recursive: true });
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  console.error(line.trimEnd());
  const logFile = join(LOG_DIR, `${ts.slice(0, 10)}.log`);
  appendFileSync(logFile, line);
}

export function parseUrl(raw: string) {
  const u = new URL(raw);
  const scheme = u.protocol.replace(":", "");
  const protocol = scheme === "https" ? "https" : "http";
  const defaultPort = scheme === "https" ? 443 : scheme === "http" ? 80 : DEFAULT_PORT;
  return {
    key: u.username,
    host: u.hostname,
    port: parseInt(u.port) || defaultPort,
    protocol,
    extensionId: u.searchParams.get("extension_id") ?? undefined,
    extensionToken: u.searchParams.get("token") ?? undefined,
    profileDirectory: u.searchParams.get("profile") ?? undefined,
    userDataDir: u.searchParams.get("user_data_dir") ?? undefined,
  };
}

export async function getOrCreateUrl(): Promise<string> {
  // Treat a URL without a bearer key as missing — it cannot authenticate
  try { if (process.env[ENV_KEY] && new URL(process.env[ENV_KEY]!).username) return process.env[ENV_KEY]!; } catch {}
  const key = randomBytes(12).toString("base64url"); // 16 chars
  const url = `http://${key}@127.0.0.1:${DEFAULT_PORT}`;
  const newLine = `${ENV_KEY}=${url}`;
  // Write to ~/.env.local so it's not shadowed by project .env.local
  const envRaw = await file(globalEnvFile).text().catch(() => "");
  const lines = envRaw.trimEnd().split("\n").filter(l => !l.startsWith(`${ENV_KEY}=`));
  const content = [...lines, newLine, ""].join("\n");
  Bun.write(globalEnvFile, content);
  process.env[ENV_KEY] = url;
  return url;
}

export function authCheck(req: Request, key: string): Response | null {
  const bearer = req.headers.get("authorization")?.replace("Bearer ", "");
  if (bearer !== key) return new Response("Unauthorized", { status: 401 });
  return null;
}

async function getClientIdentity(): Promise<{ gitUrl?: string; hostname?: string; cwd?: string }> {
  const cwd = process.cwd();
  try {
    const remoteProc = Bun.spawn(["git", "remote", "get-url", "origin"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const remoteUrl = (await new Response(remoteProc.stdout).text()).trim();
    await remoteProc.exited;

    const branchProc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const branch = (await new Response(branchProc.stdout).text()).trim();
    await branchProc.exited;

    if (remoteUrl) {
      let gitUrl: string;
      const sshMatch = remoteUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
      const httpsMatch = remoteUrl.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
      if (sshMatch) {
        gitUrl = `https://${sshMatch[1]}/${sshMatch[2]}`;
      } else if (httpsMatch) {
        gitUrl = `https://${httpsMatch[1]}/${httpsMatch[2]}`;
      } else {
        gitUrl = remoteUrl.replace(/\.git$/, "");
      }
      if (branch) gitUrl += `/tree/${branch}`;
      // Strip any embedded credentials from the URL
      try {
        const u = new URL(gitUrl);
        u.username = "";
        u.password = "";
        gitUrl = u.toString();
      } catch {}
      return { gitUrl };
    }
  } catch {}
  return { hostname: hostname(), cwd };
}

async function getClientEnv(urlExtras?: { extensionId?: string; extensionToken?: string; profileDirectory?: string; userDataDir?: string }): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (urlExtras?.extensionId)
    env["PLAYWRIGHT_MCP_EXTENSION_ID"] = urlExtras.extensionId;
  if (urlExtras?.profileDirectory)
    env["PLAYWRIGHT_MCP_PROFILE_DIRECTORY"] = urlExtras.profileDirectory;
  if (urlExtras?.userDataDir)
    env["PLAYWRIGHT_MCP_USER_DATA_DIR"] = urlExtras.userDataDir;
  // Token: shell env wins (explicit override), registry is fallback, URL param is last resort
  const profileKey = urlExtras?.profileDirectory || process.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY;
  if (profileKey) {
    const registry = await readTokenRegistry();
    const entry = registry[profileKey];
    if (entry) {
      if (!env["PLAYWRIGHT_MCP_EXTENSION_ID"]) env["PLAYWRIGHT_MCP_EXTENSION_ID"] = entry.extensionId;
      if (!env["PLAYWRIGHT_MCP_USER_DATA_DIR"] && entry.userDataDir) env["PLAYWRIGHT_MCP_USER_DATA_DIR"] = entry.userDataDir;
      if (!env["PLAYWRIGHT_MCP_EXTENSION_TOKEN"]) {
        env["PLAYWRIGHT_MCP_EXTENSION_TOKEN"] = entry.token;
      } else if (env["PLAYWRIGHT_MCP_EXTENSION_TOKEN"] !== entry.token) {
        console.error(`[rech] warning: shell PLAYWRIGHT_MCP_EXTENSION_TOKEN differs from registry token for "${profileKey}" — using shell value. Run \`unset PLAYWRIGHT_MCP_EXTENSION_TOKEN\` to use the registry.`);
      }
    }
  }
  if (!env["PLAYWRIGHT_MCP_EXTENSION_TOKEN"] && urlExtras?.extensionToken)
    env["PLAYWRIGHT_MCP_EXTENSION_TOKEN"] = urlExtras.extensionToken;
  return env;
}

const CHROME_LOCAL_STATE_PATHS = () => {
  const home = process.env.HOME || "~";
  return [
    join(home, "Library/Application Support/Google/Chrome/Local State"),
    join(home, ".config/google-chrome/Local State"),
    join(home, "AppData/Local/Google/Chrome/User Data/Local State"),
  ];
};

async function readChromeProfileCache(): Promise<Record<string, { user_name?: string; name?: string }> | null> {
  for (const statePath of CHROME_LOCAL_STATE_PATHS()) {
    const f = file(statePath);
    if (!(await f.exists())) continue;
    try {
      const data = JSON.parse(await f.text());
      return data?.profile?.info_cache ?? null;
    } catch {}
  }
  return null;
}

async function findChromeUserDataDir(): Promise<string | null> {
  for (const statePath of CHROME_LOCAL_STATE_PATHS()) {
    if (!(await file(statePath).exists())) continue;
    return dirname(statePath);
  }
  return null;
}

// Bundled extension dist (shipped via package.json `files`). `import.meta.dir` resolves to the install
// location at runtime — under local dev that's the repo root, under bunx/npm it's the package dir.
const BUNDLED_EXTENSION_DIST_DIR = join(import.meta.dir, "extension");
// The legacy submodule path (pre-1.12). Kept for backwards-compat with users who installed from there.
const LEGACY_EXTENSION_DIST_DIR = join(import.meta.dir, "lib/playwright-multi-tab/lib/playwright-mcp/packages/extension/dist");

// Stable per-user location: we copy the bundled dist here so Chrome's recorded install path survives
// the ephemeral bunx temp dir being cleaned up between invocations.
export const EXTENSION_DIST_DIR = join(process.env.HOME!, ".rechrome", "extension");

// With the manifest `key` field set, Chrome derives this ID deterministically from the key (not the path),
// so we can locate the extension by ID even when the on-disk path differs from what Chrome stored.
export const EXTENSION_ID = "fokngfbogklgiffokdnekajodmhgfnhk";

async function ensureExtensionDistInstalled(): Promise<string> {
  const source = existsSync(BUNDLED_EXTENSION_DIST_DIR)
    ? BUNDLED_EXTENSION_DIST_DIR
    : existsSync(LEGACY_EXTENSION_DIST_DIR)
      ? LEGACY_EXTENSION_DIST_DIR
      : null;
  if (!source) return EXTENSION_DIST_DIR;
  const sourceManifest = await file(join(source, "manifest.json")).text().catch(() => "");
  const destManifest = await file(join(EXTENSION_DIST_DIR, "manifest.json")).text().catch(() => "");
  if (sourceManifest && sourceManifest === destManifest) return EXTENSION_DIST_DIR;
  mkdirSync(EXTENSION_DIST_DIR, { recursive: true });
  cpSync(source, EXTENSION_DIST_DIR, { recursive: true, force: true });
  return EXTENSION_DIST_DIR;
}

async function findInstalledExtension(
  profileDir?: string,
): Promise<{ id: string; profile: string } | null> {
  const userDataDir = await findChromeUserDataDir();
  if (!userDataDir) return null;
  const cache = await readChromeProfileCache();
  const profiles = profileDir ? [profileDir] : (cache ? Object.keys(cache) : []);
  // Resolve our known-good install paths up front for path-based fallback matching.
  const knownPaths = new Set<string>();
  for (const p of [EXTENSION_DIST_DIR, BUNDLED_EXTENSION_DIST_DIR, LEGACY_EXTENSION_DIST_DIR]) {
    try { knownPaths.add(realpathSync(p)); } catch {}
  }
  for (const prof of profiles) {
    const prefsPath = join(userDataDir, prof, "Secure Preferences");
    const f = file(prefsPath);
    if (!(await f.exists())) continue;
    try {
      const data = JSON.parse(await f.text());
      const settings = data?.extensions?.settings ?? {};
      for (const [extId, info] of Object.entries(settings as Record<string, any>)) {
        if (!info?.path || info.state === 0) continue; // state 0 = explicitly disabled
        // Primary: stable ID match (works when manifest `key` is set, regardless of path).
        if (extId === EXTENSION_ID) return { id: extId, profile: prof };
        // Fallback: path equality for legacy installs without a stable key.
        let storedPath = info.path as string;
        try { storedPath = realpathSync(storedPath); } catch {}
        if (knownPaths.has(storedPath)) return { id: extId, profile: prof };
      }
    } catch {}
  }
  return null;
}

function printInstallInstructions(profileDisplay: string): void {
  console.error("");
  console.error("Multi-tab extension is not installed in this Chrome profile.");
  console.error("");
  console.error("To install:");
  console.error("  1. Open chrome://extensions/ in the selected profile");
  console.error(`     (profile: ${profileDisplay})`);
  console.error("  2. Enable \"Developer mode\" (top-right toggle)");
  console.error("  3. Click \"Load unpacked\"");
  console.error("  4. Select this directory:");
  console.error(`       ${EXTENSION_DIST_DIR}`);
  console.error("  5. Re-run `rech setup`");
  console.error("");
}

async function resolveProfileEmail(dir: string): Promise<string> {
  const cache = await readChromeProfileCache();
  if (cache?.[dir]?.user_name) return cache[dir].user_name;
  return dir;
}

async function listProfiles(): Promise<void> {
  const cache = await readChromeProfileCache();
  if (!cache) { console.error("Chrome Local State not found"); process.exit(1); }

  const current = process.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY;
  // Resolve email/name → dir for current marker
  let currentDir = current;
  if (current && !/^(Default|Profile \d+)$/i.test(current)) {
    for (const [dir, info] of Object.entries(cache)) {
      if (info.user_name === current || info.name === current) { currentDir = dir; break; }
    }
  }

  const rows = Object.entries(cache).map(([dir, info]) => [
    dir,
    info.user_name || "",
    info.name || "",
    dir === currentDir ? "← current" : "",
  ]);
  const widths = rows.reduce((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, c.length)), [] as number[]);
  for (const row of rows) {
    console.log(row.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd());
  }
}

async function callServe(
  url: string,
  args: string[],
  overrideEnv?: Record<string, string>,
): Promise<{ status: number; stdout: string; stderr: string; files?: string[]; existingSession?: boolean }> {
  const { key, host, port, protocol, extensionId, extensionToken, profileDirectory, userDataDir } = parseUrl(url);
  const identity = await getClientIdentity();
  const effectiveProfile = profileDirectory || process.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY;
  if (effectiveProfile) (identity as any).profile = effectiveProfile;
  const env = { ...(await getClientEnv({ extensionId, extensionToken, profileDirectory, userDataDir })), ...overrideEnv };
  const res = await fetch(`${protocol}://${host}:${port}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ args, identity, env }),
    signal: AbortSignal.timeout(70_000),
  }).catch(async (e) => {
    console.error(`[rech] ${e.message}`);
    const dnsResult = await import("dns/promises").then(m => m.lookup(host)).catch(() => null);
    if (!dnsResult) {
      console.error(`[rech] rech-client\n  -x: DNS failed -> ${host}[unknown] -> rech-server[unknown]`);
    } else {
      const tcpOk = await new Promise<boolean>(resolve => {
        import("net").then(({ createConnection }) => {
          const s = createConnection({ host, port: Number(port), timeout: 3000 });
          s.on("connect", () => { s.destroy(); resolve(true); });
          s.on("error", () => resolve(false));
          s.on("timeout", () => { s.destroy(); resolve(false); });
        });
      });
      if (tcpOk) {
        console.error(`[rech] rech-client -> ${host}:${port}\n  -x: connection refused -> rech-server[unknown]`);
      } else {
        console.error(`[rech] rech-client -> ${host}(${dnsResult.address})\n  -x: port ${port} unreachable -> rech-server[unknown]`);
      }
    }
    process.exit(1);
  });
  if (res.status === 401) {
    console.error(`[rech] rech-client -> rech-server[ok]\n  -x: bearer key rejected (used: ${key.slice(0, 4)}...) -> playwright[unknown]`);
    process.exit(1);
  }
  return res.json();
}

async function run(url: string, args: string[]) {
  const { host, port, protocol, extensionId, extensionToken, profileDirectory, userDataDir } = parseUrl(url);
  const effectiveProfile = profileDirectory || process.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY;
  const displayProfile = effectiveProfile ? await resolveProfileEmail(effectiveProfile) : undefined;
  const identity = await getClientIdentity();
  const profileSuffix = displayProfile ? ` profile:${displayProfile}` : "";
  console.error(
    `[rech] connecting to ${host}:${port} (identity: ${identity.gitUrl || `${identity.hostname}:${identity.cwd}`}${profileSuffix})`,
  );

  const resolvedEnv = await getClientEnv({ extensionId, extensionToken, profileDirectory, userDataDir });
  const { status, stdout, stderr, files, existingSession } = await callServe(url, args);

  const isOpenWithUrl = args[0] === "open" && args.length > 1;
  if (existingSession && isOpenWithUrl) {
    return run(url, ["goto", ...args.slice(1)]);
  }

  if (existingSession)
    console.error(`[rech] session already has open tabs — listing existing tabs instead of opening a new window`);
  if (stderr) {
    if (stderr.includes('Extension connection timeout')) {
      const hasToken = !!resolvedEnv["PLAYWRIGHT_MCP_EXTENSION_TOKEN"];
      const last = hasToken
        ? `  -x: extension token rejected -> extension[unknown]`
        : `  -> extension[not installed]  (run: rech setup)`;
      console.error(`[rech] rech-client -> rech-server[ok] -> playwright[ok]\n${last}`);
    }
    process.stderr.write(stderr);
  }
  if (stdout) process.stdout.write(stdout);

  if (files?.length) {
    const dlDir = join(process.cwd(), ".playwright-cli-multi-tab");
    mkdirSync(dlDir, { recursive: true });
    const gitignorePath = join(dlDir, ".gitignore");
    if (!existsSync(gitignorePath)) await Bun.write(gitignorePath, "*\n");
    for (const name of files) {
      const fileRes = await fetch(`${protocol}://${host}:${port}/files/${name}`, {
        headers: { Authorization: `Bearer ${parseUrl(url).key}` },
      });
      if (!fileRes.ok) continue;
      const dest = join(dlDir, basename(name));
      await Bun.write(dest, await fileRes.arrayBuffer());
      console.error(`[rech] downloaded: ${dest}`);
    }
  }

  process.exit(status);
}

function buildSetupHtml(extDistDir: string, profileDisplay: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>rechrome — Extension Setup</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #222; }
  h1 { color: #1a73e8; }
  .step { background: #f8f9fa; border-left: 4px solid #1a73e8; padding: 12px 16px; margin: 16px 0; border-radius: 0 8px 8px 0; }
  .step h3 { margin: 0 0 8px; }
  code { background: #e8eaed; padding: 2px 6px; border-radius: 4px; font-size: 0.95em; word-break: break-all; }
  .path { display: flex; align-items: center; gap: 8px; }
  button { background: #1a73e8; color: white; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 0.9em; }
  button:active { background: #1558b0; }
  .note { color: #666; font-size: 0.9em; }
</style>
</head>
<body>
<h1>rechrome — Extension Setup</h1>
<p>Install the multi-tab extension in Chrome profile: <strong>${profileDisplay}</strong></p>

<div class="step">
  <h3>Step 1 — Open Chrome Extensions</h3>
  <p>In the Chrome profile <strong>${profileDisplay}</strong>, navigate to:</p>
  <code>chrome://extensions/</code>
  <p class="note">Make sure you are in the correct profile (check the avatar in the top-right corner).</p>
</div>

<div class="step">
  <h3>Step 2 — Enable Developer Mode</h3>
  <p>Toggle <strong>Developer mode</strong> on (top-right of the extensions page).</p>
</div>

<div class="step">
  <h3>Step 3 — Load the extension</h3>
  <p>Click <strong>Load unpacked</strong> and select this directory:</p>
  <div class="path">
    <code id="extPath">${extDistDir}</code>
    <button onclick="navigator.clipboard.writeText(document.getElementById('extPath').textContent).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy path',1500)})">Copy path</button>
  </div>
</div>

<div class="step">
  <h3>Step 4 — Return to terminal</h3>
  <p>Press <strong>Enter</strong> in the terminal to continue setup.</p>
</div>

<div class="step">
  <h3>Step 5 — Copy auth token</h3>
  <p>Click the extension icon in the Chrome toolbar (or open the URL below):</p>
  <code id="statusUrl">chrome-extension://(detected after install)/status.html</code>
  <p>The page shows <strong>PLAYWRIGHT_MCP_EXTENSION_TOKEN=...</strong> — paste that into the terminal when prompted.</p>
</div>
</body>
</html>`;
}

const OXMGR_PROCESS_NAME = "rechrome-serve";

async function runOxmgr(args: string[]): Promise<number> {
  const proc = Bun.spawn(["bunx", "oxmgr", ...args], { stdout: "inherit", stderr: "inherit" });
  await proc.exited;
  return proc.exitCode ?? 1;
}

async function daemonInstall(serveUrl: string): Promise<void> {
  // Persist the URL to ~/.env.local before starting the daemon. The daemon's
  // loadEnv() walks CWD→root reading .env.local files and unconditionally
  // overwrites process.env.RECHROME_URL from whichever file it finds first.
  // Without this write, oxmgr's --env RECHROME_URL=... gets clobbered by a
  // stale ~/.env.local entry — the daemon then listens on a different bearer
  // key than the one daemonInstall was called with, and every client request
  // is rejected with "bearer key rejected".
  const envRaw = await file(globalEnvFile).text().catch(() => "");
  const filtered = envRaw.trimEnd().split("\n").filter(l => !l.startsWith(`${ENV_KEY}=`));
  await Bun.write(globalEnvFile, [...filtered, `${ENV_KEY}=${serveUrl}`, ""].join("\n"));

  const home = process.env.HOME!;
  const bunBin = Bun.which("bun") ?? process.execPath;
  const rechScript = import.meta.filename;

  // Resolve PLAYWRIGHT_CLI: env override > bundled fork (development checkout) > "playwright-cli-multi-tab"
  const bundledForkCli = join(import.meta.dir, "lib/playwright-cli/playwright-cli.js");
  const resolvedPlaywrightCli = process.env.PLAYWRIGHT_CLI
    || (existsSync(bundledForkCli) ? bundledForkCli : "playwright-cli-multi-tab");

  const envArgs: string[] = [
    "--env", `HOME=${home}`,
    "--env", `PATH=${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
    "--env", `${ENV_KEY}=${serveUrl}`,
    "--env", `PWMCP_TEST_CONNECTION_TIMEOUT=${process.env.PWMCP_TEST_CONNECTION_TIMEOUT || "30000"}`,
    "--env", `PLAYWRIGHT_CLI=${resolvedPlaywrightCli}`,
  ];
  if (process.env.RECH_HOST) envArgs.push("--env", `RECH_HOST=${process.env.RECH_HOST}`);
  if (isReadable(process.env.RECH_TLS_CERT)) envArgs.push("--env", `RECH_TLS_CERT=${process.env.RECH_TLS_CERT}`);
  if (isReadable(process.env.RECH_TLS_KEY)) envArgs.push("--env", `RECH_TLS_KEY=${process.env.RECH_TLS_KEY}`);

  await runOxmgr(["delete", OXMGR_PROCESS_NAME]).catch(() => {});
  await runOxmgr([
    "start",
    "--name", OXMGR_PROCESS_NAME,
    "--restart", "always",
    "--cwd", home,
    ...envArgs,
    `${bunBin} ${rechScript} serve`,
  ]);
  await runOxmgr(["service", "install"]);
}

async function daemonUninstall(): Promise<void> {
  await runOxmgr(["delete", OXMGR_PROCESS_NAME]);
  await runOxmgr(["service", "uninstall"]);
  console.log(`Removed oxmgr process: ${OXMGR_PROCESS_NAME}`);
}

async function setup(opts: { profile?: string } = {}): Promise<void> {
  const { createInterface } = await import("readline");
  const isTTY = process.stdin.isTTY ?? false;
  let rl: ReturnType<typeof createInterface> | null = null;
  let stdinQueue: string[] | null = null;
  if (isTTY) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
  } else {
    // Pre-read all piped stdin lines so readline close doesn't block later prompts
    stdinQueue = await new Promise<string[]>(resolve => {
      const lines: string[] = [];
      const r = createInterface({ input: process.stdin });
      r.on("line", l => lines.push(l));
      r.on("close", () => resolve(lines));
    });
  }
  const ask = (q: string, def = "") => {
    process.stdout.write(q);
    if (stdinQueue !== null) { const ans = stdinQueue.shift() ?? def; process.stdout.write(ans + "\n"); return Promise.resolve(ans); }
    return new Promise<string>(r => rl!.question("", ans => r(ans || def)));
  };

  // [1/4] Daemon
  console.log("\n[1/4] Setting up serve daemon...");

  // Bind address (persists to ~/.env.local as RECH_HOST).
  // Read the persisted value from ~/.env.local directly — process.env may be shadowed by nearer .env files.
  const globalEnvRaw = await file(globalEnvFile).text().catch(() => "");
  const persistedBindMatch = globalEnvRaw.match(/^\s*RECH_HOST\s*=\s*(.*?)\s*$/m);
  const persistedBind = persistedBindMatch?.[1].replace(/^["']|["']$/g, "") || "127.0.0.1";

  // Clear stale hostname-based URL so we always use 127.0.0.1 locally
  if (process.env[ENV_KEY]) {
    try {
      const u = new URL(process.env[ENV_KEY]);
      if (!["127.0.0.1", "localhost"].includes(u.hostname)) delete process.env[ENV_KEY];
    } catch {}
  }
  const url = await getOrCreateUrl();
  const { host, port, protocol } = parseUrl(url);

  const { key: serveKey } = parseUrl(url);
  // First check if server is up at all (unauthenticated root), then verify our key matches
  const anonPing = await fetch(`${protocol}://${host}:${port}/`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
  const authPing = anonPing ? await fetch(`${protocol}://${host}:${port}/ping`, {
    headers: { Authorization: `Bearer ${serveKey}` },
    signal: AbortSignal.timeout(2000),
  }).catch(() => null) : null;
  // The daemon's *live* bind (from /ping) is authoritative — persisted RECH_HOST may diverge if the user edited it manually.
  const liveBind = authPing?.ok
    ? await authPing.clone().json().then((b: { bind?: string }) => b?.bind).catch(() => undefined)
    : undefined;
  // Pre-patch daemons return plain "ok" with no bind info — we can't trust persisted/env values to match their live bind, so force reinstall to be safe.
  const liveBindUnknown = !!authPing?.ok && !liveBind;
  const currentBind = liveBind || persistedBind;

  // Non-TTY honors explicit process.env.RECH_HOST (shell or merged env stack) — matches the documented `RECH_HOST=0.0.0.0 rech setup` flow.
  let desiredBind = process.env.RECH_HOST || currentBind;
  if (isTTY) {
    console.log(`\n      Bind address (current: ${currentBind}):`);
    console.log(`        1.  127.0.0.1  (localhost only)`);
    console.log(`        2.  0.0.0.0    (all interfaces — HTTP plaintext, trust your network)`);
    const defaultBindChoice = currentBind === "0.0.0.0" ? "2" : "1";
    const bindAns = (await ask(`      Choice [${defaultBindChoice}]: `, defaultBindChoice)).trim();
    desiredBind = bindAns === "2" || bindAns === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
  }
  const bindChanged = desiredBind !== currentBind;
  const persistedChanged = desiredBind !== persistedBind;
  if (persistedChanged) {
    const lines = globalEnvRaw.trimEnd().split("\n").filter(l => !/^\s*RECH_HOST\s*=/.test(l));
    await Bun.write(globalEnvFile, [...lines, `RECH_HOST=${desiredBind}`, ""].join("\n"));
    console.log(`      Saved RECH_HOST=${desiredBind} to ~/.env.local`);
  }
  // Always align process.env with the desired bind — a nearer .env.local may have shadowed it.
  process.env.RECH_HOST = desiredBind;

  const waitForServe = async () => {
    process.stdout.write("      Starting");
    let ping = null;
    for (let i = 0; i < 15; i++) {
      await Bun.sleep(1000);
      ping = await fetch(`${protocol}://${host}:${port}/`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
      if (ping) break;
      process.stdout.write(".");
    }
    process.stdout.write("\n");
    if (!ping) {
      console.error(`      Failed to start serve at ${host}:${port}`);
      rl?.close();
      process.exit(1);
    }
    console.log(`      Serve running at ${protocol}://${host}:${port}`);
  };

  if (anonPing && authPing?.ok && !bindChanged && !liveBindUnknown) {
    console.log(`      Already running at ${protocol}://${host}:${port} — skipping reinstall`);
  } else if (anonPing && authPing?.ok && liveBindUnknown) {
    console.log(`      Pre-patch daemon detected (no live bind info) — reinstalling to verify bind`);
    await daemonInstall(url);
    await waitForServe();
  } else if (anonPing && bindChanged) {
    console.log(`      Bind changed (${currentBind} → ${desiredBind}) — reinstalling`);
    await daemonInstall(url);
    await waitForServe();
  } else if (anonPing && !authPing?.ok) {
    console.log(`      Server running but key mismatch — reinstalling with new key`);
    await daemonInstall(url);
    await waitForServe();
  } else {
    await daemonInstall(url);
    console.log(`      Registered daemon: ${OXMGR_PROCESS_NAME}`);
    await waitForServe();
  }

  const cache = await readChromeProfileCache();
  if (!cache) { console.error("      Chrome profiles not found"); rl?.close(); process.exit(1); }
  const userDataDir = await findChromeUserDataDir();

  async function pickProfile(exclude: Set<string>): Promise<[string, { user_name?: string; name?: string }] | null> {
    const available = Object.entries(cache!).filter(([dir]) => !exclude.has(dir));
    if (!available.length) return null;
    available.forEach(([dir, info], i) =>
      console.log(`        ${String(i + 1).padStart(2)}.  ${(info.user_name || "(no email)").padEnd(32)}  ${(info.name || "").padEnd(20)}  [${dir}]`)
    );
    if (opts.profile !== undefined) {
      const num = parseInt(opts.profile);
      if (!isNaN(num) && String(num) === opts.profile.trim()) return available[num - 1] ?? null;
      const needle = opts.profile.toLowerCase();
      return available.find(([dir, info]) =>
        dir.toLowerCase() === needle
        || (info.name ?? "").toLowerCase() === needle
        || (info.user_name ?? "").toLowerCase().includes(needle)
      ) ?? null;
    }
    if (available.length === 1) {
      console.log(`      Only one profile available — selecting: ${available[0][1].user_name || available[0][0]}`);
      return available[0];
    }
    if (!isTTY) console.log("      [agent] Provide profile number on next stdin line, or rerun with --profile <num|email>");
    const answer = await ask("\n      Profile number: ");
    const idx = parseInt(answer.trim()) - 1;
    if (isNaN(idx) || idx < 0 || idx >= available.length) return null;
    return available[idx];
  }

  async function getExtAndToken(profileDir: string, profileDisplay: string, profileKey: string): Promise<{ extId: string; token: string } | null> {
    // Extension check
    let extId: string | undefined;
    // Copy bundled dist to a stable per-user location so the install path survives bunx temp-dir cleanup.
    await ensureExtensionDistInstalled();
    while (true) {
      const found = await findInstalledExtension(profileDir);
      if (found) { extId = found.id; break; }
      console.log(`\n      Extension not found in profile: ${profileDisplay}`);
      console.log(`      Extension dist: ${EXTENSION_DIST_DIR}`);
      // Non-TTY (agent/pipe) can't install an extension interactively, and `ask` doesn't block on an exhausted stdin queue —
      // looping here would spawn `open` per iteration until the OS runs out of resources. Fail fast instead.
      if (!isTTY) {
        console.error(`      Non-TTY: cannot install extension interactively — aborting`);
        return null;
      }
      const setupHtmlPath = join(RECH_HOME_DIR, "setup.html");
      mkdirSync(RECH_HOME_DIR, { recursive: true });
      await Bun.write(setupHtmlPath, buildSetupHtml(EXTENSION_DIST_DIR, profileDisplay));
      console.log(`\n      Opening install guide in your browser...`);
      Bun.spawn(["open", setupHtmlPath], { stdout: "ignore", stderr: "ignore" });
      await ask("\n      Press Enter after loading the extension to retry...");
    }
    console.log(`      Extension found: ${extId}`);

    // Check for existing token in registry
    const registry = await readTokenRegistry();
    const existing = registry[profileKey];
    if (existing && existing.extensionId === extId && existing.token) {
      console.log(`      Existing token found: ${existing.token.slice(0, 6)}…`);
      if (!isTTY) console.log(`      [agent] Provide y to keep existing token, n to refresh on next stdin line`);
      const keep = (await ask("      Keep existing token? [Y/n]: ")).trim().toLowerCase();
      if (keep !== "n") {
        console.log("      Keeping existing token");
        return { extId, token: existing.token };
      }
    }

    // Token
    const statusUrl = `chrome-extension://${extId}/status.html`;
    console.log(`\n      Get auth token from the extension:`);
    console.log(`        ${statusUrl}`);
    if (isTTY) {
      Bun.spawn(
        ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
         `--profile-directory=${profileDir}`, statusUrl],
        { stdout: "ignore", stderr: "ignore", detached: true },
      );
      console.log(`\n      Or click the extension icon in the Chrome toolbar.`);
      console.log(`      Copy the token shown on the page (PLAYWRIGHT_MCP_EXTENSION_TOKEN=...).\n`);
    } else {
      console.log(`\n      [agent] Open the URL above in Chrome (profile: ${profileDisplay})`);
      console.log(`      [agent] Find PLAYWRIGHT_MCP_EXTENSION_TOKEN=... on that page`);
      console.log(`      [agent] Provide the token value on next stdin line:\n`);
    }
    const tokenInput = (await ask("      Paste token: ")).trim();
    const token = tokenInput.replace(/^.*?=/, "").trim();
    if (!token || token.length < 20) { console.error("      Invalid token (too short)"); return null; }
    console.log("      Token accepted");
    return { extId, token };
  }

  // [2/4] Primary profile
  console.log("\n[2/4] Select Chrome profile:");
  const picked = await pickProfile(new Set());
  if (!picked) { console.error("      Invalid selection"); rl?.close(); process.exit(1); }
  const [profileDir, profileInfoSel] = picked;
  const profileDisplay = profileInfoSel.user_name || profileInfoSel.name || profileDir;

  // [3+4/4] Extension + token for primary profile
  console.log("\n[3/4] Checking extension...");
  const profileEmail = profileInfoSel.user_name || profileDir;
  const primary = await getExtAndToken(profileDir, profileDisplay, profileEmail);
  if (!primary) { rl?.close(); process.exit(1); }
  const { extId, token } = primary;

  // Build RECHROME_URL and show it before asking where to save
  const rechUrl = new URL(url);
  if (!rechUrl.username) rechUrl.username = randomBytes(12).toString("base64url");
  rechUrl.searchParams.set("extension_id", extId);
  rechUrl.searchParams.set("token", token);
  rechUrl.searchParams.set("profile", profileEmail);
  if (userDataDir) rechUrl.searchParams.set("user_data_dir", userDataDir);
  const newLine = `RECHROME_URL=${rechUrl.toString()}`;
  console.log(`\n[4/4] Your RECHROME_URL:\n\n  ${newLine}\n`);
  if (!isTTY) console.log(`  [agent] Provide save destination on next stdin line: 1=cwd, 2=cwd rechrome-only, 3=home, 4=skip\n`);

  const pwdEnvPath = join(process.cwd(), ".env.local");
  const pwdRechPath = join(process.cwd(), ".rechrome", ".env.local");
  const homeEnvPath = join(process.env.HOME!, ".env.local");
  const saveChoice = (await ask(
    `Save to:\n  1. ${pwdEnvPath} (current dir) [default]\n  2. ${pwdRechPath} (current dir, rechrome-only)\n  3. ${homeEnvPath} (user home)\n  4. Skip (already copied)\n\n  Choice [1]: `
  )).trim();
  if (saveChoice !== "4") {
    const globalEnvPath = saveChoice === "3" ? homeEnvPath : saveChoice === "2" ? pwdRechPath : pwdEnvPath;
    if (saveChoice === "2") mkdirSync(join(process.cwd(), ".rechrome"), { recursive: true });
    const existing = await file(globalEnvPath).text().catch(() => "");
    const keysToRemove = ["PLAYWRIGHT_MCP_USER_DATA_DIR", "PLAYWRIGHT_MCP_EXTENSION_ID", "PLAYWRIGHT_MCP_EXTENSION_TOKEN", "PLAYWRIGHT_MCP_PROFILE_DIRECTORY"];
    let lines = existing.trimEnd().split("\n").filter(l => !keysToRemove.some(k => l.startsWith(`${k}=`)));
    const rechIdx = lines.findIndex(l => l.startsWith("RECHROME_URL="));
    if (rechIdx >= 0) lines[rechIdx] = newLine;
    else lines.push(newLine);
    await Bun.write(globalEnvPath, lines.join("\n").trim() + "\n");
    console.log(`\nSaved to ${globalEnvPath}`);
  }

  // Save primary to token registry
  await saveTokenEntry(profileEmail, { extensionId: extId, token, profileDir, userDataDir: userDataDir ?? undefined });

  // Additional profiles
  const configured = new Set([profileDir]);
  while (true) {
    const more = (await ask("\nAdd another profile? [y/N]: ")).trim().toLowerCase();
    if (more !== "y" && more !== "yes") break;
    const remaining = Object.entries(cache!).filter(([dir]) => !configured.has(dir));
    if (!remaining.length) { console.log("      No more profiles available."); break; }
    console.log("\n      Select additional profile:");
    const extra = await pickProfile(configured);
    if (!extra) { console.log("      Skipped."); continue; }
    const [extraDir, extraInfo] = extra;
    const extraDisplay = extraInfo.user_name || extraInfo.name || extraDir;
    const extraEmail = extraInfo.user_name || extraDir;
    console.log(`\n      Setting up: ${extraDisplay}`);
    const result = await getExtAndToken(extraDir, extraDisplay, extraEmail);
    if (!result) { console.log("      Skipped."); continue; }
    await saveTokenEntry(extraEmail, { extensionId: result.extId, token: result.token, profileDir: extraDir, userDataDir: userDataDir ?? undefined });
    configured.add(extraDir);
    console.log(`      Saved token for ${extraDisplay}`);
  }
  rl?.close();
  envWatcher?.close();
  console.log(`\nDone! Test with:\n  rech eval "() => document.title"`);
}

async function status(): Promise<void> {
  const url = process.env[ENV_KEY];
  if (!url) {
    console.log(`serve:    not configured (run \`rech setup\`)`);
    return;
  }
  const { host, port, protocol } = parseUrl(url);
  const parsed = parseUrl(url);
  const ping = await fetch(`${protocol}://${host}:${port}/`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
  // Check actual socket binding via lsof (shows * for 0.0.0.0, or exact IP for loopback-only)
  const lsofProc = Bun.spawn(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdout: "pipe", stderr: "ignore" });
  const lsofOut = await new Response(lsofProc.stdout).text();
  const listenLine = lsofOut.split("\n").find(l => l.includes(`:${port}`));
  const listenAddr = listenLine?.match(/TCP\s+(\S+:\d+)/)?.[1] ?? (ping ? `${host}:${port}` : null);
  console.log(`serve:    ${ping ? `running  ${protocol}://${listenAddr ?? `${host}:${port}`}` : "not running"}`);
  const oxmgrProc = Bun.spawn(["bunx", "oxmgr", "list"], { stdout: "pipe", stderr: "ignore" });
  const oxmgrOut = await new Response(oxmgrProc.stdout).text();
  const daemonRegistered = oxmgrOut.includes(OXMGR_PROCESS_NAME);
  console.log(`daemon:   ${daemonRegistered ? `oxmgr (${OXMGR_PROCESS_NAME})` : "not installed"}`);
  const registry = await readTokenRegistry();
  const entries = Object.entries(registry);
  if (entries.length) {
    console.log(`\nprofiles:`);
    const primaryProfile = parsed.profileDirectory;
    for (const [email, entry] of entries) {
      const isPrimary = email === primaryProfile || entry.profileDir === primaryProfile;
      const marker = isPrimary ? " (primary)" : "";
      console.log(`  ${email.padEnd(36)}  [${entry.profileDir}]  ext: ${entry.extensionId.slice(0, 8)}…  token: ${entry.token.slice(0, 8)}…${marker}`);
    }
  } else if (parsed.profileDirectory) {
    // Legacy: no registry yet, show from RECHROME_URL
    const email = await resolveProfileEmail(parsed.profileDirectory).catch(() => parsed.profileDirectory);
    console.log(`\nprofiles:\n  ${email}  [${parsed.profileDirectory}]  (legacy — re-run \`rech setup\` to register)`);
  }
}

function printHelp(): void {
  console.log(`rechrome (rech) — drive Chrome via Playwright over HTTP

Usage:
  rech setup                   First-time setup: daemon + Chrome extension + config
  rech status                  Show current configuration and serve health
  rech uninstall               Remove the serve daemon and clear config
  rech serve                   Start the serve server manually (foreground)
  rech profiles                List Chrome profiles
  rech <playwright-args...>    Run Playwright CLI command (requires ${ENV_KEY})

Environment:
  ${ENV_KEY}   Server URL set by \`rech setup\`

Examples:
  rech setup
  rech eval "() => document.title"
  rech open https://example.com
  rech screenshot`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const cmd = args[0]?.toLowerCase();

  if (cmd === "serve") {
    const { serve } = await import("./serve.ts");
    serve(); // long-lived; watcher intentionally kept alive
  } else if (cmd === "status") {
    await status();
    envWatcher?.close();
  } else if (cmd === "profiles") {
    await listProfiles();
    envWatcher?.close();
  } else if (cmd === "setup") {
    const profileIdx = args.indexOf("--profile");
    const profile = profileIdx !== -1
      ? args[profileIdx + 1]
      : args.find(a => a.startsWith("--profile="))?.slice("--profile=".length);
    await setup({ profile }); // setup closes envWatcher itself before printing Done
  } else if (cmd === "uninstall") {
    await daemonUninstall();
    envWatcher?.close();
  } else if (cmd === "help" || cmd === "--help" || cmd === "-h" || args.length === 0) {
    printHelp();
    envWatcher?.close();
  } else {
    const url = process.env[ENV_KEY];
    if (!url) {
      console.error(`${ENV_KEY} is not set. Run \`rech setup\` to configure.\n`);
      printHelp();
      process.exit(1);
    }
    await run(url, args);
    envWatcher?.close();
  }
}
