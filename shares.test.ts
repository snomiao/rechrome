import { expect, test } from "bun:test";
import { mkdtempSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { authorizeCredential, createShare, credentialForBearer, inviteLink, parseDuration, readShares, redeemInvite, updateShares, webrtcCredentials, type ShareConfig } from "./shares.ts";
import { bearerOf } from "./secret.ts";

const empty = (): ShareConfig => ({ version: 1, shares: [] });
const NOW = 1_800_000_000_000;

test("a share starts as an invite that may only ping and redeem", () => {
  const config = empty();
  const share = createShare(config, { label: "alice", profiles: ["work@x.com"], via: ["webrtc"], now: NOW });
  expect(share.signal).toBe("https://rechrome.pages.dev/");
  expect(inviteLink(share, share.signal!)).toBe(`https://rechrome.pages.dev/#${share.invite}`);
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

test("the WebRTC host listens for unused invites and every device of live shares only", () => {
  const config = empty();
  const a = createShare(config, { label: "a", profiles: ["p"], via: ["webrtc"], now: NOW });
  createShare(config, { label: "lan-only", profiles: ["p"], via: ["lan"], now: NOW });
  const dead = createShare(config, { label: "dead", profiles: ["p"], via: ["webrtc"], now: NOW });
  dead.revokedAt = NOW;
  expect(webrtcCredentials(config, NOW).map(c => c.kind)).toEqual(["invite"]);
  redeemInvite(config, a.id, "d", NOW);
  expect(webrtcCredentials(config, NOW).map(c => c.kind)).toEqual(["invite", "device"]);
  a.inviteExpiresAt = NOW;
  expect(webrtcCredentials(config, NOW).map(c => c.kind)).toEqual(["device"]);
});

test("names, profiles and transports are validated", () => {
  const config = empty();
  expect(() => createShare(config, { label: "Bad Name", profiles: ["p"], via: ["webrtc"] })).toThrow(/Share names/);
  expect(() => createShare(config, { label: "ok", profiles: [], via: ["webrtc"] })).toThrow(/profile/);
  createShare(config, { label: "ok", profiles: ["p"], via: ["webrtc"] });
  expect(() => createShare(config, { label: "ok", profiles: ["p"], via: ["webrtc"] })).toThrow(/already exists/);
  expect(() => createShare(config, { label: "s", profiles: ["p"], via: ["webrtc"], signal: "ftp://x" })).toThrow(/http/);
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
