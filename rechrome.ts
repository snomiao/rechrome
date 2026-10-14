#!/usr/bin/env bun
import { readListeners, writeListeners, listenerAddress, isLoopback, normalizePrefix, serviceUrl, allowProfiles, denyProfiles, rotateListenerKey, setPublicUrl, canonicalProfileKeys, planProfileRemoval, type Listener } from "./listeners.ts";

import { file } from "bun";
import yargs from "yargs";
import { readExtensionTokenFromProfile } from "./extension-token.ts";
import { FILL_SECRET_USAGE, SECRET_MASK, parseFillSecretArgs, fillSecretWireArgs, readSecretSource, totpCode, totpWaitMs } from "./fill-secret.ts";
import { createHash, randomBytes } from "crypto";
import { mkdirSync, appendFileSync, existsSync, realpathSync, accessSync, cpSync, unlinkSync, readFileSync, readdirSync, renameSync, rmdirSync, constants as fsConstants } from "fs";
import { hostname, homedir, networkInterfaces } from "os";
import { isIPv4 } from "net";
import { join, basename, dirname, resolve } from "path";
import { pathToFileURL } from "url";
import { createRequire } from "node:module";
import { spawn as cpSpawn } from "child_process";
import { readFile, writeFile, rename, chmod, mkdir } from "node:fs/promises";
import { isDeprecatedPm2Fallback, listsProcess, oxmgrInstallCommand, pickDaemonManager, PM2_DEPRECATION, type DaemonManager } from "./daemon-manager.ts";

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
/** Machine-wide RECHROME_URL from `rech connect --global`: read from every folder, after the project's own files. */
export const GLOBAL_ENV_FILE = join(RECH_DIR, ".env.local");
const globalEnvFile = join(HOME || "~", ".env.local");

// Capture inherited values once so explicit environment overrides survive reloads,
// while values loaded from files can still change when those files are edited.
/**
 * A KEY=value line for an env file. A value with "#" (every connection URL's #key=…) or
 * whitespace is double-quoted: Bun's own .env loader treats an unquoted "#" as a comment and
 * would drop the key. rech's loader strips the quotes again.
 */
export function envAssignment(key: string, value: string): string {
  return /[#\s]/.test(value) ? `${key}="${value}"` : `${key}=${value}`;
}

/** Parse KEY=value lines the way Bun's .env loader does (unquoted values end at "#"). */
function parseBunEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const raw = m[2].trim();
    const quoted = raw.match(/^(["'`])(.*)\1/);
    out[m[1]] = quoted ? quoted[2] : raw.replace(/\s*#.*$/, "").trim();
  }
  return out;
}

/**
 * Keys Bun itself loaded from the current folder's .env files before rech started. They look
 * like shell exports, but are file values: counting them as inherited would let a folder's
 * .env.local beat its .rechrome/.env.local, and a keyless (cut at "#") URL beat a good one.
 */
export function bunAutoloadedKeys(env: Record<string, string | undefined>, files: string[]): Set<string> {
  const keys = new Set<string>();
  for (const text of files)
    for (const [key, value] of Object.entries(parseBunEnvFile(text))) if (env[key] === value) keys.add(key);
  return keys;
}

const bunLoaded = bunAutoloadedKeys(process.env,
  [".env", `.env.${process.env.NODE_ENV || "development"}`, ".env.local", `.env.${process.env.NODE_ENV || "development"}.local`]
    .map(name => { try { return readFileSync(join(process.cwd(), name), "utf8"); } catch { return ""; } }));
const inheritedEnvKeys = new Set(Object.keys(process.env).filter(key => !bunLoaded.has(key)));

/** Where RECHROME_URL came from: "environment", an env file's path, or undefined when unset. */
export let rechromeUrlSource: string | undefined;

// Walk CWD→root loading env files nearest-first; inherited environment wins over files.
// At each level .rechrome/.env.local is checked before .env.local (rechrome-specific overrides general).
// The machine-wide file comes last, so it also applies outside $HOME (e.g. an agent's /tmp scratch dir).
export async function loadNearestEnv(extraFallbacks: string[] = [GLOBAL_ENV_FILE]) {
  const seen = new Set<string>(inheritedEnvKeys);
  rechromeUrlSource = seen.has(ENV_KEY) ? "environment" : undefined;
  const applyFile = async (path: string) => {
    const raw = await file(path).text().catch(() => "");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([^#=\s][^#=]*?)\s*=\s*(.*?)\s*$/);
      if (!m || m[1].startsWith("#")) continue;
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      if (m[1] === ENV_KEY) rechromeUrlSource = path;
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

// The Mac app's binary only acts as the CLI when it is told to (or has a terminal): from a
// daemon it tries to start the GUI and fails. Harmless for the standalone CLI.
const TAILSCALE_ENV = { ...process.env, TAILSCALE_BE_CLI: "1" };
const tailscaleBinary = () => Bun.which("tailscale") || (existsSync("/Applications/Tailscale.app/Contents/MacOS/Tailscale") ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale" : null);

/** Run the Tailscale CLI read-only: its output, or why it gave none (missing, failed, slow). */
async function runTailscaleDetailed(args: string[]): Promise<{ output: string } | { error: string; missing?: true }> {
  const binary = tailscaleBinary();
  if (!binary) return { error: "not installed", missing: true };
  try {
    const proc = Bun.spawn([binary, ...args], { env: TAILSCALE_ENV, stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; proc.kill(); }, 2000);
    try {
      const [output, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      if (await proc.exited === 0) return { output };
      const reason = timedOut ? "no answer within 2s" : (stderr.trim() || output.trim()).split("\n")[0] || `exit ${proc.exitCode}`;
      return { error: `\`tailscale ${args.join(" ")}\`: ${reason}` };
    } finally { clearTimeout(timeout); }
  } catch (error) { return { error: String(error) }; }
}

/** Run the Tailscale CLI read-only; null when it is missing, disconnected, or slow. */
async function runTailscale(args: string[]): Promise<string | null> {
  const result = await runTailscaleDetailed(args);
  return "output" in result ? result.output : null;
}

export async function detectListenChoices(): Promise<ListenChoice[]> {
  const output = await runTailscale(["ip", "-4"]);
  const ips = output ? output.trim().split(/\s+/).filter(isIPv4) : [];
  return buildListenChoices(networkInterfaces(), ips);
}

/**
 * `funnel`: Funnel (public internet) is on for the host that serves — or would serve — this
 * node's routes, so a route there is not tailnet-only. `mounts`: every Serve path in use.
 */
export type TailscaleServe = { dnsName: string | null; routeUrl: string | null; funnel: boolean; mounts: string[] };

export function serveMountsAndFunnel(serveStatus: unknown, host: string | null): { mounts: string[]; funnel: boolean } {
  const status = serveStatus as { Web?: Record<string, { Handlers?: Record<string, unknown> }>; AllowFunnel?: Record<string, boolean> } | null;
  const mounts = Object.values(status?.Web ?? {}).flatMap(config => Object.keys(config.Handlers ?? {}).map(path => path.replace(/\/+$/, "") || "/"));
  const funnel = Object.entries(status?.AllowFunnel ?? {}).some(([hostPort, on]) => on && (!host || hostPort.split(/:(?=\d+$)/)[0] === host));
  return { mounts: [...new Set(mounts)], funnel };
}

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
  const routeUrl = findTailscaleServeRoute(dnsName, serveStatus, port, prefix);
  return { dnsName, routeUrl, ...serveMountsAndFunnel(serveStatus, routeUrl ? new URL(routeUrl).hostname : dnsName) };
}

type ServeHandler = { hostPort: string; mount: string; target: URL };

/** Every Serve route that proxies to a loopback HTTP port. */
function loopbackServeHandlers(serveStatus: unknown): ServeHandler[] {
  const web = (serveStatus as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> } | null)?.Web ?? {};
  const handlers: ServeHandler[] = [];
  for (const [hostPort, config] of Object.entries(web)) {
    for (const [path, handler] of Object.entries(config.Handlers ?? {})) {
      if (!handler.Proxy) continue;
      let target: URL;
      try { target = new URL(/^[a-z]+:\/\//i.test(handler.Proxy) ? handler.Proxy : `http://${handler.Proxy}`); } catch { continue; }
      if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || !target.port) continue;
      handlers.push({ hostPort, mount: path.replace(/\/+$/, "") || "/", target });
    }
  }
  return handlers;
}

export type ServeRepair = { hostPort: string; mount: string; from: number; to: number; proxy: string };
export type ServeStale = { hostPort: string; mount: string; port: number };

/**
 * Health check for Tailscale Serve against listeners.json. `repair`: a route on a listener's own
 * mount that proxies to another port (the listener moved), re-pointed at the listener's port.
 * `stale`: a route next to a listener's mount (same first path segment, e.g. /rechrome beside
 * /rechrome/taku) whose port no listener uses — a removed listener's leftover, which answers 502.
 * Root ("/") mounts are never touched: they could be anything.
 */
export function planTailscaleServeRepairs(serveStatus: unknown, listeners: { port: number; prefix?: string }[]): { repair: ServeRepair[]; stale: ServeStale[] } {
  const ports = new Set(listeners.map(l => l.port));
  const mounts = new Map<string, number>();
  for (const l of listeners) {
    const mount = normalizePrefix(l.prefix).replace(/\/+$/, "");
    if (mount) mounts.set(mount, l.port);
  }
  const roots = new Set([...mounts.keys()].map(m => m.split("/")[1]));
  const repair: ServeRepair[] = [], stale: ServeStale[] = [];
  for (const { hostPort, mount, target } of loopbackServeHandlers(serveStatus)) {
    const port = Number(target.port), want = mounts.get(mount);
    if (want !== undefined) {
      if (port !== want) {
        const proxy = new URL(target); proxy.port = String(want);
        repair.push({ hostPort, mount, from: port, to: want, proxy: proxy.href.replace(/\/$/, mount === "/" ? "/" : "") });
      }
    } else if (mount !== "/" && roots.has(mount.split("/")[1]) && !ports.has(port)) {
      stale.push({ hostPort, mount, port });
    }
  }
  return { repair, stale };
}

/** Drop the Serve routes that proxy to a removed listener, so they don't linger answering 502. */
async function removeTailscaleServeRoutes(listener: { port: number; prefix?: string }): Promise<void> {
  const binary = tailscaleBinary(), raw = binary && await runTailscale(["serve", "status", "--json"]);
  if (!binary || !raw) return;
  let serveStatus: unknown;
  try { serveStatus = JSON.parse(raw); } catch { return; }
  const mount = normalizePrefix(listener.prefix).replace(/\/+$/, "") || "/";
  for (const h of loopbackServeHandlers(serveStatus)) {
    if (Number(h.target.port) !== listener.port || h.mount !== mount) continue;
    const args = ["serve", `--https=${h.hostPort.split(/:(?=\d+$)/)[1] ?? "443"}`, `--set-path=${h.mount}`, "off"];
    const ok = await Bun.spawn([binary, ...args], { env: TAILSCALE_ENV, stdout: "ignore", stderr: "inherit", windowsHide: true }).exited === 0;
    console.log(ok ? `Removed its Tailscale Serve route ${h.hostPort}${h.mount}.` : `Remove its Tailscale Serve route yourself: tailscale ${args.join(" ")}`);
  }
}

type HealthListener = Pick<Listener, "name" | "port" | "prefix" | "profiles">;

/**
 * Read-only Tailscale Serve health for the listeners: `absent` (no Tailscale here), `unresponsive`
 * (installed, but its CLI doesn't answer — e.g. not running, or the Mac app's GUI binary), or
 * `ok` with each shared listener's route plus the routes to re-point or remove.
 */
export type TailscaleHealth =
  | { state: "absent" }
  | { state: "unresponsive"; error: string }
  | { state: "ok"; routes: { listener: string; port: number; url: string | null }[]; repair: ServeRepair[]; stale: ServeStale[] };

export async function inspectTailscaleServe(listeners: HealthListener[]): Promise<TailscaleHealth> {
  const [serve, status] = await Promise.all([runTailscaleDetailed(["serve", "status", "--json"]), runTailscale(["status", "--json"])]);
  if (!("output" in serve)) return serve.missing ? { state: "absent" } : { state: "unresponsive", error: serve.error };
  let serveStatus: unknown, dnsName: string | null = null;
  try { serveStatus = JSON.parse(serve.output || "null"); } catch { return { state: "unresponsive", error: "`tailscale serve status --json` printed no JSON" }; }
  try { dnsName = (JSON.parse(status ?? "null")?.Self?.DNSName as string | undefined)?.replace(/\.$/, "") || null; } catch { /* not connected */ }
  const routes = listeners.filter(l => l.profiles !== "*")
    .map(l => ({ listener: l.name, port: l.port, url: findTailscaleServeRoute(dnsName, serveStatus, l.port, normalizePrefix(l.prefix)) }));
  return { state: "ok", routes, ...planTailscaleServeRepairs(serveStatus, listeners) };
}

const httpsPortOf = (hostPort: string) => hostPort.split(/:(?=\d+$)/)[1] ?? "443";

/** Problems in a health report, one line each with the command that fixes it; empty when healthy. */
export function tailscaleHealthProblems(health: TailscaleHealth): string[] {
  if (health.state === "absent") return [];
  if (health.state === "unresponsive") return [`Tailscale is installed but its CLI doesn't answer, so Serve routes go unchecked: ${health.error}`];
  return [
    ...health.repair.map(r => `${r.hostPort}${r.mount} proxies to 127.0.0.1:${r.from}, but the listener is on ${r.to} (clients get HTTP 502). Fix: tailscale serve --bg --https=${httpsPortOf(r.hostPort)} --set-path=${r.mount} ${r.proxy}`),
    ...health.stale.map(st => `${st.hostPort}${st.mount} proxies to 127.0.0.1:${st.port}, where no listener runs (clients get HTTP 502). Remove it: tailscale serve --https=${httpsPortOf(st.hostPort)} --set-path=${st.mount} off`),
  ];
}

/** The `tailscale:` block of `rech status` / `rech share ls`: each shared listener's route, then problems. */
export function formatTailscaleHealth(health: TailscaleHealth): string[] {
  if (health.state === "absent") return [];
  const lines = health.state === "ok"
    ? health.routes.map(r => r.url ? `✓ ${r.listener} → ${r.url} (127.0.0.1:${r.port})` : `- ${r.listener}: no Tailscale Serve route (fine if another proxy exposes it)`)
    : [];
  lines.push(...tailscaleHealthProblems(health).map(p => `⚠ ${p}`));
  return lines.map((line, i) => `${i ? " ".repeat(11) : "tailscale: "}${line}`);
}

/**
 * Daemon health check: keep Tailscale Serve routes pointed at the listeners' current ports.
 * Re-points a moved listener's route on this node; only reports stale routes (removing a
 * route is the user's call) and a Tailscale CLI that doesn't answer. Returns log lines, empty
 * when healthy or Tailscale is absent.
 */
export async function checkTailscaleServe(listeners: HealthListener[]): Promise<string[]> {
  const health = await inspectTailscaleServe(listeners);
  const binary = tailscaleBinary();
  if (health.state !== "ok" || !binary) return tailscaleHealthProblems(health).map(p => `tailscale serve: ${p}`);
  const lines: string[] = [];
  for (const r of health.repair) {
    const args = ["serve", "--bg", `--https=${httpsPortOf(r.hostPort)}`, `--set-path=${r.mount}`, r.proxy];
    const proc = Bun.spawn([binary, ...args], { env: TAILSCALE_ENV, stdout: "ignore", stderr: "pipe", windowsHide: true });
    const ok = await proc.exited === 0;
    lines.push(ok
      ? `tailscale serve: re-pointed ${r.hostPort}${r.mount} from 127.0.0.1:${r.from} to ${r.to}`
      : `tailscale serve: ${r.hostPort}${r.mount} points at 127.0.0.1:${r.from}, listener is on ${r.to}; re-pointing failed (${(await new Response(proc.stderr).text()).trim()}). Run: tailscale ${args.join(" ")}`);
  }
  lines.push(...tailscaleHealthProblems({ ...health, repair: [] }).map(p => `tailscale serve: ${p}`));
  return lines;
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
    const newLine = envAssignment(ENV_KEY, url);
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

export async function readChromeProfileCache(): Promise<Record<string, ChromeProfileInfo> | null> {
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

export type ProfileCandidate = { id: string; label: string; fields: string[]; localPart?: string };

/** Several profiles match; an interactive caller can offer them as a choice. */
export class AmbiguousProfileError extends Error {
  constructor(message: string, readonly candidates: ProfileCandidate[]) { super(message); }
}

/** share can't pick a listener on its own; an interactive caller can ask. */
export class ShareListenerError extends Error {
  constructor(message: string, readonly kind: "several" | "none", readonly listeners: Listener[]) { super(message); }
}

/**
 * Looser profile matching, tried after the exact rules: the email's part before "@", then the
 * start (3+ characters) of an email/name/folder. No substring matching: "h" must not pick a
 * profile because its email happens to contain an h. Each stage counts only when it picks out
 * exactly one profile; if a stage matches several, stop and name them rather than guess.
 */
export function matchProfileLoosely(value: string, candidates: ProfileCandidate[]): ProfileCandidate | null {
  const needle = value.trim().toLowerCase();
  if (!needle) return null;
  const stages: Array<[string, (c: ProfileCandidate) => boolean]> = [
    ["email name", c => c.localPart?.toLowerCase() === needle],
    ["prefix", c => needle.length >= 3 && c.fields.some(f => f.toLowerCase().startsWith(needle))],
  ];
  for (const [, test] of stages) {
    const hits = candidates.filter(test);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1)
      throw new AmbiguousProfileError(`Profile "${value}" matches several profiles: ${hits.map(c => c.label).join(", ")}. Use one of those, or see \`rech profile\`.`, hits);
  }
  return null;
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
  let match = resolveChromeProfileSelector(profiles, value);

  if (!match) {
    // No exact match: accept a looser one only when it is unique, and say which profile it chose.
    const chromeIds = new Set(profiles.flatMap(([dir, info]) => [dir, info.user_name ?? ""]));
    for (const [key, entry] of Object.entries(registry)) if (profiles.some(([dir]) => dir === entry.profileDir)) chromeIds.add(key);
    const candidates: ProfileCandidate[] = [
      ...profiles.map(([dir, info]) => ({
        id: `chrome:${dir}`,
        label: info.user_name ? `${info.user_name} (${info.name ?? dir})` : `${info.name ?? dir} [${dir}]`,
        fields: [info.user_name ?? "", info.name ?? "", dir].filter(Boolean),
        localPart: info.user_name?.split("@")[0],
      })),
      // Registered profiles Chrome doesn't list (managed test profiles).
      ...Object.keys(registry).filter(k => !chromeIds.has(k)).map(k => ({ id: `registry:${k}`, label: k, fields: [k], localPart: k.includes("@") ? k.split("@")[0] : undefined })),
    ];
    const loose = matchProfileLoosely(value, candidates);
    if (!loose) {
      throw new Error(`Profile "${value}" does not match any Chrome profile. See available profiles with \`rech profile\`.`);
    }
    console.error(`[rech] profile "${value}" → ${loose.label}`);
    if (loose.id.startsWith("registry:")) {
      const key = loose.id.slice("registry:".length);
      return { email: key, entry: registry[key] };
    }
    match = profiles.find(([dir]) => `chrome:${dir}` === loose.id)!;
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

/**
 * Split a Windows command line into arguments the way the C runtime does (CommandLineToArgvW
 * rules): whitespace separates outside quotes; quotes toggle and may sit mid-argument
 * (`--x="C:\a"b` is `--x=C:\ab`); 2n backslashes before a quote are n backslashes and the quote
 * toggles, 2n+1 are n and a literal quote; `""` inside quotes is a literal quote.
 */
export function splitWindowsCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let current = "", quoted = false, started = false;
  for (let i = 0; i < commandLine.length; i++) {
    const c = commandLine[i];
    if (c === "\\") {
      let n = 0;
      while (commandLine[i] === "\\") { n++; i++; }
      if (commandLine[i] === '"') {
        current += "\\".repeat(n >> 1);
        if (n % 2) current += '"'; else quoted = !quoted;
      } else { current += "\\".repeat(n); i--; }
      started = true;
    } else if (c === '"') {
      if (quoted && commandLine[i + 1] === '"') { current += '"'; i++; } else quoted = !quoted;
      started = true;
    } else if (!quoted && (c === " " || c === "\t")) {
      if (started) { args.push(current); current = ""; started = false; }
    } else { current += c; started = true; }
  }
  if (started) args.push(current);
  return args;
}

/** The `--user-data-dir` value among exact arguments, or null. */
export function userDataDirArg(args: string[]): string | null {
  const arg = args.find(a => a.startsWith("--user-data-dir="));
  return arg === undefined ? null : arg.slice("--user-data-dir=".length);
}

/** Same folder: exact path, ignoring trailing separators (and case on Windows). */
export function sameDataDir(a: string, b: string, windows = process.platform === "win32"): boolean {
  const norm = (p: string) => { const t = p.replace(/[\\/]+$/, ""); return windows ? t.replaceAll("/", "\\").toLowerCase() : t; };
  return norm(a) === norm(b);
}

/**
 * Match a flattened POSIX `ps` command line (no quotes, argument boundaries lost) against a
 * user-data dir: "exact" only when the path is the last thing on the line; "ambiguous" when
 * more text follows (another flag, or a sibling folder like `qa -backup`); else "none".
 */
export function flatUserDataDirMatch(command: string, userDataDir: string): "exact" | "ambiguous" | "none" {
  const flag = `--user-data-dir=${userDataDir.replace(/\/+$/, "")}`;
  const at = command.indexOf(flag);
  if (at < 0 || (at > 0 && !/\s/.test(command[at - 1]))) return "none";
  const rest = command.slice(at + flag.length);
  if (/^\/*\s*$/.test(rest)) return "exact";
  return /^\/*\s/.test(rest) ? "ambiguous" : "none";   // `qa2` / `qa-x` are other folders
}

/**
 * Browser processes (not helpers) on this Chrome user-data dir. `exact`: certainly this folder
 * (Windows command lines are split with the C runtime's rules; Linux reads argv from /proc).
 * `ambiguous`: flattened `ps` output that may name a sibling folder — never killed.
 */
function browsersUsing(userDataDir: string): { exact: number[]; ambiguous: number[] } {
  const exact: number[] = [], ambiguous: number[] = [];
  const isHelper = (args: string[]) => args.some(a => a.startsWith("--type="));
  if (process.platform === "win32") {
    const out = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"], { windowsHide: true }).stdout.toString();
    for (const line of out.split(/\r?\n/)) {
      const tab = line.indexOf("\t"), pid = Number(line.slice(0, tab));
      if (!pid || pid === process.pid) continue;
      const args = splitWindowsCommandLine(line.slice(tab + 1));
      const dir = userDataDirArg(args);
      if (dir !== null && !isHelper(args) && sameDataDir(dir, userDataDir)) exact.push(pid);
    }
    return { exact, ambiguous };
  }
  const ps = Bun.spawnSync(["ps", "ax", "-o", "pid=,command="]).stdout.toString();
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) === process.pid || !m[2].includes("--user-data-dir=")) continue;
    const pid = Number(m[1]);
    let argv: string[] | null = null;
    try { argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean); } catch { /* not Linux, or gone */ }
    if (argv) {
      const dir = userDataDirArg(argv);
      if (dir !== null && !isHelper(argv) && sameDataDir(dir, userDataDir, false)) exact.push(pid);
      continue;
    }
    if (/(?:^|\s)--type=/.test(m[2])) continue;
    const match = flatUserDataDirMatch(m[2], userDataDir);
    if (match === "exact") exact.push(pid);
    else if (match === "ambiguous") ambiguous.push(pid);
  }
  return { exact, ambiguous };
}

/** Move a folder to the user's Trash (recoverable). Returns where it went, or null if unsupported here. */
function moveToTrash(dir: string): string | null {
  // An explicit trash folder (tests use it to keep the real Trash / Recycle Bin clean).
  const override = process.env.RECH_TRASH_DIR;
  if (override) {
    mkdirSync(override, { recursive: true });
    let dest = join(override, basename(dir));
    if (existsSync(dest)) dest = `${dest} ${new Date().toISOString().replace(/[:.]/g, "-")}`;
    renameSync(dir, dest);
    return dest;
  }
  if (process.platform === "win32") {
    // SHFileOperation with ALLOWUNDO sends it to the Recycle Bin, with no prompts or progress UI.
    // WANTNUKEWARNING makes Windows ask rather than silently delete for good when the item
    // cannot be recycled. (.NET's FileSystem.DeleteDirectory(..., SendToRecycleBin) deleted
    // permanently here.) The path goes through the environment so quoting can't break it.
    const source = [
      "using System; using System.Runtime.InteropServices;",
      "public static class RechRecycle {",
      "  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]",
      "  struct Op { public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags; public bool aborted; public IntPtr mappings; public string title; }",
      "  [DllImport(\"shell32.dll\", CharSet = CharSet.Unicode)] static extern int SHFileOperation(ref Op op);",
      "  public static int Recycle(string path) {",
      "    var op = new Op { wFunc = 3, pFrom = path + \"\\0\\0\", fFlags = 0x0040 | 0x0010 | 0x0004 | 0x0400 | 0x4000 };",
      "    int r = SHFileOperation(ref op); return op.aborted ? -1 : r;",
      "  }",
      "}",
    ].join("\n");
    const r = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command",
      "Add-Type -TypeDefinition $env:RECH_RECYCLE_SOURCE; exit [RechRecycle]::Recycle($env:RECH_RECYCLE_PATH)"],
      { env: { ...process.env, RECH_RECYCLE_SOURCE: source, RECH_RECYCLE_PATH: dir.replaceAll("/", "\\").replace(/\\+$/, "") }, windowsHide: true }); // SHFileOperation rejects `/` and a trailing `\`
    return r.exitCode === 0 && !existsSync(dir) ? "the Recycle Bin" : null;
  }
  const trash = process.platform === "darwin" ? join(HOME, ".Trash") : process.platform === "linux" ? join(HOME, ".local", "share", "Trash", "files") : null;
  if (!trash) return null;
  mkdirSync(trash, { recursive: true });
  let dest = join(trash, basename(dir));
  if (existsSync(dest)) dest = `${dest} ${new Date().toISOString().replace(/[:.]/g, "-")}`;
  renameSync(dir, dest);
  return dest;
}

/**
 * `rech profile rm <name>`: unregister a profile everywhere (all its aliases, every listener
 * allowlist, dropping listeners left empty) and move a managed test profile's own folder to the
 * Trash. Real Chrome profile data is never touched. Shows the plan and asks first (--yes skips);
 * a browser still running on a managed folder is closed only with consent (--close).
 */
async function removeProfile(selector: string, opts: { yes?: boolean; close?: boolean } = {}): Promise<void> {
  const registry = await readTokenRegistry(), cache = await readChromeProfileCache();
  const key = (await resolveGlobalProfile(registry, cache, selector)).email;
  const config = await readListeners();
  const plan = planProfileRemoval(key, registry, config?.listeners ?? [], join(RECH_DIR, "profiles"));
  const using = plan.dataDir ? browsersUsing(plan.dataDir) : { exact: [], ambiguous: [] };
  const running = using.exact;
  console.log(`Remove profile "${key}"${plan.keys.length > 1 ? ` (registered as ${plan.keys.join(", ")})` : ""}:`);
  for (const edit of plan.listeners) console.log(edit.drop ? `  - remove listener "${edit.name}" (it serves only this profile)` : `  - stop sharing it on listener "${edit.name}"`);
  console.log(`  - unregister it from rech (~/.rechrome/profiles.yaml)`);
  if (plan.dataDir) console.log(`  - move its data folder to the Trash: ${plan.dataDir}`);
  else console.log(`  - its Chrome data is left alone (this only unregisters it from rech)`);
  if (running.length) console.log(`  - close its browser window, which is running now (pid ${running.join(", ")})`);
  // A process that may be on this folder or on a sibling one: never killed, and nothing changes.
  if (using.ambiguous.length)
    throw new Error(`A process that may be using ${plan.dataDir} is running (pid ${using.ambiguous.join(", ")}), and rech can't tell it from one on a similarly named folder. Close it yourself, then run this again. Nothing changed.`);
  const interactive = isInteractive();
  if (!opts.yes) {
    if (!interactive) throw new Error("Not removed. Re-run with --yes to confirm" + (running.length ? " and --close to close its running window." : "."));
    const ok = await promptChoice("Go ahead?", [{ label: "No, keep it", value: false }, { label: "Yes, remove it", value: true }], 0);
    if (!ok) throw new Error("Cancelled; nothing changed.");
  }
  if (running.length) {
    // In a terminal, confirming the plan above (which lists closing it) is the consent; otherwise --close.
    if (!interactive && !opts.close) throw new Error("Its window is running; re-run with --close to close it, or close it yourself first.");
    for (const pid of running) process.kill(pid, "SIGTERM");
    for (let i = 0; i < 40 && browsersUsing(plan.dataDir!).exact.length; i++) await Bun.sleep(250);
    if (browsersUsing(plan.dataDir!).exact.length) throw new Error("Its window did not close; close it and run this again. Nothing else changed.");
  }
  if (config && plan.listeners.length) {
    for (const edit of plan.listeners) {
      if (edit.drop) config.listeners = config.listeners.filter(l => l.name !== edit.name);
      else { const l = config.listeners.find(x => x.name === edit.name)!; l.profiles = (l.profiles as string[]).filter(p => !plan.keys.includes(p)); }
    }
    await writeListeners(config);
  }
  for (const k of plan.keys) delete registry[k];
  await writeTokenRegistry(registry);
  // The migrated profiles.json backup still holds tokens: drop the same keys there.
  const legacy = join(RECH_DIR, "profiles.json");
  if (existsSync(legacy)) {
    try {
      const old = JSON.parse(readFileSync(legacy, "utf8"));
      if (plan.keys.some(k => k in old)) { for (const k of plan.keys) delete old[k]; await writeFile(legacy, JSON.stringify(old, null, 2) + "\n", { mode: 0o600 }); await chmod(legacy, 0o600); }
    } catch { /* unreadable backup: leave it */ }
  }
  let moved: string | null = null;
  if (plan.dataDir && existsSync(plan.dataDir)) moved = moveToTrash(plan.dataDir);
  console.log(`Removed "${key}".${moved ? ` Its data folder was moved to ${moved}.` : plan.dataDir ? ` Its data folder was left at ${plan.dataDir}; delete it yourself if you like.` : ""}`);
}

/** On a client of a remote host, `rech profile` lists what that host's link shares. */
async function listRemoteProfiles(url: string): Promise<void> {
  const response = await fetch(serviceUrl(url, "ping"), { headers: { Authorization: `Bearer ${parseUrl(url).key}` }, signal: AbortSignal.timeout(5000) })
    .catch(error => { throw new Error(`Could not reach ${serviceUrl(url)}: ${error instanceof Error ? error.message : error}`); });
  if (response.status === 401) throw new Error("The host rejected this link's key; ask for a fresh one (rech share on the host), then rech connect '<url>'.");
  const body = await response.json().catch(() => ({})) as { listener?: string; profiles?: string[] | "*" };
  const current = resolveEffectiveProfile(parseUrl(url).profileDirectory);
  console.log(`Profiles shared by ${serviceUrl(url)}${body.listener ? ` (listener ${body.listener})` : ""}:`);
  if (body.profiles === "*") console.log("  every profile registered on that host");
  else for (const p of body.profiles ?? []) console.log(`  ${p}${p === current ? "   ← current" : ""}`);
  console.log(`\nUse one: rech --profile <name> open https://example.com`);
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
    if (listenerName) {
      const named = listeners.find(l => l.name === listenerName);
      if (!named) throw new Error(`Unknown listener "${listenerName}". See rech listener ls.`);
      if (named.profiles !== "*" && !named.profiles.includes(profile))
        throw new Error(`Listener "${listenerName}" does not allow "${profile}". Allow it with: rech listener allow ${listenerName} ${JSON.stringify(profile)}`);
    }
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

/** Prompts only when a person is at the terminal; scripts and agents get errors, never a hang. */
export const isInteractive = () => !!process.stdin.isTTY && !!process.stderr.isTTY;

/**
 * Numbered choice on `output` (stderr, so stdout stays clean for piping). Enter takes the
 * default; q or end of input cancels (null). Invalid answers ask again.
 */
export async function promptChoice<T>(
  question: string, options: { label: string; value: T }[], defaultIndex = 0,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = { input: process.stdin, output: process.stderr },
): Promise<T | null> {
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: io.input, output: io.output, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  try {
    io.output.write(`${question}\n`);
    options.forEach((o, i) => io.output.write(`  ${String(i + 1).padStart(2)}. ${o.label}${i === defaultIndex ? "  (default)" : ""}\n`));
    while (true) {
      io.output.write(`Choice [${defaultIndex + 1}, q to cancel]: `);
      const next = await lines.next();
      if (next.done) return null;
      const answer = String(next.value).trim().toLowerCase();
      if (answer === "q") return null;
      if (answer === "") return options[defaultIndex]?.value ?? null;
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && options[index]) return options[index].value;
      io.output.write(`Enter a number from 1 to ${options.length}.\n`);
    }
  } finally { rl.close(); }
}

/**
 * One picker entry per Chrome profile: its Chrome name and signed-in email (from Local State,
 * for profiles in the default user data dir), then the folder, e.g. `Work · you@example.com  [Profile 2]`.
 */
export function registeredProfileChoices(registry: Record<string, TokenEntry>, cache: Record<string, ChromeProfileInfo> | null = null): { label: string; value: string }[] {
  const defaultDirs = CHROME_LOCAL_STATE_PATHS().map(path => dirname(path));
  return canonicalProfileKeys(registry).map(key => {
    const { profileDir: dir, userDataDir } = registry[key];
    const info = !userDataDir || defaultDirs.includes(userDataDir) ? cache?.[dir] : undefined;
    const names = [info?.name, info?.user_name, key].filter((n): n is string => !!n && n !== dir);
    const shown = [...new Set(names)];
    return { label: shown.length ? `${shown.join(" · ")}  [${dir}]` : dir, value: key };
  });
}

/** Chrome profiles (default user data dir) that rech has not registered yet: `[folder, info]`. */
export function unregisteredChromeProfiles(registry: Record<string, TokenEntry>, cache: Record<string, ChromeProfileInfo> | null): [string, ChromeProfileInfo][] {
  const defaultDirs = CHROME_LOCAL_STATE_PATHS().map(path => dirname(path));
  const registered = new Set(Object.values(registry).filter(e => !e.userDataDir || defaultDirs.includes(e.userDataDir)).map(e => e.profileDir));
  return Object.entries(cache ?? {}).filter(([dir]) => !registered.has(dir));
}

/**
 * Which listener `rech share <profile>` uses when none is named: a scoped one that allows the
 * profile, preferring one with a public URL. Never the management listener, whose key gives
 * full access to every profile.
 */
export function chooseShareListener(profile: string, listeners: Listener[]): string {
  const scoped = listeners.filter(l => l.profiles !== "*");
  const allowing = scoped.filter(l => (l.profiles as string[]).includes(profile));
  const pick = allowing.length === 1 ? allowing : allowing.filter(l => l.publicUrl);
  if (pick.length === 1) return pick[0].name;
  if (allowing.length > 1)
    throw new ShareListenerError(`"${profile}" is shared on several listeners (${allowing.map(l => l.name).join(", ")}). Pick one with --listener <name>.`, "several", allowing);
  throw new ShareListenerError([
    `"${profile}" isn't shared on any listener yet.`,
    scoped.length ? `  Allow it on one:  rech listener allow ${scoped[0].name} ${JSON.stringify(profile)}   (listeners: ${scoped.map(l => l.name).join(", ")})` : "",
    `  ${scoped.length ? "Or give" : "Give"} it its own link:  rech share ${JSON.stringify(profile)}   (in a terminal it asks who should connect)`,
  ].filter(Boolean).join("\n"), "none", scoped);
}

/** A loopback port no listener uses and nothing else is bound to, from the management port + 2. */
function freeListenerPort(listeners: Listener[]): number {
  const used = new Set(listeners.map(l => l.port));
  for (let port = DEFAULT_PORT + 2; port < 65536; port++) {
    if (used.has(port)) continue;
    try { Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() }).stop(true); return port; } catch { /* taken */ }
  }
  throw new Error("No free port for the share-all listener; pass one with rech listener add");
}

/**
 * `rech share --all`: one link for every Chrome profile registered now (a snapshot; run it
 * again after registering more). It uses its own listener and key, so single-profile links
 * already handed out never gain access to the other profiles.
 */
async function shareAll(opts: { listener?: string; local?: boolean; save?: boolean }): Promise<void> {
  const snapshot = canonicalProfileKeys(await readTokenRegistry());
  if (!snapshot.length) throw new Error("No registered profiles to share. Set one up first: rech setup");
  return shareSet(snapshot, { ...opts, defaultName: "share-all", prefix: "/rechrome-all/", again: "rech share --all" });
}

/** The registry key rech uses for a profile: one per Chrome profile, whatever alias it was named by. */
function canonicalKeyFor(registry: Record<string, TokenEntry>, key: string): string {
  const entry = registry[key];
  return canonicalProfileKeys(registry).find(k => registry[k].profileDir === entry?.profileDir && (registry[k].userDataDir ?? "") === (entry?.userDataDir ?? "")) ?? key;
}

/**
 * `rech share a b c`: one link for exactly these profiles, on one listener. With --listener it
 * sets that listener's profiles to the list (e.g. one that already has a proxy route); otherwise
 * it reuses a listener with exactly this set, or creates one with its own key.
 */
async function shareProfiles(selectors: string[], opts: { listener?: string; local?: boolean; save?: boolean }): Promise<void> {
  const registry = await readTokenRegistry(), cache = await readChromeProfileCache();
  const keys: string[] = [];
  for (const selector of selectors) {
    const key = canonicalKeyFor(registry, (await resolveGlobalProfile(registry, cache, selector)).email);
    if (!keys.includes(key)) keys.push(key);
  }
  if (keys.length === 1) return printProfileUri(keys[0], opts.listener, opts);
  const config = await requireListeners();
  const same = config.listeners.find(l => l.profiles !== "*" && l.profiles.length === keys.length && keys.every(k => (l.profiles as string[]).includes(k)));
  const id = createHash("sha256").update([...keys].sort().join("\0")).digest("hex").slice(0, 6);
  return shareSet(keys, { ...opts, listener: opts.listener ?? same?.name, defaultName: `share-${id}`, prefix: `/rechrome-${id}/`, again: `rech share ${selectors.map(s => JSON.stringify(s)).join(" ")}` });
}

/** Put exactly `snapshot` on one scoped listener (created if missing) and print its link. */
async function shareSet(snapshot: string[], opts: { listener?: string; local?: boolean; save?: boolean; defaultName: string; prefix: string; again: string; host?: string; tailscaleServe?: boolean }): Promise<void> {
  const config = await requireListeners();
  const name = opts.listener ?? opts.defaultName;
  let listener = config.listeners.find(l => l.name === name);
  if (listener?.profiles === "*")
    throw new Error(`"${name}" is the local management listener; it is never shared. Omit --listener, or name a scoped one.`);
  let changes = "";
  if (!listener) {
    if (opts.listener) throw new Error(`Unknown listener "${name}". See rech listener ls.`);
    listener = { name, host: opts.host ?? "127.0.0.1", port: freeListenerPort(config.listeners), prefix: opts.prefix, key: randomBytes(24).toString("base64url"), profiles: snapshot };
    config.listeners.push(listener);
    changes = `created listener "${name}" on ${listenerAddress(listener)}${listener.prefix}`;
  } else {
    const before = listener.profiles as string[];
    const added = snapshot.filter(p => !before.includes(p)), removed = before.filter(p => !snapshot.includes(p));
    listener.profiles = snapshot;
    changes = added.length || removed.length ? [added.length && `added ${added.join(", ")}`, removed.length && `removed ${removed.join(", ")}`].filter(Boolean).join("; ") : "no changes";
  }
  await writeListeners(config);
  if (changes.startsWith("created") && snapshot.length === 1) console.error(`New link "${name}" for ${snapshot[0]}.`);
  else console.error(`[rech] sharing ${snapshot.length} profiles through "${name}" (${changes}): ${snapshot.join(", ")}`);
  if (opts.defaultName === "share-all") console.error(`[rech] this is a snapshot: after registering another profile, run ${opts.again} again.`);
  else if (changes !== "no changes" && !changes.startsWith("created")) console.error(`[rech] links already given out for "${name}" now reach exactly these profiles too (same key). For a fresh key: rech listener rotate-key ${name}`);
  // The daemon reloads listeners.json about every second: confirm this listener answers before handing out its URL.
  // A one-profile link names its profile, so the other machine needs no --profile.
  const only = snapshot.length === 1 ? `?profile=${encodeURIComponent(snapshot[0])}` : "";
  const local = `http://${listener.key}@${listenerAddress(listener)}${normalizePrefix(listener.prefix)}${only}`;
  const ready = await waitForListener(listener);
  if (!ready) console.error(`[rech] warning: listener "${name}" is not answering yet; check the daemon with rech status.`);
  if (opts.tailscaleServe && !listener.publicUrl) {
    const publicUrl = await exposeWithTailscaleServe(listener);
    if (publicUrl) {
      listener.publicUrl = publicUrl;
      await writeListeners(config);
    }
  }
  const uri = listener.publicUrl && !opts.local ? rebaseConnectionUrl(listener.publicUrl, local) : registeredProfileUrl(local);
  if (!listener.publicUrl && isLoopback(listener.host)) for (const line of listenerNextSteps(listener, undefined, opts.again)) console.error(line);
  console.log(uri);
  console.error(snapshot.length === 1 ? `On the other machine: rech connect '<this link>'` : `On the other machine: rech connect '<this link>', then rech --profile <name> open <url>`);
  if (opts.save) console.error(`Saved RECHROME_URL to ${await saveProjectUrl(uri)}`);
}

/** A readable, URL-safe name for a profile's link: the email's local part or the profile name. */
export function profileSlug(profile: string): string {
  const slug = profile.split("@")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return slug || "profile";
}

/**
 * `base`, or `base-2`, `base-3`… — the first name whose listener and path are free. Never a
 * reserved name (`share --all` and `share a b` reuse theirs and rewrite their allowlists, so a
 * one-profile link under such a name would later grant its key more profiles), and never a
 * mount a proxy already serves (Tailscale Serve would replace that route).
 */
export function uniqueShareName(base: string, listeners: Listener[], servedMounts: string[] = []): string {
  const reserved = (name: string) => name === "local" || name === "share-all" || /^share-[0-9a-f]{6}$/.test(name);
  const taken = (name: string) => reserved(name) || servedMounts.includes(`/rechrome/${name}`)
    || listeners.some(l => l.name === name || normalizePrefix(l.prefix) === `/rechrome/${name}/`);
  for (let i = 1; ; i++) { const name = i === 1 ? base : `${base}-${i}`; if (!taken(name)) return name; }
}

/** Route a loopback listener through Tailscale Serve (HTTPS, tailnet only); returns its public URL. */
async function exposeWithTailscaleServe(listener: Listener): Promise<string | null> {
  const prefix = normalizePrefix(listener.prefix);
  const existing = await detectTailscaleServe(listener.port, prefix);
  if (existing.funnel) {
    console.error("Tailscale Funnel is on for this machine, so a Serve route here would be public, not tailnet-only. Not exposing it.\n  Turn Funnel off (tailscale funnel reset), then rech share again.");
    return null;
  }
  if (existing.routeUrl) return existing.routeUrl;
  const binary = tailscaleBinary();
  if (!binary) return null;
  const mount = prefix === "/" ? "/" : prefix.slice(0, -1);
  const args = ["serve", "--bg", `--set-path=${mount}`, `http://127.0.0.1:${listener.port}${mount === "/" ? "" : mount}`];
  console.error(`Running: tailscale ${args.join(" ")}`);
  const proc = Bun.spawn([binary, ...args], { env: TAILSCALE_ENV, stdout: "ignore", stderr: "inherit", windowsHide: true });
  if (await proc.exited !== 0) {
    console.error(`tailscale serve failed. Run it yourself, then rech share again:\n  tailscale ${args.join(" ")}`);
    return null;
  }
  return (await detectTailscaleServe(listener.port, prefix)).routeUrl;
}

/** The daemon reloads listeners.json about every second: wait (up to ~5s) until this listener answers. */
async function waitForListener(listener: Listener): Promise<boolean> {
  const url = `http://${listener.key}@${listenerAddress(listener)}${normalizePrefix(listener.prefix)}`;
  for (let i = 0; i < 20; i++) {
    if (await fetch(serviceUrl(url, "ping"), { headers: { Authorization: `Bearer ${listener.key}` }, signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false)) return true;
    await Bun.sleep(250);
  }
  return false;
}

/**
 * Ask how other machines will reach a link: "tailscale-serve", a detected network address
 * (plain HTTP), "127.0.0.1" for the user's own proxy, or `extra` choices; null when cancelled.
 */
async function askReachability(question: string, extra: { label: string; value: string }[] = []): Promise<string | null> {
  const serve = !!tailscaleBinary();
  // With Tailscale Serve on offer, a plain-HTTP Tailscale IP would only be a worse duplicate.
  const networks = (await detectListenChoices()).filter(c => c.kind !== "local" && !(serve && c.kind === "tailscale"));
  return promptChoice(question, [
    ...(serve ? [{ label: "Tailscale: HTTPS, only your tailnet", value: "tailscale-serve" }] : []),
    ...networks.map(c => ({ label: `${c.label.split(" — ")[0]} network: http://${c.address}, plain HTTP`, value: c.address })),
    { label: "My own reverse proxy", value: "127.0.0.1" },
    ...extra,
  ], 0);
}

/**
 * Give one profile its own link. In a terminal, ask how the other machines will reach it
 * (Tailscale Serve, a detected network, or the user's own proxy); without one, create a
 * loopback link, like `rech share a b`.
 */
async function shareNewLink(profile: string, opts: { local?: boolean; save?: boolean }): Promise<void> {
  const served = tailscaleBinary() ? (await detectTailscaleServe(0, "/")).mounts : [];
  const name = uniqueShareName(profileSlug(profile), (await requireListeners()).listeners, served);
  let host = "127.0.0.1", tailscaleServe = false;
  if (isInteractive()) {
    const how = await askReachability(`How will your other machines reach it?`);
    if (!how) throw new Error("Cancelled; nothing shared.");
    tailscaleServe = how === "tailscale-serve";
    host = tailscaleServe ? "127.0.0.1" : how;
  }
  return shareSet([profile], { ...opts, host, tailscaleServe, defaultName: name, prefix: `/rechrome/${name}/`, again: `rech share ${JSON.stringify(profile)}` });
}

/** A scoped listener's full link (contains its key): its public URL when recorded, else its own address. */
export function listenerLink(listener: Listener, local = false): string {
  const profiles = listener.profiles as string[];
  const only = profiles.length === 1 ? `?profile=${encodeURIComponent(profiles[0])}` : "";
  const direct = `http://${listener.key}@${listenerAddress(listener)}${normalizePrefix(listener.prefix)}${only}`;
  return listener.publicUrl && !local ? rebaseConnectionUrl(listener.publicUrl, direct) : registeredProfileUrl(direct);
}

/** The links already handed out (stderr: stdout stays the one URL this command prints). */
function printExistingLinks(listeners: Listener[], local = false): void {
  const scoped = listeners.filter(l => l.profiles !== "*" && l.profiles.length);
  if (!scoped.length) return;
  console.error("Already shared (secret links):");
  for (const l of scoped) {
    console.error(`  ${l.name}: ${(l.profiles as string[]).join(", ")}${!l.publicUrl && isLoopback(l.host) ? "   (this machine only: no proxy recorded)" : ""}`);
    console.error(`    ${listenerLink(l, local)}`);
  }
  console.error("");
}

async function printProfileUri(selector?: string, listener?: string, opts: { local?: boolean; save?: boolean; all?: boolean } = {}): Promise<void> {
  if (opts.all) {
    if (selector) throw new Error("Pass a profile or --all, not both.");
    return shareAll({ listener, local: opts.local, save: opts.save });
  }
  const url = process.env[ENV_KEY];
  const interactive = isInteractive();
  const registry = await readTokenRegistry();
  const cache = await readChromeProfileCache();
  const cancelled = () => new Error("Cancelled; nothing shared.");
  let config = await readListeners();
  const current = resolveEffectiveProfile(url ? parseUrl(url).profileDirectory : undefined);
  const sharedOn = (key: string) => ((config?.listeners ?? []).filter(l => l.profiles !== "*" && (l.profiles as string[]).includes(key))).map(l => l.name);
  // Chrome profiles rech doesn't manage yet are listed too; picking one runs setup for it first.
  const SETUP = "\0setup:";
  const pickProfile = async (question: string, choices = [
    ...registeredProfileChoices(registry, cache).map(c => {
      const on = sharedOn(c.value);
      return on.length ? { ...c, label: `${c.label}  (shared: ${on.join(", ")})` } : c;
    }),
    ...unregisteredChromeProfiles(registry, cache).map(([dir, info]) => ({
      label: `${[...new Set([info.name, info.user_name].filter(Boolean))].join(" · ") || dir}  [${dir}]  (not set up: runs rech setup)`,
      value: `${SETUP}${dir}`,
    })),
  ]) => {
    const def = Math.max(0, choices.findIndex(c => c.value === current || registry[c.value]?.profileDir === current));
    const picked = (await promptChoice(question, choices, def)) ?? (() => { throw cancelled(); })();
    if (!picked.startsWith(SETUP)) return picked;
    const dir = picked.slice(SETUP.length);
    console.error(`[rech] ${dir} isn't set up yet; running rech setup --profile ${JSON.stringify(dir)} first.`);
    await setup({ profile: dir });
    const after = await readTokenRegistry();
    const key = unregisteredChromeProfiles(after, { [dir]: {} }).length ? undefined : canonicalProfileKeys(after).find(k => after[k].profileDir === dir);
    if (process.exitCode || !key) throw new Error(`Setup didn't register ${dir}; nothing shared. Retry with: rech setup --profile ${JSON.stringify(dir)}`);
    Object.assign(registry, after);
    config = await readListeners(); // setup may have added a listener: never write back a stale copy
    return key;
  };
  if (!selector) {
    // No profile given: show what is already shared, then ask, defaulting to the current one
    // (?profile= in the URL, else PLAYWRIGHT_MCP_PROFILE_DIRECTORY).
    if (interactive && Object.keys(registry).length) {
      printExistingLinks(config?.listeners ?? [], opts.local);
      selector = await pickProfile("Share which profile?");
    }
    else {
      selector = current;
      if (!selector) throw new Error("No current profile to share. Name one: rech share <profile>   (see rech profile; rech share ls lists what is shared)");
      console.error(`[rech] sharing the current profile: ${selector}`);
    }
  }
  // A configured remote profile may not exist in this machine's local registry.
  let profile: string;
  if (url && parseUrl(url).profileDirectory === selector && !listener) profile = selector;
  else {
    try { profile = (await resolveGlobalProfile(registry, cache, selector)).email; }
    catch (error) {
      if (!interactive || !(error instanceof Error)) throw error;
      if (error instanceof AmbiguousProfileError) {
        const choice = await pickProfile(`"${selector}" matches several profiles. Which one?`,
          error.candidates.map(c => ({ label: c.label, value: c.id.replace(/^(chrome|registry):/, "") })));
        profile = (await resolveGlobalProfile(registry, cache, choice)).email;
      } else if (/does not match/.test(error.message)) {
        profile = (await resolveGlobalProfile(registry, cache, await pickProfile(`No profile matches "${selector}". Share which one?`))).email;
      } else throw error;
    }
  }
  const listeners = config?.listeners ?? [];
  // On a host, share through a scoped listener by default, never the management key.
  if (!listener && config) {
    try { listener = chooseShareListener(profile, listeners); }
    catch (error) {
      if (!(error instanceof ShareListenerError)) throw error;
      // Not shared yet: give it its own link rather than stopping with instructions.
      if (!interactive) { if (error.kind === "none") return shareNewLink(profile, opts); throw error; }
      const describe = (l: Listener) => `${l.name}  ${l.publicUrl ?? `${listenerAddress(l)}${normalizePrefix(l.prefix)}`}`;
      if (error.kind === "several") {
        listener = (await promptChoice(`"${profile}" is on several listeners. Share through which?`, error.listeners.map(l => ({ label: describe(l), value: l.name })))) ?? undefined;
        if (!listener) throw cancelled();
      } else {
        // Keep going until there is a URL (or the user cancels): a new link of its own is the
        // default, since allowing it on an existing listener hands it to that listener's key holders.
        const NEW_LINK = "\0new";
        const target = error.listeners.length ? await promptChoice(`${profile} isn't shared yet.`, [
          { label: "Create a new link for it", value: NEW_LINK as string | null },
          ...error.listeners.map(l => ({ label: `Add it to link "${l.name}" (its existing key)`, value: l.name as string | null })),
          { label: "Cancel", value: null },
        ], 0) : NEW_LINK;
        if (!target) throw cancelled();
        if (target === NEW_LINK) return shareNewLink(profile, opts);
        allowProfiles(config, target, [profile]);
        await writeListeners(config);
        console.error(`[rech] allowed "${profile}" on ${target}`);
        listener = target;
      }
    }
  }
  const chosen = listeners.find(l => l.name === listener);
  if (chosen?.profiles === "*")
    throw new Error(`"${listener}" is the local management listener: its key controls every profile and allows eval and file access, so it is never shared. Share through a scoped listener: rech share <profile>, or rech share --all.`);
  if (chosen && chosen.profiles.length > 1)
    console.error(`[rech] note: this link's key works for every profile on listener "${chosen.name}" (${chosen.profiles.join(", ")}); ?profile= only picks the default. For a one-profile link, give that profile its own listener.`);
  let uri = profileConnectionUri(profile, url, listeners, listener);
  // Prefer where a proxy exposes the listener, when it has been recorded.
  // A link whose proxy was set up by hand since (e.g. after `tailscale serve` failed here):
  // record the tailnet-only route so this and later shares print it.
  const pending = listeners.find(l => l.key === parseUrl(uri).key);
  if (config && pending && pending.profiles !== "*" && !pending.publicUrl && isLoopback(pending.host) && tailscaleBinary()) {
    const serve = await detectTailscaleServe(pending.port, normalizePrefix(pending.prefix));
    if (serve.routeUrl && !serve.funnel) { pending.publicUrl = serve.routeUrl; await writeListeners(config); }
  }
  // Still only reachable from this machine (no proxy recorded or detected): a link like that is
  // useless to hand out, so ask how other machines reach it, or say how to expose it.
  if (config && pending && pending.profiles !== "*" && !pending.publicUrl && isLoopback(pending.host) && !opts.local) {
    const steps = () => { for (const line of listenerNextSteps(pending, profile)) console.error(line); };
    if (!interactive) {
      console.error(`[rech] this link only works on this machine: listener "${pending.name}" is on ${listenerAddress(pending)} and no proxy is recorded.`);
      steps();
    } else {
      const KEEP = "\0keep";
      const how = await askReachability(`Link "${pending.name}" only works on this machine (${listenerAddress(pending)}). How will your other machines reach it?`,
        [{ label: "Nothing: keep it on this machine", value: KEEP }]);
      if (!how) throw cancelled();
      if (how === "tailscale-serve") {
        const routeUrl = await exposeWithTailscaleServe(pending);
        if (routeUrl) { pending.publicUrl = routeUrl; await writeListeners(config); }
      } else if (how === "127.0.0.1") steps();
      else if (how !== KEEP) {
        // Same key and prefix, now bound on that network; links already handed out change host.
        pending.host = how;
        await writeListeners(config);
        if (!(await waitForListener(pending))) console.error(`[rech] warning: listener "${pending.name}" is not answering on ${listenerAddress(pending)} yet; check the daemon with rech status.`);
        uri = profileConnectionUri(profile, undefined, config.listeners, pending.name);
      }
    }
  }
  const publicUrl = pending?.publicUrl;
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

/**
 * Is RECHROME_URL this machine's own daemon? True when its key is one of our listeners (or,
 * before listeners.json existed, when it points at loopback and profiles are registered here). A remote daemon resolves
 * profiles itself, and must never receive this machine's own extension tokens.
 */
export async function isLocalDaemon(url: string): Promise<boolean> {
  const { key, host } = parseUrl(url);
  const config = await readListeners().catch(() => null);
  // Before listeners.json existed, a local install pointed at loopback and had its own registry;
  // a fresh client (no registry) talking to a tunnelled loopback port is still remote.
  if (!config) return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host) && Object.keys(await readTokenRegistry().catch(() => ({}))).length > 0;
  return !!key && config.listeners.some(l => l.key === key);
}

/** For a remote daemon: only what the URL itself carries, plus the profile selector (not secret). */
export function remoteClientEnv(url: string, profile?: string): Record<string, string> {
  const { extensionId, extensionToken, userDataDir, loadExtension } = parseUrl(url);
  return Object.fromEntries(Object.entries({
    PLAYWRIGHT_MCP_EXTENSION_ID: extensionId, PLAYWRIGHT_MCP_EXTENSION_TOKEN: extensionToken,
    PLAYWRIGHT_MCP_PROFILE_DIRECTORY: profile, PLAYWRIGHT_MCP_USER_DATA_DIR: userDataDir, PLAYWRIGHT_MCP_LOAD_EXTENSION: loadExtension,
  }).filter(([, v]) => typeof v === "string" && v)) as Record<string, string>;
}

async function callServe(
  url: string,
  args: string[],
  overrideEnv?: Record<string, string>,
  precomputedIdentity?: { key: string; label: string; profile?: string },
  throwOnFailure = false,
  secret?: string,
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
  const env = await isLocalDaemon(url)
    ? { ...(await getClientEnv({ extensionId, extensionToken, profileDirectory: effectiveProfile, userDataDir, loadExtension })), ...overrideEnv }
    : { ...remoteClientEnv(url, effectiveProfile), ...overrideEnv };
  const res = await fetch(serviceUrl(url, "run"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    // dataDir is a client-local path; the daemon (possibly remote) only needs the session identity.
    // `secret` (fill-secret only) rides in its own field so it is never part of the logged args.
    body: JSON.stringify({ args, identity: { key: identity.key, label: identity.label, profile: identity.profile }, env, ...(secret ? { secret } : {}) }),
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
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // Not the daemon answering, e.g. a reverse proxy's 404 because the URL's path prefix is wrong.
    let detail = `HTTP ${res.status} from ${serviceUrl(url, "run")} is not a rechrome daemon response: ${text.slice(0, 200).trim()}`;
    if (res.status === 502 || res.status === 503 || res.status === 504)
      detail += `\n  The proxy is up but nothing answers behind it: this link's listener was likely removed or moved. Ask its owner for a fresh link (\`rech share\`), then \`rechrome connect <link>\`.`;
    if (throwOnFailure) throw new Error(detail);
    console.error(`[rech] rech-client -> ${serviceUrl(url, "run")}\n  -x: ${detail}`);
    process.exit(1);
  }
}

const BOOLEAN_OPEN_FLAGS = new Set(["--headed", "--persistent", "--in-memory", "--extension"]);

export function normalizeCommandArgs(args: string[]): string[] {
  const normalized = [...args];
  if (normalized[0] === "tabs" || normalized[0] === "list") normalized[0] = "tab-list";
  // `rech open hello.com`: profile-scoped listeners accept only HTTP(S)/about:blank targets, so
  // give a bare host an https:// scheme the way a browser address bar would.
  if (["open", "goto", "tab-new"].includes(normalized[0])) {
    // The target is the first positional. A token after a `--flag` without `=` is that flag's
    // value (`open --profile my-profile url`), unless the flag is a known boolean.
    const takesValue = (flag: string) => flag.startsWith("-") && !flag.includes("=") && !BOOLEAN_OPEN_FLAGS.has(flag);
    const i = normalized.findIndex((a, idx) => idx > 0 && !a.startsWith("-") && !takesValue(normalized[idx - 1]!));
    if (i > 0) normalized[i] = withDefaultScheme(normalized[i]!);
  }
  return normalized;
}

/** `hello.com` -> `https://hello.com`, `localhost:3000` -> `http://localhost:3000`; URLs with a scheme and paths are unchanged. */
export function withDefaultScheme(target: string): string {
  if (/^[./\\~]/.test(target) || /^[a-z]:[\\/]/i.test(target)) return target; // a file path, not a host
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[^/:]+:\d+(\/|$|[?#])/.test(target)) return target;
  // Loopback by exact hostname: `localhost.example.com` / `127.example.com` are public hosts.
  const host = (target.match(/^(\[[^\]]*\]|[^/:?#]*)/)?.[1] ?? "").toLowerCase();
  const loopback = host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
  return loopback ? `http://${target}` : `https://${target}`;
}

// Pull a global `--profile <val>` / `--profile=<val>` out of the leading flags of an argv.
// Only flags before the first positional (the playwright subcommand) are rech globals — a
// --profile at/after the subcommand belongs to the forwarded CLI (e.g. playwright-cli's own
// `open --profile <dir>`, a user-data-dir path) and must pass through untouched. Throws on a
// missing value; accepts multiple occurrences (last one wins).
/**
 * `rech [--profile X] [--isolate] pw <args>` forwards <args> to playwright-cli verbatim, so
 * `rech pw --version` or `rech pw status` reach playwright instead of rech. `--` works the
 * same after a rech flag (`rech --profile X -- status`); a bare leading `--` cannot, because
 * Bun consumes the `--` right after the script path. The separator counts only when
 * everything before it is a rech global flag; otherwise it belongs to the playwright command
 * (`rech open -- x`). Returns its index, or -1.
 */
export function rechSeparatorIndex(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--" || a === "pw" || a === "playwright") return i;
    if (a === "--profile") { i++; continue; }
    if (a.startsWith("--profile=") || a === "--isolate" || a === "--isolated") continue;
    return -1;
  }
  return -1;
}

/** rechrome's own version, from the package.json shipped next to this file. */
export function rechromeVersion(): string {
  try { return JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")).version ?? "unknown"; }
  catch { return "unknown"; }
}

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

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/** What to do when no RECHROME_URL is configured: set up here, or connect to another machine. */
export function notConnectedMessage(): string {
  return [
    `rech: not connected to a rechrome daemon (${ENV_KEY} is not set).`,
    `  On the machine with Chrome:   rech setup`,
    `  On another machine:           rech connect '<URL printed by \`rech share\` on that machine>'`,
  ].join("\n");
}

/**
 * When playwright-cli rejects a command, replace its own usage dump with a rech-branded hint.
 * Candidates are rech's commands plus the browser commands listed in that usage text, so the
 * suggestion stays current without a hardcoded list. Returns null for any other output.
 */
export function unknownCommandHint(output: string, rechCommands: Iterable<string> = RECH_COMMANDS): string | null {
  const unknown = output.match(/^Unknown command: (\S+)/m)?.[1];
  if (!unknown) return null;
  const browser = [...output.matchAll(/^ {2}([a-z][a-z0-9-]+) /gm)].map(m => m[1]);
  const candidates = [...new Set([...rechCommands, ...browser])];
  const scored = candidates.map(c => ({ c, d: editDistance(unknown.toLowerCase(), c) })).sort((x, y) => x.d - y.d);
  const best = scored[0] && scored[0].d <= Math.max(1, Math.floor(unknown.length / 3)) ? scored[0].c : null;
  return [
    `rech: unknown command "${unknown}".${best ? ` Did you mean "${best}"?` : ""}`,
    `  rech --help       rechrome commands (setup, status, profile, share, connect, listener…)`,
    `  rech pw --help    browser commands (open, click, screenshot…)`,
  ].join("\n");
}

async function run(url: string, args: string[], overrideEnv?: Record<string, string>, opts: { verbatim?: boolean } = {}) {
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
  let secret: string | undefined;
  const cmdIdx = args.findIndex(a => !a.startsWith("-s="));
  if (args[cmdIdx] === "fill-secret") {
    if (args.some(a => a === "--help" || a === "-h")) { console.log(FILL_SECRET_USAGE); process.exit(0); }
    try {
      ({ args, secret } = await prepareFillSecret(args));
    } catch (err) {
      console.error(`[rech] ${err instanceof Error ? err.message : String(err)}\n${FILL_SECRET_USAGE}`);
      process.exit(2);
    }
  }
  const served = await callServe(url, args, overrideEnv, identity, false, secret);
  // The daemon already masks the value; this is a second line of defence for an older daemon.
  const scrub = (s: string) => secret && s ? s.replaceAll(secret, SECRET_MASK) : s;
  const { files, existingSession } = served;
  const status = served.status, stdout = scrub(served.stdout), stderr = scrub(served.stderr);

  const isOpenWithUrl = args[0] === "open" && args.length > 1;
  if (existingSession && isOpenWithUrl) {
    return run(url, ["goto", ...args.slice(1)], overrideEnv, opts);
  }

  if (existingSession)
    console.error(`[rech] session already has open tabs — listing existing tabs instead of opening a new window`);
  // A typo'd command: rech's hint instead of playwright-cli's full usage (kept for `rech pw`).
  const hint = !opts.verbatim && status !== 0 ? unknownCommandHint(`${stderr ?? ""}\n${stdout ?? ""}`) : null;
  if (hint) {
    console.error(hint);
    process.exit(status || 1);
  }
  if (stderr) {
    if (stderr.includes('Extension connection timeout')) {
      // The daemon resolves registered profiles' bridge tokens itself and then asks for a reload;
      // only blame a missing install when neither side had credentials.
      const hasToken = !!effectiveEnv["PLAYWRIGHT_MCP_EXTENSION_TOKEN"] || /reload the .*extension/i.test(stderr);
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

/** Swap the client-side fill-secret args for the wire form and read the value (or TOTP code). */
async function prepareFillSecret(args: string[]): Promise<{ args: string[]; secret: string }> {
  const sessionArgs = args.filter(a => a.startsWith("-s="));
  const req = parseFillSecretArgs(args.filter(a => !a.startsWith("-s=")).slice(1));
  const raw = await readSecretSource(req.source);
  let secret = raw;
  if (req.totp) {
    const wait = totpWaitMs();
    if (wait) { console.error(`[rech] TOTP code expires in under 5s; waiting ${Math.ceil(wait / 1000)}s for the next one`); await Bun.sleep(wait); }
    secret = totpCode(raw); // only the code leaves this machine, never the seed
  }
  if (!req.allowDomains.length) console.error("[rech] fill-secret: no --allow-domain given; the value will be typed into whatever page is active");
  const wire = fillSecretWireArgs(req);
  return { args: [...wire, ...sessionArgs], secret };
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
/**
 * The first oxmgr that actually runs. PATH order alone isn't enough: a stale global shim
 * (e.g. bun's, printing "oxmgr binary is missing") can shadow a working build, and npm's
 * `oxmgr.cmd` re-parses argv through cmd.exe, so real executables come first. RECH_OXMGR
 * names one explicitly (a path, or a command looked up on PATH). The successful probe's
 * output seeds the version cache, so `--version` runs once.
 */
function findWorkingOxmgr(): string | null {
  const ext = IS_WINDOWS ? ".exe" : "";
  // Windows PATH entries may be quoted ("C:\Program Files\x"); quotes break the joined path.
  const dirs = (process.env.PATH ?? "").split(IS_WINDOWS ? ";" : ":").map(d => d.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  const override = process.env.RECH_OXMGR;
  const candidates = [
    override && (/[\\/]/.test(override) ? resolve(override) : Bun.which(override)),
    ...dirs.map(d => join(d, `oxmgr${ext}`)),
    // The vendored binary inside a global npm / bun install of the `oxmgr` package
    // (npm: <dir>/node_modules on Windows, <prefix>/lib/node_modules beside <prefix>/bin elsewhere).
    ...dirs.map(d => join(d, "node_modules", "oxmgr", "vendor", `oxmgr${ext}`)),
    ...(IS_WINDOWS ? [] : dirs.map(d => join(d, "..", "lib", "node_modules", "oxmgr", "vendor", "oxmgr"))),
    join(HOME, ".bun", "install", "global", "node_modules", "oxmgr", "vendor", `oxmgr${ext}`),
  ].filter((p): p is string => !!p && existsSync(p));
  const works = (p: string) => {
    try {
      const r = Bun.spawnSync([p, "--version"], { stdout: "pipe", stderr: "ignore", windowsHide: true });
      if (r.exitCode !== 0) return false;
      const m = /(\d+\.\d+\.\d+[^\s]*)/.exec(r.stdout?.toString() ?? "");
      _oxmgrVersion = m ? m[1]! : null;
      return true;
    } catch { return false; }
  };
  const exe = [...new Set(candidates)].find(works);
  if (exe) return exe;
  // Last resort (Windows): a working shim such as npm's oxmgr.cmd, but never over a working
  // pm2 — cmd.exe re-parses a shim's argv (see runPm).
  if (!IS_WINDOWS || Bun.which("pm2")) return null;
  const shim = Bun.which("oxmgr");
  return shim && works(shim) ? shim : null;
}

function daemonManager(): DaemonManager {
  if (_daemonMgr) return _daemonMgr;
  const oxmgrBin = findWorkingOxmgr();
  const pm2Bin = Bun.which("pm2");
  _daemonMgr = pickDaemonManager({
    oxmgrBin,
    pm2Bin,
    oxmgrVersion: oxmgrBin ? oxmgrVersion(oxmgrBin) : null,
    isWindows: IS_WINDOWS,
    override: process.env.RECH_DAEMON_MANAGER,
  });
  if (isDeprecatedPm2Fallback(_daemonMgr, { isWindows: IS_WINDOWS, override: process.env.RECH_DAEMON_MANAGER }))
    console.error(`[rech] warning: using pm2 because oxmgr is not on PATH. ${PM2_DEPRECATION}`);
  return _daemonMgr;
}

// Spawn the resolved process manager by its absolute path (Bun.which). `env` is
// merged over process.env for the child: pm2 captures the CLI's environment for
// the managed process (it has no per-var flag like oxmgr's --env), so install
// passes daemon env this way.
async function runPm(mgr: DaemonManager, args: string[], env?: Record<string, string>): Promise<number> {
  // A .cmd/.bat shim runs through cmd.exe, which treats & | < > ^ in an argument as syntax
  // (e.g. the &s in a RECHROME_URL passed with --env): fail clearly instead of mangling it.
  if (/\.(cmd|bat)$/i.test(mgr.bin) && args.some(a => /[&|<>^]/.test(a)))
    throw new Error(`${mgr.bin} is a cmd.exe shim, which would mangle an argument containing & | < > ^. Install the ${mgr.id} executable${mgr.id === "oxmgr" ? " (or set RECH_OXMGR to it)" : ""} and try again.`);
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
// Match a name in it with listsProcess, not a substring test.
async function pmList(mgr: DaemonManager = daemonManager()): Promise<string> {
  const proc = Bun.spawn([mgr.bin, mgr.id === "pm2" ? "jlist" : "list"], { stdout: "pipe", stderr: "ignore", windowsHide: true });
  return await new Response(proc.stdout).text();
}

// A candidate playwright-cli entry is usable only if the playwright-core it requires actually
// resolves FROM that entry — the wrapper does `require('playwright-core/lib/tools/cli-client/program')`,
// a deep subpath reachable only through the fork's patched `exports` map. existsSync on the .js is
// not the same check: an uninitialised/half-built lib/playwright-cli submodule leaves the wrapper on
// disk with no resolvable core, and the failure surfaces later as MODULE_NOT_FOUND inside the daemon.
export function playwrightCliIsUsable(jsEntry: string): boolean {
  try {
    createRequire(jsEntry).resolve("playwright-core/lib/tools/cli-client/program");
    return true;
  } catch {
    return false;
  }
}

// Resolve which playwright-cli the daemon runs to drive Chrome. Priority:
//   1. PLAYWRIGHT_CLI env override — explicit, already a full command string.
//   2. Vendored fork in a git checkout (lib/playwright-cli/playwright-cli.js) — the patched
//      multi-tab CLI + patched playwright-core (PLAYWRIGHT_MCP_PROFILE_DIRECTORY etc.).
//   3. The fork bundled into the npm tarball (vendor/playwright-cli/playwright-cli.js, produced by
//      scripts/vendor-cli.sh at prepublish, and by `prepare` on `bun install` in a checkout). This
//      is the batteries-included default for `bun i -g rechrome`: self-contained, no
//      @playwright/cli dep, no browser-binary download.
//   4. Bare `playwright-cli-multi-tab` on PATH — legacy fallback for a pre-existing global link.
// Candidates 2–3 must also pass playwrightCliIsUsable(), so a present-but-broken one falls through.
// lib/ stays ahead of vendor/ on purpose: a dev who built the fork wants their patched core, not
// the (possibly older) vendor-src snapshot that `prepare` unpacks into vendor/.
// A resolved .js entry is run through `node` on Windows (which can't exec a .js by shebang) and
// bare on POSIX (its `#!/usr/bin/env node` shebang runs it under node, which the relay handshake
// needs — see daemonInstall). serve splits the result on spaces into argv.
export function resolvePlaywrightCli(root: string = import.meta.dir): string {
  if (process.env.PLAYWRIGHT_CLI) return process.env.PLAYWRIGHT_CLI;
  const jsEntry = [
    join(root, "lib/playwright-cli/playwright-cli.js"),
    join(root, "vendor/playwright-cli/playwright-cli.js"),
  ].filter(existsSync).find(playwrightCliIsUsable);
  if (jsEntry) return IS_WINDOWS ? `node ${jsEntry}` : jsEntry;
  return "playwright-cli-multi-tab";
}

/**
 * Make sure a daemon process manager is available, offering to install oxmgr
 * (default No; --yes approves). An explicit RECH_DAEMON_MANAGER=pm2 is respected,
 * since installing oxmgr would not satisfy it. When only the deprecated pm2 fallback
 * is available (POSIX without oxmgr), the offer is made too, but declining keeps pm2.
 */
async function ensureDaemonManager(ask: (q: string, def?: string) => Promise<string>, yes = false): Promise<void> {
  let fallback: DaemonManager | undefined;
  try {
    fallback = daemonManager();
    if (!isDeprecatedPm2Fallback(fallback, { isWindows: IS_WINDOWS, override: process.env.RECH_DAEMON_MANAGER })) return;
  } catch (error) {
    if (process.env.RECH_DAEMON_MANAGER?.toLowerCase() === "pm2") throw error;
  }
  const command = oxmgrInstallCommand(process.env);
  const reason = fallback ? "Only the deprecated pm2 is available" : "oxmgr is missing";
  const answer = yes ? "yes" : (await ask(`      ${reason}. Install oxmgr globally with \`${command.join(" ")}\`? [y/N]: `)).trim();
  if (!/^(y|yes)$/i.test(answer)) {
    if (fallback) return; // keep the working pm2 setup
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
  if (!findWorkingOxmgr()) {
    throw new Error("oxmgr was installed but is not on PATH. Add the package manager's global bin directory to PATH, then rerun setup.");
  }
  _daemonMgr = undefined;
  _oxmgrVersion = undefined;
  daemonManager();
}

/**
 * Rewriting RECHROME_URL for a new daemon key must not drop the saved `?profile=`: without it
 * every client loses its Chrome profile (and a setup aborted before its final save step used
 * to leave it that way).
 */
export function keepProfileParam(next: string, previous?: string): string {
  try {
    const url = new URL(next);
    // A .env.local value may be quoted: RECHROME_URL="http://…/?profile=work".
    const raw = previous?.trim().replace(/^(['"])(.*)\1$/, "$2");
    const profile = raw ? new URL(raw).searchParams.get("profile") : null;
    if (profile && !url.searchParams.has("profile")) url.searchParams.set("profile", profile);
    return url.toString();
  } catch { return next; }
}

export async function daemonInstall(serveUrl: string): Promise<void> {
  // Resolve the manager first so a missing dependency fails before config is mutated.
  const mgr = daemonManager();
  // Persist the URL for future clients without an explicit environment override.
  // The daemon's explicit environment takes precedence over this saved default.
  const envRaw = await file(globalEnvFile).text().catch(() => "");
  const lines = envRaw.trimEnd().split("\n");
  const filtered = lines.filter(l => !l.startsWith(`${ENV_KEY}=`));
  await Bun.write(globalEnvFile, [...filtered, envAssignment(ENV_KEY, keepProfileParam(serveUrl, lines.find(l => l.startsWith(`${ENV_KEY}=`))?.slice(ENV_KEY.length + 1))), ""].join("\n"));

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
  // Migrating from pm2 to oxmgr: a serve still registered in pm2 would hold the port and be
  // resurrected at login, fighting the oxmgr-managed one. Remove it from pm2 too.
  const pm2Bin = mgr.id === "oxmgr" ? Bun.which("pm2") : null;
  if (pm2Bin) {
    const pm2: DaemonManager = { id: "pm2", bin: pm2Bin };
    const listed = await pmList(pm2).catch(() => "");
    const stale = [PM_PROCESS_NAME, ...LEGACY_PROCESS_NAMES].filter(name => listsProcess("pm2", listed, name));
    if (stale.length) {
      console.log(`      Migrating from pm2: removing ${stale.join(", ")}`);
      for (const name of stale) await runPm(pm2, ["delete", name]);
      // --force: pm2 won't save an empty list otherwise, keeping the old dump that `pm2 resurrect`
      // would bring back at login to fight the oxmgr-managed serve over the port.
      if (await runPm(pm2, ["save", "--force"]) !== 0)
        console.warn("      pm2 save failed; run `pm2 save --force` so pm2 doesn't resurrect the old serve at login.");
    }
  }

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
    // oxmgr shell-splits the command string (backslashes are escapes, so `C:\Users\…` became
    // `C:Users…`); pass quoted forward-slash paths — Windows accepts `/`, quotes keep spaces.
    const q = (path: string) => `"${path.replaceAll("\\", "/")}"`;
    startCode = await runPm(mgr, [
      "start",
      "--name", PM_PROCESS_NAME,
      "--restart", "always",
      "--cwd", home,
      ...envArgs,
      `${q(bunBin)} ${q(rechScript)} serve`,
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
  if (mgr.id === "pm2") await runPm(mgr, ["save", "--force"]); // an emptied list must still overwrite the dump
  // oxmgr's boot/login service is left installed: every other oxmgr-managed process depends on it.
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
    // Chromium 137+ ignores --load-extension unless this feature is off (Chrome for Testing
    // too): the extension silently never loads and status.html is an error page.
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
  ];
  if (!opts.headed) args.push("--headless=new");
  if (process.platform === "linux") args.push("--no-sandbox");
  // Headless can't answer a Keychain prompt, so first launch could stall on it (as Playwright does).
  if (process.platform === "darwin") args.push("--use-mock-keychain");
  args.push("about:blank");
  const proc = Bun.spawn([chromeBin, ...args], { stdout: "ignore", stderr: "ignore", windowsHide: true });
  let cdp: CDPClient | null = null;
  // Every step is bounded: a stuck Chrome must end in an error, never a silent hang.
  const within = <T>(ms: number, what: string, work: Promise<T>) => Promise.race([work,
    Bun.sleep(ms).then(() => { throw new Error(`${what} took over ${ms / 1000}s`); })]);
  try {
    // Chrome writes the chosen port to DevToolsActivePort once the debug server is up.
    let port: number | null = null;
    for (let i = 0; i < 300; i++) {
      await Bun.sleep(100);
      const line = (await file(portFile).text().catch(() => "")).split("\n")[0]?.trim();
      if (line && /^\d+$/.test(line)) { port = parseInt(line); break; }
      if (proc.exitCode !== null) throw new Error("Chrome exited before opening the DevTools port");
    }
    if (!port) throw new Error("Chrome didn't open its DevTools port within 30s");
    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
    cdp = new CDPClient(ver.webSocketDebuggerUrl as string);
    await within(5000, "Connecting to Chrome DevTools", cdp.open());
    // Wait for the extension's service worker: if it never shows, the extension didn't load.
    const extensionUrl = `chrome-extension://${EXTENSION_ID}/`;
    let loaded = false;
    for (let i = 0; i < 50 && !loaded; i++) {
      const { targetInfos } = await cdp.send("Target.getTargets");
      loaded = (targetInfos as { url: string }[]).some(t => t.url.startsWith(extensionUrl));
      if (!loaded) await Bun.sleep(200);
    }
    if (!loaded) throw new Error(`The extension at ${dist} didn't load in Chrome for Testing (no ${extensionUrl} target within 10s)`);
    const { targetId } = await cdp.send("Target.createTarget", { url: `${extensionUrl}status.html` });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    // The extension page may still be loading; retry the write until localStorage reflects it.
    let ok = false, last = "";
    const expr = `(()=>{try{localStorage.setItem('auth-token',${JSON.stringify(token)});return localStorage.getItem('auth-token');}catch(e){return 'ERR:'+e.message}})()`;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const r = await within(3000, "Runtime.evaluate", cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId)).catch(e => ({ error: String(e) }));
      const value = (r as any)?.result?.value;
      if (value === token) { ok = true; break; }
      last = typeof value === "string" ? value : (r as any)?.error ?? (r as any)?.result?.description ?? "";
      await Bun.sleep(200);
    }
    if (!ok) throw new Error(`Could not seed auth token into ${extensionUrl}${last ? ` (${last})` : ""}`);
    // Graceful close flushes localStorage to the profile's leveldb before we kill Chrome.
    await within(5000, "Browser.close", cdp.send("Browser.close")).catch(() => {});
    await within(5000, "Chrome exit", proc.exited).catch(() => {});
  } finally {
    cdp?.close();
    await stopThrowawayChrome(proc, userDataDir);
  }
}

/**
 * Stop a Chrome we launched on a throwaway user-data-dir: SIGTERM, then SIGKILL, then any helper
 * still holding that exact --user-data-dir (scoped to it, so never the user's own Chrome).
 */
async function stopThrowawayChrome(proc: ReturnType<typeof Bun.spawn>, userDataDir: string): Promise<void> {
  if (proc.exitCode === null) {
    try { proc.kill(); } catch {}
    const exited = await Promise.race([proc.exited.then(() => true, () => true), Bun.sleep(3000).then(() => false)]);
    if (!exited) { try { proc.kill("SIGKILL"); } catch {} await Promise.race([proc.exited.catch(() => {}), Bun.sleep(2000)]); }
  }
  if (process.platform !== "win32") Bun.spawnSync(["pkill", "-9", "-f", `--user-data-dir=${userDataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`], { stdout: "ignore", stderr: "ignore" });
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


  const profileUrl = registeredProfileUrl(rechUrl.toString());
  const newLine = envAssignment(ENV_KEY, profileUrl);

  // [3/3] Register in the token registry so `rech status` lists it and the daemon can resolve it.
  await saveTokenEntry(name, { extensionId: EXTENSION_ID, token, profileDir: name, userDataDir, loadExtension: dist });
  console.log(`\n[3/3] Registered "${name}" in ${TOKENS_FILE}`);

  console.log(`\nDone! RECHROME_URL for "${name}":\n\n  ${newLine}\n`);
  console.log(`Use it per-call:\n  ${ENV_KEY}='${profileUrl}' rech open https://example.com\n`);
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

/** Print rows as left-aligned columns; the first row is the header. */
function printTable(rows: string[][]): void {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => (r[i] ?? "").length)));
  for (const r of rows) console.log(r.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd());
}

async function listListeners(): Promise<void> {
  const rows = [["NAME", "ADDRESS", "PROFILES", "PUBLIC URL"]];
  for (const l of (await requireListeners()).listeners)
    rows.push([l.name, `${listenerAddress(l)}${normalizePrefix(l.prefix)}`, l.profiles === "*" ? "(all — local management)" : l.profiles.join(", "), l.publicUrl ?? "-"]);
  printTable(rows);
}

async function removeListener(name: string): Promise<void> {
  const config = await requireListeners();
  const listener = config.listeners.find(l => l.name === name);
  if (!listener) throw new Error("Unknown listener");
  if (listener.profiles === "*") throw new Error("Keep the local management listener for setup and recovery");
  config.listeners = config.listeners.filter(l => l !== listener);
  await writeListeners(config);
  console.log("Listener removed from configuration; daemon reloads automatically.");
  await removeTailscaleServeRoutes(listener);
}

async function resolveProfileKeys(selectors: string[]): Promise<string[]> {
  const registry = await readTokenRegistry(), cache = await readChromeProfileCache();
  const profiles: string[] = [];
  for (const selector of selectors) profiles.push((await resolveGlobalProfile(registry, cache, selector)).email);
  return [...new Set(profiles)];
}

/** Next steps after exposing a listener: proxy it, record where, share. Plain text, so any shell works. */
export function listenerNextSteps(listener: Listener, profile?: string, shareCommand?: string): string[] {
  const prefix = normalizePrefix(listener.prefix);
  const mount = prefix === "/" ? "" : prefix.slice(0, -1);
  return [
    `Expose it through any reverse proxy on port ${listener.port}${mount ? ` (mount ${mount}; stripping it is fine)` : ""}, e.g.:`,
    `  tailscale serve --bg${mount ? ` --set-path=${mount}` : ""} ${listener.port}`,
    `Then record where it is reachable and print the URL to share:`,
    `  rech listener set ${listener.name} --public-url https://<your-host>${prefix}`,
    `  ${shareCommand ?? `rech share ${profile ? JSON.stringify(profile) : "<profile>"}`}`,
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
  console.log(`New key for ${name}; URLs carrying the old key stop working now. Print new ones with: rech share <profile> --listener ${name}`);
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
  printTable(rows);
  const wide = config.listeners.filter(l => l.profiles !== "*" && l.profiles.length > 1);
  if (wide.length) console.log(`\nOne key covers several profiles on: ${wide.map(l => `${l.name} (${(l.profiles as string[]).length})`).join(", ")}. Anyone with such a link can use each of them.`);
  const tailscale = formatTailscaleHealth(await inspectTailscaleServe(config.listeners));
  if (tailscale.length) console.log(`\n${tailscale.join("\n")}`);
  console.log(`\nPrint a full URL (contains the secret key): rech share <profile>, or rech share --all`);
}

/** Write RECHROME_URL to this project's .rechrome/.env.local (the folder git-ignores itself). */
async function saveProjectUrl(url: string): Promise<string> {
  const { dataDir } = await getClientIdentity();
  mkdirSync(dataDir, { recursive: true });
  const gitignore = join(dataDir, ".gitignore");
  if (!existsSync(gitignore)) await Bun.write(gitignore, "*\n");
  return writeEnvUrl(join(dataDir, ".env.local"), url);
}

/** Write RECHROME_URL to ~/.rechrome/.env.local: the default for every project without its own. */
async function saveGlobalUrl(url: string): Promise<string> {
  mkdirSync(dirname(GLOBAL_ENV_FILE), { recursive: true });
  return writeEnvUrl(GLOBAL_ENV_FILE, url);
}

/** Replace RECHROME_URL in an env file, keeping its other lines; owner-only, since the URL holds a key. */
async function writeEnvUrl(envPath: string, url: string): Promise<string> {
  const lines = (await file(envPath).text().catch(() => "")).split("\n").filter(l => l.trim() && !l.startsWith(`${ENV_KEY}=`));
  await writeFile(envPath, [...lines, envAssignment(ENV_KEY, url), ""].join("\n"), { mode: 0o600 });
  await chmod(envPath, 0o600);
  return envPath;
}

/**
 * What would shadow the machine-wide RECHROME_URL from `cwd`: the shell's own RECHROME_URL, or the
 * nearest project env file that sets one (searched the way loadNearestEnv walks). Null when none does.
 */
export function nearerUrlSource(cwd: string, inherited: boolean, globalFile = GLOBAL_ENV_FILE): string | null {
  if (inherited) return "your shell's RECHROME_URL";
  const globalReal = (() => { try { return realpathSync(globalFile); } catch { return globalFile; } })();
  for (let dir = cwd; ; dir = dirname(dir)) {
    for (const path of [join(dir, ".rechrome", ".env.local"), join(dir, ".env.local")]) {
      if (path === globalFile || path === globalReal) return null;
      const text = (() => { try { return readFileSync(path, "utf8"); } catch { return ""; } })();
      if (text.split("\n").some(line => line.trimStart().startsWith(`${ENV_KEY}=`))) return path;
    }
    if (dirname(dir) === dir) return null;
  }
}

async function connect(url: string, opts: { global?: boolean; project?: boolean } = {}): Promise<void> {
  if (opts.global && opts.project) throw new Error("Pass --global or --project, not both.");
  const parsed = parseUrl(url);
  if (!parsed.key) throw new Error("That URL has no key (#key=…). Ask the host for the full URL from: rech share <profile>");
  const response = await fetch(serviceUrl(url, "ping"), { headers: { Authorization: `Bearer ${parsed.key}` }, signal: AbortSignal.timeout(5000) })
    .catch(error => { throw new Error(`Could not reach ${serviceUrl(url)}: ${error instanceof Error ? error.message : error}`); });
  if (response.status === 401) throw new Error("The daemon rejected this key; ask the host for a fresh URL (keys change on rech listener rotate-key).");
  if (!response.ok) throw new Error(`${serviceUrl(url, "ping")} answered ${response.status}; is the proxy pointing at the listener?`);
  const body = await response.json().catch(() => ({})) as { listener?: string; profiles?: string[] | "*" };
  if (parsed.profileDirectory && Array.isArray(body.profiles) && !body.profiles.includes(parsed.profileDirectory))
    throw new Error(`Connected, but listener "${body.listener}" does not allow profile "${parsed.profileDirectory}".`);
  // Where to save: the flag, else ask in a terminal (this project by default), else this project.
  let global = !!opts.global;
  if (!opts.global && !opts.project && isInteractive()) {
    const { dataDir } = await getClientIdentity();
    const choice = await promptChoice("Use this link for:", [
      { label: `This project only  (${join(dataDir, ".env.local")})`, value: "project" },
      { label: `Every project on this machine without its own link  (${GLOBAL_ENV_FILE})`, value: "global" },
    ], 0);
    if (!choice) throw new Error("Cancelled; nothing saved.");
    global = choice === "global";
  }
  // A machine running its own daemon would stop reaching its own Chrome from every project without a link.
  if (global && !(await isLocalDaemon(url)) && (await readListeners().catch(() => null))?.listeners.length)
    console.error(`[rech] warning: this machine runs its own rech daemon. Projects without their own RECHROME_URL will now use ${serviceUrl(url)}, not this machine's Chrome. Undo: remove ${ENV_KEY} from ${GLOBAL_ENV_FILE}`);
  const saved = global ? await saveGlobalUrl(url) : await saveProjectUrl(url);
  console.log(`Connected to ${serviceUrl(url)}${body.listener ? ` (listener ${body.listener})` : ""}. Saved RECHROME_URL ${global ? "for every project on this machine" : "for this project"}: ${saved}`);
  const shadow = global ? nearerUrlSource(process.cwd(), inheritedEnvKeys.has(ENV_KEY)) : null;
  if (shadow) console.log(`Note: here, ${shadow} takes precedence over it. Remove that, or run rech connect --project to update it.`);
  if (Array.isArray(body.profiles) && body.profiles.length > 1) {
    console.log(`This link shares ${body.profiles.length} profiles:`);
    for (const p of body.profiles) console.log(`  ${p}${p === parsed.profileDirectory ? "  (default)" : ""}`);
    console.log(`${parsed.profileDirectory ? "Use another" : "Pick one"} per command: rech --profile <name> open https://example.com   (see them again with rech profile)`);
  }
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
  const newLine = envAssignment(ENV_KEY, registeredProfileUrl(rechUrl.toString()));

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
    console.log(`serve:    not configured`);
    console.log(notConnectedMessage().split("\n").slice(1).join("\n"));
    return;
  }
  const parsed = parseUrl(url);
  const ping = await fetch(serviceUrl(url), { signal: AbortSignal.timeout(2000) }).catch(() => null);
  // The authenticated /ping reports which listener answered, its bind, and the profiles it allows.
  const pingResponse = ping
    ? await fetch(serviceUrl(url, "ping"), { headers: { Authorization: `Bearer ${parsed.key}` }, signal: AbortSignal.timeout(2000) }).catch(() => null)
    : null;
  const pingBody = pingResponse?.ok
    ? await pingResponse.json().catch(() => null) as { bind?: string; listener?: string; profiles?: string[] | "*"; degraded?: boolean; consecutiveTimeouts?: number } | null
    : null;
  // Show the URL this client connects to; through a proxy, the daemon's bind is on another port.
  const details = [pingBody?.listener && `listener ${pingBody.listener}`, pingBody?.bind && `bind ${pingBody.bind}`].filter(Boolean).join(", ");
  // Any HTTP answer is not the daemon: a proxy's 404/502 means the link's listener is gone or moved.
  const answered = pingResponse?.ok || pingResponse?.status === 401;
  console.log(`serve:    ${!ping ? `not reachable at ${serviceUrl(url)}`
    : answered ? `running  ${serviceUrl(url)}${details ? `  (${details})` : ""}`
    : `✗ ${serviceUrl(url)} answers HTTP ${pingResponse?.status ?? ping.status}, not a rechrome daemon — this link's listener was likely removed or moved; ask its host for a fresh link (\`rech share <profile>\`), then \`rech connect '<url>'\``}`);
  if (rechromeUrlSource) console.log(`config:   ${rechromeUrlSource === "environment" ? "RECHROME_URL from the environment" : rechromeUrlSource}${rechromeUrlSource === GLOBAL_ENV_FILE ? "  (machine-wide)" : ""}`);
  if (pingResponse?.status === 401)
    console.log(`auth:     ✗ key rejected — ask the host for a fresh URL (\`rech share <profile>\`), then \`rech connect '<url>'\``);
  // daemonManager().id — there is no PM_BIN constant. Referencing one threw a
  // ReferenceError that took down the whole of `rech status`, so the one command
  // that reports "the relay is wedged" died exactly when the relay was wedged,
  // printing a stack trace instead of the restart hint.
  // The daemon line is about this machine; a client of a remote host has no local daemon to report.
  const isHost = !!(await readListeners().catch(() => null));
  // No oxmgr/pm2 on PATH must not take down `rech status`: report it instead of throwing.
  let mgr: DaemonManager | undefined;
  if (isHost) try { mgr = daemonManager(); } catch { /* reported below */ }
  if (pingBody?.degraded)
    console.log(`relay:    ⚠ degraded (${pingBody.consecutiveTimeouts} consecutive command timeouts) — if it persists, the daemon self-restarts; ${isHost ? `force it now with \`${mgr?.id ?? "oxmgr"} restart ${PM_PROCESS_NAME}\`` : "the daemon host can restart it"}`);
  if (isHost) {
    const daemonRegistered = mgr ? listsProcess(mgr.id, await pmList(mgr).catch(() => ""), PM_PROCESS_NAME) : false;
    console.log(`daemon:   ${daemonRegistered ? `${mgr!.id} (${PM_PROCESS_NAME})` : mgr ? "not installed" : "not installed (no oxmgr or pm2 on PATH)"}`);
  }
  // Same resolution as a command: ?profile= in the URL, else PLAYWRIGHT_MCP_PROFILE_DIRECTORY.
  const effective = resolveEffectiveProfile(parsed.profileDirectory);
  const current = effective ? await resolveProfileEmail(effective).catch(() => effective) : undefined;
  const allowed = pingBody?.profiles === "*" ? "all registered profiles" : pingBody?.profiles?.join(", ");
  console.log(`profile:  ${current ?? "(none selected; add ?profile= to the URL or pass --profile)"}${allowed ? `  — this listener serves: ${allowed}` : ""}`);
  if (isHost) {
    const listeners = (await readListeners().catch(() => null))?.listeners ?? [];
    for (const line of formatTailscaleHealth(await inspectTailscaleServe(listeners))) console.log(line);
    console.log(`\nMore: rech profile (profiles) · rech share ls (who can connect, and where)`);
  }
}


export type SetupOptions = { profile?: string; token?: string; listen?: string; prefix?: string; port?: number; yes?: boolean };
export type RechHandlers = {
  serve(): Promise<void> | void;
  status(): Promise<void>;
  listListeners(): Promise<void>;
  addListener(name: string, opts: { listen: string; profile: string[]; port?: number; prefix?: string }): Promise<void>;
  removeListener(name: string): Promise<void>;
  listProfiles(): Promise<void>;
  removeProfile(selector: string, opts: { yes?: boolean; close?: boolean }): Promise<void>;
  printProfileUri(selector?: string, listener?: string, opts?: { local?: boolean; save?: boolean; all?: boolean }): Promise<void>;
  urlList(): Promise<void>;
  shareProfiles(selectors: string[], opts: { listener?: string; local?: boolean; save?: boolean }): Promise<void>;
  connect(url: string, opts?: { global?: boolean; project?: boolean }): Promise<void>;
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
export const RECH_COMMANDS = new Set(["serve", "status", "listener", "listeners", "profile", "profiles", "share", "connect", "setup", "tray", "provision-profile", "uninstall"]);

const portOption = { type: "number", requiresArg: true, describe: "Listener port (1-65535)" } as const;

// yargs trims indentation in .usage(), so the indented browser-command block lives in the epilogue.
const HELP_USAGE = `rechrome (rech) — drive your real, logged-in Chrome from scripts, agents and other machines

Usage: rech <command> [options]   ·   rech <browser-command> [args]`;

const HELP_EPILOGUE = `Browser commands (sent to this project's Chrome session):
  rech [--profile <p>] [--isolate] <browser-command> [args]
      open, goto, click, fill, screenshot, eval, tab-list…  (\`rech pw --help\` lists all)
      --profile <p>  as another registered profile (email, name or folder); put it first
      --isolate      in a throwaway session, e.g. for a login flow
  rech fill-secret <ref> --from-env VAR | --totp-from-env VAR [--env-file f] [--allow-domain '*.example.com']
                     type a password / TOTP code without it reaching argv, logs or output
  rech pw <args>     forward verbatim to playwright-cli, e.g. \`rech pw --version\`
  rech --version     rechrome's version

Environment:
  ${ENV_KEY}      connection URL; read from the nearest .rechrome/.env.local or .env.local
  RECH_IDENTITY     session key: worktree (default) | branch | cwd
  RECH_TOKEN        extension token for \`rech setup\` (same as --token)
  RECH_SETUP_AGENT  setup hints: codex | claude | none (auto-detected)

Examples:
  rech setup --profile you@example.com         set up Chrome on this machine
  rech open https://example.com                open a page in this project's session
  rech screenshot                              saved to <project>/.rechrome/output/
  rech share you@example.com                   URL to give another machine (secret)
  rech connect '<url>'                         use that URL in this project

Run \`rech <command> --help\` for a command's options. Tutorial: https://github.com/snomiao/rechrome#tutorial`;

export function rechCli(argv: string[], handlers: RechHandlers) {
  return yargs(argv)
    .scriptName("rech")
    .usage(HELP_USAGE)
    .epilogue(HELP_EPILOGUE)
    .wrap(Math.min(110, process.stdout.columns || 110))
    .parserConfiguration({ "parse-numbers": false, "parse-positional-numbers": false })
    // Set up and inspect this machine
    .command("setup", "Set up this machine: daemon, Chrome extension, connection", y => y
      .option("profile", { type: "string", requiresArg: true, describe: "Chrome profile: exact email, Chrome profile name, or folder (e.g. \"Profile 1\"); not menu numbers" })
      .option("token", { type: "string", requiresArg: true, describe: "Extension token, for headless runs (default: read from the profile, or RECH_TOKEN)" })
      .option("listen", { type: "string", requiresArg: true, describe: "Who can reach this profile: local (default) | lan | tailscale | <detected IP>" })
      .option("prefix", { type: "string", requiresArg: true, describe: "URL path for a proxied listener, e.g. rechrome (port defaults to the management port + 1)" })
      .option("port", portOption)
      .option("yes", { alias: "y", type: "boolean", default: false, describe: "Approve installing a missing oxmgr without prompting" }),
      a => handlers.setup({ profile: a.profile, token: a.token ?? process.env.RECH_TOKEN, listen: a.listen, prefix: a.prefix, port: a.port, yes: a.yes }))
    .command("status", "Is it working? The URL in use, the daemon, and the current profile", {}, () => handlers.status())
    .command(["profile [name] [target]", "profiles [name] [target]"], "List Chrome profiles; `profile rm <name>` removes one from rech", y => y
      .positional("name", { type: "string", describe: "ls/list lists all (the default); rm/remove <name> removes a profile" })
      .positional("target", { type: "string", describe: "The profile to remove (with rm)" })
      .option("yes", { alias: "y", type: "boolean", describe: "With rm: don't ask for confirmation" })
      .option("close", { type: "boolean", describe: "With rm: close the profile's running window (managed profiles)" })
      .option("print-uri", { type: "boolean", describe: "Same as `rech share <name>`" })
      .option("listener", { type: "string", requiresArg: true, implies: "print-uri", describe: "Listener to build the URL for" }),
      a => {
        if (a.name === "rm" || a.name === "remove") {
          if (!a.target) throw new Error("Which profile? rech profile rm <name>   (see rech profile)");
          return handlers.removeProfile(a.target, { yes: a.yes, close: a.close });
        }
        if (a.target) throw new Error(`Unexpected "${a.target}". To remove a profile: rech profile rm <name>`);
        if (a.printUri) return handlers.printProfileUri(a.name, a.listener); // alias of `rech share`
        if (a.name === undefined || ["ls", "list"].includes(a.name)) return handlers.listProfiles();
        throw new Error(`To share "${a.name}" with another machine: rech share ${JSON.stringify(a.name)}. To list profiles: rech profile`);
      })
    // Share with and connect from other machines
    .command("share [profiles..]", "Print a URL another machine can connect with (secret); `share ls` lists all", y => y
      .positional("profiles", { type: "string", array: true, describe: "Profile(s): email, name, folder, or a unique part of one. Several = one link for all of them. ls/list lists everything shared" })
      .option("listener", { type: "string", requiresArg: true, describe: "Listener to share through (default: the one that allows the profile)" })
      .option("local", { type: "boolean", describe: "Print the direct listener address even when a public URL is set" })
      .option("save", { type: "boolean", describe: "Also save it as RECHROME_URL in this project's .rechrome/.env.local" })
      .option("all", { type: "boolean", describe: "One link for every registered profile (a snapshot, on its own listener); the other machine picks with --profile" }),
      a => {
        const profiles = (a.profiles ?? []) as string[];
        if (profiles.length === 1 && ["ls", "list"].includes(profiles[0]) && !a.listener && !a.save && !a.all) return handlers.urlList();
        if (profiles.length > 1) {
          if (a.all) throw new Error("Pass profiles or --all, not both.");
          return handlers.shareProfiles(profiles, { listener: a.listener, local: a.local, save: a.save });
        }
        return handlers.printProfileUri(profiles[0], a.listener, a.all ? { local: a.local, save: a.save, all: true } : { local: a.local, save: a.save });
      })
    .command("connect <url>", "Use a URL from another machine (checks it first; asks: this project or every project)", y => y
      .positional("url", { type: "string", demandOption: true, describe: "The URL printed by `rech share <profile>` on the machine with Chrome. Quote it: it contains #" })
      .option("project", { type: "boolean", describe: "Save it for this project only (.rechrome/.env.local); the default without a terminal" })
      .option("global", { type: "boolean", describe: "Save it for every project on this machine without its own link (~/.rechrome/.env.local)" })
      .conflicts("project", "global")
      .example("rech connect 'https://host.example.ts.net/rechrome/?profile=you%40example.com#key=…'", "")
      .example("rech connect --global '<url>'", "An agent machine: one link for every folder, /tmp included"),
      a => a.global || a.project ? handlers.connect(a.url, { global: a.global, project: a.project }) : handlers.connect(a.url))
    .command(["listener", "listeners"], "Control who can connect: listeners, allowed profiles, keys, public URLs", y => y
      .command(["ls", "list", "$0"], "List listeners (keys hidden)", {}, () => handlers.listListeners())
      .command("add <name>", "Expose registered profiles on an address (local for a proxy, lan, tailscale, IP)", y => y
        .positional("name", { type: "string", demandOption: true })
        .option("listen", { type: "string", requiresArg: true, demandOption: true, describe: "local | lan | tailscale | <detected IP>" })
        .option("profile", { type: "string", array: true, requiresArg: true, demandOption: true, describe: "Allowed profile; repeat for several" })
        .option("port", portOption)
        .option("prefix", { type: "string", requiresArg: true, describe: "URL path prefix, e.g. rechrome" }),
        a => handlers.addListener(a.name, { listen: a.listen, profile: a.profile, port: a.port, prefix: a.prefix }))
      .command("allow <name> <profiles..>", "Allow more profiles on a listener", y => y
        .positional("name", { type: "string", demandOption: true }).positional("profiles", { type: "string", array: true, demandOption: true }),
        a => handlers.allowListener(a.name, a.profiles))
      .command("deny <name> <profiles..>", "Remove profiles from a listener", y => y
        .positional("name", { type: "string", demandOption: true }).positional("profiles", { type: "string", array: true, demandOption: true }),
        a => handlers.denyListener(a.name, a.profiles))
      .command("set <name>", "Record where a reverse proxy exposes a listener", y => y
        .positional("name", { type: "string", demandOption: true })
        .option("public-url", { type: "string", requiresArg: true, describe: "e.g. https://host.example.ts.net/rechrome/" })
        .option("clear-public-url", { type: "boolean", conflicts: "public-url" })
        .check(a => a.publicUrl !== undefined || a.clearPublicUrl ? true : "Pass --public-url <url> or --clear-public-url"),
        a => handlers.setListener(a.name, { publicUrl: a.publicUrl, clearPublicUrl: a.clearPublicUrl }))
      .command("port [name]", "Print a listener's port (for a proxy command)", y => y.positional("name", { type: "string" }),
        a => handlers.listenerPort(a.name))
      .command("rotate-key <name>", "Give a listener a new key (old URLs stop working)", y => y.positional("name", { type: "string", demandOption: true }),
        a => handlers.rotateKey(a.name))
      .command("remove <name>", "Remove a listener", y => y.positional("name", { type: "string", demandOption: true }),
        a => handlers.removeListener(a.name))
      .demandCommand(1).strict())
    // Daemon and extras
    .command("tray [action]", "Menu-bar icon for the daemon (starts after setup)", y => y
      .positional("action", { type: "string", choices: ["show", "start", "hide", "stop", "quit"] }),
      a => handlers.tray(a.action))
    .command("provision-profile <name>", "(experimental) Clean Chrome-for-Testing profile, fully automated; not your real Chrome", y => y
      .positional("name", { type: "string", demandOption: true })
      .option("experimental", { type: "boolean", default: false })
      .option("headed", { type: "boolean", default: false }),
      a => handlers.provisionProfile(a.name, { headed: a.headed, experimental: a.experimental }))
    .command("uninstall", "Stop and remove the daemon", {}, () => handlers.uninstall())
    .command("serve", "Run the daemon in the foreground (normally managed by oxmgr)", {}, () => handlers.serve())
    .demandCommand(1)
    .strict()
    .help()
    .alias("help", "h")
    .version(false)
    // A parse error (missing argument, unknown option…) shows that command's help above the
    // error, so the fix is visible. Errors thrown by a command's own handler pass through.
    .fail((message, error, y) => {
      if (error) throw error;
      // Straight to stderr: Bun's console.error would paint the whole help red.
      y.showHelp((help: string) => process.stderr.write(`${help}\n\n`));
      throw new Error(`rech: ${/^Not enough non-option arguments/.test(message) ? "missing a required argument; see the usage line above" : message}`);
    });
}

if (import.meta.main) {
  let args = process.argv.slice(2);
  const cmd = args[0]?.toLowerCase();

  const handlers: RechHandlers = {
    serve: async () => { const { serve } = await import("./serve.ts"); serve(); }, // long-lived; watcher intentionally kept alive
    status,
    listListeners, addListener, removeListener, printProfileUri,
    listProfiles: async () => {
      const url = process.env[ENV_KEY];
      return url && !(await isLocalDaemon(url)) ? listRemoteProfiles(url) : listProfiles();
    },
    urlList, shareProfiles, removeProfile, connect, listenerPort, allowListener, denyListener, rotateKey, setListener,
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

  if (cmd && RECH_COMMANDS.has(cmd)) {
    try {
      await rechCli([cmd, ...args.slice(1)], handlers).parseAsync();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      if (cmd !== "serve") envWatcher?.close();
    }
  } else if (cmd === "--version") {
    console.log(rechromeVersion()); // playwright-cli's own: rech pw --version
    envWatcher?.close();
  } else if (cmd === "help" || cmd === "--help" || cmd === "-h" || args.length === 0) {
    try { await rechCli(["--help"], handlers).parseAsync(); }
    finally { envWatcher?.close(); }
  } else {
    const url = process.env[ENV_KEY];
    if (!url) {
      console.error(notConnectedMessage());
      process.exit(1);
    }
    // --profile: target a registered Chrome profile globally (see extractGlobalProfileArg for
    // the leading-flags-only rule that protects the forwarded CLI's own --profile).
    let profileSelector: string | undefined;
    let overrideEnv: Record<string, string> | undefined;
    // Everything after rech's `pw` (or `--`) goes to playwright-cli untouched; only the flags before it are rech's.
    const separator = rechSeparatorIndex(args);
    const forwarded = separator === -1 ? [] : args.slice(separator + 1);
    if (separator !== -1) args = args.slice(0, separator);
    try {
      const extracted = extractGlobalProfileArg(args);
      profileSelector = extracted.selector;
      args = extracted.args;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      envWatcher?.close();
      process.exit(1);
    }
    if (profileSelector !== undefined && !(await isLocalDaemon(url))) {
      // A remote host resolves the name among the profiles its link shares; this machine's
      // registry is irrelevant (and usually empty on a client).
      overrideEnv = { PLAYWRIGHT_MCP_PROFILE_DIRECTORY: profileSelector.trim() };
    } else if (profileSelector !== undefined) {
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
    args = [...forwarded, ...args];
    await run(url, args, overrideEnv, { verbatim: separator !== -1 });
    envWatcher?.close();
  }
}
