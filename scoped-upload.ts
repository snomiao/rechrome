import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
// Base64 (4/3) plus metadata. Bound JSON input before parsing, not just decoded bytes.
export const MAX_REQUEST_BYTES = 14 * 1024 * 1024;
export const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'] as const;
const EXTENSION_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
/**
 * How the file reaches the page. auto: the open file chooser, else the page's only file input.
 * chooser: the file chooser a previous `rech click` opened. into: a file input (hidden ones too),
 * or a button that opens a file chooser when clicked. drop: a drag-and-drop zone. paste: an editor
 * that takes pasted images (the target, else the focused element).
 */
export const UPLOAD_MODES = ['auto', 'chooser', 'into', 'drop', 'paste'] as const;
export type UploadMode = typeof UPLOAD_MODES[number];
export type UploadPolicy = { maxBytes?: number; contentTypes?: string[] };
export type UploadPayload = { name: string; contentType: string; data: string; mode?: UploadMode; target?: string };
export type UploadResult = { status: number; stdout: string; stderr: string };
export type UploadAudit = { name: string | null; size: number | null; sha256: string | null; origin: string | null; result: string; mode?: UploadMode };

export function validateUploadPolicy(value: unknown): asserts value is UploadPolicy {
  const p = value as UploadPolicy;
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !['maxBytes', 'contentTypes'].includes(k))
    || (p.maxBytes !== undefined && (!Number.isSafeInteger(p.maxBytes) || p.maxBytes < 1 || p.maxBytes > MAX_UPLOAD_BYTES))
    || (p.contentTypes !== undefined && (!Array.isArray(p.contentTypes) || !p.contentTypes.length || p.contentTypes.some(t => !UPLOAD_TYPES.includes(t as any)))))
    throw new Error(`uploads must be an object with optional maxBytes (1..${MAX_UPLOAD_BYTES}) and contentTypes (${UPLOAD_TYPES.join(', ')})`);
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
  return false;
}

export const UPLOAD_USAGE = `Usage: rech upload <file> [how]   (the file is read on this machine; only its bytes are sent)
  (no flag)              the file chooser a click opened, else the page's only <input type=file>
  --into <ref|selector>  a file input (hidden ones too), or a button that opens a file chooser
  --drop <ref|selector>  a drag-and-drop zone
  --paste [ref|selector] an editor that takes pasted images (default: the focused element)
  --name <file>          read the bytes from stdin instead:  rech upload --name shot.png < shot.png
Types: ${UPLOAD_TYPES.join(', ')}, up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB. Get refs from rech snapshot.`;

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
    const match = option.match(/^--(name|content-type|into|drop|paste|chooser)(?:=(.*))?$/);
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
  if (path === undefined && !stdin) throw new Error(`upload needs a file.`);
  const name = fields.name ?? (path !== undefined ? basename(path) : undefined);
  if (!validName(name)) throw new Error(path !== undefined ? 'The file name must be a plain name; rename the file or pass --name' : 'Reading stdin needs --name with a plain filename (no path)');
  const contentType = fields['content-type'] ?? EXTENSION_TYPES[name.toLowerCase().split('.').pop() ?? ''] ?? '';
  if (!UPLOAD_TYPES.includes(contentType as any)) throw new Error(`Upload content type must be one of ${UPLOAD_TYPES.join(', ')} (from the file extension, or --content-type)`);
  let bytes: Buffer;
  if (path !== undefined) {
    bytes = Buffer.from(await readLocal(path).catch((e: any) => { throw new Error(`Cannot read ${path}: ${e?.code === 'ENOENT' ? 'no such file' : e?.message ?? e}`); }));
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error(`Upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB`);
  } else {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stdin!) {
      size += chunk.byteLength;
      if (size > MAX_UPLOAD_BYTES) throw new Error(`Upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB`);
      chunks.push(Buffer.from(chunk));
    }
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
export async function receiveUpload(options: {
  policy: UploadPolicy | undefined; payload: unknown; args: string[];
  run: (args: string[]) => Promise<UploadResult>; audit: (event: UploadAudit) => void;
}): Promise<UploadResult> {
  const record: UploadAudit = { name: null, size: null, sha256: null, origin: null, result: 'rejected' };
  let dir: string | undefined;
  try {
    const p = options.payload as UploadPayload;
    if (validName(p?.name)) record.name = p.name;
    if (UPLOAD_MODES.includes(p?.mode as UploadMode)) record.mode = p.mode;
    if (options.policy === undefined) throw new Error('Uploads are disabled on this listener');
    validateUploadPolicy(options.policy);
    if (options.args.length !== 1 || options.args[0] !== 'upload') throw new Error('Upload takes file bytes, not host paths or CLI options');
    if (!p || !validName(p.name) || typeof p.contentType !== 'string' || typeof p.data !== 'string'
      || Object.keys(p).some(k => !['name', 'contentType', 'data', 'mode', 'target'].includes(k))
      || (p.mode !== undefined && !UPLOAD_MODES.includes(p.mode)) || (p.target !== undefined && !validTarget(p.target))
      || ((p.mode === 'into' || p.mode === 'drop') && p.target === undefined) || ((p.mode === 'auto' || p.mode === 'chooser') && p.target !== undefined))
      throw new Error('Invalid upload payload');
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
    // The page sees the original name (validName: a plain name, so it stays inside the private dir).
    const path = join(dir, p.name);
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
    record.result = 'failed';
    const failed = (r: UploadResult) => r.status !== 0 || /^### Error\b/m.test(r.stdout);
    const script = async (mode: Exclude<UploadMode, 'chooser'>) => {
      const file = join(dir!, randomBytes(8).toString('hex') + '.js');
      await writeFile(file, uploadScript(mode, p.target, path, p), { mode: 0o600, flag: 'wx' });
      return options.run(['run-code', '--filename', file]);
    };
    const mode = p.mode ?? 'auto';
    let result = mode === 'auto' || mode === 'chooser' ? await options.run(['upload', path]) : await script(mode);
    // No chooser open: the page's only file input, the common case that needs no click at all.
    // The CLI's wording for "no file chooser is open" (older builds: "No file chooser visible").
    const noChooser = (r: UploadResult) => /No file chooser visible|only be used when there is related modal state/.test(r.stdout + r.stderr);
    if (mode === 'auto' && failed(result) && noChooser(result)) result = await script('auto');
    // The script's return value, not its echoed source (which contains the marker too).
    if (mode === 'into' && !failed(result) && result.stdout.match(/^### Result\n(.*)$/m)?.[1]?.includes(CLICKED)) {
      const filled = await options.run(['upload', path]);
      result = noChooser(filled)
        ? { status: 1, stdout: '', stderr: `Clicking ${p.target} opened no file chooser. Point --into at the file input or the button that opens it (see rech snapshot).\n` }
        : filled;
    }
    record.result = failed(result) ? 'failed' : 'completed';
    return { ...result, status: record.result === 'completed' ? 0 : 1,
      stdout: cleanOutput(result.stdout, path, dir, p.name), stderr: cleanOutput(result.stderr, path, dir, p.name) };
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
      if (size > MAX_REQUEST_BYTES) throw new Error(`Request exceeds ${MAX_REQUEST_BYTES / 1024 / 1024} MiB`);
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
