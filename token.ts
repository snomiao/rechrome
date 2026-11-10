// The rech1_ token format, with no Node imports: the invite page (public/invite.js) runs this too.
// Derivations and everything else about shares are in secret.ts, which re-exports all of this.

export const TOKEN_PREFIX = "rech1_";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58 = "[1-9A-HJ-NP-Za-km-z]";
const BODY_LEN = 22, SUM_LEN = 6;
export const SECRET_BYTES = 16;
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
