// Share secrets: `rech1_` + 22 base58 chars (128 random bits) + 6 base58 chars (CRC32).
//
// The unique prefix lets secret scanners match with few false positives (`sk-` would be
// mistaken for OpenAI-style keys), base58 drops look-alike characters (0 O I l) and keeps the
// token one double-click word, and the checksum catches a truncated or mistyped link offline.
// Everything a party needs is derived one-way from the secret with HKDF, so a signal server or
// HTTP proxy never holds anything that would let it derive another value or the secret itself.
import { hkdfSync, randomBytes, timingSafeEqual } from "crypto";
import { SECRET_BYTES, TOKEN_PATTERN, TOKEN_PREFIX, base58, formatToken, parseToken } from "./token.ts";

export * from "./token.ts";

export function newToken(): string {
  return formatToken(new Uint8Array(randomBytes(SECRET_BYTES)));
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
