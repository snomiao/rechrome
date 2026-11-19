import { constants } from 'node:fs';
import { mkdir, lstat, open, readFile, rename, unlink, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateAudioDrain } from './audio-bridge.ts';

type StreamState = { bytes: number; nextSeq: number; final: boolean };
type Manifest = { version: 1; id: string; streams: Record<string, StreamState>; receipts: Record<string, string> };
const RECEIPT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Save a validated, ordered batch privately. An unacknowledged batch can be retried. */
export async function saveAudioDrain(raw: unknown, directory: string) {
  const batch = validateAudioDrain(raw) as any;
  const receipt = (raw as any)?.receipt;
  if (typeof receipt !== 'string' || !RECEIPT.test(receipt)) throw new Error('audio: invalid output receipt');
  const dir = join(resolve(directory), batch.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await lstat(dir)).isDirectory() || (await lstat(dir)).isSymbolicLink()) throw new Error('audio: output directory is not a regular directory');
  const lockPath = join(dir, '.write-lock');
  let lock;
  try { lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
  catch { throw new Error('audio: another writer owns this output; retry after it finishes'); }
  const manifestPath = join(dir, 'manifest.json');
  try {
    let state: Manifest;
    try {
      const stat = await lstat(manifestPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid manifest');
      state = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (state.version !== 1 || state.id !== batch.id || !state.streams || !state.receipts) throw new Error('invalid manifest');
      if (Object.keys(state.streams).length > 16 || Object.keys(state.receipts).length > 128 || Object.entries(state.streams).some(([id,s])=>!/^s-[0-9]+$/.test(id)||!Number.isSafeInteger(s.bytes)||s.bytes<0||!Number.isSafeInteger(s.nextSeq)||s.nextSeq<0||typeof s.final!=='boolean') || Object.entries(state.receipts).some(([id,hash])=>!RECEIPT.test(id)||typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))) throw new Error('invalid manifest');
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw new Error('audio: invalid existing output manifest');
      if ((await readdir(dir)).some(name => name !== '.write-lock')) throw new Error('audio: output directory contains files without a manifest');
      state = { version: 1, id: batch.id, streams: {}, receipts: {} };
      const f = await open(manifestPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await f.writeFile(JSON.stringify(state)); await f.sync(); } finally { await f.close(); }
    }
    const digest = createHash('sha256').update(JSON.stringify(batch)).digest('hex');
    if (state.receipts[receipt]) {
      if (state.receipts[receipt] !== digest) throw new Error('audio: output receipt changed');
      for (const [id, stream] of Object.entries(state.streams)) {
        if (!stream.bytes) continue;
        const stat = await lstat(join(dir, `${id}.webm`));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== stream.bytes) throw new Error('audio: saved output was changed');
      }
      return { directory: dir, files: Object.entries(state.streams).filter(([, s]) => s.bytes).map(([id, s]) => ({ path: join(dir, `${id}.webm`), bytes: s.bytes })), receipt, retried: true };
    }
    for (const stream of batch.streams) {
      const old = state.streams[stream.id] ?? { bytes: 0, nextSeq: 0, final: false };
      if (!Number.isSafeInteger(old.bytes) || old.bytes < 0 || !Number.isSafeInteger(old.nextSeq) || old.nextSeq < 0 || stream.seq !== old.nextSeq || (old.final && stream.chunks.length)) throw new Error('audio: output sequence mismatch; use the same output directory');
      const chunks = stream.chunks.map((text: string) => Buffer.from(text, 'base64'));
      const end = old.bytes + chunks.reduce((n: number, b: Buffer) => n + b.length, 0);
      if (end) {
        const path = join(dir, `${stream.id}.webm`);
        try {
          const stat=await lstat(path);
          if (!stat.isFile()||stat.isSymbolicLink()) throw new Error('audio: output is not a regular file');
        } catch(error:any) { if(error?.code!=='ENOENT')throw error; }
        const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size < old.bytes || stat.size > end) throw new Error('audio: unexpected existing output size');
          let position = old.bytes;
          for (const bytes of chunks) {
            let at = 0;
            while (at < bytes.length) {
              const { bytesWritten } = await file.write(bytes, at, bytes.length - at, position);
              if (!bytesWritten) throw new Error('audio: output write did not advance');
              at += bytesWritten; position += bytesWritten;
            }
          }
          await file.truncate(end);
          await file.sync();
        } finally { await file.close(); }
      }
      state.streams[stream.id] = { bytes: end, nextSeq: stream.seq + stream.chunks.length, final: stream.final };
    }
    state.receipts[receipt] = digest;
    const receiptKeys = Object.keys(state.receipts);
    for (const key of receiptKeys.slice(0, Math.max(0, receiptKeys.length - 128))) delete state.receipts[key];
    const temporary = join(dir, `.manifest-${randomUUID()}.tmp`);
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await file.writeFile(JSON.stringify(state, null, 2)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, manifestPath);
    return { directory: dir, files: Object.entries(state.streams).filter(([, s]) => s.bytes).map(([id, s]) => ({ path: join(dir, `${id}.webm`), bytes: s.bytes })), receipt, retried: false };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
