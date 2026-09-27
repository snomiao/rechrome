import { readFileSync, readdirSync } from "fs";
import { join } from "path";

function varint(b: Buffer, cursor: { p: number }): number {
  let value = 0;
  for (let shift = 0; shift < 56; shift += 7) {
    if (cursor.p >= b.length) throw new Error("Truncated varint");
    const byte = b[cursor.p++];
    value += (byte & 127) * 2 ** shift;
    if (!(byte & 128)) return value;
  }
  throw new Error("Invalid varint");
}

export function decodeSnappy(b: Buffer): Buffer {
  const c = { p: 0 };
  const size = varint(b, c);
  if (size > 64 * 1024 * 1024) throw new Error("Oversized block");
  const out = Buffer.alloc(size);
  let p = 0;
  while (c.p < b.length) {
    const tag = b[c.p++], type = tag & 3;
    let length: number, offset = 0;
    if (type === 0) {
      length = tag >>> 2;
      if (length >= 60) {
        const bytes = length - 59;
        if (c.p + bytes > b.length) throw new Error("Truncated literal");
        length = b.readUIntLE(c.p, bytes); c.p += bytes;
      }
      length++;
      if (c.p + length > b.length || p + length > size) throw new Error("Invalid literal");
      b.copy(out, p, c.p, c.p + length); c.p += length; p += length;
    } else {
      length = type === 1 ? 4 + ((tag >>> 2) & 7) : 1 + (tag >>> 2);
      const bytes = type === 1 ? 1 : type === 2 ? 2 : 4;
      if (c.p + bytes > b.length) throw new Error("Truncated copy");
      offset = b.readUIntLE(c.p, bytes) + (type === 1 ? (tag & 224) * 8 : 0); c.p += bytes;
      if (!offset || offset > p || p + length > size) throw new Error("Invalid copy");
      for (let i = 0; i < length; i++) { out[p] = out[p - offset]; p++; }
    }
  }
  if (p !== size) throw new Error("Truncated block");
  return out;
}

function* entries(b: Buffer): Generator<[Buffer, Buffer]> {
  const restarts = b.readUInt32LE(b.length - 4);
  const end = b.length - 4 - restarts * 4;
  const c = { p: 0 };
  let key = Buffer.alloc(0);
  while (c.p < end) {
    const shared = varint(b, c), extra = varint(b, c), length = varint(b, c);
    if (shared > key.length || c.p + extra + length > end) throw new Error("Invalid entry");
    key = Buffer.concat([key.subarray(0, shared), b.subarray(c.p, c.p + extra)]);
    c.p += extra;
    const value = b.subarray(c.p, c.p + length); c.p += length;
    yield [key, value];
  }
}

function block(file: Buffer, handle: Buffer): Buffer {
  const c = { p: 0 }, offset = varint(handle, c), length = varint(handle, c);
  if (offset + length + 5 > file.length) throw new Error("Invalid block handle");
  const bytes = file.subarray(offset, offset + length), compression = file[offset + length];
  if (compression === 0) return bytes;
  if (compression === 1) return decodeSnappy(bytes);
  throw new Error("Unsupported compression");
}

function* logRecords(b: Buffer): Generator<Buffer> {
  let parts: Buffer[] = [];
  for (let base = 0; base < b.length; base += 32768) {
    const end = Math.min(base + 32768, b.length);
    for (let p = base; p + 7 <= end;) {
      const length = b.readUInt16LE(p + 4), type = b[p + 6]; p += 7;
      if (!type || p + length > end) break;
      const data = b.subarray(p, p + length); p += length;
      if (type === 1) { parts = []; yield data; }
      else if (type === 2) parts = [data];
      else if (type === 3 && parts.length) parts.push(data);
      else if (type === 4 && parts.length) { parts.push(data); yield Buffer.concat(parts); parts = []; }
    }
  }
}

// Read files without opening the database or taking Chrome's LevelDB lock. Internal
// sequence numbers, not filenames/byte order, determine the latest value. Decode
// SST prefix compression and Snappy, and scope the key to the exact extension origin.
export function readExtensionTokenFromProfile(userDataDir: string, profileDir: string, extensionId: string): string | null {
  const dir = join(userDataDir, profileDir, "Local Storage", "leveldb");
  const wanted = Buffer.from(`_chrome-extension://${extensionId}\0\x01auth-token`, "latin1");
  let newest = -1n, token: string | null = null;
  const accept = (key: Buffer, value: Buffer, seq: bigint, type: number) => {
    if (!key.equals(wanted) || seq <= newest) return;
    newest = seq;
    token = type === 1 && /^\x01[A-Za-z0-9_-]{43}$/.test(value.toString("latin1")) ? value.subarray(1).toString("latin1") : null;
  };
  try {
    for (const name of readdirSync(dir)) {
      if (!/\.(ldb|sst|log)$/.test(name)) continue;
      let b: Buffer;
      try { b = readFileSync(join(dir, name)); } catch { continue; } // Compaction can remove files.
      if (name.endsWith(".log")) {
        for (const record of logRecords(b)) {
          if (record.length < 12) continue;
          const seq = record.readBigUInt64LE(0), count = record.readUInt32LE(8), c = { p: 12 };
          for (let i = 0; i < count; i++) {
            const type = record[c.p++];
            if (type !== 0 && type !== 1) throw new Error("Invalid write batch");
            const keyLen = varint(record, c), key = record.subarray(c.p, c.p + keyLen); c.p += keyLen;
            const valueLen = type === 1 ? varint(record, c) : 0;
            if (c.p + valueLen > record.length) throw new Error("Truncated batch");
            const value = record.subarray(c.p, c.p + valueLen); c.p += valueLen;
            accept(key, value, seq + BigInt(i), type);
          }
        }
      } else {
        if (b.length < 48 || b.readBigUInt64LE(b.length - 8) !== 0xdb4775248b80fb57n) throw new Error("Invalid table");
        const footer = b.subarray(b.length - 48), c = { p: 0 };
        varint(footer, c); varint(footer, c); // Skip metaindex handle.
        for (const [, handle] of entries(block(b, footer.subarray(c.p)))) {
          for (const [key, value] of entries(block(b, handle))) {
            if (key.length < 8) throw new Error("Invalid internal key");
            const tag = key.readBigUInt64LE(key.length - 8);
            accept(key.subarray(0, -8), value, tag >> 8n, Number(tag & 255n));
          }
        }
      }
    }
    return token;
  } catch { return null; } // Never replace credentials with a partial/unsupported read.
}
