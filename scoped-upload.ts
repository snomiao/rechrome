import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
// Base64 plus metadata. Bound JSON input before parsing, not just decoded bytes.
export const MAX_REQUEST_BYTES = 3 * 1024 * 1024;
export const UPLOAD_TYPES = ['image/png', 'image/svg+xml'] as const;
export type UploadPolicy = { maxBytes?: number; contentTypes?: string[] };
export type UploadPayload = { name: string; contentType: string; data: string };
export type UploadResult = { status: number; stdout: string; stderr: string };
export type UploadAudit = { name: string | null; size: number | null; sha256: string | null; origin: string | null; result: string };

export function validateUploadPolicy(value: unknown): asserts value is UploadPolicy {
  const p = value as UploadPolicy;
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !['maxBytes', 'contentTypes'].includes(k))
    || (p.maxBytes !== undefined && (!Number.isSafeInteger(p.maxBytes) || p.maxBytes < 1 || p.maxBytes > MAX_UPLOAD_BYTES))
    || (p.contentTypes !== undefined && (!Array.isArray(p.contentTypes) || !p.contentTypes.length || p.contentTypes.some(t => !UPLOAD_TYPES.includes(t as any)))))
    throw new Error('uploads must be an object with optional maxBytes (1..2097152) and contentTypes (image/png, image/svg+xml)');
}

function validName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 128
    && name !== '.' && name !== '..' && !name.startsWith('-') && !/[\\/:\x00-\x1f\x7f]/.test(name);
}

function matchesType(bytes: Buffer, type: string): boolean {
  if (type === 'image/png') return bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR';
  if (type === 'image/svg+xml') {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return false; }
    // Sniff only; never parse/render SVG or resolve XML entities on the host.
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) return false;
    text = text.trim().replace(/^<\?xml\s[^?]*\?>\s*/, '').replace(/^(?:<!--[\s\S]*?-->\s*)+/, '');
    return /^<svg(?:\s|\/?>)/.test(text) && /(?:<\/svg\s*>|\/>)\s*$/.test(text);
  }
  return false;
}

export async function prepareStdinUpload(args: string[], input: AsyncIterable<Uint8Array>): Promise<{ args: string[]; upload: UploadPayload }> {
  const sessions = args.filter(a => /^-s=[a-zA-Z0-9_-]{1,64}$/.test(a));
  const options = args.filter(a => !sessions.includes(a));
  if (options.shift() !== 'upload') throw new Error('Expected upload command');
  const fields: Record<string, string> = {};
  while (options.length) {
    const option = options.shift()!;
    const match = option.match(/^--(name|content-type)(?:=(.*))?$/);
    if (!match || fields[match[1]] !== undefined) throw new Error('Usage: rech upload --name icon.png [--content-type image/png] < icon.png (stdin only; no path argument)');
    const value = match[2] ?? options.shift();
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${match[1]}`);
    fields[match[1]] = value;
  }
  if (!validName(fields.name)) throw new Error('upload requires --name with a plain filename (no path)');
  const contentType = fields['content-type'] ?? (fields.name.toLowerCase().endsWith('.png') ? 'image/png' : fields.name.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : '');
  if (!UPLOAD_TYPES.includes(contentType as any)) throw new Error('Upload content type must be image/png or image/svg+xml');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    size += chunk.byteLength;
    if (size > MAX_UPLOAD_BYTES) throw new Error('Upload exceeds 2 MiB');
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (!matchesType(bytes, contentType)) throw new Error('Upload bytes do not match the content type (PNG or UTF-8 SVG without DTD/entities required)');
  return { args: ['upload', ...sessions], upload: { name: fields.name, contentType, data: bytes.toString('base64') } };
}

export function currentPageOrigin(output: string): string {
  const current = output.split('\n').filter(line => /^- \d+: \(current\) /.test(line));
  const url = current.length === 1 ? current[0].match(/\]\((.*)\)(?: \[crashed\])?$/)?.[1] : undefined;
  if (!url) throw new Error('Could not determine the upload page origin');
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Uploads require an HTTP(S) page');
  return parsed.origin;
}

/** No payload field is ever used as a host path. run() is a server-owned CLI runner,
 * not caller-supplied code. Audit records the selected origin immediately before upload.
 */
export async function receiveUpload(options: {
  policy: UploadPolicy | undefined; payload: unknown; args: string[];
  run: (args: string[]) => Promise<UploadResult>; audit: (event: UploadAudit) => void;
}): Promise<UploadResult> {
  const record: UploadAudit = { name: null, size: null, sha256: null, origin: null, result: 'rejected' };
  let dir: string | undefined;
  try {
    const p = options.payload as UploadPayload;
    if (validName(p?.name)) record.name = p.name;
    if (options.policy === undefined) throw new Error('Uploads are disabled on this listener');
    validateUploadPolicy(options.policy);
    if (options.args.length !== 1 || options.args[0] !== 'upload') throw new Error('Upload takes stdin bytes, not host paths or CLI options');
    if (!p || !validName(p.name) || typeof p.contentType !== 'string' || typeof p.data !== 'string'
      || Object.keys(p).some(k => !['name', 'contentType', 'data'].includes(k))) throw new Error('Invalid upload payload');
    const limit = options.policy.maxBytes ?? MAX_UPLOAD_BYTES;
    if (p.data.length > 4 * Math.ceil(limit / 3) || /[^A-Za-z0-9+/=]/.test(p.data))
      throw new Error('Upload exceeds maxBytes or has invalid base64');
    const bytes = Buffer.from(p.data, 'base64');
    record.size = bytes.length;
    record.sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!bytes.length || bytes.length > limit || bytes.toString('base64') !== p.data) throw new Error('Upload is empty, exceeds maxBytes, or is not canonical base64');
    if (!(options.policy.contentTypes ?? UPLOAD_TYPES).includes(p.contentType) || !matchesType(bytes, p.contentType))
      throw new Error('Upload content type is not allowed or does not match the bytes');
    const tabs = await options.run(['tab-list']);
    if (tabs.status !== 0) throw new Error('Could not inspect the upload page');
    record.origin = currentPageOrigin(tabs.stdout);
    dir = await mkdtemp(join(tmpdir(), 'rech-upload-')); // 0700; never served by /files
    const path = join(dir, randomBytes(16).toString('hex') + (p.contentType === 'image/png' ? '.png' : '.svg'));
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
    record.result = 'failed';
    const result = await options.run(['upload', path]);
    record.result = result.status === 0 && !/^### Error\b/m.test(result.stdout) ? 'completed' : 'failed';
    return { ...result, status: record.result === 'completed' ? 0 : 1,
      stdout: result.stdout.replaceAll(path, p.name), stderr: result.stderr.replaceAll(path, p.name) };
  } catch (error) {
    return { status: 1, stdout: '', stderr: (error instanceof Error ? error.message : 'Upload failed') + '\n' };
  } finally {
    try { if (dir) await rm(dir, { recursive: true, force: true }); }
    finally { options.audit(record); }
  }
}

export async function readRequestJson(req: Request): Promise<any> {
  const reader = req.body?.getReader();
  if (!reader) throw new Error('Empty request');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) throw new Error('Request exceeds 3 MiB');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
