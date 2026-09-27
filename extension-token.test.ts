import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readExtensionTokenFromProfile, decodeSnappy } from "./extension-token.ts";

const ext = "a".repeat(32), token = "b".repeat(43), old = "c".repeat(43);
const key = (id = ext) => Buffer.from(`_chrome-extension://${id}\0\x01auth-token`, "latin1");
const v = (n: number) => { const a = []; do { a.push((n & 127) | (n > 127 ? 128 : 0)); n = Math.floor(n / 128); } while(n); return Buffer.from(a); };
const cat = (...b: Buffer[]) => Buffer.concat(b);
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
function dataBlock(rows: [Buffer, Buffer][]) {
  let previous = Buffer.alloc(0);
  return cat(...rows.map(([k, value]) => {
    let shared = 0; while(shared < Math.min(k.length, previous.length) && k[shared] === previous[shared]) shared++;
    const b = cat(v(shared), v(k.length - shared), v(value.length), k.subarray(shared), value); previous = k; return b;
  }), u32(0), u32(1));
}
function sst(seq: number, value: string, compressed = false) {
  const tag = Buffer.alloc(8); tag.writeBigUInt64LE(BigInt(seq) * 256n + 1n);
  const raw = dataBlock([
    [cat(Buffer.from(`_chrome-extension://${ext}\0\x01aaa`, 'latin1'), tag), Buffer.from('unrelated')],
    [cat(key(), tag), Buffer.from('\x01' + value)],
  ]);
  // A valid Snappy literal stream (also exercises long-literal lengths).
  const data = compressed ? cat(v(raw.length), Buffer.from([240, raw.length - 1]), raw) : raw;
  const index = dataBlock([[Buffer.from('z'), cat(v(0), v(data.length))]]);
  const footer = Buffer.alloc(48); cat(v(0), v(0), v(data.length + 5), v(index.length)).copy(footer);
  footer.writeBigUInt64LE(0xdb4775248b80fb57n, 40);
  return cat(data, Buffer.from([compressed ? 1 : 0, 0, 0, 0, 0]), index, Buffer.alloc(5), footer);
}
function wal(seq: number, id: string, value: string | null) {
  const h = Buffer.alloc(12); h.writeBigUInt64LE(BigInt(seq)); h.writeUInt32LE(1, 8);
  const k = key(id), val = Buffer.from('\x01' + value);
  const payload = cat(h, Buffer.from([value === null ? 0 : 1]), v(k.length), k, ...(value === null ? [] : [v(val.length), val]));
  const header = Buffer.alloc(7); header.writeUInt16LE(payload.length, 4); header[6] = 1;
  return cat(header, payload);
}
function fixture(run: (dir: string, read: () => string | null) => void) {
  const root = mkdtempSync(join(tmpdir(), 'rech-token-'));
  const dir = join(root, 'Profile 2', 'Local Storage', 'leveldb'); mkdirSync(dir, {recursive:true});
  try { run(dir, () => readExtensionTokenFromProfile(root, 'Profile 2', ext)); } finally { rmSync(root, {recursive:true, force:true}); }
}
test('decodes overlapping Snappy copies and rejects truncated blocks', () => {
  expect(decodeSnappy(Buffer.from([5, 0, 97, 1, 1])).toString()).toBe('aaaaa');
  expect(() => decodeSnappy(Buffer.from([5, 0, 97]))).toThrow();
});
test('newest sequence wins across compressed SST files regardless of filename', () => fixture((dir, read) => {
  writeFileSync(join(dir, '000010.ldb'), sst(100, old));
  writeFileSync(join(dir, '000002.ldb'), sst(200, token, true));
  expect(read()).toBe(token);
}));
test('WAL updates and deletions override SST; other origins never supply the token', () => fixture((dir, read) => {
  writeFileSync(join(dir, '000010.ldb'), sst(100, old));
  writeFileSync(join(dir, '000011.log'), cat(wal(200, ext, token), wal(300, 'd'.repeat(32), old)));
  expect(read()).toBe(token);
  writeFileSync(join(dir, '000012.log'), wal(400, ext, null));
  expect(read()).toBeNull();
}));
test('malformed table does not return a stale token from other files', () => fixture((dir, read) => {
  writeFileSync(join(dir, '000010.ldb'), sst(100, old));
  writeFileSync(join(dir, '000011.ldb'), Buffer.from('broken'));
  expect(read()).toBeNull();
}));
