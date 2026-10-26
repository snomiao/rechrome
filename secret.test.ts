import { expect, test } from "bun:test";
import { TOKEN_PATTERN, base58, bearerOf, crc32, formatToken, isToken, looksLikeToken, newToken, parseToken, redactSecrets, roomAuthOf, roomOf, unbase58 } from "./secret.ts";
import { deriveDirKeys, newRecvState, newSendState, open, pack, seal, transcriptHash, unpack } from "./e2e.ts";

test("tokens are rech1_ + 28 base58 chars and round-trip", () => {
  const t = newToken();
  expect(t).toMatch(/^rech1_[1-9A-HJ-NP-Za-km-z]{28}$/);
  expect(t).not.toMatch(/[0OIl]/);
  expect(isToken(t)).toBe(true);
  const secret = new Uint8Array(16).fill(0);
  // All-zero secret: the body is all "1"s (base58 zero), the checksum is CRC32 of 16 zero bytes.
  const crc = crc32(secret);
  expect(formatToken(secret)).toBe(`rech1_${"1".repeat(22)}${base58(new Uint8Array([crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255]), 6)}`);
  const parsed = parseToken(t);
  expect(parsed.ok && formatToken(parsed.secret)).toBe(t);
});

test("fixed-width base58 keeps leading zero bytes and rejects overflow", () => {
  const bytes = new Uint8Array([0, 0, 1, 2]);
  expect(unbase58(base58(bytes, 6), 4)).toEqual(bytes);
  expect(unbase58("zzzzzzzzzzzzzzzzzzzzzzzzz", 4)).toBeNull();
  expect(unbase58("0abc", 4)).toBeNull(); // 0 is not base58
});

test("the checksum catches a typo; the parser tells a damaged token from a non-token", () => {
  const t = newToken();
  const flipped = t.slice(0, 10) + (t[10] === "a" ? "b" : "a") + t.slice(11);
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
  const t = newToken();
  const text = `RECHROME_URL="https://rechrome.pages.dev/#${t}" and http://h/#key=abcdef&profile=x`;
  expect([...text.matchAll(TOKEN_PATTERN)].map(m => m[0])).toEqual([t]);
  const red = redactSecrets(text);
  expect(red).not.toContain(t);
  expect(red).toContain(`${t.slice(0, 10)}…`);
  expect(red).toContain("#key=…&profile=x");
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
