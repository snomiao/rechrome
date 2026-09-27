#!/usr/bin/env bun
import { readListeners, writeListeners, listenerAddress, isLoopback, normalizePrefix, serviceUrl, allowProfiles, denyProfiles, rotateListenerKey, setPublicUrl, type Listener } from "./listeners.ts";

import { file } from "bun";
import yargs from "yargs";
import { readExtensionTokenFromProfile } from "./extension-token.ts";
import { randomBytes } from "crypto";
import { mkdirSync, appendFileSync, existsSync, realpathSync, accessSync, cpSync, unlinkSync, readFileSync, readdirSync, renameSync, rmdirSync, constants as fsConstants } from "fs";
import { hostname, homedir, networkInterfaces } from "os";
import { isIPv4 } from "net";
import { join, basename, dirname } from "path";
import { pathToFileURL } from "url";
import { spawn as cpSpawn } from "child_process";
import { readFile, writeFile, rename, chmod, mkdir } from "node:fs/promises";
import { oxmgrInstallCommand, pickDaemonManager, type DaemonManager } from "./daemon-manager.ts";

export const ENV_KEY = "RECHROME_URL";
export const DEFAULT_PORT = 13775;
// Home dir: HOME on POSIX, USERPROFILE on Windows (handled by os.homedir()).
export const HOME = homedir();

// All rechrome state (registry, listeners, extension, logs, daemon output) lives in
// ~/.rechrome, never next to the code: a bunx/npx install dir is a disposable cache.
export const RECH_DIR = join(HOME, ".rechrome");
export const LOG_DIR = join(RECH_DIR, "logs");
// Before the rename, logs and daemon output lived in <install dir>/.rech.
export const LEGACY_RECH_DIR = join(import.meta.dir, ".rech");
const TOKENS_FILE = join(RECH_DIR, "profiles.yaml");

type TokenEntry = { extensionId: string; token: string; profileDir: string; userDataDir?: string; loadExtension?: string };

function validateTokenRegistry(value: unknown): Record<string, TokenEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid profile registry: expected a mapping");
  for (const entry of Object.values(value)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        !["extensionId", "token", "profileDir"].every(k => typeof entry[k] === "string" && entry[k].length > 0) ||
        !["userDataDir", "loadExtension"].every(k => entry[k] === undefined || typeof entry[k] === "string"))
      throw new Error("Invalid profile registry entry");
  }
  return value as Record<string, TokenEntry>;
}

export async function writeTokenRegistry(registry: Record<string, TokenEntry>, directory = RECH_DIR): Promise<void> {
  validateTokenRegistry(registry);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "profiles.yaml");
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, Bun.YAML.stringify(registry, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}

export async function readTokenRegistry(directory = RECH_DIR): Promise<Record<string, TokenEntry>> {
  const path = join(directory, "profiles.yaml");
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const legacyPath = join(directory, "profiles.json");
    let legacy: string;
    try { legacy = await readFile(legacyPath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const registry = validateTokenRegistry(JSON.parse(legacy));
    await writeTokenRegistry(registry, directory);
    // Retain the original as a private migration backup; YAML is authoritative.
    await chmod(legacyPath, 0o600);
    return registry;
  }
  return validateTokenRegistry(Bun.YAML.parse(raw));
}

async function saveTokenEntry(profileEmail: string, entry: TokenEntry): Promise<void> {
  mkdirSync(RECH_DIR, { recursive: true });
  const registry = await readTokenRegistry();
  registry[profileEmail] = entry;
  await writeTokenRegistry(registry);
}

const envFile = join(import.meta.dir, ".env.local");
const globalEnvFile = join(HOME || "~", ".env.local");

// Capture inherited values once so explicit environment overrides survive reloads,
// while values loaded from files can still change when those files are edited.
const inheritedEnvKeys = new Set(Object.keys(process.env));

// Walk CWD→root loading env files nearest-first; inherited environment wins over files.
// At each level .rechrome/.env.local is checked before .env.local (rechrome-specific overrides general).
export async function loadNearestEnv(extraFallbacks: string[] = []) {
  const seen = new Set<string>(inheritedEnvKeys);
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
await loadEnv();

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
  try { Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", windowsHide: true }); } catch {}
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
      { stdout: "ignore", stderr: "ignore", detached: true, windowsHide: true },
    );
    return true;
  } catch {
    openInDefaultApp(target);
    return false;
  }
}

export async function openSetupGuide(profileDir: string, setupHtmlPath: string): Promise<boolean> {
  // A unique URL identifies the window opened in the requested profile, even if
  // other profiles have an older copy of the setup guide open.
  const guideUrl = /^https?:\/\//.test(setupHtmlPath) ? new URL(setupHtmlPath) : pathToFileURL(setupHtmlPath);
  guideUrl.hash = `setup-${randomBytes(6).toString("hex")}`;
  if (!openInChromeProfile(profileDir, guideUrl.toString())) return false;
  if (process.platform !== "darwin") {
    openInChromeProfile(profileDir, "chrome://extensions/");
    return openInChromeProfile(profileDir, guideUrl.toString());
  }
  // Chrome may discard chrome:// URLs passed on its command line. AppleScript
  // can create an internal-page tab in the specific window containing our guide.
  const script = `on run argv
    repeat 30 times
      tell application "Google Chrome"
        repeat with w in windows
          repeat with tabNumber from 1 to count of tabs of w
            set t to tab tabNumber of w
            if URL of t is item 1 of argv then
              make new tab at end of tabs of w with properties {URL:"chrome://extensions/"}
              make new tab at end of tabs of w with properties {URL:item 1 of argv}
              close t
              set active tab index of w to count of tabs of w
              set index of w to 1
              return "opened"
            end if
          end repeat
        end repeat
      end tell
      delay 0.1
    end repeat
    return "guide not found"
  end run`;
  try {
    const proc = Bun.spawn(["osascript", "-e", script, guideUrl.toString()], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(proc.stdout).text();
    return await proc.exited === 0 && output.trim() === "opened";
  } catch { return false; }
}

export function log(msg: string) {
  mkdirSync(LOG_DIR, { recursive: true });
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  console.error(line.trimEnd());
  const logFile = join(LOG_DIR, `${ts.slice(0, 10)}.log`);
  appendFileSync(logFile, line);
}

/**
 * Move logs and daemon output from the legacy <install dir>/.rech into RECH_DIR, entry by
 * entry. An entry already present in RECH_DIR is kept and the legacy copy left in place,
 * so nothing is overwritten. Best effort: a cross-device rename just leaves the old copy.
 */
export function migrateLegacyDataDir(legacy = LEGACY_RECH_DIR, target = RECH_DIR): string[] {
  const moved: string[] = [];
  if (!existsSync(legacy)) return moved;
  mkdirSync(target, { recursive: true });
  if (realpathSync(legacy) === realpathSync(target)) return moved;
  for (const sub of ["logs", "output"]) {
    const from = join(legacy, sub);
    if (!existsSync(from)) continue;
    mkdirSync(join(target, sub), { recursive: true });
    for (const entry of readdirSync(from)) {
      const to = join(target, sub, entry);
      if (existsSync(to)) continue;
      try { renameSync(join(from, entry), to); moved.push(`${sub}/${entry}`); } catch { /* keep the legacy copy */ }
    }
  }
  // Remove only directories left empty (the unused tls/ included); rmdir refuses non-empty ones.
  for (const dir of ["logs", "output", "tls", ""]) { try { rmdirSync(join(legacy, dir)); } catch { /* not empty */ } }
  return moved;
}

export function parseUrl(raw: string) {
  const u = new URL(raw);
  const fragment = new URLSearchParams(u.hash.slice(1).replace(/^\?/, ""));
  const param = (name: string) => fragment.get(name) ?? u.searchParams.get(name) ?? undefined;
  const scheme = u.protocol.replace(":", "");
  const protocol = scheme === "https" ? "https" : "http";
  const defaultPort = scheme === "https" ? 443 : scheme === "http" ? 80 : DEFAULT_PORT;
  return {
    key: fragment.get("key") ?? u.username,
    prefix: normalizePrefix(u.pathname),
    host: u.hostname,
    port: parseInt(u.port) || defaultPort,
    protocol,
    extensionId: param("extension_id"),
    extensionToken: param("token"),
    profileDirectory: param("profile"),
    userDataDir: param("user_data_dir"),
    loadExtension: param("load_extension"),
  };
}

// URLs for registered profiles need only the endpoint, profile selector and daemon
// key. Bridge credentials and local browser paths stay in the server registry.
export function registeredProfileUrl(raw: string): string {
  const parsed = parseUrl(raw);
  const url = new URL(serviceUrl(raw));
  if (parsed.profileDirectory) url.searchParams.set("profile", parsed.profileDirectory);
  url.hash = new URLSearchParams({ key: parsed.key }).toString();
  return url.toString();
}

// Setup edits parameters while probing before registration. Fold fragments into
// the legacy fields first so an old fragment cannot override the new selection.
function editableConnectionUrl(raw: string): URL {
  const url = new URL(raw);
  const parsed = parseUrl(raw);
  url.username = parsed.key;
  for (const [name, value] of Object.entries({ extension_id: parsed.extensionId, token: parsed.extensionToken, profile: parsed.profileDirectory, user_data_dir: parsed.userDataDir, load_extension: parsed.loadExtension })) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  url.hash = "";
  return url;
}

export type ListenChoice = { kind: "local" | "lan" | "tailscale" | "other"; address: string; label: string };

export function buildListenChoices(interfaces: ReturnType<typeof networkInterfaces>, tailscaleIPs: string[] = []): ListenChoice[] {
  const choices: ListenChoice[] = [{ kind: "local", address: "127.0.0.1", label: "Local — this computer only" }];
  const seen = new Set(["127.0.0.1"]);
  for (const [name, entries] of Object.entries(interfaces).sort(([a], [b]) => a.localeCompare(b))) {
    for (const entry of entries ?? []) {
      const address = entry.address;
      if (entry.internal || !isIPv4(address) || address.startsWith("169.254.") || seen.has(address)) continue;
      seen.add(address);
      const tunnel = /^(utun|tun|tap|wg|zt|tailscale)|wireguard|zerotier|vpn/i.test(name);
      if (tailscaleIPs.includes(address) || /^tailscale/i.test(name)) {
        choices.push({ kind: "tailscale", address, label: `Tailscale — ${name}` });
      } else if (tunnel) {
        const provider = /^wg|wireguard/i.test(name) ? "WireGuard" : /^zt|zerotier/i.test(name) ? "ZeroTier" : "VPN / tunnel";
        choices.push({ kind: "other", address, label: `${provider} — ${name}` });
      } else {
        const local = /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(address);
        const virtual = /^(docker|veth|virbr|br-|bridge|vmnet|vbox)/i.test(name);
        choices.push({ kind: local && !virtual ? "lan" : "other", address, label: `${virtual ? "Virtual network" : local ? "LAN" : "Network interface"} — ${name}` });
      }
    }
  }
  const rank = { local: 0, lan: 1, tailscale: 2, other: 3 };
  return choices.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

const tailscaleBinary = () => Bun.which("tailscale") || (existsSync("/Applications/Tailscale.app/Contents/MacOS/Tailscale") ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale" : null);

/** Run the Tailscale CLI read-only; null when it is missing, disconnected, or slow. */
async function runTailscale(args: string[]): Promise<string | null> {
  const binary = tailscaleBinary();
  if (!binary) return null;
  try {
    const proc = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "ignore" });
    const timeout = setTimeout(() => proc.kill(), 2000);
    try {
      const output = await new Response(proc.stdout).text();
      return await proc.exited === 0 ? output : null;
    } finally { clearTimeout(timeout); }
  } catch { return null; }
}

export async function detectListenChoices(): Promise<ListenChoice[]> {
  const output = await runTailscale(["ip", "-4"]);
  const ips = output ? output.trim().split(/\s+/).filter(isIPv4) : [];
  return buildListenChoices(networkInterfaces(), ips);
}

export type TailscaleServe = { dnsName: string | null; routeUrl: string | null };

/**
 * Find the HTTPS Serve route that forwards `prefix` to a loopback listener on `port`,
 * keeping the prefix (a route that strips it would 404 on the prefixed listener).
 * Prefers this node's own DNS name when several hostnames carry the same route.
 */
export function findTailscaleServeRoute(dnsName: string | null, serveStatus: unknown, port: number, prefix: string): string | null {
  const web = (serveStatus as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> } | null)?.Web ?? {};
  const mount = prefix.replace(/\/+$/, "");
  const matches: string[] = [];
  for (const [hostPort, config] of Object.entries(web)) {
    for (const [path, handler] of Object.entries(config.Handlers ?? {})) {
      if (path.replace(/\/+$/, "") !== mount || !handler.Proxy) continue;
      let target: URL;
      try { target = new URL(/^[a-z]+:\/\//i.test(handler.Proxy) ? handler.Proxy : `http://${handler.Proxy}`); } catch { continue; }
      if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || Number(target.port) !== port) continue;
      if (target.pathname.replace(/\/+$/, "") !== mount) continue;
      const [host, httpsPort] = hostPort.split(/:(?=\d+$)/);
      matches.push(`https://${host}${httpsPort && httpsPort !== "443" ? `:${httpsPort}` : ""}${prefix}`);
    }
  }
  return matches.find(url => dnsName && new URL(url).hostname === dnsName) ?? matches[0] ?? null;
}

export async function detectTailscaleServe(port: number, prefix: string): Promise<TailscaleServe> {
  const [status, serve] = await Promise.all([runTailscale(["status", "--json"]), runTailscale(["serve", "status", "--json"])]);
  let dnsName: string | null = null;
  let serveStatus: unknown = null;
  try { dnsName = (JSON.parse(status ?? "null")?.Self?.DNSName as string | undefined)?.replace(/\.$/, "") || null; } catch { /* not connected */ }
  try { serveStatus = JSON.parse(serve ?? "null"); } catch { /* no Serve config */ }
  return { dnsName, routeUrl: findTailscaleServeRoute(dnsName, serveStatus, port, prefix) };
}

/** The same connection (key and profile) at another base URL, e.g. where a proxy exposes the listener. */
export function rebaseConnectionUrl(routeUrl: string, localUrl: string): string {
  const local = new URL(localUrl);
  const remote = new URL(routeUrl);
  remote.username = parseUrl(localUrl).key;
  remote.search = local.search;
  return registeredProfileUrl(remote.toString());
}

export function chooseListenAddress(choices: ListenChoice[], selector: string): string {
  const matches = choices.filter(choice => choice.address === selector || choice.kind === selector.toLowerCase());
  if (matches.length === 1) return matches[0].address;
  if (matches.length > 1) throw new Error(`Multiple ${selector} addresses detected. Use --listen with one of: ${matches.map(c => c.address).join(", ")}`);
  throw new Error(`Listen network "${selector}" was not detected. Choose local or a detected interface address.`);
}

export function listenUrl(rawUrl: string, address: string): string {
  const url = new URL(rawUrl);
  const connectAddress = address === "0.0.0.0" ? "127.0.0.1" : address === "::" ? "[::1]" : address;
  url.hostname = connectAddress.includes(":") && !connectAddress.startsWith("[") ? `[${connectAddress}]` : connectAddress;
  return url.toString();
}

export async function getOrCreateUrl(persist = true): Promise<string> {
  // Treat a URL without a bearer key as missing — it cannot authenticate
  try { if (process.env[ENV_KEY] && parseUrl(process.env[ENV_KEY]!).key) return process.env[ENV_KEY]!; } catch {}
  const key = randomBytes(12).toString("base64url"); // 16 chars
  const url = `http://${key}@127.0.0.1:${DEFAULT_PORT}`;
  if (persist) {
    const newLine = `${ENV_KEY}=${url}`;
    // Write to ~/.env.local so it's not shadowed by project .env.local
    const envRaw = await file(globalEnvFile).text().catch(() => "");
    const lines = envRaw.trimEnd().split("\n").filter(l => !l.startsWith(`${ENV_KEY}=`));
    const content = [...lines, newLine, ""].join("\n");
    await Bun.write(globalEnvFile, content);
  }
  process.env[ENV_KEY] = url;
  return url;
}

export function authCheck(req: Request, key: string): Response | null {
  const bearer = req.headers.get("authorization")?.replace("Bearer ", "");
  if (bearer !== key) return new Response("Unauthorized", { status: 401 });
  return null;
}

function realpathSafe(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

async function gitOutput(args: string[], cwd: string): Promise<string | null> {
  try {
    // windowsHide: don't flash a console window on Windows (git.exe is a console app)
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", windowsHide: true });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out || null;
  } catch {
    return null;
  }
}

// Normalize a git remote URL to "host/owner/repo" — no scheme, no .git, no credentials.
export function normalizeRemote(remoteUrl: string): string {
  const sshMatch = remoteUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  const httpsMatch = remoteUrl.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`;
  return remoteUrl.replace(/^[^/]*:\/\//, "").replace(/^[^@]*@/, "").replace(/\.git$/, "");
}

// Derive the session bucket KEY (what the server hashes) and a human LABEL (logs / tab group)
// from already-gathered git facts. KEY and LABEL are deliberately decoupled: the key is keyed
// on the *worktree root path* for predictability (a human can tell which browser they drive),
// while the label renders a pretty <remote>#<basename>@<branch> for display only.
//   - mode "worktree" (default): key = realpath(worktree root). Stable across `cd` within the
//     project, distinct per worktree (no same-branch collisions), survives `git checkout`
//     (no mutable-branch surprise), and has no branch so detached HEAD doesn't degrade it.
//   - mode "branch": legacy opt-in — key = <remote>/tree/<branch> (the old behavior).
//   - mode "cwd": key = realpath(cwd).
// Pass realpath'd `cwd` and `root`.
export function deriveIdentity(opts: {
  mode: string;
  cwd: string;
  host: string;
  root?: string | null;   // worktree root (already realpath'd), null when not in git
  remote?: string | null; // normalized host/owner/repo
  branch?: string | null; // branch name, or short SHA when detached
}): { key: string; label: string } {
  const { mode, cwd, host } = opts;
  const root = opts.root || null;
  const remote = opts.remote || null;
  const branch = opts.branch || null;

  let key: string;
  if (mode === "branch") {
    key = remote ? `https://${remote}${branch ? `/tree/${branch}` : ""}` : `${host}:${cwd}`;
  } else if (mode === "cwd") {
    key = `cwd:${cwd}`;
  } else {
    key = `worktree:${root || cwd}`;
  }

  let label: string;
  if (root) {
    label = `${remote ? `${remote}#` : ""}${basename(root)}${branch ? `@${branch}` : ""}`;
  } else if (remote) {
    label = `${remote}${branch ? `/tree/${branch}` : ""}`;
  } else {
    label = `${host}:${cwd}`;
  }
  return { key, label };
}

/**
 * A project's own rechrome folder: <root>/.rechrome, where root is the same one the session
 * key uses (the worktree root, submodules rolled up), or cwd in `cwd` mode / outside git.
 */
export function projectDataDir(opts: { mode: string; cwd: string; root?: string | null }): string {
  return join(opts.mode === "cwd" ? opts.cwd : opts.root || opts.cwd, ".rechrome");
}

async function getClientIdentity(): Promise<{ key: string; label: string; dataDir: string; profile?: string }> {
  const cwd = realpathSafe(process.cwd());
  const mode = (process.env.RECH_IDENTITY || "worktree").toLowerCase();
  let root: string | null = null;
  let remote: string | null = null;
  let branch: string | null = null;

  const top = await gitOutput(["rev-parse", "--show-toplevel"], cwd);
  if (top) {
    // Roll a submodule cwd up to the outermost superproject working tree, so submodule work
    // shares the parent worktree's browser session (monorepo-friendly). Bounded loop guards
    // against pathological nesting.
    let superCwd = top;
    for (let i = 0; i < 16; i++) {
      const sup = await gitOutput(["rev-parse", "--show-superproject-working-tree"], superCwd);
      if (!sup) break;
      superCwd = sup;
    }
    root = realpathSafe(superCwd);
    branch = await gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], root);
    if (!branch || branch === "HEAD")
      branch = await gitOutput(["rev-parse", "--short", "HEAD"], root); // detached HEAD
    const remoteUrl = await gitOutput(["remote", "get-url", "origin"], root);
    if (remoteUrl) remote = normalizeRemote(remoteUrl);
  }

  return { ...deriveIdentity({ mode, cwd, host: hostname(), root, remote, branch }), dataDir: projectDataDir({ mode, cwd, root }) };
}

// Profile precedence: an explicit `?profile=` in RECHROME_URL is authoritative; the
// PLAYWRIGHT_MCP_PROFILE_DIRECTORY shell env is the fallback. When both are set and differ,
// warn once — a silent mismatch here is how an OAuth/login flow can target the WRONG account.
let _profileMismatchWarned = false;
function resolveEffectiveProfile(urlProfile?: string): string | undefined {
  const envProfile = process.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY;
  if (urlProfile && envProfile && urlProfile !== envProfile && !_profileMismatchWarned) {
    _profileMismatchWarned = true;
    console.error(
      `[rech] warning: profile mismatch — RECHROME_URL profile="${urlProfile}" wins over ` +
      `PLAYWRIGHT_MCP_PROFILE_DIRECTORY="${envProfile}". Unset the env var to silence this.`,
    );
  }
  return urlProfile || envProfile;
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
      // The extension mints a fresh `auth-token` whenever its localStorage is cleared
      // (reinstall, "Load unpacked" from a new path, site-data wipe). A registry token
      // that predates that is silently rejected by connect.html ("Invalid token"), which
      // surfaces only as an extension connection timeout. Re-read the live value from the
      // profile and heal the registry instead of failing. Managed (provisioned) profiles are
      // seeded over CDP, but their localStorage can be re-minted the same way, and they use the
      // same <userDataDir>/<profileDir>/Local Storage layout — so they heal here too.
      if (entry.userDataDir) {
        const profileDir = entry.profileDir; // the folder name ("Profile 2"), not the email key
        const live = profileDir ? readExtensionTokenFromProfile(entry.userDataDir, profileDir, entry.extensionId) : null;
        if (live && live !== entry.token) {
          console.error(`[rech] extension token for "${profileKey}" changed — refreshing registry`);
          entry.token = live;
          await saveTokenEntry(profileKey, entry);
        }
      }
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

type ChromeProfileInfo = { user_name?: string; name?: string };

async function readChromeProfileCache(): Promise<Record<string, ChromeProfileInfo> | null> {
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

export function resolveChromeProfileSelector(
  profiles: Array<[string, ChromeProfileInfo]>,
  selector: string,
): [string, ChromeProfileInfo] | null {
  const value = selector.trim();
  validateChromeProfileSelector(value);

  const needle = value.toLowerCase();
  const selectors: Array<{ label: string; value: (dir: string, info: ChromeProfileInfo) => string }> = [
    { label: "email", value: (_dir, info) => info.user_name ?? "" },
    { label: "Chrome profile name", value: (_dir, info) => info.name ?? "" },
    { label: "profile folder name", value: (dir) => dir },
  ];
  for (const kind of selectors) {
    const matches = profiles.filter(([dir, info]) => kind.value(dir, info).trim().toLowerCase() === needle);
    if (matches.length > 1) {
      throw new Error(
        `--profile "${value}" matches multiple profiles by ${kind.label}. ` +
        `Use a unique email or profile folder name from \`rech profile\`.`,
      );
    }
    if (matches.length === 1) return matches[0];
  }
  return null;
}

export function validateChromeProfileSelector(selector: string): void {
  const value = selector.trim();
  if (!/^\d+$/.test(value)) return;
  throw new Error(
    `--profile no longer accepts menu numbers (received "${value}"). ` +
    `Use the profile email, Chrome profile name, or profile folder name from \`rech profile\`.`,
  );
}

export async function resolveGlobalProfile(
  registry: Record<string, TokenEntry>,
  chromeProfiles: Record<string, ChromeProfileInfo> | null,
  selector: string,
): Promise<{ email: string; entry: TokenEntry }> {
  const value = selector.trim();
  if (!value) throw new Error("--profile requires a non-empty value");

  const registryKey = Object.keys(registry).find(k => k.toLowerCase() === value.toLowerCase());
  if (registryKey) return { email: registryKey, entry: registry[registryKey] };

  if (!chromeProfiles) {
    throw new Error(
      `--profile "${value}" does not match any registered email, and Chrome profiles are not accessible. ` +
      `Run \`rech setup --profile "${value}"\` to register this profile.`,
    );
  }

  const profiles = Object.entries(chromeProfiles);
  let match: [string, ChromeProfileInfo] | null;
  try {
    match = resolveChromeProfileSelector(profiles, value);
  } catch (err) {
    throw err;
  }

  if (!match) {
    throw new Error(
      `--profile "${value}" does not match any Chrome profile. ` +
      `See available profiles with \`rech profile\`.`,
    );
  }

  const [dir, info] = match;
  const email = info.user_name || (registry[dir]?.profileDir === dir && !registry[dir].loadExtension ? dir : undefined);
  if (!email) {
    throw new Error(
      `Chrome profile "${value}" (folder: ${dir}) has no email associated. ` +
      `Run \`rech setup --profile "${value}"\` to register it.`,
    );
  }

  const entry = registry[email];
  if (!entry) {
    throw new Error(
      `Profile "${email}" (${dir}) is not registered. ` +
      `Run \`rech setup --profile "${value}"\` to register it.`,
    );
  }

  return { email, entry };
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

export function buildProfileRows(cache: Record<string, ChromeProfileInfo> | null, registry: Record<string, TokenEntry>, chromeRoot: string | null) {
  const entries = Object.entries(registry);
  const used = new Set<string>();
  const rows = Object.entries(cache ?? {}).map(([dir, info]) => {
    const registrations = entries.filter(([, e]) => e.profileDir === dir && !e.loadExtension && (!e.userDataDir || e.userDataDir === chromeRoot));
    registrations.forEach(([key]) => used.add(key));
    return { selector: registrations[0]?.[0] || info.user_name || dir, name: info.name || "", email: info.user_name || "", dir,
      kind: "Chrome", registered: registrations.length > 0 };
  });
  for (const [key, entry] of entries) {
    if (used.has(key)) continue;
    rows.push({ selector: key, name: key, email: "", dir: entry.profileDir,
      kind: entry.loadExtension ? "Managed test" : "Registered", registered: true });
  }
  return rows;
}

async function listProfiles(): Promise<void> {
  const [cache, registry, root] = await Promise.all([readChromeProfileCache(), readTokenRegistry(), findChromeUserDataDir()]);
  const profiles = buildProfileRows(cache, registry, root);
  const listeners = await readListeners();
  const url = process.env[ENV_KEY];
  const current = url ? resolveEffectiveProfile(parseUrl(url).profileDirectory) : process.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY;
  const identity = await getClientIdentity();
  const states = await Promise.all(profiles.map(async p => {
    if (!p.registered) return "Not set up";
    if (!url) return "Registered / unknown";
    try {
      const { key, protocol, host, port } = parseUrl(url);
      // tab-list only inspects this worktree's existing session; never opens Chrome.
      const response = await fetch(serviceUrl(url, "run"), {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ args: ["tab-list"], identity: { ...identity, profile: p.selector }, env: {} }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return "Registered / unknown";
      const result = await response.json() as { status: number; stdout: string; stderr: string };
      if (result.status === 0 && !/### Error|not open|not connected/i.test(result.stdout + result.stderr)) return "Connected";
      if (/not open|not connected/i.test(result.stdout + result.stderr)) return "Registered / idle";
      return "Registered / unknown";
    } catch { return "Registered / unknown"; }
  }));
  const rows = [["TYPE", "EMAIL / SELECTOR", "PROFILE NAME", "FOLDER", "CONNECTION", "ACCESS", ""], ...profiles.map((p, i) => [
    p.kind, p.selector, p.name, p.dir, states[i],
    listeners ? listeners.listeners.filter(l => l.profiles === "*" || l.profiles.includes(p.selector)).map(l => (listenerAddress(l) + normalizePrefix(l.prefix))).join(", ") || "none" : "legacy daemon",
    current && [p.selector, p.dir, p.name, p.email].some(v => v.toLowerCase() === current.toLowerCase()) ? "← current" : "",
  ])];
  const widths = rows.reduce((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, c.length)), [] as number[]);
  for (const row of rows) console.log(row.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd());
  console.log("\nConnection checks this worktree's default session; other sessions may also be open.");
}

export function profileConnectionUri(profile: string, configuredUrl: string | undefined, listeners: Listener[], listenerName?: string): string {
  let url = configuredUrl;
  if (listenerName || !url) {
    const candidates = listeners.filter(l => (l.profiles === "*" || l.profiles.includes(profile)) && (!listenerName || l.name === listenerName));
    if (candidates.length !== 1) throw new Error("Choose a listener with --listener <name>, or set RECHROME_URL to the desired endpoint.");
    const listener = candidates[0];
    url = `http://${listener.key}@${listenerAddress(listener)}${normalizePrefix(listener.prefix)}`;
  }
  const parsed = parseUrl(url);
  if (!parsed.key) throw new Error("The connection URL has no daemon key. Run rech setup or select --listener <name>.");
  const listener = listeners.find(l => l.key === parsed.key);
  if (listener && listener.profiles !== "*" && !listener.profiles.includes(profile)) throw new Error(`This listener does not allow profile "${profile}". Choose a different --listener.`);
  const result = new URL(serviceUrl(url));
  result.searchParams.set("profile", profile);
  result.hash = new URLSearchParams({ key: parsed.key }).toString();
  return result.toString();
}

async function printProfileUri(selector?: string, listener?: string, opts: { local?: boolean; save?: boolean } = {}): Promise<void> {
  const url = process.env[ENV_KEY];
  selector ??= url ? parseUrl(url).profileDirectory : undefined;
  if (!selector) throw new Error("Specify a profile: rech url <profile>");
  const registry = await readTokenRegistry();
  const cache = await readChromeProfileCache();
  // A configured remote profile may not exist in this machine's local registry.
  const profile = url && parseUrl(url).profileDirectory === selector && !listener
    ? selector : (await resolveGlobalProfile(registry, cache, selector)).email;
  const listeners = (await readListeners())?.listeners ?? [];
  let uri = profileConnectionUri(profile, url, listeners, listener);
  // Prefer where a proxy exposes the listener, when it has been recorded.
  const publicUrl = listeners.find(l => l.key === parseUrl(uri).key)?.publicUrl;
  if (publicUrl && !opts.local) uri = rebaseConnectionUrl(publicUrl, uri);
  console.log(uri);
  if (opts.save) console.error(`Saved RECHROME_URL to ${await saveProjectUrl(uri)}`);
}

export function sandboxConnectionWarning(env: Record<string, string | undefined> = process.env): string | null {
  if (env.CODEX_SANDBOX_NETWORK_DISABLED !== "1" && !env.CODEX_SANDBOX) return null;
  return "[rech] warning: running inside a sandbox; network restrictions may block access to the rechrome daemon, even on localhost. " +
    "Retry this command outside the sandbox (with approval in your coding agent). " +
    "If it still fails, check that the daemon is running and the host/port are correct.";
}

async function callServe(
  url: string,
  args: string[],
  overrideEnv?: Record<string, string>,
  precomputedIdentity?: { key: string; label: string; profile?: string },
  throwOnFailure = false,
): Promise<{ status: number; stdout: string; stderr: string; files?: string[]; existingSession?: boolean }> {
  const { key, host, port, protocol, extensionId, extensionToken, profileDirectory, userDataDir, loadExtension } = parseUrl(url);
  // Reuse the caller's identity when provided — computing it shells out to `git` several times,
  // and run() has already done so for its log line. Recomputing here would double those git
  // spawns (and, on Windows, the console-window flashes) on every `rech open`.
  const identity = precomputedIdentity ?? await getClientIdentity();
  // A global `--profile` override must win for the session key too: the daemon hashes
  // identity.profile into the session id, so without this, `rech --profile other open` would
  // reuse the default profile's session (and its browser) instead of opening its own.
  const effectiveProfile = overrideEnv?.["PLAYWRIGHT_MCP_PROFILE_DIRECTORY"] || resolveEffectiveProfile(profileDirectory);
  if (effectiveProfile) identity.profile = effectiveProfile;
  const env = { ...(await getClientEnv({ extensionId, extensionToken, profileDirectory: effectiveProfile, userDataDir, loadExtension })), ...overrideEnv };
  const res = await fetch(serviceUrl(url, "run"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    // dataDir is a client-local path; the daemon (possibly remote) only needs the session identity.
    body: JSON.stringify({ args, identity: { key: identity.key, label: identity.label, profile: identity.profile }, env }),
    signal: AbortSignal.timeout(70_000),
  }).catch(async (e) => {
    if (throwOnFailure) throw new Error("Cannot reach the rechrome daemon. Check that it is running.");
    console.error(`[rech] ${e.message}`);
    const sandboxWarning = sandboxConnectionWarning();
    if (sandboxWarning) console.error(sandboxWarning);
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
    if (throwOnFailure) throw new Error("The daemon rejected its connection key. Run setup again to refresh it.");
    console.error(`[rech] rech-client -> rech-server[ok]\n  -x: bearer key rejected (used: ${key.slice(0, 4)}...) -> playwright[unknown]`);
    process.exit(1);
  }
  return res.json();
}

export function normalizeCommandArgs(args: string[]): string[] {
  const normalized = [...args];
  if (normalized[0] === "tabs" || normalized[0] === "list") normalized[0] = "tab-list";
  return normalized;
}

// Pull a global `--profile <val>` / `--profile=<val>` out of the leading flags of an argv.
// Only flags before the first positional (the playwright subcommand) are rech globals — a
// --profile at/after the subcommand belongs to the forwarded CLI (e.g. playwright-cli's own
// `open --profile <dir>`, a user-data-dir path) and must pass through untouched. Throws on a
// missing value; accepts multiple occurrences (last one wins).
export function extractGlobalProfileArg(args: string[]): { args: string[]; selector?: string } {
  const rest = [...args];
  let selector: string | undefined;
  for (let i = 0; i < rest.length && rest[i].startsWith("-"); i++) {
    const a = rest[i];
    if (a === "--profile") {
      const value = rest[i + 1];
      if (!value || value.startsWith("--"))
        throw new Error("--profile requires a value (e.g. --profile you@gmail.com)");
      selector = value;
      rest.splice(i, 2);
      i--;
      continue;
    }
    if (a.startsWith("--profile=")) {
      const value = a.slice("--profile=".length);
      if (!value) throw new Error("--profile requires a value (e.g. --profile you@gmail.com)");
      selector = value;
      rest.splice(i, 1);
      i--;
      continue;
    }
  }
  return { args: rest, selector };
}

async function run(url: string, args: string[], overrideEnv?: Record<string, string>) {
  // Match the underlying CLI's command names while accepting the short forms humans
  // naturally try. Keep this client-side so old and new serve daemons behave alike.
  args = normalizeCommandArgs(args);
  const { host, port, protocol, extensionId, extensionToken, profileDirectory, userDataDir, loadExtension } = parseUrl(url);
  const effectiveProfile = overrideEnv?.["PLAYWRIGHT_MCP_PROFILE_DIRECTORY"] || resolveEffectiveProfile(profileDirectory);
  const displayProfile = effectiveProfile ? await resolveProfileEmail(effectiveProfile) : undefined;
  const identity = await getClientIdentity();
  const profileSuffix = displayProfile ? ` profile:${displayProfile}` : "";
  console.error(
    `[rech] connecting to ${host}:${port} (identity: ${identity.label}${profileSuffix})`,
  );

  const resolvedEnv = await getClientEnv({ extensionId, extensionToken, profileDirectory: effectiveProfile, userDataDir, loadExtension });
  const effectiveEnv = { ...resolvedEnv, ...overrideEnv };
  const { status, stdout, stderr, files, existingSession } = await callServe(url, args, overrideEnv, identity);

  const isOpenWithUrl = args[0] === "open" && args.length > 1;
  if (existingSession && isOpenWithUrl) {
    return run(url, ["goto", ...args.slice(1)], overrideEnv);
  }

  if (existingSession)
    console.error(`[rech] session already has open tabs — listing existing tabs instead of opening a new window`);
  if (stderr) {
    if (stderr.includes('Extension connection timeout')) {
      const hasToken = !!effectiveEnv["PLAYWRIGHT_MCP_EXTENSION_TOKEN"];
      const last = hasToken
        ? `  -x: extension did not connect (reload it at chrome://extensions; then verify its token) -> extension[degraded]`
        : `  -> extension[not installed]  (run: rech setup)`;
      console.error(`[rech] rech-client -> rech-server[ok] -> playwright[ok]\n${last}`);
    }
    if (stderr.includes("Browser '") && stderr.includes("is not open")) {
      console.error(
        `[rech] the session id is derived from this worktree and profile; it is not a persisted stale id. ` +
        `The preceding open did not finish. Retry \`rech open <url>\`; if it reports an extension timeout, ` +
        `reload Playwright MCP Bridge at chrome://extensions and retry.`,
      );
    }
    process.stderr.write(stderr);
  }
  if (stdout) process.stdout.write(stdout);

  if (files?.length) {
    // Saved files belong to the project: <project>/.rechrome/output. The folder also holds
    // .env.local (secrets), so it is git-ignored as a whole when first created.
    const dlDir = join(identity.dataDir, "output");
    mkdirSync(dlDir, { recursive: true });
    const gitignorePath = join(identity.dataDir, ".gitignore");
    if (!existsSync(gitignorePath)) await Bun.write(gitignorePath, "*\n");
    for (const name of files) {
      const fileRes = await fetch(serviceUrl(url, `files/${name}`), {
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

export type SetupPhase = "extension" | "token" | "bridge" | "error" | "save" | "ready";

export function createSetupGuide(extDistDir: string, profileDisplay: string) {
  const route = `/setup/${randomBytes(24).toString("hex")}`;
  let state: { phase: SetupPhase; message: string; statusUrl?: string } = { phase: "extension", message: "Waiting for the extension in this profile…" };
  let manualToken: string | undefined;
  let retry = false;
  let readyDelivered = false;
  let checks = { extension: false, token: false, bridge: false, registration: false };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, maxRequestBodySize: 4096,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
      if (url.host !== `127.0.0.1:${server.port}`) return new Response("Invalid host", { status: 403 });
      if (url.pathname === route && request.method === "GET")
        return new Response(buildSetupHtml(extDistDir, profileDisplay, `${route}/status`), { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
      if (url.pathname !== `${route}/status`) return new Response("Not found", { status: 404 });
      if (request.method === "POST") {
        if (request.headers.get("Origin") !== url.origin) return new Response("Invalid origin", { status: 403 });
        if (Number(request.headers.get("Content-Length")) > 4096) return new Response("Too large", { status: 413 });
        try {
          const body = await request.json() as { token?: string; retry?: boolean };
          if (body.token !== undefined) {
            const value = body.token.replace(/^PLAYWRIGHT_MCP_EXTENSION_TOKEN=/, "").trim();
            if (!/^[A-Za-z0-9_-]{20,256}$/.test(value)) return new Response("Invalid token", { status: 400 });
            manualToken = value;
          }
          if (body.retry || body.token) retry = true;
        } catch { return new Response("Invalid request", { status: 400 }); }
      } else if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      if (state.phase === "ready") readyDelivered = true;
      return Response.json({ ...state, checks }, { headers });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}${route}`,
    update(phase: SetupPhase, message: string) {
      state = { ...state, phase, message };
      if (phase !== "error") {
        const rank = ["extension", "token", "bridge", "save", "ready"].indexOf(phase);
        checks = { extension: rank >= 1, token: rank >= 2, bridge: rank >= 3, registration: rank >= 4 };
      }
    },
    setExtensionId(id: string) {
      if (!/^[a-p]{32}$/.test(id)) throw new Error("Invalid extension ID");
      state.statusUrl = `chrome-extension://${id}/status.html`;
    },
    takeToken() { const value = manualToken; manualToken = undefined; return value; },
    markRegistered() { checks.registration = true; },
    takeRetry() { const value = retry; retry = false; return value; },
    async deliverSuccess() {
      const deadline = Date.now() + 10_000;
      while (!readyDelivered && Date.now() < deadline) await Bun.sleep(100);
      await Bun.sleep(250);
    },
    close() { manualToken = undefined; server.stop(); },
  };
}

export function buildSetupHtml(extDistDir: string, profileDisplay: string, checkUrl?: string): string {
  const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>rechrome — Extension Setup</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #222; line-height: 1.6; }
  h1, a { color: #1a73e8; }
  .step { background: #f8f9fa; border-left: 4px solid #1a73e8; padding: 16px; margin: 16px 0; border-radius: 0 8px 8px 0; }
  .step h2 { margin: 0 0 8px; font-size: 1.2rem; }
  code { background: #e8eaed; padding: 2px 6px; border-radius: 4px; font-size: 0.95em; word-break: break-all; }
  .path { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
  button, .button { display: inline-block; background: #1a73e8; color: white; border: none; padding: 10px 16px; border-radius: 6px; cursor: pointer; font: inherit; text-decoration: none; }
  button:active, .button:active { background: #1558b0; }
  .note { color: #666; font-size: 0.9em; }
  details.step > summary { cursor: pointer; font-size: 1.2rem; font-weight: 600; }
  details.step[data-complete="true"] > summary { color: #28743e; }
  details.step[data-complete="true"] > summary::after { content: " ✓"; }
</style>
</head>
<body>
<h1>rechrome — Extension Setup</h1>
<p>Chrome profile: <strong>${escapeHtml(profileDisplay)}</strong></p>
<p>The previous tab is <strong>Chrome Extensions</strong>. Keep this guide open while you install.</p>
${checkUrl ? '<div class="step"><h2>Connection status</h2><p id="liveStatus" role="status" aria-live="polite">Connecting to setup…</p><ul id="verifiedChecks"><li>○ Extension detected — pending</li><li>○ Token detected — pending</li><li>○ Browser connection verified — pending</li><li>○ Profile registered — pending</li></ul></div>' : ''}

<main id="start">
  <details class="step" data-check="extension" open>
    <summary>Step 1 — Install the extension</summary>
    <p>Copy the extension path:</p>
    <div class="path">
      <code id="extPath">${escapeHtml(extDistDir)}</code>
      <button type="button" id="copyPath">Copy path</button>
    </div>
    <p id="copyStatus" class="note" role="status" aria-live="polite"></p>
    <ol>
      <li>Switch to the <strong>Extensions</strong> tab immediately to the left, or press <strong>Ctrl+Shift+Tab</strong>.</li>
      <li>Enable <strong>Developer mode</strong>, then click <strong>Load unpacked</strong>.</li>
      <li>Paste the path into the folder picker and select the folder. On macOS, press <strong>⌘⇧G</strong>, paste, press <strong>Enter</strong>, then click <strong>Select</strong>. On Windows or Linux, use the location field.</li>
      <li>Return to this guide. Installation is detected automatically.</li>
    </ol>
    <p class="note">If the Extensions tab did not open, type <code>chrome://extensions/</code> into a new tab’s address bar and press Enter.</p>
  </details>

  <details class="step" data-check="bridge" open>
    <summary>Step 2 — Verify the connection</summary>
    <p>Switch back here. Setup watches for the extension and token automatically, then tests the connection.</p>
    ${checkUrl ? `<button type="button" id="revalidate" data-url="${escapeHtml(checkUrl)}">Revalidate installation</button>` : '<p>Run your setup command again in the terminal to revalidate the installation.</p>'}
    <p id="validationStatus" role="status" aria-live="polite"></p>
    <p class="note">After installation is detected, setup continues in the terminal to read the token and verify the browser connection.</p>
    <p><a id="extensionStatusLink" href="chrome-extension://${EXTENSION_ID}/status.html" target="_blank" rel="noopener">Open extension status ↗</a></p>
    <p class="note">If Chrome blocks the link, copy this URL into the address bar of a new tab:</p>
    <div class="path"><code id="extensionStatusUrl">chrome-extension://${EXTENSION_ID}/status.html</code><button type="button" id="copyStatusUrl">Copy status URL</button></div>
    ${checkUrl ? `<details><summary>Token not detected? Paste it manually</summary><p>Open the extension status page above, copy its auth token, and paste it here.</p><input id="manualToken" type="password" autocomplete="off" aria-label="Extension auth token"><button type="button" id="submitToken">Use token</button></details>` : ''}
  </details>

  <details class="step" data-check="registration" open>
    <summary>Step 3 — Finish setup</summary>
    <p>Once the browser connection is verified, return to the terminal and choose where to save your connection URL. You can also skip saving the URL and just register the profile.</p>
    <p>This guide confirms when the profile is registered. You can then close the setup tabs.</p>
  </details>
</main>
<script>
  const checkButton = document.getElementById('revalidate');
  let finished = false;
  async function checkSetup(payload) {
    const status = document.getElementById('validationStatus');
    try {
      const response = await fetch(checkButton.dataset.url, payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {});
      if (response.status === 400) {
        status.textContent = 'That token looks incomplete. Copy the full token from the extension and try again.';
        return;
      }
      if (!response.ok) throw new Error('Check failed');
      const result = await response.json();
      document.getElementById('liveStatus').textContent = result.message;
      const checks = document.getElementById('verifiedChecks');
      checks.replaceChildren(...Object.entries({ extension: 'Extension detected', token: 'Token detected', bridge: 'Browser connection verified', registration: 'Profile registered' }).map(([key, label]) => {
        const item = document.createElement('li');
        item.textContent = (result.checks?.[key] ? '✓ ' : '○ ') + label + (result.checks?.[key] ? ' — verified' : ' — pending');
        return item;
      }));
      for (const step of document.querySelectorAll('details.step[data-check]')) {
        const complete = !!result.checks?.[step.dataset.check];
        // Collapse only on completion, preserving manual expansion on later polls.
        if (complete && step.dataset.complete !== 'true') step.open = false;
        if (!complete && step.dataset.complete === 'true') step.open = true;
        step.dataset.complete = String(complete);
      }
      if (result.statusUrl) {
        document.getElementById('extensionStatusLink').href = result.statusUrl;
        document.getElementById('extensionStatusUrl').textContent = result.statusUrl;
      }
      checkButton.textContent = result.phase === 'error' ? 'Retry connection' : 'Revalidate installation';
      finished = result.phase === 'ready';
      checkButton.disabled = finished;
      status.textContent = finished ? 'Setup complete. You can close these setup tabs.' : '';
    } catch {
      status.textContent = 'Cannot reach the setup process. This page works while rech setup is running, including with piped input. If setup was stopped or finished, run it again and use the new guide tab. Retrying…';
    }
  }
  checkButton?.addEventListener('click', () => checkSetup({ retry: true }));
  document.getElementById('submitToken')?.addEventListener('click', async () => {
    const input = document.getElementById('manualToken');
    const token = input.value;
    input.value = '';
    await checkSetup({ token });
  });
  if (checkButton) {
    const poll = async () => { await checkSetup(); if (!finished) setTimeout(poll, 1000); };
    poll();
  }
  document.getElementById('copyStatusUrl').addEventListener('click', async function () {
    const url = document.getElementById('extensionStatusUrl');
    try {
      await navigator.clipboard.writeText(url.textContent);
      this.textContent = 'Copied!';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(url);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      this.textContent = 'Press ⌘C / Ctrl+C';
    }
  });
  document.getElementById('copyPath').addEventListener('click', async function () {
    const path = document.getElementById('extPath');
    const status = document.getElementById('copyStatus');
    try {
      await navigator.clipboard.writeText(path.textContent);
      this.textContent = 'Copied!';
      status.textContent = 'Path copied. Switch to the Extensions tab.';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(path);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = 'Press ⌘C on Mac or Ctrl+C on Windows/Linux to copy the selected path, then switch to the Extensions tab.';
    }
  });
</script>
</body>
</html>`;
}

const PM_PROCESS_NAME = "rechrome";
// Pre-rename names to evict on (re)install/uninstall so a single `rech setup`
// migrates an existing checkout cleanly.
const LEGACY_PROCESS_NAMES = ["rechrome-serve"];
const IS_WINDOWS = process.platform === "win32";

// Read the installed oxmgr's version (e.g. "0.4.0+winfix"), or null if oxmgr
// isn't on PATH / doesn't answer. Cached — daemonManager() sits on the hot path
// of several subcommands (status, setup, install). Synchronous by design so the
// selection has no await threading through call sites.
let _oxmgrVersion: string | null | undefined;
function oxmgrVersion(bin: string): string | null {
  if (_oxmgrVersion !== undefined) return _oxmgrVersion;
  try {
    const p = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "ignore", windowsHide: true });
    const m = /(\d+\.\d+\.\d+[^\s]*)/.exec(p.stdout?.toString() ?? "");
    _oxmgrVersion = m ? m[1]! : null;
  } catch {
    _oxmgrVersion = null;
  }
  return _oxmgrVersion;
}

// Resolve (and cache) the process manager that daemonizes `rech serve`. The
// selection policy — oxmgr default, pm2 fallback, winfix-guarded on Windows,
// RECH_DAEMON_MANAGER override — lives in ./daemon-manager.ts (pure + tested);
// here we just supply the runtime inputs (what's on PATH, the oxmgr version).
let _daemonMgr: DaemonManager | undefined;
function daemonManager(): DaemonManager {
  if (_daemonMgr) return _daemonMgr;
  const oxmgrBin = Bun.which("oxmgr");
  const pm2Bin = Bun.which("pm2");
  _daemonMgr = pickDaemonManager({
    oxmgrBin,
    pm2Bin,
    oxmgrVersion: oxmgrBin ? oxmgrVersion(oxmgrBin) : null,
    isWindows: IS_WINDOWS,
    override: process.env.RECH_DAEMON_MANAGER,
  });
  return _daemonMgr;
}

// Spawn the resolved process manager by its absolute path (Bun.which). `env` is
// merged over process.env for the child: pm2 captures the CLI's environment for
// the managed process (it has no per-var flag like oxmgr's --env), so install
// passes daemon env this way.
async function runPm(mgr: DaemonManager, args: string[], env?: Record<string, string>): Promise<number> {
  const proc = Bun.spawn([mgr.bin, ...args], {
    stdout: "inherit",
    stderr: "inherit",
    windowsHide: true, // no console-window flash for the manager child on Windows
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  await proc.exited;
  return proc.exitCode ?? 1;
}

// oxmgr boot/login autostart. `service install` wires the platform init
// integration (Windows Task Scheduler, macOS launchd, or a systemd --user unit)
// so the daemon — and the managed serve with it — returns at login/boot, the way
// the pm2 path relied on `pm2 resurrect`. Skipped when already installed:
// re-running `service install` re-bootstraps the oxmgr daemon, which restarts
// every managed process (including the live serve). Best-effort — a failure
// leaves serve crash-managed but not login-persistent.
async function oxmgrEnsureAutostart(mgr: DaemonManager): Promise<void> {
  let alreadyInstalled = false;
  try {
    alreadyInstalled =
      Bun.spawnSync([mgr.bin, "service", "status"], { stdout: "ignore", stderr: "ignore", windowsHide: true }).exitCode === 0;
  } catch { /* treat a probe failure as not-installed and attempt install */ }
  if (alreadyInstalled) return;
  await runPm(mgr, ["service", "install"]);
}

// Capture the process-manager's process list as text (oxmgr `list` / pm2 `jlist`).
// Both render the process name verbatim, so callers can substring-match it.
async function pmList(mgr: DaemonManager = daemonManager()): Promise<string> {
  const proc = Bun.spawn([mgr.bin, mgr.id === "pm2" ? "jlist" : "list"], { stdout: "pipe", stderr: "ignore", windowsHide: true });
  return await new Response(proc.stdout).text();
}

// Resolve which playwright-cli the daemon runs to drive Chrome. Priority:
//   1. PLAYWRIGHT_CLI env override — explicit, already a full command string.
//   2. Vendored fork in a git checkout (lib/playwright-cli/playwright-cli.js) — the patched
//      multi-tab CLI + patched playwright-core (PLAYWRIGHT_MCP_PROFILE_DIRECTORY etc.).
//   3. The fork bundled into the npm tarball (vendor/playwright-cli/playwright-cli.js, produced by
//      scripts/vendor-cli.sh at prepublish). This is the batteries-included default for
//      `bun i -g rechrome`: self-contained, no @playwright/cli dep, no browser-binary download.
//   4. Bare `playwright-cli-multi-tab` on PATH — legacy fallback for a pre-existing global link.
// A resolved .js entry is run through `node` on Windows (which can't exec a .js by shebang) and
// bare on POSIX (its `#!/usr/bin/env node` shebang runs it under node, which the relay handshake
// needs — see daemonInstall). serve splits the result on spaces into argv.
export function resolvePlaywrightCli(): string {
  if (process.env.PLAYWRIGHT_CLI) return process.env.PLAYWRIGHT_CLI;
  const jsEntry = [
    join(import.meta.dir, "lib/playwright-cli/playwright-cli.js"),
    join(import.meta.dir, "vendor/playwright-cli/playwright-cli.js"),
  ].find(existsSync);
  if (jsEntry) return IS_WINDOWS ? `node ${jsEntry}` : jsEntry;
  return "playwright-cli-multi-tab";
}

/**
 * Make sure a daemon process manager is available, offering to install oxmgr
 * (default No; --yes approves). An explicit RECH_DAEMON_MANAGER=pm2 is respected,
 * since installing oxmgr would not satisfy it.
 */
async function ensureDaemonManager(ask: (q: string, def?: string) => Promise<string>, yes = false): Promise<void> {
  try {
    daemonManager();
    return;
  } catch (error) {
    if (process.env.RECH_DAEMON_MANAGER?.toLowerCase() === "pm2") throw error;
  }
  const command = oxmgrInstallCommand(process.env);
  const answer = yes ? "yes" : (await ask(`      oxmgr is missing. Install globally with \`${command.join(" ")}\`? [y/N]: `)).trim();
  if (!/^(y|yes)$/i.test(answer)) {
    throw new Error(`Setup cancelled. To install oxmgr, run \`${command.join(" ")}\`, then rerun setup.`);
  }
  console.log(`      Installing oxmgr: ${command.join(" ")}`);
  const installer = Bun.which(command[0]) ?? (command[0] === "bun" ? process.execPath : null);
  if (!installer) throw new Error(`${command[0]} is not on PATH. Install it or run \`${command.join(" ")}\` in your terminal, then rerun setup.`);
  const proc = Bun.spawn([installer, ...command.slice(1)], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: true,
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`\`${command.join(" ")}\` failed (exit code ${code}). Resolve the installation error, then rerun setup.`);
  if (!Bun.which("oxmgr")) {
    throw new Error("oxmgr was installed but is not on PATH. Add the package manager's global bin directory to PATH, then rerun setup.");
  }
  _daemonMgr = undefined;
  _oxmgrVersion = undefined;
  daemonManager();
}

export async function daemonInstall(serveUrl: string): Promise<void> {
  // Resolve the manager first so a missing dependency fails before config is mutated.
  const mgr = daemonManager();
  // Persist the URL for future clients without an explicit environment override.
  // The daemon's explicit environment takes precedence over this saved default.
  const envRaw = await file(globalEnvFile).text().catch(() => "");
  const filtered = envRaw.trimEnd().split("\n").filter(l => !l.startsWith(`${ENV_KEY}=`));
  await Bun.write(globalEnvFile, [...filtered, `${ENV_KEY}=${serveUrl}`, ""].join("\n"));

  const home = HOME;
  const bunBin = Bun.which("bun") ?? process.execPath;
  const rechScript = import.meta.filename;

  // Resolve PLAYWRIGHT_CLI (see resolvePlaywrightCli). The resolved .js entry MUST run under node,
  // not bun: the cliDaemon inherits its parent's runtime (spawned via process.execPath), and the
  // extension-bridge relay's WebSocket handshake hangs under Bun (the extension WS connects but
  // `extension.initialized` never completes) — under node it completes, matching the POSIX shebang.
  // serve splits PLAYWRIGHT_CLI on spaces into argv, so on Windows we use bare `node` (the node
  // path lives under "Program Files" and contains a space); node must be on the daemon's PATH, same
  // as the shebang's `env node` assumption. The repo / install paths contain no spaces.
  const resolvedPlaywrightCli = resolvePlaywrightCli();

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
  for (const name of [PM_PROCESS_NAME, ...LEGACY_PROCESS_NAMES]) await runPm(mgr, ["delete", name]);

  let startCode: number;
  if (mgr.id === "pm2") {
    // pm2 captures the CLI env (passed via runPm's env) for the managed process,
    // autorestarts by default, and runs the bun binary directly with
    // `--interpreter none` (so it isn't fed to node).
    startCode = await runPm(mgr, [
      "start", bunBin,
      "--name", PM_PROCESS_NAME,
      "--interpreter", "none",
      "--cwd", home,
      "--", rechScript, "serve",
    ], daemonEnv);
    await runPm(mgr, ["save"]); // persist process list for `pm2 resurrect` on reboot
  } else {
    const envArgs = Object.entries(daemonEnv).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
    startCode = await runPm(mgr, [
      "start",
      "--name", PM_PROCESS_NAME,
      "--restart", "always",
      "--cwd", home,
      ...envArgs,
      `${bunBin} ${rechScript} serve`,
    ]);
    // Boot/login persistence: on Windows the winfix oxmgr wires Task Scheduler,
    // on POSIX a systemd --user unit / launchd agent — the equivalent of the pm2
    // path's `pm2 resurrect` at login. Guarded so a re-install doesn't bounce the
    // live daemon.
    await oxmgrEnsureAutostart(mgr);
  }
  // Surface a failed start instead of reporting a daemon that was never registered.
  if (startCode !== 0)
    throw new Error(`${mgr.id} failed to start "${PM_PROCESS_NAME}" (exit ${startCode}). Check that ${mgr.id} is installed and on PATH.`);
}

async function daemonUninstall(): Promise<void> {
  const mgr = daemonManager();
  for (const name of [PM_PROCESS_NAME, ...LEGACY_PROCESS_NAMES]) await runPm(mgr, ["delete", name]);
  if (mgr.id === "pm2") await runPm(mgr, ["save"]);
  else await runPm(mgr, ["service", "uninstall"]);
  console.log(`Removed ${mgr.id} process: ${PM_PROCESS_NAME}`);
}

// ── Native tray (menu-bar / system-tray) icon ───────────────────────────────
// The tray is a small native binary (tray/, Rust). `rech` just supervises it:
// locate the binary and launch it detached (singleton via a pidfile).
// `rech tray hide` / the menu "Hide" item both kill the process;
// `rech tray show` starts a fresh one.
const TRAY_PID_FILE = join(RECH_DIR, "tray.pid");

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

// Verify a PID is actually a rechrome-tray process, not an unrelated process that
// happened to reuse the pid after the real tray died. POSIX only (`ps` isn't on stock
// Windows); there we fall back to trusting the liveness probe alone (best-effort).
function isPidRechromeTray(pid: number): boolean {
  if (IS_WINDOWS) return true;
  try {
    const p = Bun.spawnSync(["ps", "-o", "comm=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore", windowsHide: true });
    return (p.stdout?.toString() ?? "").trim().includes("rechrome-tray");
  } catch {
    return false;
  }
}

// PIDs of live rechrome-tray processes (POSIX). Catches untracked trays — ones launched
// outside `rech tray show` that never touch the pidfile — so a singleton guard can't
// spawn a second icon on top of them. Empty on Windows (no `ps`), where we rely on the
// pidfile liveness check alone.
function listTrayPids(): number[] {
  if (IS_WINDOWS) return [];
  try {
    const p = Bun.spawnSync(["ps", "-axo", "pid=,comm="], { stdout: "pipe", stderr: "ignore", windowsHide: true });
    const out = p.stdout?.toString() ?? "";
    const pids: number[] = [];
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      // macOS reports the full launch path in `comm`, so match the basename via a
      // trailing "/rechrome-tray" or an exact bare name (Linux truncates to the name).
      if (m && Number(m[1]) !== process.pid && m[2].includes("rechrome-tray")) pids.push(Number(m[1]));
    }
    return pids;
  } catch {
    return [];
  }
}

function isTrayRunning(): boolean {
  // Any live tray (tracked by the pidfile or not) means "already running" — the pidfile
  // is a single slot that only ever records the most-recent spawn, so it cannot see
  // earlier/untracked instances on its own.
  if (listTrayPids().length > 0) return true;
  try {
    const pid = parseInt(readFileSync(TRAY_PID_FILE, "utf8"), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0); // signal 0 = liveness probe, doesn't actually signal
    return isPidRechromeTray(pid);
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
  // Kill every live tray (tracked or untracked), then drop the pidfile. A singleton
  // tray should never have more than one instance, but a crashed/overwritten pidfile
  // can leave orphans the single-slot pidfile no longer points at — reap them too.
  const pids = listTrayPids();
  if (pids.length === 0 && !isTrayRunning()) { console.log("tray: not running."); return; }
  for (const pid of pids) { try { process.kill(pid); } catch {} }
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
  const proc = Bun.spawn([chromeBin, ...args], { stdout: "ignore", stderr: "ignore", windowsHide: true });
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
  const userDataDir = join(RECH_DIR, "profiles", name);
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
  const healthy = await fetch(serviceUrl(url, "ping"), {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(2000),
  }).then(r => r.ok).catch(() => false);
  if (!healthy) console.log(`      Note: daemon not reachable at ${host}:${port} — run \`rech setup\` once to start it.`);

  const rechUrl = new URL(serviceUrl(url));
  rechUrl.username = key || randomBytes(12).toString("base64url");
  rechUrl.searchParams.set("extension_id", EXTENSION_ID);
  rechUrl.searchParams.set("token", token);
  rechUrl.searchParams.set("profile", name);
  rechUrl.searchParams.set("user_data_dir", userDataDir);
  rechUrl.searchParams.set("load_extension", dist);


  const newLine = `RECHROME_URL=${registeredProfileUrl(rechUrl.toString())}`;

  // [3/3] Register in the token registry so `rech status` lists it and the daemon can resolve it.
  await saveTokenEntry(name, { extensionId: EXTENSION_ID, token, profileDir: name, userDataDir, loadExtension: dist });
  console.log(`\n[3/3] Registered "${name}" in ${TOKENS_FILE}`);

  console.log(`\nDone! RECHROME_URL for "${name}":\n\n  ${newLine}\n`);
  console.log(`Use it per-call:\n  ${newLine.replace("RECHROME_URL=", "RECHROME_URL='")}' rech open https://example.com\n`);
  console.log(`Or save it to a project .env.local to make it the default.`);
}

async function exposeProfile(profile: string, host: string, port: number, prefix = "/"): Promise<Listener> {
  const config = await readListeners();
  if (!config) throw new Error("Run rech setup once to initialize listeners");
  // Setup selects this profile's exposure, not the daemon's global bind. Remove
  // only this profile from other scoped listeners; retain all other profiles.
  config.listeners = config.listeners.filter(l => {
    if (l.profiles === "*" || (l.host === host && l.port === port)) return true;
    l.profiles = l.profiles.filter(p => p !== profile);
    return l.profiles.length > 0;
  });
  let listener = config.listeners.find(l => l.host === host && l.port === port);
  if (listener && normalizePrefix(listener.prefix) !== prefix) throw new Error("This port already uses a different prefix; choose --port with a separate port");
  if (prefix !== "/" && listener?.profiles === "*") throw new Error("A prefixed proxy requires a separate scoped listener port");
  if (listener) {
    if (listener.profiles !== "*" && !listener.profiles.includes(profile)) listener.profiles.push(profile);
  } else {
    listener = { name: `listen-${randomBytes(4).toString("hex")}`, host, port, prefix, key: randomBytes(24).toString("base64url"), profiles: [profile] };
    config.listeners.push(listener);
  }
  await writeListeners(config);
  return listener;
}

async function requireListeners() {
  const config = await readListeners();
  if (!config) throw new Error("No listener configuration yet. Run rech setup to migrate the daemon.");
  return config;
}

async function listListeners(): Promise<void> {
  for (const l of (await requireListeners()).listeners) console.log(`${l.name}  ${listenerAddress(l)}${normalizePrefix(l.prefix)}  ${l.profiles === "*" ? "local management (all profiles)" : l.profiles.join(", ")}`);
}

async function removeListener(name: string): Promise<void> {
  const config = await requireListeners();
  const listener = config.listeners.find(l => l.name === name);
  if (!listener) throw new Error("Unknown listener");
  if (listener.profiles === "*") throw new Error("Keep the local management listener for setup and recovery");
  config.listeners = config.listeners.filter(l => l !== listener);
  await writeListeners(config);
  console.log("Listener removed from configuration; daemon reloads automatically.");
}

async function resolveProfileKeys(selectors: string[]): Promise<string[]> {
  const registry = await readTokenRegistry(), cache = await readChromeProfileCache();
  const profiles: string[] = [];
  for (const selector of selectors) profiles.push((await resolveGlobalProfile(registry, cache, selector)).email);
  return [...new Set(profiles)];
}

/** Next steps after exposing a listener: proxy it, record where, share. Plain text, so any shell works. */
export function listenerNextSteps(listener: Listener, profile?: string): string[] {
  const prefix = normalizePrefix(listener.prefix);
  const mount = prefix === "/" ? "" : prefix.slice(0, -1);
  return [
    `Expose it through any reverse proxy on port ${listener.port}${mount ? ` (mount ${mount}; stripping it is fine)` : ""}, e.g.:`,
    `  tailscale serve --bg${mount ? ` --set-path=${mount}` : ""} ${listener.port}`,
    `Then record where it is reachable and print the URL to share:`,
    `  rech listener set ${listener.name} --public-url https://<your-host>${prefix}`,
    `  rech url ${profile ? JSON.stringify(profile) : "<profile>"} --listener ${listener.name}`,
  ];
}

async function addListener(name: string, opts: { listen: string; profile: string[]; port?: number; prefix?: string }): Promise<void> {
  const config = await requireListeners();
  const profiles = await resolveProfileKeys(opts.profile);
  const host = chooseListenAddress(await detectListenChoices(), opts.listen);
  const port = opts.port ?? DEFAULT_PORT;
  if (config.listeners.some(l => l.name === name)) throw new Error(`Listener "${name}" already exists; change its profiles with rech listener allow|deny ${name} <profile>`);
  const listener: Listener = { name, host, port, prefix: normalizePrefix(opts.prefix), key: randomBytes(24).toString("base64url"), profiles };
  config.listeners.push(listener);
  await writeListeners(config);
  console.log(`Listener saved for ${host}:${port}; daemon reloads automatically. Credentials are in ~/.rechrome/listeners.json (keep private).`);
  if (isLoopback(host)) for (const line of listenerNextSteps(listener, profiles[0])) console.log(line);
}

function findListener(config: { listeners: Listener[] }, name?: string): Listener {
  if (name) {
    const listener = config.listeners.find(l => l.name === name);
    if (!listener) throw new Error(`Unknown listener "${name}". See rech listener ls.`);
    return listener;
  }
  const scoped = config.listeners.filter(l => l.profiles !== "*");
  if (scoped.length !== 1) throw new Error(`Name a listener: ${config.listeners.map(l => l.name).join(", ")}`);
  return scoped[0];
}

async function listenerPort(name?: string): Promise<void> {
  console.log(findListener(await requireListeners(), name).port);
}

async function allowListener(name: string, selectors: string[]): Promise<void> {
  const config = await requireListeners();
  const added = allowProfiles(config, name, await resolveProfileKeys(selectors));
  await writeListeners(config);
  console.log(added.length ? `Allowed on ${name}: ${added.join(", ")}` : `Already allowed on ${name}; nothing changed.`);
}

async function denyListener(name: string, selectors: string[]): Promise<void> {
  const config = await requireListeners();
  // Accept raw registry keys too, so a profile that no longer resolves can still be removed.
  const keys = [...selectors, ...await resolveProfileKeys(selectors).catch(() => [] as string[])];
  const removed = denyProfiles(config, name, keys);
  await writeListeners(config);
  console.log(removed.length ? `Removed from ${name}: ${removed.join(", ")}` : `Not on ${name}; nothing changed.`);
}

async function rotateKey(name: string): Promise<void> {
  const config = await requireListeners();
  rotateListenerKey(config, name);
  await writeListeners(config);
  console.log(`New key for ${name}; URLs carrying the old key stop working now. Print new ones with: rech url <profile> --listener ${name}`);
}

async function setListener(name: string, opts: { publicUrl?: string; clearPublicUrl?: boolean }): Promise<void> {
  const config = await requireListeners();
  const listener = setPublicUrl(config, name, opts.clearPublicUrl ? null : opts.publicUrl ?? null);
  await writeListeners(config);
  console.log(listener.publicUrl ? `${name} is reachable at ${listener.publicUrl}` : `${name}: public URL cleared`);
}

const hideKey = (url: string) => url.replace(/([#&?]key=)[^&]*/, "$1…");

async function urlList(): Promise<void> {
  const config = await requireListeners();
  const rows = [["LISTENER", "PROFILE", "LOCAL", "PUBLIC"]];
  for (const l of config.listeners) {
    const local = `http://${listenerAddress(l)}${normalizePrefix(l.prefix)}`;
    for (const profile of l.profiles === "*" ? ["(all profiles)"] : l.profiles) rows.push([l.name, profile, local, l.publicUrl ?? "-"]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd());
  console.log(`\nPrint a full URL (contains the secret key): rech url <profile> --listener <name>`);
}

/** Write RECHROME_URL to this project's .rechrome/.env.local (the folder git-ignores itself). */
async function saveProjectUrl(url: string): Promise<string> {
  const { dataDir } = await getClientIdentity();
  mkdirSync(dataDir, { recursive: true });
  const gitignore = join(dataDir, ".gitignore");
  if (!existsSync(gitignore)) await Bun.write(gitignore, "*\n");
  const envPath = join(dataDir, ".env.local");
  const lines = (await file(envPath).text().catch(() => "")).split("\n").filter(l => l.trim() && !l.startsWith(`${ENV_KEY}=`));
  await writeFile(envPath, [...lines, `${ENV_KEY}=${url}`, ""].join("\n"), { mode: 0o600 });
  await chmod(envPath, 0o600);
  return envPath;
}

async function connect(url: string): Promise<void> {
  const parsed = parseUrl(url);
  if (!parsed.key) throw new Error("That URL has no key (#key=…). Ask the host for the full URL from: rech url <profile>");
  const response = await fetch(serviceUrl(url, "ping"), { headers: { Authorization: `Bearer ${parsed.key}` }, signal: AbortSignal.timeout(5000) })
    .catch(error => { throw new Error(`Could not reach ${serviceUrl(url)}: ${error instanceof Error ? error.message : error}`); });
  if (response.status === 401) throw new Error("The daemon rejected this key; ask the host for a fresh URL (keys change on rech listener rotate-key).");
  if (!response.ok) throw new Error(`${serviceUrl(url, "ping")} answered ${response.status}; is the proxy pointing at the listener?`);
  const body = await response.json().catch(() => ({})) as { listener?: string; profiles?: string[] | "*" };
  if (parsed.profileDirectory && Array.isArray(body.profiles) && !body.profiles.includes(parsed.profileDirectory))
    throw new Error(`Connected, but listener "${body.listener}" does not allow profile "${parsed.profileDirectory}".`);
  const saved = await saveProjectUrl(url);
  console.log(`Connected to ${serviceUrl(url)}${body.listener ? ` (listener ${body.listener})` : ""}. Saved RECHROME_URL to ${saved}`);
}

export function detectSetupAgent(env: Record<string, string | undefined> = process.env): "Codex" | "Claude Code" | null {
  // These are hints, not proof of identity or permission to automate the desktop.
  if (env.RECH_SETUP_AGENT === "none") return null;
  if (env.RECH_SETUP_AGENT === "codex") return "Codex";
  if (env.RECH_SETUP_AGENT === "claude") return "Claude Code";
  const enabled = (value: string | undefined) => !!value && !["0", "false"].includes(value.toLowerCase());
  if (enabled(env.CODEX_THREAD_ID) || enabled(env.CODEX_CI) || enabled(env.CODEX_SANDBOX)) return "Codex";
  if (enabled(env.CLAUDECODE) || enabled(env.CLAUDE_CODE_ENTRYPOINT)) return "Claude Code";
  return null;
}

export function setupAgentGuidance(agent: "Codex" | "Claude Code", platform = process.platform): string {
  const skillPath = join(import.meta.dir, "skills", "rechrome-setup", "SKILL.md");
  return [
    `[rech] ${agent} environment detected — setup guidance:`,
    `  Read the setup skill: ${skillPath}`,
    "  Keep this setup process alive while installing; retain and poll its terminal session.",
    "  Piped stdin is supported: supply prompt answers and close stdin so setup can start.",
    "  Use the available Computer Use skill for the selected profile's Load unpacked flow; follow its approval rules.",
    ...(platform === "darwin" ? ["  macOS: in the folder picker, use Command+Shift+G and the extension path shown in the guide."] : []),
    "  If desktop control is unavailable, leave setup running and give the user the exact remaining step.",
    "  Never restart the user's Chrome. Let setup detect the token; do not print credentials.",
    "  Wait for bridge verification and registration before reporting success; preserve the default profile unless asked to change it.",
    "  Agent detection does not grant permissions. Set RECH_SETUP_AGENT=none to hide these hints.",
  ].join("\n");
}

async function setup(opts: SetupOptions = {}): Promise<void> {
  const prefix = normalizePrefix(opts.prefix);
  if (opts.port !== undefined && (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)) throw new Error("--port must be between 1 and 65535");
  const agent = detectSetupAgent();
  if (agent) console.error(setupAgentGuidance(agent));
  if (opts.profile !== undefined) {
    try {
      validateChromeProfileSelector(opts.profile);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      envWatcher?.close();
      process.exit(1);
    }
  }
  const { createInterface } = await import("readline");
  const isTTY = process.stdin.isTTY ?? false;
  let rl: ReturnType<typeof createInterface> | null = null;
  let stdinQueue: string[] | null = null;
  if (isTTY) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("SIGINT", () => { rl?.close(); envWatcher?.close(); process.exit(130); });
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

  // [1/5] Daemon
  console.log("\n○ [1/5] Detecting networks and configuring the daemon...");
  const listenChoices = await detectListenChoices();

  // Defer persistence until daemon prerequisites have passed; daemonInstall saves the URL.
  const currentUrl = await getOrCreateUrl(false);
  const previous = parseUrl(currentUrl);
  let config = await readListeners();
  if (!config) {
    const previousHost = process.env.RECH_HOST || "127.0.0.1";
    const local: Listener = { name: "local", host: "127.0.0.1", port: previous.port, key: previous.key, profiles: "*" };
    config = { version: 1, listeners: [local] };
    const registered = Object.keys(await readTokenRegistry());
    if (!isLoopback(previousHost) && registered.length && previousHost !== "0.0.0.0" && previousHost !== "::") {
      config.listeners.push({ name: "existing-remote", host: previousHost, port: previous.port, key: randomBytes(24).toString("base64url"), profiles: registered });
      console.log("      Existing remote exposure retained for registered profiles with a new scoped listener key.");
    }
    await writeListeners(config);
  }
  const management = config.listeners.find(l => l.profiles === "*" && isLoopback(l.host));
  if (!management) throw new Error("Setup requires a loopback management listener in ~/.rechrome/listeners.json");
  const scheme = previous.protocol;
  let url = `${scheme}://${management.key}@${listenerAddress(management)}${normalizePrefix(management.prefix)}`;
  const { host, port, protocol, key: serveKey } = parseUrl(url);
  let desiredBind = management.host;
  if (opts.listen) desiredBind = chooseListenAddress(listenChoices, opts.listen);
  else if (isTTY) {
    console.log("\n      Where should this profile be accessible? (Other profiles keep their listeners.)");
    listenChoices.forEach((choice, index) => console.log(`        ${index + 1}. ${choice.label} — ${choice.address}`));
    while (true) {
      const answer = (await ask("      Choice [1]: ", "1")).trim();
      const choice = /^\d+$/.test(answer) ? listenChoices[Number(answer) - 1] : undefined;
      if (choice) { desiredBind = choice.address; break; }
      console.log("      Enter one of the numbers shown above.");
    }
  }
  const pingManagement = () => fetch(serviceUrl(url, "ping"), {
    headers: { Authorization: `Bearer ${serveKey}` }, signal: AbortSignal.timeout(2000),
  }).then(async r => r.ok && (await r.json()).multiListener === true).catch(() => false);
  if (!await pingManagement()) {
    // A one-time source upgrade restarts only the daemon, never Chrome. Subsequent
    // listener changes are reloaded in place by the running daemon.
    try {
      await ensureDaemonManager(ask, opts.yes);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      rl?.close();
      envWatcher?.close();
      process.exit(1);
    }
    process.env.RECH_HOST = management.host;
    await daemonInstall(url);
    let ready = false;
    for (let i = 0; i < 15; i++) {
      await Bun.sleep(1000);
      if (await pingManagement()) { ready = true; break; }
    }
    if (!ready) throw new Error("Local management listener did not start; inspect rech status and daemon logs");
  }
  console.log(`✓ [1/5] Local management daemon verified; requested profile access: ${desiredBind}`);

  const cache = await readChromeProfileCache();
  if (!cache) { console.error("      Chrome profiles not found"); rl?.close(); process.exit(1); }
  const userDataDir = await findChromeUserDataDir();

  async function pickProfile(exclude: Set<string>): Promise<[string, ChromeProfileInfo] | null> {
    const available = Object.entries(cache!).filter(([dir]) => !exclude.has(dir));
    if (!available.length) return null;
    available.forEach(([dir, info], i) =>
      console.log(`        ${String(i + 1).padStart(2)}.  ${(info.user_name || "(no email)").padEnd(32)}  ${(info.name || "").padEnd(20)}  [${dir}]`)
    );
    if (opts.profile !== undefined) {
      let match: [string, ChromeProfileInfo] | null;
      try {
        match = resolveChromeProfileSelector(available, opts.profile);
      } catch (error) {
        console.error(`      ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
      if (match) console.log(`      selected: ${match[1].user_name || "(no email)"} [${match[0]}]`);
      return match;
    }
    if (available.length === 1) {
      console.log(`      Only one profile available — selecting: ${available[0][1].user_name || available[0][0]}`);
      return available[0];
    }
    if (!isTTY) console.log("      [agent] Provide profile number on next stdin line, or rerun with --profile <email|name|folder>");
    const answer = await ask("\n      Profile number: ");
    const idx = parseInt(answer.trim()) - 1;
    if (isNaN(idx) || idx < 0 || idx >= available.length) return null;
    return available[idx];
  }

  let guide: ReturnType<typeof createSetupGuide> | undefined;
  async function getExtAndToken(profileDir: string, profileDisplay: string, _profileKey: string, providedToken?: string): Promise<{ extId: string; token: string } | null> {
    await ensureExtensionDistInstalled();
    guide?.close();
    guide = createSetupGuide(EXTENSION_DIST_DIR, profileDisplay);
    console.log(`      Live setup guide: ${guide.url}`);
    if (!await openSetupGuide(profileDir, guide.url))
      console.log("      Open chrome://extensions/ in the selected profile if the tab did not open.");
    const deadline = Date.now() + 15 * 60_000;
    let statusOpenedFor: string | undefined;
    let terminalToken: string | undefined;
    let manualPromptStarted = false;
    const promptAbort = new AbortController();
    try {
      while (Date.now() < deadline) {
        const found = await findInstalledExtension(profileDir);
        if (!found) {
          guide.update("extension", "Waiting for the extension. Load it in the previous tab; this page updates automatically.");
          await Bun.sleep(1000);
          continue;
        }
        const extId = found.id;
        guide.setExtensionId(extId);
        const manual = guide.takeToken() || terminalToken || providedToken;
        const candidate = manual?.replace(/^PLAYWRIGHT_MCP_EXTENSION_TOKEN=/, "").trim();
        const automatic = userDataDir ? readExtensionTokenFromProfile(userDataDir, profileDir, extId) : null;
        const token = candidate && /^[A-Za-z0-9_-]{20,256}$/.test(candidate) ? candidate : automatic;
        if (token) {
          guide.update("bridge", "Extension and token detected. Testing the browser connection…");
          console.log(`      Extension ${extId} and auth token detected${candidate ? " (provided token)" : " automatically"}`);
          return { extId, token };
        }
        guide.update("token", "Extension installed. Waiting for its auth token. Open the extension status page using the link below to initialize it, or paste a token manually.");
        if (statusOpenedFor !== extId) {
          statusOpenedFor = extId;
          openInChromeProfile(profileDir, `chrome-extension://${extId}/status.html`);
          console.log("      Watching for the token automatically. You can also paste it in the live guide.");
        }
        if (rl && !manualPromptStarted) {
          manualPromptStarted = true;
          rl.question("      Optional fallback — paste token here (automatic detection continues): ", { signal: promptAbort.signal }, answer => { terminalToken = answer.trim(); });
        }
        await Bun.sleep(1000);
      }
      guide.update("error", "Setup timed out after 15 minutes. Run setup again to resume.");
      console.error("      Extension/token detection timed out; run setup again to resume.");
      return null;
    } finally {
      promptAbort.abort();
    }
  }

  // [2/5] Primary profile
  console.log("\n○ [2/5] Select Chrome profile:");
  const picked = await pickProfile(new Set());
  if (!picked) { console.error("      Invalid selection"); rl?.close(); process.exit(1); }
  const [profileDir, profileInfoSel] = picked;
  const profileDisplay = profileInfoSel.user_name || profileInfoSel.name || profileDir;
  console.log(`✓ [2/5] Profile resolved: ${profileDisplay} [${profileDir}]`);

  // [3/5] Extension + token for primary profile
  console.log("\n○ [3/5] Checking extension...");
  const profileEmail = profileInfoSel.user_name || profileDir;
  const primary = await getExtAndToken(profileDir, profileDisplay, profileEmail, opts.token);
  if (!primary) { await Bun.sleep(1500); guide?.close(); rl?.close(); process.exit(1); }
  const { extId } = primary;
  let token = primary.token;
  console.log("✓ [3/5] Extension and token detected");

  // Build RECHROME_URL, verify the selected profile can complete a real extension
  // handshake, then show it before asking where to save.
  const rechUrl = editableConnectionUrl(url);
  if (!rechUrl.username) rechUrl.username = randomBytes(12).toString("base64url");
  rechUrl.searchParams.set("extension_id", extId);
  rechUrl.searchParams.set("token", token);
  rechUrl.searchParams.set("profile", profileEmail);
  if (userDataDir) rechUrl.searchParams.set("user_data_dir", userDataDir);

  console.log(`\n○ [4/5] Verifying extension bridge for ${profileDisplay}...`);
  const probeSession = `s${randomBytes(3).toString("hex")}`;
  const probeIdentity = await getClientIdentity();
  probeIdentity.profile = profileEmail;
  const probeEnv: Record<string, string> = {
    PLAYWRIGHT_MCP_EXTENSION_ID: extId,
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: token,
    PLAYWRIGHT_MCP_PROFILE_DIRECTORY: profileEmail,
    ...(userDataDir ? { PLAYWRIGHT_MCP_USER_DATA_DIR: userDataDir } : {}),
  };
  let bridgeVerified = false;
  let bridgeError = "";
  const bridgeDeadline = Date.now() + 15 * 60_000;
  do {
    guide?.takeRetry();
    guide?.update("bridge", "Extension and token detected. Testing the browser connection…");
    try {
      const probe = await callServe(
        rechUrl.toString(),
        [`-s=${probeSession}`, "open", "about:blank", "--wait", "none"],
        probeEnv,
        probeIdentity,
        true,
      );
      bridgeVerified = probe.status === 0;
      if (bridgeVerified) {
        console.log("✓ [4/5] Extension bridge connected successfully");
      } else {
        const diagnostic = probe.stderr.trim() || probe.stdout.trim() || `bridge probe exited ${probe.status}`;
        bridgeError = diagnostic;
        console.error(`      Extension bridge verification failed: ${diagnostic}`);
      }
    } catch (error) {
      bridgeError = error instanceof Error ? error.message : String(error);
      console.error(`      Extension bridge verification failed: ${bridgeError}`);
    } finally {
      // The isolated probe must never claim or close an existing worktree session.
      await callServe(rechUrl.toString(), [`-s=${probeSession}`, "close"], probeEnv, probeIdentity, true).catch(() => {});
    }

    if (bridgeVerified) break;
    const safeError = bridgeError.replaceAll(token, "[redacted]").replaceAll(serveKey, "[redacted]").slice(0, 700);
    guide?.update("error", `Connection failed: ${safeError}. Check the daemon and reload the extension if needed, then click Retry connection. A replacement token can also be pasted below.`);
    while (Date.now() < bridgeDeadline && !guide?.takeRetry()) await Bun.sleep(500);
    const replacement = guide?.takeToken() || (userDataDir ? readExtensionTokenFromProfile(userDataDir, profileDir, extId) : null);
    if (replacement) {
      token = replacement;
      rechUrl.searchParams.set("token", token);
      probeEnv.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token;
    }
  } while (Date.now() < bridgeDeadline);
  if (!bridgeVerified) {
    guide?.update("error", "Connection check timed out. Run setup again after reloading the extension.");
    await Bun.sleep(1500);
    guide?.close();
    rl?.close();
    envWatcher?.close();
    process.exitCode = 1;
    return;
  }
  guide?.update("save", "Browser connection verified! Finish the configuration prompts in the terminal.");
  await saveTokenEntry(profileEmail, { extensionId: extId, token, profileDir, userDataDir: userDataDir ?? undefined });
  const existingPrefix = prefix !== "/" ? (await readListeners())?.listeners.find(l => l.host === desiredBind && l.profiles !== "*" && normalizePrefix(l.prefix) === prefix) : undefined;
  const exposurePort = opts.port ?? existingPrefix?.port ?? (prefix !== "/" ? port + 1 : port);
  const exposure = await exposeProfile(profileEmail, desiredBind, exposurePort, prefix);
  const tailscaleChoice = listenChoices.find(c => c.kind === "tailscale")?.address;
  rechUrl.hostname = exposure.host;
  rechUrl.port = String(exposure.port);
  rechUrl.username = exposure.key;
  rechUrl.pathname = prefix;
  // Ensure the newly bound listener is live before offering its connection URL.
  let exposed = false;
  for (let i = 0; i < 20; i++) {
    const response = await fetch(serviceUrl(rechUrl.toString(), "ping"), { headers: { Authorization: `Bearer ${exposure.key}` }, signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (response?.ok) { exposed = true; break; }
    await Bun.sleep(250);
  }
  if (!exposed) throw new Error("Profile registered, but its listener did not become reachable. Check for an occupied port or an unavailable interface.");
  if (prefix !== "/" && exposure.host === "127.0.0.1") {
    // Detect only; never change the Serve config without the user running the command themselves.
    const serve = await detectTailscaleServe(exposure.port, prefix);
    if (serve.routeUrl) {
      console.log(`      Tailscale Serve route found: ${serve.routeUrl} → ${protocol}://${listenerAddress(exposure)}${prefix.slice(0, -1)}`);
      console.log(`      Remote RECHROME_URL (secret; for other tailnet machines):\n        ${rebaseConnectionUrl(serve.routeUrl, rechUrl.toString())}`);
    } else {
      console.log(`      Tailscale Serve command (run separately): tailscale serve --bg --https=443 --set-path=${prefix.slice(0, -1)} ${protocol}://${listenerAddress(exposure)}${prefix.slice(0, -1)}`);
      if (serve.dnsName) console.log(`      Then remote clients can use:\n        ${rebaseConnectionUrl(`https://${serve.dnsName}${prefix}`, rechUrl.toString())}`);
      else console.log(`      For remote clients, use https://<your-machine-tailnet-name>${prefix} with this listener's bearer key and profile query.`);
    }
    console.log(`      The URL saved below is the local loopback one.`);
  } else if (tailscaleChoice && exposure.host === tailscaleChoice) {
    console.log(`      This binds the raw Tailscale IP over plain HTTP. For an HTTPS tailnet URL instead, run:`);
    console.log(`        rech setup --profile ${JSON.stringify(profileEmail)} --listen local --prefix=rechrome`);
    console.log(`      then expose it with tailscale serve (setup prints the command and the remote URL).`);
  }
  const newLine = `RECHROME_URL=${registeredProfileUrl(rechUrl.toString())}`;

  console.log("\n○ [5/5] Connection verified. Save connection configuration:");
  console.log(`\n${newLine}\n`);
  if (!isTTY) console.log(`  [agent] Provide save destination on next stdin line: 1=cwd, 2=cwd rechrome-only, 3=home, 4=skip\n`);

  const pwdEnvPath = join(process.cwd(), ".env.local");
  const pwdRechPath = join(process.cwd(), ".rechrome", ".env.local");
  const homeEnvPath = join(HOME, ".env.local");
  // Show whether each target already exists so it's clear we'll update (merge) vs create.
  const tag = async (p: string) => (await file(p).exists()) ? "exists → will update" : "new file";
  const [pwdTag, pwdRechTag, homeTag] = await Promise.all([tag(pwdEnvPath), tag(pwdRechPath), tag(homeEnvPath)]);
  const saveChoice = (await ask(
    `Save to:\n  1. ${pwdEnvPath} (current dir) [${pwdTag}] [default]\n  2. ${pwdRechPath} (current dir, rechrome-only) [${pwdRechTag}]\n  3. ${homeEnvPath} (user home) [${homeTag}]\n  4. Skip saving URL (register profile only)\n\n  Choice [1]: `
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

  console.log("✓ [5/5] Profile registration saved");
  guide?.update("ready", "Success — extension installed, token detected, browser connected, and profile registered.");
  await guide?.deliverSuccess();
  guide?.close();

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
    if (!result) { guide?.close(); console.log("      Skipped."); continue; }
    await saveTokenEntry(extraEmail, { extensionId: result.extId, token: result.token, profileDir: extraDir, userDataDir: userDataDir ?? undefined });
    configured.add(extraDir);
    guide?.update("bridge", "Token registered. Run setup for this profile to verify its browser connection.");
    guide?.markRegistered();
    await Bun.sleep(1500);
    guide?.close();
    console.log(`      Saved token for ${extraDisplay}`);
  }
  rl?.close();
  envWatcher?.close();
  if (bridgeVerified)
    console.log(`\nDone! Test with:\n  rech open github.com/snomiao`);
  else
    console.error(`\nSetup was saved, but the selected profile did not pass the bridge check. Reload the extension at chrome://extensions and run \`rech setup --profile ${profileEmail}\` again.`);
}

async function status(): Promise<void> {
  const url = process.env[ENV_KEY];
  if (!url) {
    console.log(`serve:    not configured (run \`rech setup\`)`);
    return;
  }
  const parsed = parseUrl(url);
  const ping = await fetch(serviceUrl(url), { signal: AbortSignal.timeout(2000) }).catch(() => null);
  // Resolve the daemon's actual bind from its authenticated /ping (cross-platform; lsof is
  // POSIX-only and absent on Windows). bind is "0.0.0.0" (all interfaces) or the loopback IP.
  const pingBody = ping
    ? await fetch(serviceUrl(url, "ping"), {
        headers: { Authorization: `Bearer ${parsed.key}` },
        signal: AbortSignal.timeout(2000),
      }).then(r => (r.ok ? r.json() : null)).catch(() => null) as { bind?: string; listener?: string; degraded?: boolean; consecutiveTimeouts?: number } | null
    : null;
  // Show the URL this client connects to; through a proxy, the daemon's bind is on another port.
  const details = [pingBody?.listener && `listener ${pingBody.listener}`, pingBody?.bind && `bind ${pingBody.bind}`].filter(Boolean).join(", ");
  console.log(`serve:    ${ping ? `running  ${serviceUrl(url)}${details ? `  (${details})` : ""}` : "not running"}`);
  // daemonManager().id — there is no PM_BIN constant. Referencing one threw a
  // ReferenceError that took down the whole of `rech status`, so the one command
  // that reports "the relay is wedged" died exactly when the relay was wedged,
  // printing a stack trace instead of the restart hint.
  if (pingBody?.degraded)
    console.log(`relay:    ⚠ degraded (${pingBody.consecutiveTimeouts} consecutive command timeouts) — if it persists, the daemon self-restarts; force it now with \`${daemonManager().id} restart ${PM_PROCESS_NAME}\``);
  const pmOut = await pmList();
  const daemonRegistered = pmOut.includes(PM_PROCESS_NAME);
  console.log(`daemon:   ${daemonRegistered ? `${daemonManager().id} (${PM_PROCESS_NAME})` : "not installed"}`);
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
  rech [--profile <email|name|folder>] <playwright-args...>
                               Run Playwright CLI command with the given registered
                               Chrome profile. --profile selects the profile by exact
                               registered email (e.g. you@gmail.com), exact Chrome
                               profile name, or exact profile folder name. The profile
                               must already be registered (see \`rech setup\`). Place
                               --profile before the playwright subcommand. Requires
                               ${ENV_KEY}.
  rech setup [--listen <local|lan|tailscale|IP>] [--profile <email|name|folder>] [--token <tok>] [--prefix <path>] [--port <port>] [--yes]
                               First-time setup: daemon + Chrome extension + config
                               --prefix=rechrome mounts at /rechrome/ on a scoped listener.
                               Prefixed setup defaults to the management port + 1; override with --port.
                               Offers to install missing oxmgr globally (y/N).
                               --yes approves installation without prompting.
                               --profile selects the Chrome profile non-interactively.
                               Menu numbers are not accepted. Resolution order is exact
                               email (e.g. you@gmail.com), exact Chrome profile name,
                               then exact profile folder name (e.g. "Profile 1"). See
                               available values with \`rech profile\`.
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
  rech listener [ls|add|remove]  Manage daemon listener addresses and allowed profiles
  rech listener allow|deny <name> <profile...>
                               Add or remove profiles on an existing listener
  rech listener port [name]    Print a listener's port, for a reverse-proxy command
  rech listener set <name> --public-url <url>
                               Record where a proxy exposes the listener (rech url uses it)
  rech listener rotate-key <name>
                               New key for a listener; URLs with the old key stop working
  rech profile [ls|list]
                               List Chrome + managed test profiles and connection status
  rech url [profile] [--listener <name>] [--local] [--save]
                               Print a connection URL (includes the secret key): the public
                               URL when one is set, else the listener address. --save also
                               writes it to this project's .rechrome/.env.local.
                               \`rech profile [name] --print-uri\` is an alias.
  rech url ls                  List every listener × profile URL (keys hidden)
  rech connect <url>           Check a shared URL answers, then save it for this project
  rech <playwright-args...>    Run Playwright CLI command (requires ${ENV_KEY})
  rech --isolate <args...>     Run in a throwaway session (sugar for -s=<random>) so a
                               fragile single-shot flow (OAuth/login) never shares tabs
                               with the worktree's default session

Environment:
  ${ENV_KEY}   Server URL set by \`rech setup\`
  RECH_TOKEN     Auth token for \`rech setup\` (same as --token)
  RECH_IDENTITY  Session bucket mode: worktree (default) | branch | cwd. The session a
                 client reuses is keyed on the worktree root path; \`branch\` restores the
                 old <remote>/tree/<branch> keying, \`cwd\` keys on the exact directory
  RECH_SETUP_AGENT  Setup hints: codex | claude | none (otherwise auto-detected)

Examples:
  rech setup
  rech setup --profile you@gmail.com --token <PLAYWRIGHT_MCP_EXTENSION_TOKEN>
  rech --profile you@gmail.com open https://example.com
  rech eval "() => document.title"
  rech open https://example.com
  rech screenshot`);
}

export type SetupOptions = { profile?: string; token?: string; listen?: string; prefix?: string; port?: number; yes?: boolean };
export type RechHandlers = {
  serve(): Promise<void> | void;
  status(): Promise<void>;
  listListeners(): Promise<void>;
  addListener(name: string, opts: { listen: string; profile: string[]; port?: number; prefix?: string }): Promise<void>;
  removeListener(name: string): Promise<void>;
  listProfiles(): Promise<void>;
  printProfileUri(selector?: string, listener?: string, opts?: { local?: boolean; save?: boolean }): Promise<void>;
  urlList(): Promise<void>;
  connect(url: string): Promise<void>;
  listenerPort(name?: string): Promise<void>;
  allowListener(name: string, profiles: string[]): Promise<void>;
  denyListener(name: string, profiles: string[]): Promise<void>;
  rotateKey(name: string): Promise<void>;
  setListener(name: string, opts: { publicUrl?: string; clearPublicUrl?: boolean }): Promise<void>;
  setup(opts: SetupOptions): Promise<void>;
  tray(action?: string): Promise<void>;
  provisionProfile(name: string, opts: { headed: boolean; experimental: boolean }): Promise<void>;
  uninstall(): Promise<void>;
};

/** Commands rech handles itself; anything else is forwarded verbatim to playwright-cli. */
export const RECH_COMMANDS = new Set(["serve", "status", "listener", "listeners", "profile", "profiles", "url", "urls", "connect", "setup", "tray", "provision-profile", "uninstall"]);

const portOption = { type: "number", requiresArg: true, describe: "Listener port (1-65535)" } as const;

export function rechCli(argv: string[], handlers: RechHandlers) {
  return yargs(argv)
    .scriptName("rech")
    .parserConfiguration({ "parse-numbers": false, "parse-positional-numbers": false })
    .command("serve", "Run the rechrome daemon in the foreground", {}, () => handlers.serve())
    .command("status", "Show daemon, relay and profile connection status", {}, () => handlers.status())
    .command(["listener", "listeners"], "Manage network listeners", y => y
      .command(["ls", "list", "$0"], "List listeners (credentials hidden)", {}, () => handlers.listListeners())
      .command("add <name>", "Expose registered profiles on a network", y => y
        .positional("name", { type: "string", demandOption: true })
        .option("listen", { type: "string", requiresArg: true, demandOption: true, describe: "local | lan | tailscale | <detected IP>" })
        .option("profile", { type: "string", array: true, requiresArg: true, demandOption: true, describe: "Allowed profile; repeat for several" })
        .option("port", portOption)
        .option("prefix", { type: "string", requiresArg: true, describe: "URL path prefix, e.g. rechrome" }),
        a => handlers.addListener(a.name, { listen: a.listen, profile: a.profile, port: a.port, prefix: a.prefix }))
      .command("remove <name>", "Remove a listener", y => y.positional("name", { type: "string", demandOption: true }),
        a => handlers.removeListener(a.name))
      .command("port [name]", "Print a listener's port (for a proxy command)", y => y.positional("name", { type: "string" }),
        a => handlers.listenerPort(a.name))
      .command("allow <name> <profiles..>", "Allow more profiles on a listener", y => y
        .positional("name", { type: "string", demandOption: true }).positional("profiles", { type: "string", array: true, demandOption: true }),
        a => handlers.allowListener(a.name, a.profiles))
      .command("deny <name> <profiles..>", "Remove profiles from a listener", y => y
        .positional("name", { type: "string", demandOption: true }).positional("profiles", { type: "string", array: true, demandOption: true }),
        a => handlers.denyListener(a.name, a.profiles))
      .command("rotate-key <name>", "Give a listener a new key (old URLs stop working)", y => y.positional("name", { type: "string", demandOption: true }),
        a => handlers.rotateKey(a.name))
      .command("set <name>", "Record where a reverse proxy exposes a listener", y => y
        .positional("name", { type: "string", demandOption: true })
        .option("public-url", { type: "string", requiresArg: true, describe: "e.g. https://host.example.ts.net/rechrome/" })
        .option("clear-public-url", { type: "boolean", conflicts: "public-url" })
        .check(a => a.publicUrl !== undefined || a.clearPublicUrl ? true : "Pass --public-url <url> or --clear-public-url"),
        a => handlers.setListener(a.name, { publicUrl: a.publicUrl, clearPublicUrl: a.clearPublicUrl }))
      .demandCommand(1).strict())
    .command(["url [profile]", "urls [profile]"], "Print a profile's connection URL (contains a secret key); `url ls` lists them", y => y
      .positional("profile", { type: "string", describe: "Profile (email, name or folder); ls/list lists all listeners' URLs" })
      .option("listener", { type: "string", requiresArg: true, describe: "Listener to build the URL for" })
      .option("local", { type: "boolean", describe: "Print the direct listener address even when a public URL is set" })
      .option("save", { type: "boolean", describe: "Also save it as RECHROME_URL in this project's .rechrome/.env.local" }),
      a => ["ls", "list"].includes(a.profile ?? "") && !a.listener && !a.save
        ? handlers.urlList()
        : handlers.printProfileUri(a.profile, a.listener, { local: a.local, save: a.save }))
    .command("connect <url>", "Check a shared connection URL and save it for this project", y => y
      .positional("url", { type: "string", demandOption: true }),
      a => handlers.connect(a.url))
    .command(["profile [name]", "profiles [name]"], "List profiles, or print a profile's connection URI", y => y
      .positional("name", { type: "string", describe: "Profile (email, name or folder); ls/list lists all" })
      .option("print-uri", { type: "boolean", describe: "Print the profile's connection URI (contains a secret key)" })
      .option("listener", { type: "string", requiresArg: true, implies: "print-uri", describe: "Listener to build the URI for" }),
      a => {
        if (a.printUri) return handlers.printProfileUri(a.name, a.listener); // alias of `rech url`
        if (a.name === undefined || ["ls", "list"].includes(a.name)) return handlers.listProfiles();
        throw new Error("Usage: rech profile [ls|list] | rech profile [name] --print-uri. Create, rename, and delete are not implemented.");
      })
    .command("setup", "Install the daemon and connect a Chrome profile", y => y
      .option("profile", { type: "string", requiresArg: true, describe: "Chrome profile: email, name or folder" })
      .option("token", { type: "string", requiresArg: true, describe: "Extension token (default: read from the profile, or RECH_TOKEN)" })
      .option("listen", { type: "string", requiresArg: true, describe: "local | lan | tailscale | <detected IP>" })
      .option("prefix", { type: "string", requiresArg: true, describe: "URL path prefix for a scoped listener, e.g. rechrome" })
      .option("port", portOption)
      .option("yes", { alias: "y", type: "boolean", default: false, describe: "Approve installing a missing oxmgr without prompting" }),
      a => handlers.setup({ profile: a.profile, token: a.token ?? process.env.RECH_TOKEN, listen: a.listen, prefix: a.prefix, port: a.port, yes: a.yes }))
    .command("tray [action]", "Show or hide the tray icon", y => y
      .positional("action", { type: "string", choices: ["show", "start", "hide", "stop", "quit"] }),
      a => handlers.tray(a.action))
    .command("provision-profile <name>", "Create a managed Chrome-for-Testing profile (experimental)", y => y
      .positional("name", { type: "string", demandOption: true })
      .option("experimental", { type: "boolean", default: false })
      .option("headed", { type: "boolean", default: false }),
      a => handlers.provisionProfile(a.name, { headed: a.headed, experimental: a.experimental }))
    .command("uninstall", "Stop and remove the rechrome daemon", {}, () => handlers.uninstall())
    .demandCommand(1)
    .strict()
    .help()
    .version(false)
    .fail((message, error) => { throw error ?? new Error(message); });
}

if (import.meta.main) {
  let args = process.argv.slice(2);
  const cmd = args[0]?.toLowerCase();

  if (cmd && RECH_COMMANDS.has(cmd)) {
    const handlers: RechHandlers = {
      serve: async () => { const { serve } = await import("./serve.ts"); serve(); }, // long-lived; watcher intentionally kept alive
      status,
      listListeners, addListener, removeListener, listProfiles, printProfileUri,
      urlList, connect, listenerPort, allowListener, denyListener, rotateKey, setListener,
      setup: async (opts) => {
        await setup(opts); // setup closes envWatcher itself before printing Done
        // Auto-start the tray (best-effort, silent on headless / missing binary).
        await startTray({ quiet: true }).catch(() => {});
      },
      tray: trayCommand,
      provisionProfile: async (name, { headed, experimental }) => {
        // Experimental: a managed profile runs on Chrome for Testing, not the user's real Google Chrome
        // (branded Chrome 149+ rejects --load-extension). It's a clean browser with no logins/cookies,
        // so it's gated behind --experimental rather than offered as the default setup path.
        if (!experimental) throw new Error([
          `provision-profile is experimental and creates a Chrome-for-Testing profile (not your`,
          `real Chrome): branded Google Chrome 149+ rejects --load-extension, so a managed profile`,
          `can't reuse your logged-in Chrome. For your real Chrome use:  rech setup --profile <email|name|folder>`,
          `To proceed anyway, re-run with --experimental.`,
        ].join("\n"));
        await provisionProfile(name, { headed });
      },
      uninstall: daemonUninstall,
    };
    try {
      await rechCli([cmd, ...args.slice(1)], handlers).parseAsync();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      if (cmd !== "serve") envWatcher?.close();
    }
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
    // --profile: target a registered Chrome profile globally (see extractGlobalProfileArg for
    // the leading-flags-only rule that protects the forwarded CLI's own --profile).
    let profileSelector: string | undefined;
    let overrideEnv: Record<string, string> | undefined;
    try {
      const extracted = extractGlobalProfileArg(args);
      profileSelector = extracted.selector;
      args = extracted.args;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      envWatcher?.close();
      process.exit(1);
    }
    if (profileSelector !== undefined) {
      try {
        const registry = await readTokenRegistry();
        const cache = await readChromeProfileCache();
        const resolved = await resolveGlobalProfile(registry, cache, profileSelector);
        // Use the registry key (email, or the managed profile name) as the profile identity:
        // the daemon already resolves email/name → profile dir for the default URL-param path,
        // so this keeps `--profile <email>` on the SAME session as the default path and only
        // opens a separate session when the profile really differs.
        overrideEnv = {
          PLAYWRIGHT_MCP_PROFILE_DIRECTORY: resolved.email,
          PLAYWRIGHT_MCP_EXTENSION_ID: resolved.entry.extensionId,
        };
        if (resolved.entry.userDataDir) overrideEnv.PLAYWRIGHT_MCP_USER_DATA_DIR = resolved.entry.userDataDir;
        if (resolved.entry.loadExtension) overrideEnv.PLAYWRIGHT_MCP_LOAD_EXTENSION = resolved.entry.loadExtension;
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        envWatcher?.close();
        process.exit(1);
      }
    }
    // --isolate: ephemeral session isolation, sugar for -s=iso-<random>. For fragile single-shot
    // flows (OAuth/login) that must not share tabs with the worktree's default session. The `iso-`
    // marker lets the daemon reap these throwaway sessions on an idle TTL (see serve.ts), so an
    // OAuth drive can't leak an orphaned browser context.
    const isolateIdx = args.findIndex((a) => a === "--isolate" || a === "--isolated");
    if (isolateIdx !== -1) {
      args.splice(isolateIdx, 1);
      args.push(`-s=iso-${randomBytes(8).toString("hex")}`);
    }
    await run(url, args, overrideEnv);
    envWatcher?.close();
  }
}
