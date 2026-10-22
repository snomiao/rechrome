// Share secrets: `rech1_` + 22 base58 chars (128 random bits) + 6 base58 chars (CRC32).
//
// The unique prefix lets secret scanners match with few false positives (`sk-` would be
// mistaken for OpenAI-style keys), base58 drops look-alike characters (0 O I l) and keeps the
// token one double-click word, and the checksum catches a truncated or mistyped link offline.
// Everything a party needs is derived one-way from the secret with HKDF, so a signal server or
// HTTP proxy never holds anything that would let it derive another value or the secret itself.
import { hkdfSync, randomBytes, timingSafeEqual } from "crypto";

export const TOKEN_PREFIX = "rech1_";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58 = "[1-9A-HJ-NP-Za-km-z]";
const BODY_LEN = 22, SUM_LEN = 6, SECRET_BYTES = 16;
/** Matches a token anywhere in text (logs, files); for scanners and redaction. */
export const TOKEN_PATTERN = new RegExp(`\\brech1_${B58}{${BODY_LEN + SUM_LEN}}\\b`, "g");
const EXACT = new RegExp(`^rech1_(${B58}{${BODY_LEN}})(${B58}{${SUM_LEN}})$`);

export function base58(bytes: Uint8Array, width: number): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  if (s.length > width) throw new Error("base58 value wider than its field");
  return s.padStart(width, "1");
}

export function unbase58(text: string, length: number): Uint8Array | null {
  let n = 0n;
  for (const c of text) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return n === 0n ? out : null; // leftover bits: not a fixed-width encoding of `length` bytes
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u32 = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

export function formatToken(secret: Uint8Array): string {
  if (secret.length !== SECRET_BYTES) throw new Error(`a share secret is ${SECRET_BYTES} bytes`);
  return `${TOKEN_PREFIX}${base58(secret, BODY_LEN)}${base58(u32(crc32(secret)), SUM_LEN)}`;
}

export function newToken(): string {
  return formatToken(new Uint8Array(randomBytes(SECRET_BYTES)));
}

export type ParsedToken = { ok: true; secret: Uint8Array } | { ok: false; reason: "format" | "checksum" };

/** Parse a token, telling a non-token apart from a damaged one (a truncated paste, a typo). */
export function parseToken(token: string): ParsedToken {
  const m = EXACT.exec(token.trim());
  if (!m) return { ok: false, reason: "format" };
  const secret = unbase58(m[1], SECRET_BYTES), sum = unbase58(m[2], 4);
  if (!secret || !sum) return { ok: false, reason: "format" };
  const expected = u32(crc32(secret));
  return sum.every((b, i) => b === expected[i]) ? { ok: true, secret } : { ok: false, reason: "checksum" };
}

export function isToken(text: string): boolean {
  return parseToken(text).ok;
}

/** Looks like a token (prefix and shape) whether or not its checksum holds. */
export function looksLikeToken(text: string): boolean {
  return EXACT.test(text.trim());
}

function secretOf(token: string): Uint8Array {
  const parsed = parseToken(token);
  if (!parsed.ok) throw new Error(parsed.reason === "checksum"
    ? "This rech1_ link is damaged (checksum mismatch): it was copied incompletely or mistyped."
    : "Not a rech1_ link.");
  return parsed.secret;
}

const derive = (token: string, label: string, bytes: number) =>
  new Uint8Array(hkdfSync("sha256", secretOf(token), new Uint8Array(0), `rech/${label}`, bytes));

/** Signal room id (the signal server sees it). */
export const roomOf = (token: string) => base58(derive(token, "room", 12), 17);
/** Signal room admission (the signal server sees it; one-way). */
export const roomAuthOf = (token: string) => Buffer.from(derive(token, "auth", 32)).toString("hex");
/** Bearer for HTTP transports (a proxy in front of a listener sees it; one-way). */
export const bearerOf = (token: string) => `rb_${base58(derive(token, "bearer", 24), 33)}`;
/** Stable, non-secret id for a device credential (log lines, `share devices`). */
export const credentialIdOf = (token: string) => base58(derive(token, "id", 6), 9);

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Hide every token (and legacy #key=…) in text meant for a terminal or a log. */
export function redactSecrets(text: string): string {
  return text.replace(TOKEN_PATTERN, t => `${t.slice(0, TOKEN_PREFIX.length + 4)}…`).replace(/([#&?]key=)[^&\s"]*/g, "$1…");
}
