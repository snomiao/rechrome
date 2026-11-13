import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm, realpath, stat, open, readFile, statfs, type FileHandle } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, join, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';

// The most that fits in one request; a larger file is split into chunks (chunkUploadPayloads) that
// serve streams to a temp file on disk, so rechrome imposes no total-size cap of its own. A listener
// may still set an optional per-upload maxBytes (for links shared with outsiders).
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
// Base64 (4/3) plus metadata. Bound JSON input before parsing, not just decoded bytes.
export const MAX_REQUEST_BYTES = 14 * 1024 * 1024;
// How much of a staged file to read for content sniffing (magic bytes, and a UTF-8 head check for
// text types). The whole file is never read into memory for into/auto delivery.
export const SNIFF_HEAD_BYTES = 64 * 1024;
// Why into/auto have no size limit but drop/paste do:
//   - into/auto call setInputFiles(<host path>): Chrome opens the file from DISK itself and the page
//     reads it through the streaming File/Blob API. Nothing is buffered whole in JS, so there is no
//     cap — a multi-GB file is fine (bounded only by disk). This is rech's path for large files.
//   - drop/paste must synthesize a real drag-drop/paste event, which requires a fully-materialized
//     File inside a DataTransfer *in page JS*. There is no streaming/incremental API that feeds a
//     DataTransfer, so the whole payload has to exist as one in-page value: a base64 string (V8 max
//     string length ~1 GiB) decoded to a Uint8Array (V8 max ArrayBuffer ~2 GiB) — structural engine
//     caps, not just memory. And rech hands that value to the page as ONE page.evaluate argument,
//     serialized into ONE CDP message over the extension relay, whose message size is the real (and
//     lowest) ceiling. So drop/paste cannot stream; above the limit we fail with "use --into".
// NOTE: 32 MiB is a conservative, NOT-YET-MEASURED placeholder. The real relay/CDP ceiling must be
// measured on sym003 once it runs this code (chunked upload + a temporarily-raised constant), then
// set here in a follow-up PR. ~7 MiB base64 inline is confirmed instant; the upper bound is unverified.
export const DROP_PASTE_MAX_BYTES = 32 * 1024 * 1024;
// Keep the host from running out of disk: leave this much free after an upload's estimated size.
const FREE_DISK_MARGIN = 256 * 1024 * 1024;
// Images are the default allowed set (every listener with uploads on). matchesType sniffs each.
export const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'] as const;
// Documents are opt-in per listener (rech listener set <name> --upload-types …). They are never
// parsed or executed on the host — the bytes are written to a private temp file and handed to the
// page's file input as a File, so the sniffs below only confirm the declared type, not host safety.
export const DOCUMENT_TYPES = [
  'application/pdf',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
  'text/csv',
  'text/tab-separated-values',
  'text/plain',
  'application/json',
] as const;
export const ALL_UPLOAD_TYPES = [...UPLOAD_TYPES, ...DOCUMENT_TYPES] as const;
const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', json: 'application/json',
};
// The ZIP container shared by xlsx/docx/pptx (and a bare .zip). Empty/spanned markers included.
const ZIP_TYPES = new Set([
  'application/zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
// Text-ish types with no magic number: accept any valid UTF-8 without a NUL byte.
const TEXT_TYPES = new Set(['text/csv', 'text/tab-separated-values', 'text/plain', 'application/json']);
/**
 * How the file reaches the page. auto: the open file chooser, else the page's only file input.
 * chooser: the file chooser a previous `rech click` opened. into: a file input (hidden ones too),
 * or a button that opens a file chooser when clicked. drop: a drag-and-drop zone. paste: an editor
 * that takes pasted images (the target, else the focused element).
 */
export const UPLOAD_MODES = ['auto', 'chooser', 'into', 'drop', 'paste'] as const;
export type UploadMode = typeof UPLOAD_MODES[number];
/** hostDirs: opt-in, off by default. Lets a link holder upload a file that is already on the
 *  host, inside one of these directories (rech upload --host <path>). */
export type UploadPolicy = { maxBytes?: number; contentTypes?: string[]; hostDirs?: string[] };
/** A large client file is split into ordered chunks sharing one id; the final chunk delivers. */
export type UploadChunk = { id: string; seq: number; total: number };
export type UploadPayload = { name: string; contentType: string; data?: string; hostPath?: string; mode?: UploadMode; target?: string; chunk?: UploadChunk };

// A client file above this raw size is sent in chunks so no single request body approaches
// MAX_REQUEST_BYTES. 6 MiB raw ≈ 8 MiB base64, comfortably under the ~14 MiB JSON cap.
export const CHUNK_RAW_BYTES = 6 * 1024 * 1024;
const MAX_CHUNKS = 1_000_000; // a sanity bound on the chunk count; real limits are free disk + maxBytes
const STAGING_TTL_MS = 5 * 60 * 1000;
const MAX_INFLIGHT_UPLOADS = 8;
const CHUNK_ID = /^[0-9A-Za-z]{8,43}$/;
// Each in-flight chunked upload streams to its own temp dir on disk, so serve holds only one chunk
// in memory at a time, not the whole file. Keyed by the caller's session plus the client-chosen id,
// so one credential's upload can't touch another's.
type Staging = { dir: string; path: string; handle: FileHandle; received: number; next: number; total: number; name: string; contentType: string; mode?: UploadMode; target?: string; maxBytes?: number; at: number };
const staging = new Map<string, Staging>();
async function discardStaging(s: Staging): Promise<void> {
  try { await s.handle.close(); } catch {}
  try { await rm(s.dir, { recursive: true, force: true }); } catch {}
}
async function sweepStaging(): Promise<void> {
  const now = Date.now();
  for (const [k, s] of staging) if (now - s.at > STAGING_TTL_MS) { staging.delete(k); await discardStaging(s); }
}
export type UploadResult = { status: number; stdout: string; stderr: string };
export type UploadAudit = { name: string | null; size: number | null; sha256: string | null; origin: string | null; result: string; mode?: UploadMode; hostPath?: string };

export function validateUploadPolicy(value: unknown): asserts value is UploadPolicy {
  const p = value as UploadPolicy;
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !['maxBytes', 'contentTypes', 'hostDirs'].includes(k))
    || (p.maxBytes !== undefined && (!Number.isSafeInteger(p.maxBytes) || p.maxBytes < 1))
    || (p.contentTypes !== undefined && (!Array.isArray(p.contentTypes) || !p.contentTypes.length || p.contentTypes.some(t => !ALL_UPLOAD_TYPES.includes(t as any))))
    || (p.hostDirs !== undefined && (!Array.isArray(p.hostDirs) || !p.hostDirs.length || p.hostDirs.some(d => typeof d !== 'string' || !isAbsolute(d) || d.includes('\0') || d === sep))))
    throw new Error(`uploads must be an object with optional maxBytes (a positive byte count; a per-upload cap for outsiders, no cap by default), contentTypes (${ALL_UPLOAD_TYPES.join(', ')}) and hostDirs (absolute directories, not /)`);
}

/**
 * Resolve `rech listener set --upload-types <token…>` into the content-type list to store on the
 * policy. Tokens: "images" (reset to the image-only default — returns undefined), "documents"/"docs"
 * /"all" (images plus every document type), or any mix of extensions (xlsx, csv) and MIME types.
 * An explicit list always keeps the images allowed, so turning on documents never silently drops them.
 */
export function resolveUploadTypes(tokens: string[]): string[] | undefined {
  const lower = tokens.map(t => t.trim().toLowerCase()).filter(Boolean);
  if (!lower.length) throw new Error('--upload-types needs at least one of: images, documents, or specific types (xlsx, csv, application/pdf, …)');
  if (lower.length === 1 && lower[0] === 'images') return undefined; // back to the image-only default
  if (lower.some(t => t === 'documents' || t === 'docs' || t === 'all')) return [...ALL_UPLOAD_TYPES];
  const picked = new Set<string>(UPLOAD_TYPES); // images stay allowed alongside any documents chosen
  for (const t of lower) {
    if (t === 'images') { for (const i of UPLOAD_TYPES) picked.add(i); continue; }
    const mime = ALL_UPLOAD_TYPES.includes(t as any) ? t : EXTENSION_TYPES[t.replace(/^\./, '')];
    if (!mime) throw new Error(`Unknown upload type "${t}". Use images, documents, an extension (${Object.keys(EXTENSION_TYPES).join(', ')}) or a MIME type.`);
    picked.add(mime);
  }
  return [...picked];
}

function validName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 128
    && name !== '.' && name !== '..' && !name.startsWith('-') && !/[\\/:\x00-\x1f\x7f]/.test(name);
}

/** A snapshot ref (e12, f1e3) or a selector, the targets `rech click` takes; never a host path. */
function validTarget(target: unknown): target is string {
  return typeof target === 'string' && target.length > 0 && target.length <= 512 && !/[\x00-\x1f\x7f]/.test(target);
}

function matchesType(bytes: Buffer, type: string): boolean {
  if (type === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/gif') return bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
  if (type === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
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
  if (type === 'application/pdf') return bytes.length >= 5 && bytes.toString('ascii', 0, 5) === '%PDF-';
  if (ZIP_TYPES.has(type)) {
    // Any ZIP local-file (PK\x03\x04), empty-archive (PK\x05\x06) or spanned (PK\x07\x08) header.
    // xlsx/docx/pptx are ZIPs; we confirm the container, not the OOXML part names.
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
    return (bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06) || (bytes[2] === 0x07 && bytes[3] === 0x08);
  }
  // Text types carry no magic number; reject only an obvious binary (a NUL byte). The check runs on a
  // bounded head of a streamed file, so it must not depend on seeing the whole file or a clean UTF-8 end.
  if (TEXT_TYPES.has(type)) return !bytes.includes(0);
  return false;
}

export const UPLOAD_USAGE = `Usage: rech upload <file> [how]   (the file is read on this machine; only its bytes are sent)
  (no flag)              the file chooser a click opened, else the page's only <input type=file>
  --into <ref|selector>  a file input (hidden ones too), or a button that opens a file chooser
  --drop <ref|selector>  a drag-and-drop zone
  --paste [ref|selector] an editor that takes pasted images (default: the focused element)
  --name <file>          read the bytes from stdin instead:  rech upload --name shot.png < shot.png
  --host <path>          a file already on the host (only where its listener allows that directory)
Images (${UPLOAD_TYPES.join(', ')}) are always allowed; a listener may also allow documents (xlsx, csv, pdf, zip, …).
There is no size limit by default — a file larger than one request (~${MAX_REQUEST_BYTES / 1024 / 1024} MiB) is streamed in chunks, bounded only by host disk (and a listener's optional --upload-max-mb). --drop/--paste deliver through the page and are limited to ${DROP_PASTE_MAX_BYTES / 1024 / 1024} MiB; use --into for a larger file. Get refs from rech snapshot.`;

/**
 * Client side of `rech upload`: read the file here (a path argument, or stdin with --name) and
 * send only its bytes and metadata. The host never sees a client path, and no payload field can
 * name a host file.
 */
export async function prepareUpload(args: string[], stdin: AsyncIterable<Uint8Array> | null, readLocal: (path: string) => Promise<Uint8Array> = path => Bun.file(path).bytes()): Promise<{ args: string[]; upload: UploadPayload }> {
  const sessions = args.filter(a => /^-s=[a-zA-Z0-9_-]{1,64}$/.test(a));
  const options = args.filter(a => !sessions.includes(a));
  if (options.shift() !== 'upload') throw new Error('Expected upload command');
  const fields: Record<string, string> = {};
  let path: string | undefined, mode: UploadMode = 'auto', target: string | undefined;
  const setMode = (next: UploadMode) => { if (mode !== 'auto') throw new Error(`Pick one of --into, --drop, --paste.`); mode = next; };
  while (options.length) {
    const option = options.shift()!;
    const match = option.match(/^--(name|content-type|into|drop|paste|chooser|host)(?:=(.*))?$/);
    if (!match) {
      if (option.startsWith('-') || path !== undefined) throw new Error(path !== undefined ? `One file per upload; unexpected ${option}` : `Unknown option ${option}`);
      path = option;
      continue;
    }
    const [, flag, inline] = match;
    if (flag === 'chooser') { setMode('chooser'); continue; }
    // --paste's target is optional (the focused element); the others need a value.
    const value = inline ?? (flag === 'paste' && (!options[0] || options[0].startsWith('-')) ? '' : options.shift());
    if (value === undefined || (value === '' && flag !== 'paste') || value.startsWith('--')) throw new Error(`Missing value for --${flag}.`);
    if (flag === 'into' || flag === 'drop' || flag === 'paste') { setMode(flag); if (value) target = value; continue; }
    if (fields[flag] !== undefined) throw new Error(`--${flag} given twice`);
    fields[flag] = value;
  }
  if (target !== undefined && !validTarget(target)) throw new Error('Upload target must be a snapshot ref (e12) or a selector');
  if (fields.host !== undefined) {
    // A file on the host: send only its path; the host reads it if its listener allows that directory.
    if (path !== undefined || fields.name !== undefined) throw new Error('--host takes the host file instead of a local file or --name');
    if (!isAbsolute(fields.host)) throw new Error('--host needs an absolute path on the host');
    const hostName = basename(fields.host);
    if (!validName(hostName)) throw new Error('The host file name must be a plain name');
    const hostType = fields['content-type'] ?? EXTENSION_TYPES[hostName.toLowerCase().split('.').pop() ?? ''] ?? '';
    if (!ALL_UPLOAD_TYPES.includes(hostType as any)) throw new Error(`Upload content type must be one of ${ALL_UPLOAD_TYPES.join(', ')} (from the file extension, or --content-type)`);
    const upload: UploadPayload = { name: hostName, contentType: hostType, hostPath: fields.host };
    if (mode !== 'auto') upload.mode = mode;
    if (target !== undefined) upload.target = target;
    return { args: ['upload', ...sessions], upload };
  }
  if (path === undefined && !stdin) throw new Error(`upload needs a file.`);
  const name = fields.name ?? (path !== undefined ? basename(path) : undefined);
  if (!validName(name)) throw new Error(path !== undefined ? 'The file name must be a plain name; rename the file or pass --name' : 'Reading stdin needs --name with a plain filename (no path)');
  const contentType = fields['content-type'] ?? EXTENSION_TYPES[name.toLowerCase().split('.').pop() ?? ''] ?? '';
  if (!ALL_UPLOAD_TYPES.includes(contentType as any)) throw new Error(`Upload content type must be one of ${ALL_UPLOAD_TYPES.join(', ')} (from the file extension, or --content-type)`);
  // No client-side size cap: a file above one request is split by chunkUploadPayloads and streamed
  // to disk on the host, where free disk and the listener's optional maxBytes are what bound it.
  let bytes: Buffer;
  if (path !== undefined) {
    bytes = Buffer.from(await readLocal(path).catch((e: any) => { throw new Error(`Cannot read ${path}: ${e?.code === 'ENOENT' ? 'no such file' : e?.message ?? e}`); }));
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin!) chunks.push(Buffer.from(chunk));
    bytes = Buffer.concat(chunks);
  }
  if (!matchesType(bytes, contentType)) throw new Error(`Upload bytes are not ${contentType} (SVG must be UTF-8 without DTD/entities)`);
  const upload: UploadPayload = { name, contentType, data: bytes.toString('base64') };
  if (mode !== 'auto') upload.mode = mode;
  if (target !== undefined) upload.target = target;
  return { args: ['upload', ...sessions], upload };
}

/** @deprecated stdin form only; kept for callers of the old name. */
export const prepareStdinUpload = (args: string[], input: AsyncIterable<Uint8Array>) => prepareUpload(args, input, () => Promise.reject(new Error('stdin only')));

/**
 * Split a client upload whose bytes exceed `chunkRawBytes` into ordered chunk payloads sharing one
 * id (each request then stays well under MAX_REQUEST_BYTES); the host stages them and the final one
 * delivers. A small upload, or a `--host` upload (no client bytes), is returned as a single payload.
 */
export function chunkUploadPayloads(upload: UploadPayload, chunkRawBytes = CHUNK_RAW_BYTES): UploadPayload[] {
  if (upload.hostPath !== undefined || typeof upload.data !== 'string') return [upload];
  const bytes = Buffer.from(upload.data, 'base64');
  if (bytes.length <= chunkRawBytes) return [upload];
  const total = Math.ceil(bytes.length / chunkRawBytes);
  const id = randomBytes(12).toString('hex');
  const out: UploadPayload[] = [];
  for (let seq = 0; seq < total; seq++) {
    const slice = bytes.subarray(seq * chunkRawBytes, (seq + 1) * chunkRawBytes);
    out.push({
      name: upload.name, contentType: upload.contentType, data: slice.toString('base64'),
      ...(upload.mode !== undefined ? { mode: upload.mode } : {}),
      ...(upload.target !== undefined ? { target: upload.target } : {}),
      chunk: { id, seq, total },
    });
  }
  return out;
}

/** What the `into` script returns after clicking a button that should open a file chooser. */
const CLICKED = 'rech-upload: clicked, filling the file chooser';

/** The locator a CLI target names, as playwright-cli resolves it: refs use the snapshot's aria-ref engine. */
const locatorFor = (target: string) => `page.locator(${JSON.stringify(/^(f\d+)?e\d+$/.test(target) ? `aria-ref=${target}` : target)})`;

/**
 * The run-code script that delivers a staged file for `into`, `drop`, `paste`, or the auto
 * fallback (`auto`: the page's only file input). Every value is embedded with JSON.stringify,
 * so neither the target nor the file name can inject code; `file` is a server-owned path.
 */
export function uploadScript(mode: Exclude<UploadMode, 'chooser'>, target: string | undefined, file: string, payload: Pick<UploadPayload, 'name' | 'contentType' | 'data'>): string {
  const fileJson = JSON.stringify(file);
  // The page gets the bytes as a File, as if the user dragged or pasted it from outside.
  const bytes = `{ data: ${JSON.stringify(payload.data)}, name: ${JSON.stringify(payload.name)}, type: ${JSON.stringify(payload.contentType)} }`;
  const makeTransfer = `({ data, name, type }) => { const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], name, { type })); return dt; }`;
  if (mode === 'auto') return `async page => {
  const inputs = page.locator('input[type=file]');
  const count = await inputs.count();
  if (count !== 1) throw new Error(count ? count + ' file inputs on this page: pick one with --into <ref>' : 'No file chooser is open and the page has no file input. Name the upload button: rech upload <file> --into <ref>');
  await inputs.setInputFiles(${fileJson});
  return "Set on the page's file input";
}`;
  if (mode === 'into') return `async page => {
  const target = ${locatorFor(target!)};
  if (await target.evaluate(el => el instanceof HTMLInputElement && el.type === 'file')) {
    await target.setInputFiles(${fileJson});
    return 'Set on the file input';
  }
  // Not an input: click it. playwright-cli takes the file chooser that opens as its modal state,
  // which the follow-up \`upload\` fills (see receiveUpload).
  await target.click();
  return ${JSON.stringify(CLICKED)};
}`;
  if (mode === 'drop') return `async page => {
  const target = ${locatorFor(target!)};
  const transfer = await page.evaluateHandle(${makeTransfer}, ${bytes});
  for (const type of ['dragenter', 'dragover', 'drop']) await target.dispatchEvent(type, { dataTransfer: transfer });
  return 'Dropped onto the target';
}`;
  return `async page => {
  ${target ? `const target = ${locatorFor(target)}; await target.focus(); const element = await target.elementHandle();` : `const element = await page.evaluateHandle(() => document.activeElement || document.body);`}
  const handled = await element.evaluate((el, file) => {
    const make = ${makeTransfer};
    const event = new ClipboardEvent('paste', { clipboardData: make(file), bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  }, ${bytes});
  return handled ? 'Pasted; the page handled it' : 'Pasted, but nothing on the page handled the paste: try --drop or --into';
}`;
}

export function currentPageOrigin(output: string): string {
  const current = output.split('\n').filter(line => /^- \d+: \(current\) /.test(line));
  const url = current.length === 1 ? current[0].match(/\]\((.*)\)(?: \[crashed\])?$/)?.[1] : undefined;
  if (!url) throw new Error('Could not determine the upload page origin');
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Uploads require an HTTP(S) page');
  return parsed.origin;
}

/**
 * What the client gets back: the original name for the staged file, never the private dir, and
 * without the echoed script (for drop/paste it embeds the whole file as base64).
 */
function cleanOutput(text: string, path: string, dir: string, name: string): string {
  return text.replace(/### Ran Playwright code\n```js\n[\s\S]*?\n```\n*/g, '').replaceAll(path, name).replaceAll(dir, '<upload>');
}

/** No payload field is ever used as a host path. run() is a server-owned CLI runner,
 * not caller-supplied code. Audit records the selected origin immediately before upload.
 */
/**
 * A host file for `rech upload --host`: only when the listener lists hostDirs, and only a regular
 * file whose real path (symlinks resolved) is inside one of them.
 */
export async function readHostFile(path: string, hostDirs: string[] | undefined, limit: number): Promise<Buffer> {
  if (!hostDirs?.length) throw new Error('Host-path uploads are off on this listener (the host can allow a directory: rech listener set <name> --host-upload-dir <dir>)');
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Host upload path must be absolute');
  const roots = (await Promise.all(hostDirs.map(d => realpath(d).catch(() => null)))).filter((r): r is string => !!r);
  const inside = (real: string) => roots.some(root => real.startsWith(root.endsWith(sep) ? root : root + sep));
  const resolveInside = async () => {
    let real: string;
    // One answer for "missing" and "outside", so a link holder can't probe which host paths exist.
    const refused = () => new Error('Host upload path is not an existing file in the listener\'s allowed directories');
    try { real = await realpath(path); } catch { throw refused(); }
    if (!inside(real)) throw refused();
    return real;
  };
  // Open once, then prove the opened file is the one an allowed path names now (same device and
  // inode), so swapping in a symlink between the check and the open can't reach outside. Read from
  // that descriptor only, at most limit + 1 bytes, so a file growing after the check can't either.
  const handle = await open(await resolveInside(), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Host upload path is not a regular file');
    const now = await stat(await resolveInside());
    if (now.dev !== info.dev || now.ino !== info.ino) throw new Error('Host upload file changed while it was being opened');
    if (info.size > limit) throw new Error("Upload is empty or exceeds maxBytes");
    // Size the read buffer from the file itself (bounded by limit), not from limit, which may be
    // "no cap" (a huge sentinel) — Buffer.alloc of that would fail.
    const buf = Buffer.alloc(Math.min(info.size, limit) + 1);
    let n = 0;
    for (let r; n < buf.length && (r = await handle.read(buf, n, buf.length - n, n)).bytesRead > 0;) n += r.bytesRead;
    if (n > limit) throw new Error('Upload is empty or exceeds maxBytes');
    return buf.subarray(0, n);
  } finally { await handle.close(); }
}

/** name/type/mode/target validation shared by single-shot and chunk payloads (not data/hostPath). */
function validateDelivery(p: UploadPayload): void {
  if (!validName(p?.name) || typeof p.contentType !== 'string'
    || (p.mode !== undefined && !UPLOAD_MODES.includes(p.mode)) || (p.target !== undefined && !validTarget(p.target))
    || ((p.mode === 'into' || p.mode === 'drop') && p.target === undefined) || ((p.mode === 'auto' || p.mode === 'chooser') && p.target !== undefined))
    throw new Error('Invalid upload payload');
}

/** sha256 of a staged file, read in blocks so a large file is never fully held in memory. */
async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let r; (r = await handle.read(buf, 0, buf.length, null)).bytesRead > 0;) hash.update(buf.subarray(0, r.bytesRead));
  } finally { await handle.close(); }
  return hash.digest('hex');
}

/** The first `n` bytes of a file, for content sniffing without reading the whole thing. */
async function readHead(path: string, n: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    let got = 0;
    for (let r; got < n && (r = await handle.read(buf, got, n - got, got)).bytesRead > 0;) got += r.bytesRead;
    return buf.subarray(0, got);
  } finally { await handle.close(); }
}

/** Refuse before staging if the host has little room left for the upload's estimated size. */
async function assertFreeDisk(dir: string, estimate: number): Promise<void> {
  try {
    const fs = await statfs(dir);
    const free = fs.bavail * fs.bsize;
    if (free < estimate + FREE_DISK_MARGIN) throw new Error('Not enough free disk on the host for this upload');
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Not enough free disk')) throw e;
    // statfs unavailable on this platform: rely on an ENOSPC during the write instead.
  }
}

/**
 * Deliver a file already staged at `path` (inside private `dir`). Shared by the single-shot and the
 * final-chunk paths. Sniffs a bounded head, hashes by streaming, and never reads the whole file into
 * memory for into/auto (setInputFiles takes the path). drop/paste must embed base64 through the page,
 * so they are bounded by DROP_PASTE_MAX_BYTES and fail with a clear message above it. Fills `record`
 * and cleans `dir`; does NOT audit (the caller audits exactly once).
 */
async function deliverStaged(dir: string, path: string, p: UploadPayload, policy: UploadPolicy, run: (args: string[]) => Promise<UploadResult>, record: UploadAudit): Promise<UploadResult> {
  try {
    const size = (await stat(path)).size;
    record.size = size;
    if (!size) throw new Error('Upload is empty');
    if (policy.maxBytes !== undefined && size > policy.maxBytes) throw new Error('Upload exceeds maxBytes');
    const head = await readHead(path, SNIFF_HEAD_BYTES);
    if (!((policy.contentTypes ?? UPLOAD_TYPES) as readonly string[]).includes(p.contentType) || !matchesType(head, p.contentType))
      throw new Error('Upload content type is not allowed or does not match the bytes');
    record.sha256 = await sha256File(path);
    const tabs = await run(['tab-list']);
    if (tabs.status !== 0) throw new Error('Could not inspect the upload page');
    record.origin = currentPageOrigin(tabs.stdout);
    record.result = 'failed';
    const failed = (r: UploadResult) => r.status !== 0 || /^### Error\b/m.test(r.stdout);
    // into/auto/chooser hand Chrome the host path (setInputFiles) — no size limit, no bytes embedded.
    // drop/paste embed base64 through a page.evaluate, so they are capped at DROP_PASTE_MAX_BYTES.
    const script = async (mode: Exclude<UploadMode, 'chooser'>) => {
      let data = '';
      if (mode === 'drop' || mode === 'paste') {
        if (size > DROP_PASTE_MAX_BYTES) throw new Error(`This file (${(size / 1024 / 1024).toFixed(1)} MiB) is too large for --${mode}, which delivers it through the page (limit ${DROP_PASTE_MAX_BYTES / 1024 / 1024} MiB). Use --into <ref> (a file input) for a file this size.`);
        data = (await readFile(path)).toString('base64');
      }
      const file = join(dir, randomBytes(8).toString('hex') + '.js');
      await writeFile(file, uploadScript(mode, p.target, path, { name: p.name, contentType: p.contentType, data }), { mode: 0o600, flag: 'wx' });
      return run(['run-code', '--filename', file]);
    };
    const mode = p.mode ?? 'auto';
    let result = mode === 'auto' || mode === 'chooser' ? await run(['upload', path]) : await script(mode);
    // No chooser open: the page's only file input, the common case that needs no click at all.
    // The CLI's wording for "no file chooser is open" (older builds: "No file chooser visible").
    const noChooser = (r: UploadResult) => /No file chooser visible|only be used when there is related modal state/.test(r.stdout + r.stderr);
    if (mode === 'auto' && failed(result) && noChooser(result)) result = await script('auto');
    // The script's return value, not its echoed source (which contains the marker too).
    if (mode === 'into' && !failed(result) && result.stdout.match(/^### Result\n(.*)$/m)?.[1]?.includes(CLICKED)) {
      const filled = await run(['upload', path]);
      result = noChooser(filled)
        ? { status: 1, stdout: '', stderr: `Clicking ${p.target} opened no file chooser. Point --into at the file input or the button that opens it (see rech snapshot).\n` }
        : filled;
    }
    record.result = failed(result) ? 'failed' : 'completed';
    return { ...result, status: record.result === 'completed' ? 0 : 1,
      stdout: cleanOutput(result.stdout, path, dir, p.name), stderr: cleanOutput(result.stderr, path, dir, p.name) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function receiveUpload(options: {
  policy: UploadPolicy | undefined; payload: unknown; args: string[]; stagingKey?: string;
  run: (args: string[]) => Promise<UploadResult>; audit: (event: UploadAudit) => void;
}): Promise<UploadResult> {
  const record: UploadAudit = { name: null, size: null, sha256: null, origin: null, result: 'rejected' };
  const p = options.payload as UploadPayload;
  if (validName(p?.name)) record.name = p.name;
  if (UPLOAD_MODES.includes(p?.mode as UploadMode)) record.mode = p.mode;
  // A chunked upload streams across requests; it audits only on a failed chunk or the final chunk,
  // never per intermediate chunk, so it runs its own flow.
  if (p?.chunk !== undefined) return receiveChunk(options, p, record);
  let dir: string | undefined;
  try {
    if (options.policy === undefined) throw new Error('Uploads are disabled on this listener');
    validateUploadPolicy(options.policy);
    const policy = options.policy;
    if (options.args.length !== 1 || options.args[0] !== 'upload') throw new Error('Upload takes file bytes, not host paths or CLI options');
    const fromHost = p?.hostPath !== undefined;
    if (!p || (fromHost ? p.data !== undefined || typeof p.hostPath !== 'string' : typeof p.data !== 'string')
      || Object.keys(p).some(k => !['name', 'contentType', 'data', 'hostPath', 'mode', 'target'].includes(k)))
      throw new Error('Invalid upload payload');
    validateDelivery(p);
    // A single request is bounded by MAX_REQUEST_BYTES, so these bytes fit in memory; stage them to a
    // private file and deliver through the shared path (which sniffs/hashes from disk, not this buffer).
    let bytes: Buffer;
    if (fromHost) {
      record.hostPath = p.hostPath!.slice(0, 512);
      // A --host read is bounded by maxBytes if set, else by what a single read can return; large host
      // files still go via setInputFiles after staging.
      bytes = await readHostFile(p.hostPath!, policy.hostDirs, policy.maxBytes ?? Number.MAX_SAFE_INTEGER);
      if (basename(p.hostPath!) !== p.name) throw new Error('Host upload name must be the file\'s own name');
    } else {
      if (/[^A-Za-z0-9+/=]/.test(p.data!)) throw new Error('Upload has invalid base64');
      bytes = Buffer.from(p.data!, 'base64');
      if (bytes.toString('base64') !== p.data) throw new Error('Upload is not canonical base64');
    }
    dir = await mkdtemp(join(tmpdir(), 'rech-upload-')); // 0700; never served by /files
    const path = join(dir, p.name); // validName keeps it inside the private dir
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
    const result = await deliverStaged(dir, path, p, policy, options.run, record); // cleans dir
    dir = undefined;
    options.audit(record);
    return result;
  } catch (error) {
    if (dir) await rm(dir, { recursive: true, force: true });
    options.audit(record);
    return { status: 1, stdout: '', stderr: (error instanceof Error ? error.message : 'Upload failed') + '\n' };
  }
}

/** Stream one upload's ordered chunks to a per-session temp file (serve persists between requests)
 *  and deliver on the last. Never holds more than one chunk in memory. */
async function receiveChunk(options: {
  policy: UploadPolicy | undefined; args: string[]; stagingKey?: string;
  run: (args: string[]) => Promise<UploadResult>; audit: (event: UploadAudit) => void;
}, p: UploadPayload, record: UploadAudit): Promise<UploadResult> {
  const c = p.chunk!;
  const keyFor = (id: string) => `${options.stagingKey ?? ''}\0${id}`;
  try {
    if (options.policy === undefined) throw new Error('Uploads are disabled on this listener');
    validateUploadPolicy(options.policy);
    const policy = options.policy;
    if (options.args.length !== 1 || options.args[0] !== 'upload') throw new Error('Upload takes file bytes, not host paths or CLI options');
    if (!c || typeof c.id !== 'string' || !CHUNK_ID.test(c.id)
      || !Number.isSafeInteger(c.seq) || c.seq < 0 || !Number.isSafeInteger(c.total) || c.total < 1 || c.total > MAX_CHUNKS || c.seq >= c.total)
      throw new Error('Invalid upload chunk');
    if (p.hostPath !== undefined || typeof p.data !== 'string'
      || Object.keys(p).some(k => !['name', 'contentType', 'data', 'mode', 'target', 'chunk'].includes(k)))
      throw new Error('Invalid upload payload');
    validateDelivery(p);
    if (p.data.length > 4 * Math.ceil((CHUNK_RAW_BYTES + 1) / 3) || /[^A-Za-z0-9+/=]/.test(p.data))
      throw new Error('Upload chunk exceeds size or has invalid base64');
    const bytes = Buffer.from(p.data, 'base64');
    if (bytes.toString('base64') !== p.data) throw new Error('Upload chunk is not canonical base64');
    await sweepStaging();
    const key = keyFor(c.id);
    let s = staging.get(key);
    if (c.seq === 0) {
      const prior = staging.get(key); // a restart replaces any partial already under this id
      if (prior) { staging.delete(key); await discardStaging(prior); }
      if (staging.size >= MAX_INFLIGHT_UPLOADS) throw new Error('Too many uploads in progress; try again shortly');
      const dir = await mkdtemp(join(tmpdir(), 'rech-upload-'));
      await assertFreeDisk(dir, c.total * CHUNK_RAW_BYTES); // conservative estimate from the chunk count
      const path = join(dir, p.name);
      const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      s = { dir, path, handle, received: 0, next: 0, total: c.total, name: p.name, contentType: p.contentType, mode: p.mode, target: p.target, maxBytes: policy.maxBytes, at: Date.now() };
      staging.set(key, s);
    } else {
      if (!s) throw new Error('Unknown or expired upload; restart from the first chunk');
      if (c.seq !== s.next || c.total !== s.total || p.name !== s.name || p.contentType !== s.contentType
        || (p.mode ?? undefined) !== (s.mode ?? undefined) || (p.target ?? undefined) !== (s.target ?? undefined))
        throw new Error('Upload chunk out of order or its metadata changed');
    }
    if (s.maxBytes !== undefined && s.received + bytes.length > s.maxBytes) throw new Error('Upload exceeds maxBytes');
    try { await s.handle.write(bytes); }
    catch (e: any) { throw new Error(e?.code === 'ENOSPC' ? 'Not enough free disk on the host for this upload' : (e?.message ?? 'Could not stage upload chunk')); }
    s.received += bytes.length; s.next++; s.at = Date.now();
    if (c.seq < c.total - 1) return { status: 0, stdout: `### Result\n"staged chunk ${c.seq + 1}/${c.total}"`, stderr: '' };
    // Final chunk: close the file, then deliver it from disk (deliverStaged cleans the dir).
    staging.delete(key);
    try { await s.handle.close(); } catch {}
    const result = await deliverStaged(s.dir, s.path, p, policy, options.run, record);
    options.audit(record);
    return result;
  } catch (error) {
    const s = c?.id ? staging.get(keyFor(c.id)) : undefined;
    if (s) { staging.delete(keyFor(c.id)); await discardStaging(s); }
    options.audit(record);
    return { status: 1, stdout: '', stderr: (error instanceof Error ? error.message : 'Upload failed') + '\n' };
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
      if (size > MAX_REQUEST_BYTES) throw new Error(`Request exceeds ${MAX_REQUEST_BYTES / 1024 / 1024} MiB`);
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
