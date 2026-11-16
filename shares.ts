// Shares: who may connect, to which profiles, over which transports.
//
// A listener is a transport (an address); a share is a grant on one or more transports. Each
// share has an invite (a rech1_ token) that is used up as devices redeem it: a redeemed device
// gets its own rech1_ credential, so a link that leaks after it was used no longer works, and
// the host can see, approve and drop each device. Legacy listener keys (#key=…) stay valid as
// they are; shares are an additional way in.
import { randomBytes } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { mkdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { bearerOf, credentialIdOf, newToken, parseToken, safeEqual } from "./secret.ts";

export const WEBRTC = "webrtc";
export const DEFAULT_SIGNAL = "https://rechrome.pages.dev/";
// The built-in WebRTC listener's name (see listeners.ts): the public signal server above.
export const DEFAULT_RTC = "webrtc-default";
export const SHARES_FILE = join(homedir(), ".rechrome", "shares.json");

export type Device = { id: string; name: string; token: string; addedAt: number; lastSeen?: number; approved: boolean };
export type Share = {
  id: string;
  label: string;
  invite: string;            // rech1_ token; replaced by rotate
  inviteExpiresAt?: number;  // unused invites stop working after this
  inviteTtlMs?: number;      // how long each new invite stays usable (rotate reuses it)
  profiles: string[];
  via: string[];             // listener names, and/or "webrtc"
  signal?: string;           // signal server origin, for webrtc
  createdAt: number;
  expiresAt?: number;
  maxDevices: number;
  approve: boolean;          // each new device waits for `rech share approve`
  reusable?: boolean;        // the invite is not used up by one device: many redeem it (up to maxDevices) until it expires or is rotated
  redeemed?: number;         // how many times the invite was redeemed (devices removed since still count)
  devices: Device[];
  revokedAt?: number;
  eval?: boolean;            // this share's devices may run `eval` (page JS) on its profiles, even if the listener doesn't allow eval
};
export type ShareConfig = { version: 1; shares: Share[] };

const LABEL = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function validateShares(value: unknown): ShareConfig {
  const config = value as ShareConfig;
  if (config?.version !== 1 || !Array.isArray(config.shares)) throw new Error("shares.json requires version 1 and a shares list");
  const labels = new Set<string>();
  for (const s of config.shares) {
    if (!s || typeof s.id !== "string" || !LABEL.test(s.label) || typeof s.invite !== "string" || !Array.isArray(s.profiles)
      || !Array.isArray(s.via) || !s.via.length || !Array.isArray(s.devices) || !Number.isInteger(s.maxDevices) || s.maxDevices < 1
      || (s.eval !== undefined && typeof s.eval !== "boolean"))
      throw new Error(`shares.json: malformed share ${JSON.stringify(s?.label ?? s?.id ?? "?")}`);
    if (labels.has(s.label)) throw new Error(`shares.json: duplicate share name "${s.label}"`);
    labels.add(s.label);
  }
  return config;
}

export async function readShares(path = SHARES_FILE): Promise<ShareConfig> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error: any) { if (error.code === "ENOENT") return { version: 1, shares: [] }; throw error; }
  return validateShares(JSON.parse(raw));
}

export async function writeShares(config: ShareConfig, path = SHARES_FILE): Promise<void> {
  validateShares(config);
  await mkdir(join(path, ".."), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}

/**
 * Read-modify-write under a lock directory, so the daemon (redeeming invites, noting device
 * use) and the CLI (allow, revoke, approve) can't drop each other's changes.
 */
export async function updateShares<T>(fn: (config: ShareConfig) => T | Promise<T>, path = SHARES_FILE): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(join(path, ".."), { recursive: true });
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      // Break a lock only when its owner is gone (crashed) or it is far past any real write.
      if (await staleLock(lock)) { await rm(lock, { recursive: true, force: true }); continue; }
      await new Promise(r => setTimeout(r, 25 + Math.random() * 50));
    }
  }
  await writeFile(join(lock, "owner"), JSON.stringify({ pid: process.pid, at: Date.now() }));
  try {
    const config = await readShares(path);
    const result = await fn(config);
    await writeShares(config, path);
    return result;
  } finally { await rm(lock, { recursive: true, force: true }); }
}

async function staleLock(lock: string): Promise<boolean> {
  try {
    const { pid, at } = JSON.parse(await readFile(join(lock, "owner"), "utf8"));
    if (Date.now() - at > 30_000) return true;
    try { process.kill(pid, 0); return false; } catch (error: any) { return error.code === "ESRCH"; }
  } catch {
    // No owner file yet: the holder is between mkdir and writing it; stale only if old.
    const st = await stat(lock).catch(() => null);
    return !!st && Date.now() - st.mtimeMs > 30_000;
  }
}

export function findShare(config: ShareConfig, name: string): Share {
  const share = config.shares.find(s => s.label === name || s.id === name);
  if (!share) throw new Error(`No share named "${name}". See: rech share ls`);
  return share;
}

export type NewShareOptions = {
  label: string; profiles: string[]; via: string[]; signal?: string;
  expiresAt?: number; inviteTtlMs?: number; maxDevices?: number; approve?: boolean; reusable?: boolean; eval?: boolean; now?: number;
};

/** Device cap of a reusable invite when --devices isn't given: bounds what a leaked link can enroll. */
export const REUSABLE_MAX_DEVICES = 100;
/** Invite lifetime of a reusable invite when --ttl isn't given. */
export const REUSABLE_DEFAULT_TTL = "7d";

export function createShare(config: ShareConfig, opts: NewShareOptions): Share {
  const now = opts.now ?? Date.now();
  if (!LABEL.test(opts.label)) throw new Error(`Share names use a-z, 0-9, "-" and "_" (up to 40), e.g. alice or ci-bot; got "${opts.label}"`);
  if (config.shares.some(s => s.label === opts.label)) throw new Error(`A share named "${opts.label}" already exists. Pick another --name, or: rech share rotate ${opts.label}`);
  if (!opts.profiles.length) throw new Error("A share needs at least one profile.");
  if (!opts.via.length) throw new Error("A share needs at least one transport (--via).");
  const share: Share = {
    id: randomBytes(4).toString("hex"),
    label: opts.label,
    invite: newToken(opts.reusable ? "reusable" : "invite"),
    inviteExpiresAt: opts.inviteTtlMs ? now + opts.inviteTtlMs : undefined,
    inviteTtlMs: opts.inviteTtlMs,
    profiles: [...new Set(opts.profiles)],
    via: [...new Set(opts.via)],
    // Only the legacy "webrtc" transport keeps its signal server on the share; a WebRTC
    // listener carries its own.
    signal: opts.via.includes(WEBRTC) ? normalizeSignal(opts.signal ?? DEFAULT_SIGNAL) : undefined,
    createdAt: now,
    expiresAt: opts.expiresAt,
    maxDevices: opts.maxDevices ?? (opts.reusable ? REUSABLE_MAX_DEVICES : 1),
    approve: !!opts.approve,
    devices: [],
  };
  if (opts.reusable) { share.reusable = true; share.redeemed = 0; }
  if (opts.eval) share.eval = true;
  config.shares.push(share);
  return share;
}

export function normalizeSignal(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Signal server must be an http(s) URL, e.g. https://signal.example.com; got "${value}"`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Signal server must be a plain http(s) URL, without credentials, query or fragment");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

/** Where an invite opens in a browser, under the transport's origin: …/share/#rech1_invite_… */
export const INVITE_PATH = "share/";

/** The link to send: the transport's origin, the invite page's path, and the invite in the
 *  #fragment (browsers never send it, so neither the server nor a chat app's link preview sees it).
 *  Invites minted before token labels keep their old link, the bare origin. */
export function inviteLink(share: Share, origin: string): string {
  const base = origin.endsWith("/") ? origin : `${origin}/`;
  const kind = parseToken(share.invite);
  return `${base}${kind.ok && kind.kind ? INVITE_PATH : ""}#${share.invite}`;
}

export type Credential = { share: Share; kind: "invite"; token: string } | { share: Share; kind: "device"; token: string; device: Device };

const bearerCache = new Map<string, string>();
const cachedBearer = (token: string) => {
  let b = bearerCache.get(token);
  if (!b) { b = bearerOf(token); bearerCache.set(token, b); }
  return b;
};

/** The share credential an HTTP bearer belongs to, if any. */
export function credentialForBearer(config: ShareConfig, bearer: string | null | undefined): Credential | null {
  if (!bearer) return null;
  for (const share of config.shares) {
    if (safeEqual(cachedBearer(share.invite), bearer)) return { share, kind: "invite", token: share.invite };
    for (const device of share.devices)
      if (safeEqual(cachedBearer(device.token), bearer)) return { share, kind: "device", token: device.token, device };
  }
  return null;
}

export type Denial = { status: number; message: string; pending?: true };

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Why a share as a whole can't be used right now (revoked, expired), or null. */
export function shareProblem(share: Share, now = Date.now()): string | null {
  if (share.revokedAt) return `Share "${share.label}" was revoked by its host.`;
  if (share.expiresAt && now >= share.expiresAt) return `Share "${share.label}" expired on ${day(share.expiresAt)}. Ask the host to renew it: rech share renew ${share.label}`;
  return null;
}

/** Why an unused invite can't be redeemed right now, or null. */
export function inviteProblem(share: Share, now = Date.now()): string | null {
  if (share.inviteExpiresAt && now >= share.inviteExpiresAt) return `This invite expired${share.reusable ? "" : " unused"}. Ask the host for a fresh one: rech share rotate ${share.label}`;
  if (share.reusable) {
    if (share.devices.length >= share.maxDevices) return `This reusable invite reached its limit of ${share.maxDevices} devices. Ask the host to remove unused devices (rech share devices ${share.label} --rm <id>) or to rotate it.`;
    return null;
  }
  if (share.devices.length >= share.maxDevices) return `This invite was already used${share.maxDevices > 1 ? ` by ${share.maxDevices} devices` : ""}. Ask the host for a fresh one (rech share rotate ${share.label}); if you didn't use it, tell them, since someone else did.`;
  return null;
}

/** What an invite's holder is told about it before redeeming (the /ping of an invite). */
export function inviteState(share: Share, now = Date.now()): { state: "open" | "used" | "expired"; maxDevices: number; used: number; expiresAt?: number } {
  const used = share.devices.length;
  const state = used >= share.maxDevices ? "used" : share.inviteExpiresAt && now >= share.inviteExpiresAt ? "expired" : "open";
  return { state, maxDevices: share.maxDevices, used, ...(share.inviteExpiresAt ? { expiresAt: share.inviteExpiresAt } : {}) };
}

/** A share's live browser sessions: names and device names only, none of another share's. */
export function shareSessions(share: Share, owners: Iterable<[string, { owner: string; name: string }]>, live: ReadonlySet<string>): { name: string; device: string }[] {
  const prefix = `share:${share.id}:`;
  const out: { name: string; device: string }[] = [];
  for (const [session, o] of owners) {
    if (!o.owner.startsWith(prefix) || !live.has(session)) continue;
    const device = share.devices.find(d => d.id === o.owner.slice(prefix.length));
    if (device) out.push({ name: o.name, device: device.name });
  }
  return out;
}

/**
 * Whether a credential may make this request. Invites may only ping and redeem; a device may
 * do everything its share allows once approved. `via` is the transport the request came in on.
 */
export function authorizeCredential(cred: Credential, via: string, route: string, now = Date.now()): Denial | null {
  const problem = shareProblem(cred.share, now);
  if (problem) return { status: 403, message: problem };
  if (!cred.share.via.includes(via)) return { status: 403, message: `Share "${cred.share.label}" is not offered on this connection.` };
  if (cred.kind === "invite") {
    if (route === "ping") return null;
    const inv = inviteProblem(cred.share, now);
    if (inv) return { status: 403, message: inv };
    if (route === "redeem") return null;
    return { status: 403, message: "This link is an invite: run `rech connect '<link>'` once to register this device." };
  }
  if (!cred.device.approved && route !== "ping")
    return { status: 403, pending: true, message: `Waiting for the host to approve this device (${cred.device.name}, ${cred.device.id}). On the host: rech share approve ${cred.share.label} ${cred.device.id}` };
  return null;
}

/** Turn one use of an invite into a device credential. */
export function redeemInvite(config: ShareConfig, shareId: string, name: string, now = Date.now()): Device {
  const share = config.shares.find(s => s.id === shareId);
  if (!share) throw new Error("This share no longer exists.");
  const problem = shareProblem(share, now) ?? inviteProblem(share, now);
  if (problem) throw new Error(problem);
  const token = newToken("device");
  const device: Device = {
    id: credentialIdOf(token),
    name: (name || "device").replace(/[^\w .@-]/g, "").slice(0, 40) || "device",
    token, addedAt: now, approved: !share.approve,
  };
  share.devices.push(device);
  if (share.reusable) share.redeemed = (share.redeemed ?? 0) + 1;
  return device;
}

export function findDevice(share: Share, id: string): Device {
  const device = share.devices.find(d => d.id === id || d.name === id);
  if (!device) throw new Error(`Share "${share.label}" has no device "${id}". See: rech share devices ${share.label}`);
  return device;
}

/** Parse "30d", "24h", "90m", "2w"; "never"/"none"/"0" mean no limit (undefined). */
export function parseDuration(text: string): number | undefined {
  const t = text.trim().toLowerCase();
  if (["never", "none", "0", "off"].includes(t)) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|h|d|w)$/.exec(t);
  if (!m) throw new Error(`Durations look like 90m, 24h, 30d or 2w (or "never"); got "${text}"`);
  const unit = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "m"];
  return Math.round(Number(m[1]) * unit);
}

/** Every credential a WebRTC host should be reachable on: unused invites and devices. */
/** Live credentials of shares offered on a WebRTC listener (`rtcNames`; the legacy "webrtc" always counts). */
export function webrtcCredentials(config: ShareConfig, now = Date.now(), rtcNames: Iterable<string> = [DEFAULT_RTC]): Credential[] {
  const names = new Set([WEBRTC, DEFAULT_RTC, ...rtcNames]);
  const out: Credential[] = [];
  for (const share of config.shares) {
    if (!share.via.some(v => names.has(v)) || shareProblem(share, now)) continue;
    // A used-up or expired invite keeps its room while the share lives, so whoever tries it hears
    // "already used" (a sign the link leaked) or "expired" rather than "host offline". Such a
    // room only ever answers with that refusal (see inviteProblem).
    out.push({ share, kind: "invite", token: share.invite });
    for (const device of share.devices) out.push({ share, kind: "device", token: device.token, device });
  }
  return out;
}
