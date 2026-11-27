import { expect, test } from "bun:test";
import { mkdtempSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { REUSABLE_MAX_DEVICES, authorizeCredential, createShare, credentialForBearer, inviteLink, inviteState, shareSessions, parseDuration, readShares, redeemInvite, updateShares, validateShares, webrtcCredentials, type ShareConfig } from "./shares.ts";
import { bearerOf, formatToken, newToken, parseToken } from "./secret.ts";

const empty = (): ShareConfig => ({ version: 1, shares: [] });
const NOW = 1_800_000_000_000;

test("a share starts as an invite that may only ping and redeem", () => {
  const config = empty();
  const share = createShare(config, { label: "alice", profiles: ["work@x.com"], via: ["webrtc"], now: NOW });
  expect(share.signal).toBe("https://rechrome.pages.dev/");
  expect(share.invite.startsWith("rech1_invite_")).toBe(true);
  expect(inviteLink(share, share.signal!)).toBe(`https://rechrome.pages.dev/share/#${share.invite}`);
  // An invite minted before token labels keeps its old link.
  expect(inviteLink({ ...share, invite: formatToken(new Uint8Array(16).fill(3)) }, "http://h:1/p")).toBe(`http://h:1/p/#${formatToken(new Uint8Array(16).fill(3))}`);
  const cred = credentialForBearer(config, bearerOf(share.invite))!;
  expect(cred.kind).toBe("invite");
  expect(authorizeCredential(cred, "webrtc", "ping", NOW)).toBeNull();
  expect(authorizeCredential(cred, "webrtc", "redeem", NOW)).toBeNull();
  expect(authorizeCredential(cred, "webrtc", "run", NOW)?.message).toMatch(/invite/);
  expect(authorizeCredential(cred, "lan-1", "ping", NOW)?.message).toMatch(/not offered on this connection/);
  expect(credentialForBearer(config, "rb_nope")).toBeNull();
});

test("redeeming uses the invite up; the device credential works, the invite no longer does", () => {
  const config = empty();
  const share = createShare(config, { label: "alice", profiles: ["p"], via: ["webrtc"], now: NOW });
  const device = redeemInvite(config, share.id, "mbp", NOW);
  expect(device.approved).toBe(true);
  const dev = credentialForBearer(config, bearerOf(device.token))!;
  expect(dev.kind).toBe("device");
  expect(authorizeCredential(dev, "webrtc", "run", NOW)).toBeNull();
  const inv = credentialForBearer(config, bearerOf(share.invite))!;
  expect(authorizeCredential(inv, "webrtc", "redeem", NOW)?.message).toMatch(/already used.*someone else did/);
  expect(() => redeemInvite(config, share.id, "thief", NOW)).toThrow(/already used/);
});

test("--devices N allows N redemptions; --approve holds each device until approved", () => {
  const config = empty();
  const share = createShare(config, { label: "team", profiles: ["p"], via: ["lan"], maxDevices: 2, approve: true, now: NOW });
  const a = redeemInvite(config, share.id, "a", NOW);
  redeemInvite(config, share.id, "b", NOW);
  expect(() => redeemInvite(config, share.id, "c", NOW)).toThrow(/already used by 2 devices/);
  const cred = credentialForBearer(config, bearerOf(a.token))!;
  const pending = authorizeCredential(cred, "lan", "run", NOW)!;
  expect(pending.pending).toBe(true);
  expect(pending.message).toContain(`rech share approve team ${a.id}`);
  expect(authorizeCredential(cred, "lan", "ping", NOW)).toBeNull();
  a.approved = true;
  expect(authorizeCredential(cred, "lan", "run", NOW)).toBeNull();
});

test("a reusable invite is redeemed by many devices, each with its own credential, until rotated or expired", () => {
  const config = empty();
  const share = createShare(config, { label: "team", profiles: ["p"], via: ["webrtc"], reusable: true, inviteTtlMs: 1000, now: NOW });
  expect(share.maxDevices).toBe(REUSABLE_MAX_DEVICES);
  const a = redeemInvite(config, share.id, "a", NOW);
  const b = redeemInvite(config, share.id, "b", NOW);
  expect(a.token).not.toBe(b.token);
  expect(share.redeemed).toBe(2);
  const inv = credentialForBearer(config, bearerOf(share.invite))!;
  expect(authorizeCredential(inv, "webrtc", "redeem", NOW)).toBeNull();
  expect(authorizeCredential(inv, "webrtc", "redeem", NOW + 1000)?.message).toMatch(/invite expired\./);
  // dropping one device leaves the other working
  share.devices = share.devices.filter(d => d !== a);
  expect(credentialForBearer(config, bearerOf(a.token))).toBeNull();
  expect(authorizeCredential(credentialForBearer(config, bearerOf(b.token))!, "webrtc", "run", NOW)).toBeNull();
  // rotating kills the leaked link
  const old = share.invite; share.invite = newToken();
  expect(credentialForBearer(config, bearerOf(old))).toBeNull();
});

test("a reusable invite stops at its device cap", () => {
  const config = empty();
  const share = createShare(config, { label: "cap", profiles: ["p"], via: ["lan"], reusable: true, maxDevices: 2, now: NOW });
  redeemInvite(config, share.id, "a", NOW); redeemInvite(config, share.id, "b", NOW);
  expect(() => redeemInvite(config, share.id, "c", NOW)).toThrow(/limit of 2 devices/);
});

test("expiry, invite TTL and revocation", () => {
  const config = empty();
  const share = createShare(config, { label: "x", profiles: ["p"], via: ["webrtc"], expiresAt: NOW + 1000, inviteTtlMs: 500, now: NOW });
  const inv = credentialForBearer(config, bearerOf(share.invite))!;
  expect(authorizeCredential(inv, "webrtc", "redeem", NOW + 600)?.message).toMatch(/expired unused/);
  const device = redeemInvite(config, share.id, "d", NOW);
  const dev = credentialForBearer(config, bearerOf(device.token))!;
  expect(authorizeCredential(dev, "webrtc", "run", NOW + 999)).toBeNull();
  expect(authorizeCredential(dev, "webrtc", "run", NOW + 1000)?.message).toMatch(/expired on .*rech share renew x/);
  share.expiresAt = undefined; share.revokedAt = NOW;
  expect(authorizeCredential(dev, "webrtc", "ping", NOW)?.message).toMatch(/revoked/);
});

test("the WebRTC host listens for the invite and every device of live shares only", () => {
  const config = empty();
  const a = createShare(config, { label: "a", profiles: ["p"], via: ["webrtc"], now: NOW });
  createShare(config, { label: "lan-only", profiles: ["p"], via: ["lan"], now: NOW });
  const dead = createShare(config, { label: "dead", profiles: ["p"], via: ["webrtc"], now: NOW });
  dead.revokedAt = NOW;
  expect(webrtcCredentials(config, NOW).map(c => c.kind)).toEqual(["invite"]);
  redeemInvite(config, a.id, "d", NOW);
  expect(webrtcCredentials(config, NOW).map(c => c.kind)).toEqual(["invite", "device"]);
  // An expired invite keeps its room, so the taker hears "expired", not "host offline"…
  a.inviteExpiresAt = NOW;
  const creds = webrtcCredentials(config, NOW);
  expect(creds.map(c => c.kind)).toEqual(["invite", "device"]);
  // …and that room can only say so: it can't redeem or run anything.
  const invite = creds[0]!;
  expect(authorizeCredential(invite, "webrtc", "ping", NOW)).toBeNull();
  expect(authorizeCredential(invite, "webrtc", "redeem", NOW)?.message).toContain("expired");
  expect(authorizeCredential(invite, "webrtc", "run", NOW)?.status).toBe(403);
  expect(() => redeemInvite(config, a.id, "e", NOW)).toThrow(/expired/);
});

test("names, profiles and transports are validated", () => {
  const config = empty();
  expect(() => createShare(config, { label: "Bad Name", profiles: ["p"], via: ["webrtc"] })).toThrow(/Share names/);
  expect(() => createShare(config, { label: "ok", profiles: [], via: ["webrtc"] })).toThrow(/profile/);
  createShare(config, { label: "ok", profiles: ["p"], via: ["webrtc"] });
  expect(() => createShare(config, { label: "ok", profiles: ["p"], via: ["webrtc"] })).toThrow(/already exists/);
  expect(() => createShare(config, { label: "s", profiles: ["p"], via: ["webrtc"], signal: "ftp://x" })).toThrow(/http/);
});

test("a share carries an optional per-share eval level that round-trips and is validated", () => {
  const config = empty();
  expect(createShare(config, { label: "plain", profiles: ["p"], via: ["webrtc"] }).eval).toBeUndefined();
  const dev = createShare(config, { label: "dev", profiles: ["p"], via: ["webrtc"], eval: true });
  expect(dev.eval).toBe(true);
  expect(createShare(config, { label: "off", profiles: ["p"], via: ["webrtc"], eval: false }).eval).toBeUndefined();
  // persists through validation (JSON round-trip of a stored shares.json)
  expect(validateShares(JSON.parse(JSON.stringify(config))).shares.find(s => s.label === "dev")?.eval).toBe(true);
  // a non-boolean eval is rejected
  expect(() => validateShares({ version: 1, shares: [{ ...dev, eval: "yes" as any }] })).toThrow(/malformed/);
});

test("durations", () => {
  expect(parseDuration("30d")).toBe(30 * 86_400_000);
  expect(parseDuration("24h")).toBe(86_400_000);
  expect(parseDuration("90m")).toBe(90 * 60_000);
  expect(parseDuration("2w")).toBe(14 * 86_400_000);
  expect(parseDuration("never")).toBeUndefined();
  expect(() => parseDuration("soon")).toThrow(/Durations/);
});

test("updateShares persists owner-only and serializes concurrent writers", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "rech-shares-")), "shares.json");
  await Promise.all(["a", "b", "c", "d"].map(label =>
    updateShares(c => { createShare(c, { label, profiles: ["p"], via: ["lan"] }); }, path)));
  expect((await readShares(path)).shares.map(s => s.label).sort()).toEqual(["a", "b", "c", "d"]);
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("inviteState: open, then used; expired only while it can still be used", () => {
  const config = empty();
  const s = createShare(config, { label: "s", profiles: ["p"], via: ["webrtc"], now: NOW, inviteTtlMs: 1000 });
  expect(inviteState(s, NOW)).toEqual({ state: "open", maxDevices: 1, used: 0, expiresAt: NOW + 1000 });
  expect(inviteState(s, NOW + 1000).state).toBe("expired");
  redeemInvite(config, s.id, "d", NOW);
  expect(inviteState(s, NOW).state).toBe("used");
  expect(inviteState(s, NOW + 1000).state).toBe("used");
});

test("shareSessions lists this share's live sessions by name and device, and no one else's", () => {
  const config = empty();
  const a = createShare(config, { label: "a", profiles: ["p"], via: ["webrtc"], now: NOW });
  const b = createShare(config, { label: "b", profiles: ["p"], via: ["webrtc"], now: NOW });
  const da = redeemInvite(config, a.id, "laptop", NOW), db = redeemInvite(config, b.id, "other", NOW);
  const owners: [string, { owner: string; name: string; profile: string }][] = [
    ["s1", { owner: `share:${a.id}:${da.id}`, name: "default", profile: "secret-profile" }],
    ["s2", { owner: `share:${a.id}:${da.id}`, name: "closed", profile: "p" }],
    ["s3", { owner: `share:${b.id}:${db.id}`, name: "theirs", profile: "p" }],
    ["s4", { owner: "listener:local", name: "mine", profile: "p" }],
    ["s5", { owner: `share:${a.id}:gone`, name: "removed-device", profile: "p" }],
  ];
  const live = new Set(["s1", "s3", "s4", "s5"]);
  expect(shareSessions(a, owners, live)).toEqual([{ name: "default", device: "laptop" }]);
  expect(shareSessions(b, owners, live)).toEqual([{ name: "theirs", device: "other" }]);
});

test("tokens say what they are: invite, reusable, and each device's own credential", () => {
  const config = empty();
  const once = createShare(config, { label: "one", profiles: ["p"], via: ["webrtc"], now: NOW });
  const many = createShare(config, { label: "many", profiles: ["p"], via: ["webrtc"], reusable: true, now: NOW });
  expect(parseToken(once.invite)).toMatchObject({ ok: true, kind: "invite" });
  expect(parseToken(many.invite)).toMatchObject({ ok: true, kind: "reusable" });
  expect(inviteLink(many, "https://sig.example/")).toBe(`https://sig.example/share/#${many.invite}`);
  const device = redeemInvite(config, once.id, "mbp", NOW);
  expect(parseToken(device.token)).toMatchObject({ ok: true, kind: "device" });
});
