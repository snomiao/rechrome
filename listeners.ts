import { validateUploadPolicy, type UploadPolicy } from "./scoped-upload.ts";
import { isIP } from "net";
import { createHash, randomBytes } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { DEFAULT_RTC, DEFAULT_SIGNAL, normalizeSignal } from "./shares.ts";

// eval grants page-context JavaScript only; never host-process run-code or raw CDP.
// publicUrl: where a reverse proxy (Tailscale Serve, Caddy, nginx, ...) exposes this listener.
export type Listener = { name: string; host: string; port: number; key: string; profiles: string[] | "*"; prefix?: string; publicUrl?: string; uploads?: UploadPolicy | false; readSecrets?: boolean; readCookies?: boolean; readHeaders?: boolean; keepDownloads?: boolean; eval?: boolean };
// retiredPorts: ports of removed listeners, newest last. New listeners skip them so a link
// saved for a removed listener gets "connection refused", not some other listener's answer.
// rtcListeners: WebRTC transports (a signal server, plus optional STUN/TURN). They live under
// their own key so a daemon from before they existed reads the file unchanged and ignores them.
export type ListenerConfig = { version: 1; listeners: Listener[]; retiredPorts?: number[]; rtcListeners?: RtcListener[] };
export type IceServer = { urls: string | string[]; username?: string; credential?: string };
export type RtcListener = { name: string; kind: "webrtc"; signal: string; ice?: IceServer[]; builtin?: true };

// The built-in WebRTC listener: the public signal server, for trying sharing out. Never written
// to listeners.json; a share names it in `via`. The legacy `via: ["webrtc"]` (+ share.signal)
// maps to a virtual listener named "webrtc".
export { DEFAULT_RTC };
export const LEGACY_RTC = "webrtc";
export const DEFAULT_RTC_NOTE = "best effort, for trying it out: no speed or uptime promise. Host your own: rech listener add <name> --webrtc=<url>";
export const defaultRtcListener = (): RtcListener => ({ name: DEFAULT_RTC, kind: "webrtc", signal: DEFAULT_SIGNAL, builtin: true });

/** Every WebRTC listener a share can name: the saved ones plus the built-in default. */
export function rtcListeners(config: ListenerConfig | null): RtcListener[] {
  return [...(config?.rtcListeners ?? []), defaultRtcListener()];
}

/** The WebRTC listeners a share is offered on, in `via` order. */
export function shareRtcListeners(share: { via: string[]; signal?: string }, config: ListenerConfig | null): RtcListener[] {
  const all = rtcListeners(config);
  const out: RtcListener[] = [];
  for (const via of share.via) {
    if (via === LEGACY_RTC) out.push({ name: LEGACY_RTC, kind: "webrtc", signal: normalizeSignal(share.signal ?? DEFAULT_SIGNAL), builtin: true });
    else { const l = all.find(x => x.name === via); if (l) out.push(l); }
  }
  return out;
}

/**
 * One STUN/TURN server from a URL: `turn[s]://user:pass@host:port?transport=tcp` (user and
 * password percent-encoded) becomes {urls: "turn[s]:host:port?transport=tcp", username, credential}.
 * `stun:host:port` and `turn:host:port` without credentials are accepted as they are.
 */
export function parseIceUrl(value: string): IceServer {
  const raw = value.trim();
  const m = /^(stuns?|turns?):(?:\/\/)?(?:([^:@/\s]*)(?::([^@/\s]*))?@)?([^/?#@\s]+)(\?[^#]*)?$/i.exec(raw);
  if (!m) throw new Error("A STUN/TURN server is a URL like turns://user:pass@turn.example.com:5349 or stun:stun.example.com:3478");
  const [, scheme, user, pass, hostPort, query = ""] = m;
  const kind = scheme!.toLowerCase();
  if (query && !/^\?transport=(udp|tcp)$/i.test(query)) throw new Error("A STUN/TURN URL may only carry ?transport=udp or ?transport=tcp");
  const urls = `${kind}:${hostPort}${query}`;
  if (user === undefined) return { urls };
  if (kind.startsWith("stun")) throw new Error("A STUN server takes no username or password");
  let username: string, credential: string;
  try { username = decodeURIComponent(user); credential = decodeURIComponent(pass ?? ""); }
  catch { throw new Error("The TURN username or password has a bad %-escape"); }
  if (!username || !credential) throw new Error("A TURN URL with credentials needs both: turns://user:pass@host:port");
  return { urls, username, credential };
}

/** How a STUN/TURN server is shown: the username, never the password. */
export function iceLabel(s: IceServer): string {
  const url = [s.urls].flat()[0] ?? "";
  if (!s.username) return url;
  const [scheme, ...rest] = url.split(":");
  return `${scheme}://${encodeURIComponent(s.username)}:…@${rest.join(":")}`;
}

function validateRtcListeners(value: unknown, socketNames: Set<string>): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error("listeners.json rtcListeners must be a list");
  const names = new Set<string>();
  for (const l of value as RtcListener[]) {
    if (!l || l.kind !== "webrtc" || typeof l.name !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(l.name) || typeof l.signal !== "string")
      throw new Error("Each WebRTC listener needs a name and a signal server URL");
    if (l.name === DEFAULT_RTC || l.name === LEGACY_RTC || names.has(l.name) || socketNames.has(l.name))
      throw new Error(`Listener names must be unique ("${DEFAULT_RTC}" and "${LEGACY_RTC}" are built in)`);
    l.signal = normalizeSignal(l.signal);
    if (l.ice !== undefined && (!Array.isArray(l.ice) || l.ice.some(s => !s || (typeof s.urls !== "string" && !Array.isArray(s.urls))
      || (s.username !== undefined && typeof s.username !== "string") || (s.credential !== undefined && typeof s.credential !== "string"))))
      throw new Error(`WebRTC listener "${l.name}": ice must be a list of {urls, username?, credential?}`);
    delete l.builtin;
    names.add(l.name);
  }
}
const MAX_RETIRED_PORTS = 32;
export const LISTENERS_FILE = join(homedir(), ".rechrome", "listeners.json");
export const isLoopback = (host: string) => host === "::1" || /^127\./.test(host);
export const listenerAddress = (l: Listener) => `${l.host.includes(":") ? `[${l.host}]` : l.host}:${l.port}`;
export const profileOutputPrefix = (profile: string) => `profiles/${createHash("sha256").update(profile).digest("hex")}/`;

export function normalizePrefix(value = "/"): string {
  if (typeof value !== "string") throw new Error("Prefix must be a URL path");
  const path = value.replace(/^\/+|\/+$/g, "");
  if (!path) return "/";
  if (path.split("/").some(segment => !/^[A-Za-z0-9._~-]+$/.test(segment) || segment === "." || segment === ".."))
    throw new Error("Prefix must contain URL path segments, without queries, escapes, or traversal");
  return `/${path}/`;
}

/** Build an API endpoint without forwarding connection credentials or profile query params. */
export function serviceUrl(raw: string, route = ""): string {
  const source = new URL(raw);
  const result = new URL(`${source.protocol === "https:" ? "https:" : "http:"}//${source.host}`);
  result.pathname = normalizePrefix(source.pathname) + route.replace(/^\/+/, "");
  return result.toString();
}

/** A public base URL: http(s), no credentials, query or fragment (the key never lives here). */
export function normalizePublicUrl(value: unknown): string {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new Error(`Public URL must be an absolute http(s) URL, e.g. https://host.example.ts.net/rechrome/`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Public URL must be plain http(s), without credentials, query, or fragment");
  url.pathname = normalizePrefix(url.pathname);
  return url.toString();
}

export function validateListeners(value: unknown): ListenerConfig {
  const config = value as ListenerConfig;
  if (config?.version !== 1 || !Array.isArray(config.listeners) || !config.listeners.length) throw new Error("listeners.json requires version 1 and at least one listener");
  const names = new Set<string>(), addresses = new Set<string>(), keys = new Set<string>();
  for (const l of config.listeners) {
    if (!l || !/^[a-zA-Z0-9_-]+$/.test(l.name) || typeof l.host !== "string" || !isIP(l.host) || ["0.0.0.0", "::"].includes(l.host)
      || !Number.isInteger(l.port) || l.port < 1 || l.port > 65535 || typeof l.key !== "string" || l.key.length < 16)
      throw new Error("Each listener needs a name, concrete IP, valid port, and bearer key of at least 16 characters");
    l.prefix = normalizePrefix(l.prefix);
    if (l.publicUrl !== undefined) l.publicUrl = normalizePublicUrl(l.publicUrl);
    if (l.profiles === "*") {
      if (!isLoopback(l.host)) throw new Error("Unrestricted management listeners must bind to loopback");
    } else if (!Array.isArray(l.profiles) || !l.profiles.length || l.profiles.some(p => typeof p !== "string" || !p.trim() || p.includes("\0") || p === "*")) {
      throw new Error("Listener profiles must be a nonempty list of registered profile keys");
    }
    // Uploads are on unless set to false: the client sends file bytes it already has, and the
    // host never reads a path for them.
    if (l.uploads !== undefined && l.uploads !== false) validateUploadPolicy(l.uploads);
    if (l.readSecrets !== undefined && typeof l.readSecrets !== "boolean") throw new Error("readSecrets must be true or false");
    if (l.readCookies !== undefined && typeof l.readCookies !== "boolean") throw new Error("readCookies must be true or false");
    if (l.readHeaders !== undefined && typeof l.readHeaders !== "boolean") throw new Error("readHeaders must be true or false");
    if (l.eval !== undefined && typeof l.eval !== "boolean") throw new Error("eval must be true or false");
    if (l.keepDownloads !== undefined && typeof l.keepDownloads !== "boolean") throw new Error("keepDownloads must be true or false");
    const address = listenerAddress(l);
    if (names.has(l.name) || addresses.has(address) || keys.has(l.key)) throw new Error("Listener names, addresses, and credentials must be unique");
    names.add(l.name); addresses.add(address); keys.add(l.key);
  }
  validateRtcListeners(config.rtcListeners, names);
  if (config.retiredPorts !== undefined && (!Array.isArray(config.retiredPorts) || config.retiredPorts.some(p => !Number.isInteger(p) || p < 1 || p > 65535)))
    throw new Error("listeners.json retiredPorts must be a list of ports");
  return config;
}

export async function readListeners(): Promise<ListenerConfig | null> {
  let raw: string;
  try { raw = await readFile(LISTENERS_FILE, "utf8"); }
  catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
  return validateListeners(JSON.parse(raw));
}

/** `previous`'s retired ports plus the ports its listeners used that `next` no longer does. */
export function retirePorts(previous: ListenerConfig | null, next: ListenerConfig): number[] {
  const inUse = new Set(next.listeners.map(l => l.port));
  const freed = (previous?.listeners ?? []).map(l => l.port).filter(p => !inUse.has(p));
  const merged = [...(previous?.retiredPorts ?? []), ...(next.retiredPorts ?? []), ...freed].filter(p => !inUse.has(p));
  return [...new Set(merged.reverse())].reverse().slice(-MAX_RETIRED_PORTS);
}

export async function writeListeners(config: ListenerConfig): Promise<void> {
  validateListeners(config);
  const previous = await readListeners().catch(() => null);
  const retired = retirePorts(previous, config);
  if (retired.length) config.retiredPorts = retired; else delete config.retiredPorts;
  await mkdir(join(homedir(), ".rechrome"), { recursive: true });
  const temp = `${LISTENERS_FILE}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, LISTENERS_FILE);
}

// Restricted listeners deliberately exclude arbitrary code, host filesystem access,
// attachment/config overrides, and commands that manage all browser sessions.
// mousemove/mousedown/mouseup/mousewheel/drag are page-level input in the same risk class as
// click/hover/type: they dispatch synthetic input to the page, with no host access and no raw CDP.
const SCOPED_COMMANDS = new Set(["open", "goto", "tab-new", "tab-list", "tab-select", "tab-close", "snapshot", "screenshot", "click", "dblclick", "drag", "fill", "type", "press", "hover", "mousemove", "mousedown", "mouseup", "mousewheel", "select", "check", "uncheck", "go-back", "go-forward", "reload", "resize", "close", "fill-secret", "console", "dialog-accept", "dialog-dismiss", "record"]);
// The CLI options each scoped command may carry (everything else is refused). record uses a
// start/stop subcommand (a positional) plus these capture/output knobs (record.ts RECORD_OPTIONS).
const RECORD_SCOPED_OPTS = ["--seconds", "--max-seconds", "--fps", "--quality", "--filename", "--format"];
export function authorizeProfileRequest(listener: Listener, body: any): string {
  if (!body || Array.isArray(body) || !body.identity || typeof body.identity.key !== "string" || !body.identity.key || !Array.isArray(body.args) || body.args.some((a: unknown) => typeof a !== "string")) throw new Error("Scoped requests require identity.key, identity.profile and string args");
  const profile = body.identity.profile;
  if (typeof profile !== "string" || listener.profiles === "*" || !listener.profiles.includes(profile)) throw new Error("Profile is not allowed on this listener");
  if (body.env?.PLAYWRIGHT_MCP_PROFILE_DIRECTORY && body.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY !== profile) throw new Error("Profile override does not match request identity");
  const args = body.args.filter((a: string) => /^-s=[a-zA-Z0-9_-]{1,64}$/.test(a) === false);
  if (args[0] === "upload" && listener.uploads === false)
    throw new Error(`Uploads are off on listener "${listener.name}". The host can turn them on: rech listener set ${listener.name} --uploads`);
  if (args[0] === "read-secret" && listener.readSecrets !== true)
    throw new Error(`read-secret is off on listener "${listener.name}". The host can turn it on: rech listener set ${listener.name} --read-secrets`);
  if (args[0] === "read-storage" && listener.readSecrets !== true)
    throw new Error(`read-storage is off on listener "${listener.name}". The host can turn it on: rech listener set ${listener.name} --read-secrets`);
  if (args[0] === "read-cookie" && listener.readCookies !== true)
    throw new Error(`read-cookie is off on listener "${listener.name}". The host can turn it on: rech listener set ${listener.name} --read-cookies`);
  if (args[0] === "read-headers" && listener.readHeaders !== true)
    throw new Error(`read-headers is off on listener "${listener.name}". The host can turn it on: rech listener set ${listener.name} --read-headers`);
  if (args[0] !== "upload" && args[0] !== "read-secret" && args[0] !== "read-cookie" && args[0] !== "read-storage" && args[0] !== "read-headers" && !(args[0] === "eval" && listener.eval === true) && !SCOPED_COMMANDS.has(args[0])) throw new Error("Command is unavailable on profile-scoped listeners; use the local management listener for arbitrary code or host access");
  if (body.args.filter((a: string) => a.startsWith("-s=")).length > 1 || args.slice(1).some((a: string) => a.startsWith("-") && !(args[0] === "screenshot" && a === "--full-page") && !(args[0] === "console" && a === "--clear") && !(args[0] === "fill-secret" && (a === "--submit" || a === "--totp" || a.startsWith("--allow-domain="))) && !(args[0] === "read-secret" && a.startsWith("--allow-domain=")) && !(args[0] === "read-cookie" && a.startsWith("--allow-domain=")) && !(args[0] === "read-storage" && (a.startsWith("--allow-domain=") || a.startsWith("--goto="))) && !(args[0] === "read-headers" && (a.startsWith("--allow-domain=") || a.startsWith("--seconds=") || a.startsWith("--goto="))) && !(args[0] === "record" && RECORD_SCOPED_OPTS.some(o => a === o || a.startsWith(o + "="))) && !((args[0] === "mousewheel" || args[0] === "mousemove") && /^-?\d+(?:\.\d+)?$/.test(a)))) throw new Error("CLI option overrides are unavailable on profile-scoped listeners");
  if (["open", "goto", "tab-new"].includes(args[0]) && args[1] && !/^https?:\/\//i.test(args[1]) && args[1] !== "about:blank") throw new Error("Scoped navigation accepts only HTTP(S) or about:blank");
  // Upload is handled by the byte-only receiver; the caller cannot supply host paths.
  if (args[0] === "upload" && (args.length !== 1 || !body.upload)) throw new Error("Upload requires stdin bytes; host paths are unavailable");
  if (args[0] !== "upload" && body.upload !== undefined) throw new Error("Unexpected upload payload");
  return profile;
}

export function canReadProfileFile(listener: Listener, path: string): boolean {
  return listener.profiles === "*" || listener.profiles.some(p => path.startsWith(profileOutputPrefix(p)));
}

function scopedListener(config: ListenerConfig, name: string): Listener & { profiles: string[] } {
  const listener = config.listeners.find(l => l.name === name);
  if (!listener) throw new Error(`Unknown listener "${name}". See rech listener ls.`);
  if (listener.profiles === "*") throw new Error(`"${name}" is the local management listener; it already serves every profile and its key is the daemon's own.`);
  return listener as Listener & { profiles: string[] };
}

/** Add profiles to a scoped listener's allowlist. Returns the profiles newly added. */
export function allowProfiles(config: ListenerConfig, name: string, profiles: string[]): string[] {
  const listener = scopedListener(config, name);
  const added = [...new Set(profiles)].filter(p => !listener.profiles.includes(p));
  listener.profiles.push(...added);
  return added;
}

/** Remove profiles from a scoped listener's allowlist. Returns the profiles removed. */
export function denyProfiles(config: ListenerConfig, name: string, profiles: string[]): string[] {
  const listener = scopedListener(config, name);
  const removed = listener.profiles.filter(p => profiles.includes(p));
  const remaining = listener.profiles.filter(p => !profiles.includes(p));
  if (!remaining.length) throw new Error(`That would leave "${name}" with no profiles; remove it instead: rech listener remove ${name}`);
  listener.profiles = remaining;
  return removed;
}

/** Give a scoped listener a new bearer key; URLs carrying the old key stop working. */
export function rotateListenerKey(config: ListenerConfig, name: string): string {
  const listener = scopedListener(config, name);
  listener.key = randomBytes(24).toString("base64url");
  return listener.key;
}

/** Record (or with null, forget) where a proxy exposes a listener. */
export function setPublicUrl(config: ListenerConfig, name: string, publicUrl: string | null): Listener {
  const listener = config.listeners.find(l => l.name === name);
  if (!listener) throw new Error(`Unknown listener "${name}". See rech listener ls.`);
  if (publicUrl === null) delete listener.publicUrl;
  else listener.publicUrl = normalizePublicUrl(publicUrl);
  return listener;
}

/** What the resolver needs from a registry entry: which Chrome profile it points at. */
export type RegisteredProfile = { profileDir: string; userDataDir?: string };
const profileIdentity = (e: RegisteredProfile) => `${e.userDataDir ?? ""}\0${e.profileDir}`;

/**
 * One registry key per Chrome profile (a profile can be registered under several aliases,
 * e.g. "Profile 5" and "personal"): prefer an email, else the alphabetically first key.
 */
export function canonicalProfileKeys(registry: Record<string, RegisteredProfile>): string[] {
  const byProfile = new Map<string, string>();
  for (const key of Object.keys(registry).sort()) {
    const id = profileIdentity(registry[key]);
    const kept = byProfile.get(id);
    if (!kept || (!kept.includes("@") && key.includes("@"))) byProfile.set(id, key);
  }
  return [...byProfile.values()];
}

/**
 * Resolve what a remote client typed (`rech --profile work`) to one allowed registry key, on
 * the host, so the client needs no registry of its own. Aliases of an allowed profile map to
 * it, so they share one session. Matching: exact key, alias, folder or Chrome name
 * (case-insensitive), then the email part before "@", then a unique 3+ character prefix.
 * Ambiguity and misses list the allowed profiles; nothing outside the allowlist can match.
 */
export function resolveAllowedProfile(
  selector: string | undefined, allowed: string[], registry: Record<string, RegisteredProfile>,
  chromeNames: Record<string, string> = {},
): string {
  const list = allowed.join(", ");
  if (!selector?.trim()) throw new Error(`Pick a profile: this link shares ${list}. For example: rech --profile ${JSON.stringify(allowed[0] ?? "<name>")} open https://example.com`);
  const needle = selector.trim().toLowerCase();
  const candidates = allowed.filter(k => registry[k]).map(key => {
    const entry = registry[key];
    const aliases = Object.keys(registry).filter(k => profileIdentity(registry[k]) === profileIdentity(entry));
    const name = entry.userDataDir ? undefined : chromeNames[entry.profileDir];
    const fields = [...new Set([...aliases, entry.profileDir, ...(name ? [name] : [])])].map(f => f.toLowerCase());
    return { key, fields, localParts: fields.filter(f => f.includes("@")).map(f => f.split("@")[0]) };
  });
  const stages: Array<(c: typeof candidates[number]) => boolean> = [
    c => c.fields.includes(needle),
    c => c.localParts.includes(needle),
    c => needle.length >= 3 && c.fields.some(f => f.startsWith(needle)),
  ];
  for (const test of stages) {
    const hits = candidates.filter(test);
    if (hits.length === 1) return hits[0].key;
    if (hits.length > 1) throw new Error(`"${selector}" matches several shared profiles (${hits.map(h => h.key).join(", ")}); be more specific.`);
  }
  throw new Error(`"${selector}" is not shared by this link. It shares: ${list}.`);
}

export type ProfileRemovalPlan = {
  keys: string[];                                              // every registry alias of the profile
  listeners: { name: string; remove: string[]; drop: boolean }[];  // allowlist edits; drop = no profiles left
  dataDir?: string;                                            // a managed profile's own folder (never real Chrome data)
};

/**
 * What `rech profile rm` would change for one registry key: all aliases of that Chrome profile,
 * their listener entries (dropping a listener left empty), and, for a managed test profile
 * whose data lives under `managedRoot`, its folder. Real Chrome profiles only get unregistered.
 */
export function planProfileRemoval(
  key: string, registry: Record<string, RegisteredProfile & { loadExtension?: string }>, listeners: Listener[], managedRoot: string,
): ProfileRemovalPlan {
  const entry = registry[key];
  if (!entry) throw new Error(`"${key}" is not a registered profile.`);
  const keys = Object.keys(registry).filter(k => profileIdentity(registry[k]) === profileIdentity(entry));
  const edits = listeners.filter(l => l.profiles !== "*" && l.profiles.some(p => keys.includes(p)))
    .map(l => ({ name: l.name, remove: (l.profiles as string[]).filter(p => keys.includes(p)), drop: (l.profiles as string[]).every(p => keys.includes(p)) }));
  const root = managedRoot.replace(/[\\/]+$/, "");
  const managed = !!entry.loadExtension && !!entry.userDataDir && (entry.userDataDir.startsWith(root + "/") || entry.userDataDir.startsWith(root + "\\"));
  return { keys, listeners: edits, ...(managed ? { dataDir: entry.userDataDir } : {}) };
}
