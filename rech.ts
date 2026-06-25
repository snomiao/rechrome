#!/usr/bin/env bun

import { file } from "bun";
import { randomBytes } from "crypto";
import { mkdirSync, appendFileSync, existsSync, realpathSync, accessSync, cpSync, unlinkSync, readFileSync, readdirSync, constants as fsConstants } from "fs";
import { hostname, homedir } from "os";
import { join, basename, dirname } from "path";
import { spawn as cpSpawn } from "child_process";

export const ENV_KEY = "RECHROME_URL";
export const DEFAULT_PORT = 13775;
export const RECH_DIR = join(import.meta.dir, ".rech");
export const LOG_DIR = join(RECH_DIR, "logs");

// Home dir: HOME on POSIX, USERPROFILE on Windows (handled by os.homedir()).
export const HOME = homedir();

const RECH_HOME_DIR = join(HOME, ".rechrome");
const TOKENS_FILE = join(RECH_HOME_DIR, "profiles.json");

type TokenEntry = { extensionId: string; token: string; profileDir: string; userDataDir?: string; loadExtension?: string };

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
const globalEnvFile = join(HOME || "~", ".env.local");

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
for (const k of ["PLAYWRIGHT_MCP_EXTENSION_ID","PLAYWRIGHT_MCP_EXTENSION_TOKEN","PLAYWRIGHT_MCP_PROFILE_DIRECTORY","PLAYWRIGHT_MCP_USER_DATA_DIR","PLAYWRIGHT_MCP_LOAD_EXTENSION"] as const) {
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
  // Managed (provisioned) profiles aren't persistently installed in Secure Preferences,
  // so the relay must re-load the unpacked extension on every launch via --load-extension.
  "PLAYWRIGHT_MCP_LOAD_EXTENSION",
  "PWMCP_TEST_CONNECTION_TIMEOUT",
] as const;

function isReadable(p?: string): boolean {
  if (!p) return false;
  try { accessSync(p, fsConstants.R_OK); return true; } catch { return false; }
}

// Open a file/URL in the OS default app/browser. `open` is macOS-only — Windows needs
// `cmd /c start`, Linux needs `xdg-open`.
function openInDefaultApp(target: string): void {
  const cmd = process.platform === "darwin" ? ["open", target]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", target]
    : ["xdg-open", target];
  try { Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }); } catch {}
}

// Best-effort path to the Chrome executable for the current platform (used to open a
// specific profile at a chrome-extension:// URL). Returns null if not found.
function findChromeBinary(): string | null {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : process.platform === "win32"
      ? [
          join(process.env.PROGRAMFILES || "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
          join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google/Chrome/Application/chrome.exe"),
          join(process.env.LOCALAPPDATA || join(HOME, "AppData/Local"), "Google/Chrome/Application/chrome.exe"),
        ]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const p of candidates) {
    if (p.includes("/") || p.includes("\\")) { if (existsSync(p)) return p; }
    else { const w = Bun.which(p); if (w) return w; }
  }
  return null;
}

// Open a target (URL or local file) in a specific Chrome profile. This opens a new tab in
// the user's running Chrome for that profile (or launches Chrome if it's not running) — it
// does NOT restart Chrome or touch the live session. Note: `--profile-directory` only opens
// a tab; flags like `--load-extension` are ignored when Chrome is already running for that
// user-data-dir. Returns true if Chrome was spawned, false if it fell back to the OS default.
function openInChromeProfile(profileDir: string, target: string): boolean {
  const chromeBin = findChromeBinary();
  if (!chromeBin) { openInDefaultApp(target); return false; }
  try {
    Bun.spawn(
      [chromeBin, `--profile-directory=${profileDir}`, target],
      { stdout: "ignore", stderr: "ignore", detached: true },
    );
    return true;
  } catch {
    openInDefaultApp(target);
    return false;
  }
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
    loadExtension: u.searchParams.get("load_extension") ?? undefined,
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

async function getClientEnv(urlExtras?: { extensionId?: string; extensionToken?: string; profileDirectory?: string; userDataDir?: string; loadExtension?: string }): Promise<Record<string, string>> {
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
  if (urlExtras?.loadExtension)
    env["PLAYWRIGHT_MCP_LOAD_EXTENSION"] = urlExtras.loadExtension;
  // Token: shell env wins (explicit override), registry is fallback, URL param is last resort
  const profileKey = urlExtras?.profileDirectory || process.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY;
  if (profileKey) {
    const registry = await readTokenRegistry();
    const entry = registry[profileKey];
    if (entry) {
      if (!env["PLAYWRIGHT_MCP_EXTENSION_ID"]) env["PLAYWRIGHT_MCP_EXTENSION_ID"] = entry.extensionId;
      if (!env["PLAYWRIGHT_MCP_USER_DATA_DIR"] && entry.userDataDir) env["PLAYWRIGHT_MCP_USER_DATA_DIR"] = entry.userDataDir;
      if (!env["PLAYWRIGHT_MCP_LOAD_EXTENSION"] && entry.loadExtension) env["PLAYWRIGHT_MCP_LOAD_EXTENSION"] = entry.loadExtension;
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
  const home = HOME || "~";
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
export const EXTENSION_DIST_DIR = join(HOME, ".rechrome", "extension");

// With the manifest `key` field set, Chrome derives this ID deterministically from the key (not the path),
// so we can locate the extension by ID even when the on-disk path differs from what Chrome stored.
export const EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";

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
  // LEGACY_EXTENSION_DIST_DIR is intentionally excluded: it points at the pre-V2 multi-tab
  // bridge, which is incompatible with the current cdpRelayV2 relay — matching it would hand
  // setup a stale, broken extension.
  const knownPaths = new Set<string>();
  for (const p of [EXTENSION_DIST_DIR, BUNDLED_EXTENSION_DIST_DIR]) {
    try { knownPaths.add(realpathSync(p)); } catch {}
  }
  // Read each profile's settings once so we can prioritize stable-ID matches over path fallbacks.
  const perProfile: Array<{ prof: string; settings: Record<string, any> }> = [];
  for (const prof of profiles) {
    const prefsPath = join(userDataDir, prof, "Secure Preferences");
    const f = file(prefsPath);
    if (!(await f.exists())) continue;
    try {
      const data = JSON.parse(await f.text());
      perProfile.push({ prof, settings: (data?.extensions?.settings ?? {}) as Record<string, any> });
    } catch {}
  }
  // Pass 1: stable ID match (manifest `key` set, path-independent). This must win over any path
  // fallback so a stale legacy install sitting on a known path can't shadow the current extension.
  for (const { prof, settings } of perProfile) {
    for (const [extId, info] of Object.entries(settings)) {
      if (!info?.path || info.state === 0) continue; // state 0 = explicitly disabled
      if (extId === EXTENSION_ID) return { id: extId, profile: prof };
    }
  }
  // Pass 2: path equality fallback for legacy keyless installs without a stable ID.
  for (const { prof, settings } of perProfile) {
    for (const [extId, info] of Object.entries(settings)) {
      if (!info?.path || info.state === 0) continue;
      let storedPath = info.path as string;
      try { storedPath = realpathSync(storedPath); } catch {}
      if (knownPaths.has(storedPath)) return { id: extId, profile: prof };
    }
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
  const { key, host, port, protocol, extensionId, extensionToken, profileDirectory, userDataDir, loadExtension } = parseUrl(url);
  const identity = await getClientIdentity();
  const effectiveProfile = profileDirectory || process.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY;
  if (effectiveProfile) (identity as any).profile = effectiveProfile;
  const env = { ...(await getClientEnv({ extensionId, extensionToken, profileDirectory, userDataDir, loadExtension })), ...overrideEnv };
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
  const { host, port, protocol, extensionId, extensionToken, profileDirectory, userDataDir, loadExtension } = parseUrl(url);
  const effectiveProfile = profileDirectory || process.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY;
  const displayProfile = effectiveProfile ? await resolveProfileEmail(effectiveProfile) : undefined;
  const identity = await getClientIdentity();
  const profileSuffix = displayProfile ? ` profile:${displayProfile}` : "";
  console.error(
    `[rech] connecting to ${host}:${port} (identity: ${identity.gitUrl || `${identity.hostname}:${identity.cwd}`}${profileSuffix})`,
  );

  const resolvedEnv = await getClientEnv({ extensionId, extensionToken, profileDirectory, userDataDir, loadExtension });
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

export function buildSetupHtml(extDistDir: string, profileDisplay: string): string {
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

const PM_PROCESS_NAME = "rechrome";
// Pre-rename names to evict on (re)install/uninstall so a single `rech setup`
// migrates an existing checkout cleanly.
const LEGACY_PROCESS_NAMES = ["rechrome-serve"];
// oxmgr everywhere, but it's unstable on Windows — fall back to pm2 there.
const IS_WINDOWS = process.platform === "win32";
const PM_BIN = IS_WINDOWS ? "pm2" : "oxmgr";

// Spawn the active process manager. `env` is merged over process.env for the
// child: pm2 captures the CLI's environment for the managed process (it has no
// per-var flag like oxmgr's --env), so install passes daemon env this way.
async function runPm(args: string[], env?: Record<string, string>): Promise<number> {
  const proc = Bun.spawn(["bunx", PM_BIN, ...args], {
    stdout: "inherit",
    stderr: "inherit",
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  await proc.exited;
  return proc.exitCode ?? 1;
}

// Capture the process-manager's process list as text (oxmgr `list` / pm2 `jlist`).
// Both render the process name verbatim, so callers can substring-match it.
async function pmList(): Promise<string> {
  const proc = Bun.spawn(["bunx", PM_BIN, IS_WINDOWS ? "jlist" : "list"], { stdout: "pipe", stderr: "ignore" });
  return await new Response(proc.stdout).text();
}

export async function daemonInstall(serveUrl: string): Promise<void> {
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

  const home = HOME;
  const bunBin = Bun.which("bun") ?? process.execPath;
  const rechScript = import.meta.filename;

  // Resolve PLAYWRIGHT_CLI: env override > bundled fork (development checkout) > "playwright-cli-multi-tab".
  // The fork is a .js script: POSIX execs it via its shebang (`#!/usr/bin/env node`), but Windows
  // can't exec a .js directly, so it must be invoked through an interpreter. It MUST be node, not
  // bun: the cliDaemon inherits its parent's runtime (spawned via process.execPath), and the
  // extension-bridge relay's WebSocket handshake hangs under Bun (the extension WS connects but
  // `extension.initialized` never completes) — under node it completes, matching the POSIX shebang.
  // serve splits PLAYWRIGHT_CLI on spaces into argv, so we use bare `node` (the node path lives
  // under "Program Files" and contains a space); node must be on the daemon's PATH, same as the
  // shebang's `env node` assumption. The repo path contains no spaces.
  const bundledForkCli = join(import.meta.dir, "lib/playwright-cli/playwright-cli.js");
  const resolvedPlaywrightCli = process.env.PLAYWRIGHT_CLI
    || (existsSync(bundledForkCli)
        ? (IS_WINDOWS ? `node ${bundledForkCli}` : bundledForkCli)
        : "playwright-cli-multi-tab");

  // Environment the managed `serve` process must run with.
  const daemonEnv: Record<string, string> = {
    HOME: home,
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    [ENV_KEY]: serveUrl,
    PWMCP_TEST_CONNECTION_TIMEOUT: process.env.PWMCP_TEST_CONNECTION_TIMEOUT || "30000",
    PLAYWRIGHT_CLI: resolvedPlaywrightCli,
  };
  if (process.env.RECH_HOST) daemonEnv.RECH_HOST = process.env.RECH_HOST;
  if (isReadable(process.env.RECH_TLS_CERT)) daemonEnv.RECH_TLS_CERT = process.env.RECH_TLS_CERT!;
  if (isReadable(process.env.RECH_TLS_KEY)) daemonEnv.RECH_TLS_KEY = process.env.RECH_TLS_KEY!;

  // Drop any prior registration (current + legacy names) before re-adding.
  for (const name of [PM_PROCESS_NAME, ...LEGACY_PROCESS_NAMES]) await runPm(["delete", name]);

  let startCode: number;
  if (IS_WINDOWS) {
    // pm2 captures the CLI env (passed via runPm's env) for the managed process,
    // autorestarts by default, and runs the bun binary directly with
    // `--interpreter none` (so it isn't fed to node).
    startCode = await runPm([
      "start", bunBin,
      "--name", PM_PROCESS_NAME,
      "--interpreter", "none",
      "--cwd", home,
      "--", rechScript, "serve",
    ], daemonEnv);
    await runPm(["save"]); // persist process list for `pm2 resurrect` on reboot
  } else {
    const envArgs = Object.entries(daemonEnv).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
    startCode = await runPm([
      "start",
      "--name", PM_PROCESS_NAME,
      "--restart", "always",
      "--cwd", home,
      ...envArgs,
      `${bunBin} ${rechScript} serve`,
    ]);
    await runPm(["service", "install"]);
  }
  // Surface a failed start instead of reporting a daemon that was never registered.
  if (startCode !== 0)
    throw new Error(`${PM_BIN} failed to start "${PM_PROCESS_NAME}" (exit ${startCode}). Check that ${PM_BIN} is installed and on PATH.`);
}

async function daemonUninstall(): Promise<void> {
  for (const name of [PM_PROCESS_NAME, ...LEGACY_PROCESS_NAMES]) await runPm(["delete", name]);
  if (IS_WINDOWS) await runPm(["save"]);
  else await runPm(["service", "uninstall"]);
  console.log(`Removed ${PM_BIN} process: ${PM_PROCESS_NAME}`);
}

// ── Native tray (menu-bar / system-tray) icon ───────────────────────────────
// The tray is a small native binary (tray/, Rust). `rech` just supervises it:
// locate the binary and launch it detached (singleton via a pidfile).
// `rech tray hide` / the menu "Hide" item both kill the process;
// `rech tray show` starts a fresh one.
const TRAY_PID_FILE = join(RECH_HOME_DIR, "tray.pid");

// A desktop GUI must be present. Linux needs an X11/Wayland display; a headless
// box (SSH, CI, container) has neither, so the tray is skipped. macOS/Windows
// desktop sessions effectively always have one (the binary bypasses if not).
function trayGuiAvailable(): boolean {
  if (process.platform === "linux")
    return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  return true;
}

// Resolve the tray binary: explicit override, then the copy shipped beside
// `rech` (packaged installs), then the dev cargo build, then PATH.
function findTrayBinary(): string | undefined {
  const ext = IS_WINDOWS ? ".exe" : "";
  const candidates = [
    process.env.RECH_TRAY_BIN,
    join(import.meta.dir, "tray", `rechrome-tray${ext}`),
    join(import.meta.dir, "tray", "target", "release", `rechrome-tray${ext}`),
    join(import.meta.dir, "tray", "target", "debug", `rechrome-tray${ext}`),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  return Bun.which(`rechrome-tray${ext}`) ?? undefined;
}

function isTrayRunning(): boolean {
  try {
    const pid = parseInt(readFileSync(TRAY_PID_FILE, "utf8"), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0); // signal 0 = liveness probe, doesn't actually signal
    return true;
  } catch {
    return false;
  }
}

// Start (and "show") the tray. quiet=true is used by `rech setup` auto-start so
// a missing binary / headless box stays silent rather than noisy.
async function startTray({ quiet = false }: { quiet?: boolean } = {}): Promise<void> {
  if (!trayGuiAvailable()) {
    if (!quiet) console.log("tray: no desktop GUI session detected — skipped.");
    return;
  }
  if (isTrayRunning()) {
    if (!quiet) console.log("tray: already running.");
    return;
  }
  const bin = findTrayBinary();
  if (!bin) {
    if (!quiet)
      console.error("tray: binary not found. Build it with:  (cd tray && cargo build --release)");
    return;
  }
  const child = cpSpawn(bin, [], { detached: true, stdio: "ignore" });
  child.unref(); // outlive this CLI invocation
  if (child.pid) await Bun.write(TRAY_PID_FILE, String(child.pid));
  if (!quiet) console.log(`tray: started (pid ${child.pid}).`);
}

function stopTray(): void {
  if (!isTrayRunning()) { console.log("tray: not running."); return; }
  try { process.kill(parseInt(readFileSync(TRAY_PID_FILE, "utf8"), 10)); } catch {}
  try { unlinkSync(TRAY_PID_FILE); } catch {}
  console.log("tray: stopped. Run `rech tray show` to restore.");
}

async function trayCommand(sub?: string): Promise<void> {
  switch (sub) {
    case "hide": case "stop": case "quit": stopTray(); break;
    case undefined: case "": case "show": case "start": await startTray(); break;
    default:
      console.error(`Unknown tray command: "${sub}". Usage: rech tray [show|hide|stop]`);
      process.exit(1);
  }
}

// Read the extension's auth token straight from a profile's localStorage LevelDB. Read-only
// (we never take LevelDB's lock), so it's safe while the user's Chrome is running. The token is
// the value of the `auth-token` key under the extension origin, stored as a 0x01 (Latin-1)
// encoding byte followed by the 43-char base64url token. LevelDB prefix-compression can split the
// origin string across block-restart points, so we anchor on the `auth-token` marker + token shape
// and (when possible) require the extension id to appear in the same file to avoid a collision
// with another extension's `auth-token`. Returns the newest token found, or null.
function readExtensionTokenFromProfile(userDataDir: string, profileDir: string): string | null {
  const dir = join(userDataDir, profileDir, "Local Storage", "leveldb");
  let files: string[];
  try { files = readdirSync(dir).filter(f => f.endsWith(".ldb") || f.endsWith(".log")).sort(); }
  catch { return null; }
  const extIdChunk = EXTENSION_ID.slice(0, 20); // contiguous prefix survives the LevelDB split
  const scan = (requireExtId: boolean): string | null => {
    let found: string | null = null;
    for (const f of files) {
      let buf: Buffer;
      try { buf = readFileSync(join(dir, f)); } catch { continue; }
      if (requireExtId && !buf.includes(extIdChunk, 0, "latin1")) continue;
      let idx = 0;
      while (true) {
        const j = buf.indexOf("auth-token", idx, "latin1");
        if (j < 0) break;
        idx = j + 1;
        const win = buf.subarray(j, Math.min(buf.length, j + 200)).toString("latin1");
        const m = win.match(/\x01([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/);
        if (m) found = m[1]; // newest file / newest occurrence wins
      }
    }
    return found;
  };
  return scan(true) ?? scan(false);
}

// Resolve a Chromium / Chrome-for-Testing executable from the Playwright browsers cache.
// Managed (provisioned) profiles must run on Chromium because branded Google Chrome 149+ rejects
// --load-extension. Returns null if no Chromium is installed (`npx playwright install chromium`).
function findChromiumForTesting(): string | null {
  // Honor PLAYWRIGHT_BROWSERS_PATH (the user's convention) first, then the platform default —
  // `playwright install` doesn't always write to the env path, so check both.
  const bases = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === "win32" ? join(HOME, "AppData/Local/ms-playwright")
      : process.platform === "darwin" ? join(HOME, "Library/Caches/ms-playwright")
      : join(HOME, ".cache/ms-playwright"),
  ].filter((b): b is string => !!b);
  for (const base of bases) {
    let revs: string[];
    try { revs = readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => parseInt(b.slice(9)) - parseInt(a.slice(9))); }
    catch { continue; }
    for (const rev of revs) {
      const root = join(base, rev);
      const candidates = process.platform === "darwin"
        ? readdirSync(root).filter(d => d.startsWith("chrome-mac")).flatMap(d => {
            const appsDir = join(root, d);
            let apps: string[] = [];
            try { apps = readdirSync(appsDir).filter(a => a.endsWith(".app")); } catch {}
            return apps.map(a => join(appsDir, a, "Contents/MacOS", a.replace(/\.app$/, "")));
          })
        : process.platform === "win32"
          ? [join(root, "chrome-win", "chrome.exe")]
          : [join(root, "chrome-linux", "chrome")];
      for (const c of candidates) if (existsSync(c)) return c;
    }
  }
  return null;
}

// Minimal Chrome DevTools Protocol client over a WebSocket — just enough to create a
// target, attach to it, and evaluate JS. Used to seed the auth token into a managed
// profile's extension localStorage without pulling in the full Playwright dependency.
class CDPClient {
  private ws: WebSocket;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private opened: Promise<void>;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise<void>((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", () => reject(new Error("CDP WebSocket error")), { once: true });
    });
    this.ws.addEventListener("message", (ev: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
      const p = msg.id != null ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
  }
  async open(): Promise<void> { await this.opened; }
  send(method: string, params: Record<string, any> = {}, sessionId?: string): Promise<any> {
    const id = ++this.nextId;
    const payload: any = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out`)); }, 15_000);
    });
  }
  close(): void { try { this.ws.close(); } catch {} }
}

// Launch a throwaway Chrome against a dedicated user-data-dir with the unpacked extension
// loaded, then seed `token` into the extension's localStorage (the value `connect.html` checks
// for token-bypass). Headless by default; never touches the user's real Chrome/profiles.
async function provisionExtensionToken(opts: {
  userDataDir: string; profileDir: string; dist: string; token: string; headed?: boolean;
}): Promise<void> {
  // Branded Google Chrome 149+ rejects --load-extension ("not allowed in Google Chrome"), so a
  // managed profile must be seeded on Chromium / Chrome for Testing, which still honors the flag.
  const chromeBin = findChromiumForTesting();
  if (!chromeBin) throw new Error("Chromium / Chrome for Testing not found — run `npx playwright install chromium`");
  const { userDataDir, profileDir, dist, token } = opts;
  mkdirSync(userDataDir, { recursive: true });
  const portFile = join(userDataDir, "DevToolsActivePort");
  try { unlinkSync(portFile); } catch {}
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profileDir}`,
    `--load-extension=${dist}`,
    `--disable-extensions-except=${dist}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
  ];
  if (!opts.headed) args.push("--headless=new");
  if (process.platform === "linux") args.push("--no-sandbox");
  args.push("about:blank");
  const proc = Bun.spawn([chromeBin, ...args], { stdout: "ignore", stderr: "ignore" });
  let cdp: CDPClient | null = null;
  try {
    // Chrome writes the chosen port to DevToolsActivePort once the debug server is up.
    let port: number | null = null;
    for (let i = 0; i < 100; i++) {
      await Bun.sleep(100);
      const line = (await file(portFile).text().catch(() => "")).split("\n")[0]?.trim();
      if (line && /^\d+$/.test(line)) { port = parseInt(line); break; }
      if (proc.exitCode !== null) throw new Error("Chrome exited before opening the DevTools port");
    }
    if (!port) throw new Error("Chrome DevTools port not found (extension may have failed to load)");
    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    cdp = new CDPClient(ver.webSocketDebuggerUrl as string);
    await cdp.open();
    const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${EXTENSION_ID}/status.html` });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    // The extension page may still be loading; retry the write until localStorage reflects it.
    let ok = false;
    const expr = `(()=>{try{localStorage.setItem('auth-token',${JSON.stringify(token)});return localStorage.getItem('auth-token');}catch(e){return 'ERR:'+e.message}})()`;
    for (let i = 0; i < 50; i++) {
      const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId).catch(() => null);
      if (r?.result?.value === token) { ok = true; break; }
      await Bun.sleep(100);
    }
    if (!ok) throw new Error(`Could not seed auth token into chrome-extension://${EXTENSION_ID}/ (is the extension loading?)`);
    // Graceful close flushes localStorage to the profile's leveldb before we kill Chrome.
    await cdp.send("Browser.close").catch(() => {});
  } finally {
    cdp?.close();
    try { proc.kill(); } catch {}
    await proc.exited.catch(() => {});
  }
}

async function provisionProfile(name: string, opts: { headed?: boolean } = {}): Promise<void> {
  // The name doubles as the on-disk profile directory and the registry/URL key, so keep it a
  // simple token and disallow the reserved real-Chrome names to avoid any cross-talk.
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || /^(Default|Profile \d+)$/i.test(name)) {
    console.error(`Invalid profile name: "${name ?? ""}". Use letters/digits/._- (not "Default"/"Profile N").`);
    process.exit(1);
  }
  const dist = await ensureExtensionDistInstalled();
  const userDataDir = join(RECH_HOME_DIR, "profiles", name);
  const token = randomBytes(32).toString("base64url");

  console.log(`\n[1/3] Provisioning managed profile "${name}"`);
  console.log(`      user-data-dir: ${userDataDir}`);
  console.log(`      extension:     ${dist}`);
  console.log(`      Launching ${opts.headed ? "headed" : "headless"} Chrome to seed the auth token...`);
  await provisionExtensionToken({ userDataDir, profileDir: name, dist, token, headed: opts.headed });
  console.log(`      Token seeded (${token.slice(0, 6)}…)`);

  // [2/3] Daemon URL — reuse the running daemon's key; warn (don't fail) if it isn't up yet.
  console.log(`\n[2/3] Building RECHROME_URL`);
  const url = await getOrCreateUrl();
  const { host, port, protocol, key } = parseUrl(url);
  const healthy = await fetch(`${protocol}://${host}:${port}/ping`, {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(2000),
  }).then(r => r.ok).catch(() => false);
  if (!healthy) console.log(`      Note: daemon not reachable at ${host}:${port} — run \`rech setup\` once to start it.`);

  const rechUrl = new URL(`${protocol}://${host}:${port}`);
  rechUrl.username = key || randomBytes(12).toString("base64url");
  rechUrl.searchParams.set("extension_id", EXTENSION_ID);
  rechUrl.searchParams.set("token", token);
  rechUrl.searchParams.set("profile", name);
  rechUrl.searchParams.set("user_data_dir", userDataDir);
  rechUrl.searchParams.set("load_extension", dist);
  const newLine = `RECHROME_URL=${rechUrl.toString()}`;

  // [3/3] Register in the token registry so `rech status` lists it and the daemon can resolve it.
  await saveTokenEntry(name, { extensionId: EXTENSION_ID, token, profileDir: name, userDataDir, loadExtension: dist });
  console.log(`\n[3/3] Registered "${name}" in ${TOKENS_FILE}`);

  console.log(`\nDone! RECHROME_URL for "${name}":\n\n  ${newLine}\n`);
  console.log(`Use it per-call:\n  ${newLine.replace("RECHROME_URL=", "RECHROME_URL='")}' rech open https://example.com\n`);
  console.log(`Or save it to a project .env.local to make it the default.`);
}

async function setup(opts: { profile?: string; token?: string } = {}): Promise<void> {
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
  console.log("\n[1/4] Checking serve daemon...");

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

  // A healthy daemon already answering on our key needs no reinstall — don't re-prompt for it.
  const daemonHealthy = !!(anonPing && authPing?.ok && !liveBindUnknown);
  // An explicit RECH_HOST override that differs from the live bind is a deliberate rebind request.
  const explicitRebind = !!process.env.RECH_HOST && process.env.RECH_HOST !== currentBind;

  // Non-TTY honors explicit process.env.RECH_HOST (shell or merged env stack) — matches the documented `RECH_HOST=0.0.0.0 rech setup` flow.
  let desiredBind = process.env.RECH_HOST || currentBind;
  // Only prompt to (re)configure the bind when we actually need to set up the daemon. A running
  // daemon is left alone unless the user explicitly asks for a different bind via RECH_HOST.
  if (isTTY && (!daemonHealthy || explicitRebind)) {
    console.log(`\n      Bind address (current: ${currentBind}):`);
    console.log(`        1.  127.0.0.1  (localhost only)`);
    console.log(`        2.  0.0.0.0    (all interfaces — HTTP plaintext, trust your network)`);
    const defaultBindChoice = currentBind === "0.0.0.0" ? "2" : "1";
    const bindAns = (await ask(`      Choice [${defaultBindChoice}]: `, defaultBindChoice)).trim();
    desiredBind = bindAns === "2" || bindAns === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
  } else if (daemonHealthy) {
    console.log(`      Daemon already running at ${protocol}://${host}:${port} (bind: ${currentBind}) — skipping daemon setup`);
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
    console.log(`      Registered daemon: ${PM_PROCESS_NAME}`);
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

  async function getExtAndToken(profileDir: string, profileDisplay: string, profileKey: string, providedToken?: string): Promise<{ extId: string; token: string } | null> {
    // Extension check
    let extId: string | undefined;
    // Copy bundled dist to a stable per-user location so the install path survives bunx temp-dir cleanup.
    await ensureExtensionDistInstalled();
    while (true) {
      const found = await findInstalledExtension(profileDir);
      if (found) { extId = found.id; break; }
      console.log(`\n      Extension not found in profile: ${profileDisplay}`);
      console.log(`      Extension dist: ${EXTENSION_DIST_DIR}`);
      const setupHtmlPath = join(RECH_HOME_DIR, "setup.html");
      mkdirSync(RECH_HOME_DIR, { recursive: true });
      await Bun.write(setupHtmlPath, buildSetupHtml(EXTENSION_DIST_DIR, profileDisplay));
      // Open the install guide directly in the *target* profile (resolved from --profile), so
      // "Load unpacked" lands in the right Chrome. This is a new tab, not a restart.
      console.log(`\n      Opening install guide in Chrome profile: ${profileDisplay}`);
      openInChromeProfile(profileDir, setupHtmlPath);
      // Non-TTY (agent/pipe) can't block on a paste prompt, and `ask` returns immediately on an
      // exhausted stdin queue — looping would respawn Chrome every iteration. Open the guide once,
      // then stop with clear re-run instructions instead of spinning.
      if (!isTTY) {
        console.error(`\n      Non-TTY: load the extension once via chrome://extensions → "Load unpacked":`);
        console.error(`        ${EXTENSION_DIST_DIR}`);
        console.error(`      (open chrome://extensions in profile "${profileDisplay}" — see the guide just opened)`);
        console.error(`      Then re-run:  rech setup --profile <num|email> [--token <tok>]`);
        return null;
      }
      await ask("\n      Press Enter after loading the extension to retry...");
    }
    console.log(`      Extension found: ${extId}`);

    // Non-interactive token injection (--token / RECH_TOKEN). An explicitly supplied token wins
    // over both the registry-keep prompt and the paste loop, so a non-TTY agent can register a
    // profile in one shot. Accepts the bare token or a full `PLAYWRIGHT_MCP_EXTENSION_TOKEN=...`.
    if (providedToken) {
      const token = providedToken.replace(/^.*?=/, "").trim();
      if (token.length < 20) {
        console.error(`      Provided token too short (${token.length} chars) — pass the full PLAYWRIGHT_MCP_EXTENSION_TOKEN value`);
        return null;
      }
      console.log(`      Using provided token: ${token.slice(0, 6)}…`);
      return { extId, token };
    }

    // Default automation: read the auth token straight from the profile's localStorage LevelDB,
    // so an installed extension needs no manual paste (works the same in TTY and non-TTY). The
    // token is minted lazily the first time the status/connect page loads, so if it isn't there
    // yet, open status.html in this profile to mint it (a new tab — never a restart) and re-scan.
    if (userDataDir) {
      let auto = readExtensionTokenFromProfile(userDataDir, profileDir);
      if (!auto) {
        console.log(`      No token in profile yet — minting via chrome-extension://${extId}/status.html …`);
        openInChromeProfile(profileDir, `chrome-extension://${extId}/status.html`);
        for (let i = 0; i < 10 && !auto; i++) { await Bun.sleep(500); auto = readExtensionTokenFromProfile(userDataDir, profileDir); }
      }
      if (auto) {
        console.log(`      Auto-read token from profile localStorage: ${auto.slice(0, 6)}…`);
        return { extId, token: auto };
      }
      console.log(`      Could not auto-read token from localStorage — falling back to manual entry`);
    }

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
      openInChromeProfile(profileDir, statusUrl);
      console.log(`\n      Or click the extension icon in the Chrome toolbar.`);
      console.log(`      Copy the token shown on the page (PLAYWRIGHT_MCP_EXTENSION_TOKEN=...).\n`);
    } else {
      console.log(`\n      [agent] Open the URL above in Chrome (profile: ${profileDisplay})`);
      console.log(`      [agent] Find PLAYWRIGHT_MCP_EXTENSION_TOKEN=... on that page`);
      console.log(`      [agent] Provide the token value on next stdin line:\n`);
    }
    // Retry on empty/too-short paste — a truncated copy or a stale token shouldn't
    // abort the whole setup. Bounded so a non-TTY agent with exhausted stdin can't spin.
    const maxTries = isTTY ? 5 : 3;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      const tokenInput = (await ask("      Paste token: ")).trim();
      const token = tokenInput.replace(/^.*?=/, "").trim();
      const retriesLeft = maxTries - attempt;
      if (!token) {
        console.error(`      No token entered.${retriesLeft ? " Copy the full PLAYWRIGHT_MCP_EXTENSION_TOKEN value and try again." : ""}`);
      } else if (token.length < 20) {
        console.error(`      Token too short (${token.length} chars) — likely truncated when copying.${retriesLeft ? " Re-copy the full value and try again." : ""}`);
      } else {
        console.log("      Token accepted");
        return { extId, token };
      }
      // Non-TTY with no input left: ask() won't block, so stop instead of burning retries on empty reads.
      if (!isTTY && !tokenInput) break;
    }
    console.error("      No valid token provided — aborting");
    return null;
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
  const primary = await getExtAndToken(profileDir, profileDisplay, profileEmail, opts.token);
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
  const homeEnvPath = join(HOME, ".env.local");
  // Show whether each target already exists so it's clear we'll update (merge) vs create.
  const tag = async (p: string) => (await file(p).exists()) ? "exists → will update" : "new file";
  const [pwdTag, pwdRechTag, homeTag] = await Promise.all([tag(pwdEnvPath), tag(pwdRechPath), tag(homeEnvPath)]);
  const saveChoice = (await ask(
    `Save to:\n  1. ${pwdEnvPath} (current dir) [${pwdTag}] [default]\n  2. ${pwdRechPath} (current dir, rechrome-only) [${pwdRechTag}]\n  3. ${homeEnvPath} (user home) [${homeTag}]\n  4. Skip (already copied)\n\n  Choice [1]: `
  )).trim();
  if (saveChoice !== "4") {
    const globalEnvPath = saveChoice === "3" ? homeEnvPath : saveChoice === "2" ? pwdRechPath : pwdEnvPath;
    if (saveChoice === "2") mkdirSync(join(process.cwd(), ".rechrome"), { recursive: true });
    const existedBefore = await file(globalEnvPath).exists();
    const existing = await file(globalEnvPath).text().catch(() => "");
    const keysToRemove = ["PLAYWRIGHT_MCP_USER_DATA_DIR", "PLAYWRIGHT_MCP_EXTENSION_ID", "PLAYWRIGHT_MCP_EXTENSION_TOKEN", "PLAYWRIGHT_MCP_PROFILE_DIRECTORY"];
    let lines = existing.trimEnd().split("\n").filter(l => !keysToRemove.some(k => l.startsWith(`${k}=`)));
    const rechIdx = lines.findIndex(l => l.startsWith("RECHROME_URL="));
    if (rechIdx >= 0) lines[rechIdx] = newLine;
    else lines.push(newLine);
    await Bun.write(globalEnvPath, lines.join("\n").trim() + "\n");
    console.log(`\n${existedBefore ? "Updated" : "Created"} ${globalEnvPath}`);
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
  console.log(`\nDone! Test with:\n  rech open github.com/snomiao`);
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
  // Resolve the daemon's actual bind from its authenticated /ping (cross-platform; lsof is
  // POSIX-only and absent on Windows). bind is "0.0.0.0" (all interfaces) or the loopback IP.
  const bind = ping
    ? await fetch(`${protocol}://${host}:${port}/ping`, {
        headers: { Authorization: `Bearer ${parsed.key}` },
        signal: AbortSignal.timeout(2000),
      }).then(r => (r.ok ? r.json() : null)).then((b: { bind?: string } | null) => b?.bind).catch(() => undefined)
    : undefined;
  const listenAddr = bind ? `${bind}:${port}` : `${host}:${port}`;
  console.log(`serve:    ${ping ? `running  ${protocol}://${listenAddr}` : "not running"}`);
  const pmOut = await pmList();
  const daemonRegistered = pmOut.includes(PM_PROCESS_NAME);
  console.log(`daemon:   ${daemonRegistered ? `${PM_BIN} (${PM_PROCESS_NAME})` : "not installed"}`);
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
  rech setup [--profile <num|email>] [--token <tok>]
                               First-time setup: daemon + Chrome extension + config
                               --profile selects the Chrome profile non-interactively
                               --token (or RECH_TOKEN) supplies the auth token for
                               non-TTY/agent runs, skipping the interactive paste
  rech provision-profile <name> --experimental [--headed]
                               (experimental) Auto-provision a managed QA profile on
                               Chrome for Testing — branded Chrome 149+ rejects
                               --load-extension, so this is a clean browser, not your
                               real Chrome. For your real Chrome, use \`rech setup\`
  rech status                  Show current configuration and serve health
  rech tray [show|hide|stop]   Native menu-bar/tray icon for the serve daemon
                               (show=start, hide/show toggle, stop=quit). Auto-
                               starts after \`rech setup\`; skipped with no GUI
  rech uninstall               Remove the serve daemon and clear config
  rech serve                   Start the serve server manually (foreground)
  rech profiles                List Chrome profiles
  rech <playwright-args...>    Run Playwright CLI command (requires ${ENV_KEY})

Environment:
  ${ENV_KEY}   Server URL set by \`rech setup\`
  RECH_TOKEN     Auth token for \`rech setup\` (same as --token)

Examples:
  rech setup
  rech setup --profile 18 --token <PLAYWRIGHT_MCP_EXTENSION_TOKEN>
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
    const tokenIdx = args.indexOf("--token");
    const token = (tokenIdx !== -1
      ? args[tokenIdx + 1]
      : args.find(a => a.startsWith("--token="))?.slice("--token=".length))
      ?? process.env.RECH_TOKEN;
    await setup({ profile, token }); // setup closes envWatcher itself before printing Done
    // Auto-start the tray (best-effort, silent on headless / missing binary).
    await startTray({ quiet: true }).catch(() => {});
  } else if (cmd === "tray") {
    await trayCommand(args[1]?.toLowerCase());
    envWatcher?.close();
  } else if (cmd === "provision-profile") {
    const name = args.find((a, i) => i > 0 && !a.startsWith("-"));
    const headed = args.includes("--headed");
    const experimental = args.includes("--experimental");
    if (!name) { console.error("Usage: rech provision-profile <name> --experimental [--headed]"); process.exit(1); }
    // Experimental: a managed profile runs on Chrome for Testing, not the user's real Google Chrome
    // (branded Chrome 149+ rejects --load-extension). It's a clean browser with no logins/cookies,
    // so it's gated behind --experimental rather than offered as the default setup path.
    if (!experimental) {
      console.error(`provision-profile is experimental and creates a Chrome-for-Testing profile (not your`);
      console.error(`real Chrome): branded Google Chrome 149+ rejects --load-extension, so a managed profile`);
      console.error(`can't reuse your logged-in Chrome. For your real Chrome use:  rech setup --profile <N>`);
      console.error(`To proceed anyway, re-run with --experimental.`);
      process.exit(1);
    }
    await provisionProfile(name, { headed });
    envWatcher?.close();
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
