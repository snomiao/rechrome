// End-to-end encryption for the WebRTC DataChannel ("rech-e2e-1"). Ported from agent-yes's
// lab/ui/e2e.js (MIT, same author) with rech's own labels and rech1_ secrets.
//
// Threat model: a fully compromised signal server, or an active MITM on the media path, may
// drop connections and see metadata, but must not read or inject traffic or learn the secret.
// The signal server only ever sees roomOf/roomAuthOf (one-way HKDF outputs, see secret.ts).
// The AES keys are HKDF(secret, transcriptHash) where the transcript binds both DTLS
// fingerprints: a relay that swaps in its own fingerprints derives different keys, and the
// mandatory key-confirmation round fails closed.
import { parseToken } from "./secret.ts";

export const PROTO = "rech-e2e-1";
export const MAX_CHUNK = 12_000;          // plaintext bytes per sealed frame, well under SCTP limits
export const CONFIRM_TIMEOUT_MS = 5_000;
export const FLAG_CONFIRM = 0x01;
const VER = 0x01, HEADER_LEN = 14, NONCE_LEN = 12, TAG_LEN = 16;
const COUNTER_MAX = (1n << 64n) - 1n;
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder(), dec = new TextDecoder();

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await subtle.digest("SHA-256", bytes as BufferSource));

function ikmOf(token: string): Uint8Array {
  const parsed = parseToken(token);
  if (!parsed.ok) throw new Error("e2e: invalid share secret");
  return parsed.secret;
}

async function hkdfKey(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: enc.encode(info) }, base, 256);
  return subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Directional keys, fresh per connection (the transcript is the salt). Host seals h2c, client c2h. */
export async function deriveDirKeys(token: string, transcriptHash: Uint8Array): Promise<{ h2c: CryptoKey; c2h: CryptoKey }> {
  const ikm = ikmOf(token);
  return {
    h2c: await hkdfKey(ikm, transcriptHash, `rech/${PROTO}/key/host->client`),
    c2h: await hkdfKey(ikm, transcriptHash, `rech/${PROTO}/key/client->host`),
  };
}

const fingerprints = (sdp: string) => [...sdp.matchAll(/^a=fingerprint:(.*)$/gim)].map(m => m[1].trim().toLowerCase()).sort();
const firstAttr = (sdp: string, name: string) => (new RegExp(`^a=${name}:(.*)$`, "im").exec(sdp)?.[1] ?? "").trim().toLowerCase();

/** Bind the session to the negotiated DTLS handshake. Both sides compute it from (offer, answer). */
export async function transcriptHash(offerSdp: string, answerSdp: string): Promise<Uint8Array> {
  const offer = fingerprints(offerSdp), answer = fingerprints(answerSdp);
  if (!offer.length || !answer.length) throw new Error("e2e: missing DTLS fingerprint");
  if ([...offer, ...answer].some(fp => !fp.startsWith("sha-256"))) throw new Error("e2e: non-sha-256 DTLS fingerprint");
  return sha256(enc.encode(`${PROTO}\n`
    + `offer=${offer.join(",")};setup=${firstAttr(offerSdp, "setup")};ufrag=${firstAttr(offerSdp, "ice-ufrag")}\n`
    + `answer=${answer.join(",")};setup=${firstAttr(answerSdp, "setup")};ufrag=${firstAttr(answerSdp, "ice-ufrag")}`));
}

export type SendState = { ctr: bigint };
export type RecvState = { last: bigint };
export const newSendState = (): SendState => ({ ctr: 0n });
export const newRecvState = (): RecvState => ({ last: -1n });

function nonceOf(ctr: bigint): Uint8Array {
  const n = new Uint8Array(NONCE_LEN);
  new DataView(n.buffer).setBigUint64(4, ctr, false);
  return n;
}

/** Wire frame: VER | FLAGS | NONCE(12) | CIPHERTEXT+TAG; AAD = header | transcriptHash. */
export async function seal(key: CryptoKey, state: SendState, flags: number, th: Uint8Array, plaintext: Uint8Array): Promise<ArrayBuffer> {
  const ctr = state.ctr;
  if (ctr >= COUNTER_MAX) throw new Error("e2e: nonce counter overflow");
  state.ctr = ctr + 1n; // claimed before the await: concurrent seals never share a nonce
  const nonce = nonceOf(ctr);
  const header = new Uint8Array(HEADER_LEN);
  header[0] = VER; header[1] = flags & 0xff; header.set(nonce, 2);
  const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource, additionalData: concat(header, th) as BufferSource, tagLength: 128 }, key, plaintext as BufferSource));
  return concat(header, sealed).buffer as ArrayBuffer;
}

/** Throws on any tampering, replay or reordering; the caller must then close the channel. */
export async function open(key: CryptoKey, frame: ArrayBuffer | Uint8Array, th: Uint8Array, state: RecvState): Promise<{ flags: number; plaintext: Uint8Array }> {
  const buf = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (buf.length < HEADER_LEN + TAG_LEN) throw new Error("e2e: short frame");
  if (buf[0] !== VER) throw new Error("e2e: bad version");
  const header = buf.subarray(0, HEADER_LEN), nonce = buf.subarray(2, HEADER_LEN);
  const view = new DataView(nonce.buffer, nonce.byteOffset, NONCE_LEN);
  if (view.getUint32(0, false) !== 0) throw new Error("e2e: bad epoch");
  const ctr = view.getBigUint64(4, false);
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: nonce as BufferSource, additionalData: concat(header, th) as BufferSource, tagLength: 128 }, key, buf.subarray(HEADER_LEN) as BufferSource);
  if (state.last === -1n && ctr !== 0n) throw new Error("e2e: first frame must be counter-0");
  if (ctr <= state.last) throw new Error("e2e: replay/reorder");
  state.last = ctr;
  return { flags: header[1], plaintext: new Uint8Array(plain) };
}

export const pack = (obj: unknown) => enc.encode(JSON.stringify(obj));
export const unpack = (bytes: Uint8Array) => JSON.parse(dec.decode(bytes));
export function randomHex(n: number): string {
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(n))).toString("hex");
}
