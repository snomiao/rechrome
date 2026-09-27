import { isIP } from "net";
import { createHash, randomBytes } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { mkdir, readFile, rename, writeFile } from "fs/promises";

export type Listener = { name: string; host: string; port: number; key: string; profiles: string[] | "*"; prefix?: string };
export type ListenerConfig = { version: 1; listeners: Listener[] };
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

export function validateListeners(value: unknown): ListenerConfig {
  const config = value as ListenerConfig;
  if (config?.version !== 1 || !Array.isArray(config.listeners) || !config.listeners.length) throw new Error("listeners.json requires version 1 and at least one listener");
  const names = new Set<string>(), addresses = new Set<string>(), keys = new Set<string>();
  for (const l of config.listeners) {
    if (!l || !/^[a-zA-Z0-9_-]+$/.test(l.name) || typeof l.host !== "string" || !isIP(l.host) || ["0.0.0.0", "::"].includes(l.host)
      || !Number.isInteger(l.port) || l.port < 1 || l.port > 65535 || typeof l.key !== "string" || l.key.length < 16)
      throw new Error("Each listener needs a name, concrete IP, valid port, and bearer key of at least 16 characters");
    l.prefix = normalizePrefix(l.prefix);
    if (l.profiles === "*") {
      if (!isLoopback(l.host)) throw new Error("Unrestricted management listeners must bind to loopback");
    } else if (!Array.isArray(l.profiles) || !l.profiles.length || l.profiles.some(p => typeof p !== "string" || !p.trim() || p.includes("\0") || p === "*")) {
      throw new Error("Listener profiles must be a nonempty list of registered profile keys");
    }
    const address = listenerAddress(l);
    if (names.has(l.name) || addresses.has(address) || keys.has(l.key)) throw new Error("Listener names, addresses, and credentials must be unique");
    names.add(l.name); addresses.add(address); keys.add(l.key);
  }
  return config;
}

export async function readListeners(): Promise<ListenerConfig | null> {
  let raw: string;
  try { raw = await readFile(LISTENERS_FILE, "utf8"); }
  catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
  return validateListeners(JSON.parse(raw));
}

export async function writeListeners(config: ListenerConfig): Promise<void> {
  validateListeners(config);
  await mkdir(join(homedir(), ".rechrome"), { recursive: true });
  const temp = `${LISTENERS_FILE}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, LISTENERS_FILE);
}

// Restricted listeners deliberately exclude arbitrary code, host filesystem access,
// attachment/config overrides, and commands that manage all browser sessions.
const SCOPED_COMMANDS = new Set(["open", "goto", "tab-new", "tab-list", "tab-select", "tab-close", "snapshot", "screenshot", "click", "dblclick", "fill", "type", "press", "hover", "select", "check", "uncheck", "go-back", "go-forward", "reload", "resize", "close"]);
export function authorizeProfileRequest(listener: Listener, body: any): string {
  if (!body || Array.isArray(body) || !body.identity || typeof body.identity.key !== "string" || !body.identity.key || !Array.isArray(body.args) || body.args.some((a: unknown) => typeof a !== "string")) throw new Error("Scoped requests require identity.key, identity.profile and string args");
  const profile = body.identity.profile;
  if (typeof profile !== "string" || listener.profiles === "*" || !listener.profiles.includes(profile)) throw new Error("Profile is not allowed on this listener");
  if (body.env?.PLAYWRIGHT_MCP_PROFILE_DIRECTORY && body.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY !== profile) throw new Error("Profile override does not match request identity");
  const args = body.args.filter((a: string) => /^-s=[a-zA-Z0-9_-]{1,64}$/.test(a) === false);
  if (!SCOPED_COMMANDS.has(args[0])) throw new Error("Command is unavailable on profile-scoped listeners; use the local management listener for arbitrary code or host access");
  if (body.args.filter((a: string) => a.startsWith("-s=")).length > 1 || args.slice(1).some((a: string) => a.startsWith("-") && !(args[0] === "screenshot" && a === "--full-page"))) throw new Error("CLI option overrides are unavailable on profile-scoped listeners");
  if (["open", "goto", "tab-new"].includes(args[0]) && args[1] && !/^https?:\/\//i.test(args[1]) && args[1] !== "about:blank") throw new Error("Scoped navigation accepts only HTTP(S) or about:blank");
  return profile;
}

export function canReadProfileFile(listener: Listener, path: string): boolean {
  return listener.profiles === "*" || listener.profiles.some(p => path.startsWith(profileOutputPrefix(p)));
}
