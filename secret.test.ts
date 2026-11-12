import { expect, test } from "bun:test";
import { TOKEN_KINDS, TOKEN_PATTERN, base58, bearerOf, crc32, formatToken, isToken, looksLikeToken, newToken, parseToken, redactSecrets, roomAuthOf, roomOf, unbase58 } from "./secret.ts";
import { deriveDirKeys, newRecvState, newSendState, open, pack, seal, transcriptHash, unpack } from "./e2e.ts";

test("tokens are rech1_ + a label + 28 base58 chars and round-trip", () => {
  const t = newToken();
  expect(t).toMatch(/^rech1_invite_[1-9A-HJ-NP-Za-km-z]{28}$/);
  expect(t).not.toMatch(/[0OIl]/);
  expect(isToken(t)).toBe(true);
  const secret = new Uint8Array(16).fill(0);
  // All-zero secret: the body is all "1"s (base58 zero), the checksum is CRC32 of 16 zero bytes.
  const crc = crc32(secret);
  expect(formatToken(secret)).toBe(`rech1_${"1".repeat(22)}${base58(new Uint8Array([crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255]), 6)}`);
  const parsed = parseToken(t);
  expect(parsed.ok && formatToken(parsed.secret, parsed.kind)).toBe(t);
  for (const kind of TOKEN_KINDS) expect(parseToken(newToken(kind))).toMatchObject({ ok: true, kind });
});

test("token labels: covered by the checksum, never by the derivations; unlabeled tokens stay valid", () => {
  const secret = new Uint8Array(16).fill(7);
  const legacy = formatToken(secret), invite = formatToken(secret, "invite"), device = formatToken(secret, "device");
  expect(parseToken(legacy)).toEqual({ ok: true, secret });
  expect(invite.startsWith("rech1_invite_")).toBe(true);
  // Relabeling (invite → reusable) reads as a damaged link, not as a different kind of access.
  expect(parseToken(invite.replace("_invite_", "_reusable_"))).toEqual({ ok: false, reason: "checksum" });
  expect(parseToken(invite.replace("_invite_", "_"))).toEqual({ ok: false, reason: "checksum" });
  expect(parseToken(invite.replace("_invite_", "_admin_"))).toEqual({ ok: false, reason: "format" });
  // The same secret is the same room and bearer whatever its label: the host's records decide.
  expect(roomOf(invite)).toBe(roomOf(legacy));
  expect(bearerOf(device)).toBe(bearerOf(legacy));
});

test("fixed-width base58 keeps leading zero bytes and rejects overflow", () => {
  const bytes = new Uint8Array([0, 0, 1, 2]);
  expect(unbase58(base58(bytes, 6), 4)).toEqual(bytes);
  expect(unbase58("zzzzzzzzzzzzzzzzzzzzzzzzz", 4)).toBeNull();
  expect(unbase58("0abc", 4)).toBeNull(); // 0 is not base58
});

test("the checksum catches a typo; the parser tells a damaged token from a non-token", () => {
  const t = newToken();
  const i = t.length - 12; // inside the secret, past the label
  const flipped = t.slice(0, i) + (t[i] === "a" ? "b" : "a") + t.slice(i + 1);
  expect(parseToken(flipped)).toEqual({ ok: false, reason: "checksum" });
  expect(looksLikeToken(flipped)).toBe(true);
  expect(parseToken(t.slice(0, -1))).toEqual({ ok: false, reason: "format" });
  expect(parseToken("sk-abc")).toEqual({ ok: false, reason: "format" });
  expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926); // standard check value
});

test("derived values are stable, distinct, and never contain the token", () => {
  const t = newToken();
  expect(roomOf(t)).toBe(roomOf(t));
  expect(roomOf(t)).not.toBe(roomOf(newToken()));
  expect(roomOf(t)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{17}$/);
  expect(roomAuthOf(t)).toMatch(/^[0-9a-f]{64}$/);
  expect(bearerOf(t)).toMatch(/^rb_/);
  for (const v of [roomOf(t), roomAuthOf(t), bearerOf(t)]) expect(v.includes(t.slice(6, 20))).toBe(false);
  expect(() => roomOf(t.slice(0, -1) + "x")).toThrow(/damaged|Not a rech1_/);
});

test("redaction hides tokens and legacy keys; the scanner pattern finds tokens in text", () => {
  const t = newToken(), d = newToken("device"), old = formatToken(new Uint8Array(16).fill(9));
  const text = `RECHROME_URL="https://rechrome.pages.dev/share/#${t}" and http://h/#${d}&via=webrtc, ${old}; http://h/#key=abcdef&profile=x`;
  expect([...text.matchAll(TOKEN_PATTERN)].map(m => m[0])).toEqual([t, d, old]);
  const red = redactSecrets(text);
  for (const token of [t, d, old]) expect(red).not.toContain(token);
  expect(red).toContain(`${t.slice(0, "rech1_invite_".length + 4)}…`); // the label stays readable
  expect(red).toContain(`${d.slice(0, "rech1_device_".length + 4)}…&via=webrtc`);
  expect(red).toContain(`${old.slice(0, 10)}…`);
  expect(red).toContain("#key=…&profile=x");
});

test("the token patterns copied into pages match every token kind, and only whole tokens", async () => {
  // public/share/index.html, public/index.html and serve.ts's link page can't import token.ts.
  const tokens = [...TOKEN_KINDS.map(k => newToken(k)), formatToken(new Uint8Array(16).fill(9))];
  for (const file of ["public/share/index.html", "serve.ts", "invite-page.ts"]) {
    const src = await Bun.file(new URL(file, import.meta.url)).text();
    const literals = [...src.matchAll(/\/(\^#\(?rech1_[^/\n]*?\$)\//g)].map(m => new RegExp(m[1]!));
    expect(literals.length).toBeGreaterThan(0);
    for (const re of literals) {
      const accepted = tokens.filter(t => re.test(`#${t}`));
      // invite-page.ts only shows host details for invites; the pages take every kind (and say which).
      expect(accepted.length).toBeGreaterThanOrEqual(file === "invite-page.ts" ? 3 : 4);
      expect(re.test(`#${tokens[0]!.slice(0, -1)}`)).toBe(false);
    }
  }
});

const OFFER = "v=0\r\na=fingerprint:sha-256 AA:BB\r\na=setup:actpass\r\na=ice-ufrag:o1\r\n";
const ANSWER = "v=0\r\na=fingerprint:sha-256 CC:DD\r\na=setup:active\r\na=ice-ufrag:a1\r\n";

test("e2e: frames round-trip; tampering, replay, a wrong secret and a swapped fingerprint all fail", async () => {
  const t = newToken();
  const th = await transcriptHash(OFFER, ANSWER);
  const host = await deriveDirKeys(t, th), client = await deriveDirKeys(t, th);
  const send = newSendState();
  const f0 = await seal(host.h2c, send, 1, th, pack({ t: "confirm" }));
  const f1 = await seal(host.h2c, send, 0, th, pack({ t: "data", n: 1 }));
  const recv = newRecvState();
  expect(unpack((await open(client.h2c, f0, th, recv)).plaintext)).toEqual({ t: "confirm" });
  expect(unpack((await open(client.h2c, f1, th, recv)).plaintext)).toEqual({ t: "data", n: 1 });
  await expect(open(client.h2c, f1, th, recv)).rejects.toThrow(/replay/);

  const tampered = new Uint8Array(f0.slice(0)); tampered[20] ^= 1;
  await expect(open(client.h2c, tampered, th, newRecvState())).rejects.toThrow();
  const other = await deriveDirKeys(newToken(), th);
  await expect(open(other.h2c, f0, th, newRecvState())).rejects.toThrow();
  // A relay that rewrites the answer's fingerprint gets a different transcript, so different keys.
  const mitmTh = await transcriptHash(OFFER, ANSWER.replace("CC:DD", "EE:FF"));
  const mitm = await deriveDirKeys(t, mitmTh);
  await expect(open(mitm.h2c, f0, mitmTh, newRecvState())).rejects.toThrow();
  // Skipping the opening frame is refused too.
  await expect(open(client.h2c, f1, th, newRecvState())).rejects.toThrow(/counter-0/);
});

test("e2e: the transcript requires sha-256 DTLS fingerprints on both sides", async () => {
  await expect(transcriptHash("v=0", ANSWER)).rejects.toThrow(/missing DTLS/);
  await expect(transcriptHash(OFFER.replace("sha-256", "sha-1"), ANSWER)).rejects.toThrow(/non-sha-256/);
});
