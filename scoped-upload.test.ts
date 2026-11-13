import { expect, test } from 'bun:test';
import { stat, readFile } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareUpload, prepareStdinUpload, chunkUploadPayloads, uploadScript, receiveUpload, readHostFile, validateUploadPolicy, resolveUploadTypes, currentPageOrigin, readRequestJson, MAX_UPLOAD_BYTES, MAX_REQUEST_BYTES, CHUNK_RAW_BYTES, DROP_PASTE_MAX_BYTES, UPLOAD_TYPES, type UploadAudit, type UploadPayload } from './scoped-upload.ts';
import { authorizeProfileRequest, type Listener } from './listeners.ts';
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
const payload = { name: 'app.svg', contentType: 'image/svg+xml', data: svg.toString('base64') };
const tabs = { status: 0, stdout: '- 0: (current) [Slack](https://api.slack.com/apps/ABC?secret=x#icon)', stderr: '' };
const listener: Listener = { name: 'qa', host: '127.0.0.1', port: 13779, profiles: ['qa'], key: 'x'.repeat(24) };
const body = (args: string[], upload: any = payload) => ({ args, upload, identity: { key: 'test', profile: 'qa' } });
async function* input(bytes = svg) { yield bytes; }

test('stdin client accepts metadata, never a caller path', async () => {
  expect(await prepareStdinUpload(['upload', '--name', 'app.svg', '-s=qa'], input())).toEqual({ args: ['upload', '-s=qa'], upload: payload });
  for (const args of [['upload', '/etc/passwd'], ['upload', '--name', '../app.svg'], ['upload', '--name', 'app.svg', '--name', 'again.svg'], ['upload', '--name', 'app.svg', '--filename=/etc/passwd']])
    await expect(prepareStdinUpload(args, input())).rejects.toThrow();
  await expect(prepareStdinUpload(['upload', '--name', 'app.png'], input())).rejects.toThrow('are not image/png');
  // No client-side size cap any more: a file above the old 10 MiB limit still builds a payload (it is
  // chunked at send time and bounded on the host by free disk / the listener's optional maxBytes).
  const big = Buffer.alloc(MAX_UPLOAD_BYTES + 4096, 0x61); // valid text, over the old cap
  const r = await prepareStdinUpload(['upload', '--name', 'big.txt'], input(big));
  expect(Buffer.from(r.upload.data!, 'base64').length).toBe(big.length);
});

test('a file path is read on the client: only its bytes, name and delivery mode are sent', async () => {
  const read = async (path: string) => { expect(path).toBe('./shots/app.svg'); return svg; };
  expect(await prepareUpload(['upload', './shots/app.svg', '-s=qa'], null, read)).toEqual({ args: ['upload', '-s=qa'], upload: payload });
  expect((await prepareUpload(['upload', './shots/app.svg', '--into', 'e12'], null, read)).upload).toEqual({ ...payload, mode: 'into', target: 'e12' });
  expect((await prepareUpload(['upload', './shots/app.svg', '--drop=.zone'], null, read)).upload).toEqual({ ...payload, mode: 'drop', target: '.zone' });
  expect((await prepareUpload(['upload', './shots/app.svg', '--paste'], null, read)).upload).toEqual({ ...payload, mode: 'paste' });
  expect((await prepareUpload(['upload', '--paste', 'e3', './shots/app.svg'], null, read)).upload).toEqual({ ...payload, mode: 'paste', target: 'e3' });
  for (const args of [['upload'], ['upload', './a.svg', './b.svg'], ['upload', './shots/app.svg', '--into'], ['upload', './shots/app.svg', '--into', 'e1', '--drop', 'e2'], ['upload', './shots/app.svg', '--config=x']])
    await expect(prepareUpload(args, null, read)).rejects.toThrow();
  await expect(prepareUpload(['upload', './missing.png'], null, () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' })))).rejects.toThrow('no such file');
  // Formats by magic bytes, not by name alone.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), webp = Buffer.from('RIFF\0\0\0\0WEBPVP8 ');
  expect((await prepareUpload(['upload', 'x.jpg'], null, async () => jpeg)).upload.contentType).toBe('image/jpeg');
  expect((await prepareUpload(['upload', 'x.webp'], null, async () => webp)).upload.contentType).toBe('image/webp');
  await expect(prepareUpload(['upload', 'x.jpg'], null, async () => webp)).rejects.toThrow('are not image/jpeg');
});

test('delivery scripts embed the target and file as data, never as code', () => {
  const evil = `'); require('child_process').exec('x'); ('`;
  for (const mode of ['auto', 'into', 'drop', 'paste'] as const) {
    const code = uploadScript(mode, evil, '/tmp/rech-upload-x/app.svg', payload);
    if (mode !== 'auto') expect(code).toContain(JSON.stringify(evil));
    expect(new Function('return ' + code)).not.toThrow();   // still one well-formed function
  }
  expect(uploadScript('into', 'e12', '/f', payload)).toContain('page.locator("aria-ref=e12")');
  expect(uploadScript('into', 'input#avatar', '/f', payload)).toContain('page.locator("input#avatar")');
});

test('uploads default on, false turns them off; uploads never enable eval or host paths', () => {
  expect(authorizeProfileRequest(listener, body(['upload', '-s=qa']))).toBe('qa');
  expect(() => authorizeProfileRequest({ ...listener, uploads: false }, body(['upload']))).toThrow(/Uploads are off/);
  const enabled = { ...listener, uploads: {} };
  expect(authorizeProfileRequest(enabled, body(['upload', '-s=qa']))).toBe('qa');
  for (const l of [listener, enabled]) for (const args of [['eval', '() => 1'], ['upload', '/etc/passwd'], ['upload', '../secret'], ['upload', '--filename=/etc/passwd'], ['upload', '--config=evil']])
    expect(() => authorizeProfileRequest(l, body(args))).toThrow();
  expect(() => authorizeProfileRequest(enabled, body(['upload'], null))).toThrow();
  for (const p of [true, null, { directory: '/tmp' }, { maxBytes: 0 }, { maxBytes: -5 }, { maxBytes: 1.5 }, { contentTypes: ['text/html'] }])
    expect(() => validateUploadPolicy(p)).toThrow();
  // maxBytes is an optional opt-in cap with no fixed ceiling (any positive byte count); document
  // types opt in too; images stay valid. The default (no maxBytes) means no size cap.
  for (const p of [{}, { maxBytes: MAX_UPLOAD_BYTES + 1 }, { maxBytes: 5 * 1024 * 1024 * 1024 }, { contentTypes: ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] }])
    expect(() => validateUploadPolicy(p)).not.toThrow();
});

test('resolveUploadTypes: images resets to default, documents/mix keep images alongside', () => {
  expect(resolveUploadTypes(['images'])).toBeUndefined();
  expect(resolveUploadTypes(['documents'])).toContain('text/csv');
  expect(resolveUploadTypes(['documents'])).toContain('image/png');
  const mix = resolveUploadTypes(['xlsx', 'csv'])!;
  expect(mix).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  expect(mix).toContain('text/csv');
  for (const img of UPLOAD_TYPES) expect(mix).toContain(img); // images never dropped
  expect(resolveUploadTypes(['application/pdf'])).toContain('application/pdf');
  expect(() => resolveUploadTypes([])).toThrow();
  expect(() => resolveUploadTypes(['nonsense'])).toThrow('Unknown upload type');
});

for (const failure of [false, true]) test(`private byte staging, origin audit and cleanup (${failure ? 'timeout/error' : 'success'})`, async () => {
  const audit: UploadAudit[] = [];
  let staged = '';
  const result = await receiveUpload({ policy: {}, payload, args: ['upload'], audit: r => audit.push(r), run: async args => {
    if (args[0] === 'tab-list') return tabs;
    staged = args[1];
    // The page sees the original name; the private random dir keeps it from naming any host file.
    expect(basename(staged)).toBe('app.svg');
    expect(basename(dirname(staged))).toMatch(/^rech-upload-/);
    expect(await readFile(staged)).toEqual(svg);
    if (process.platform !== 'win32') {
      expect((await stat(staged)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(staged))).mode & 0o777).toBe(0o700);
    }
    if (failure) throw new Error('Upload command timed out');
    return { status: 0, stdout: `uploaded ${staged}`, stderr: '' };
  } });
  expect(result.status).toBe(failure ? 1 : 0);
  expect(result.stdout).not.toContain('rech-upload-');
  expect(await Bun.file(staged).exists()).toBe(false);
  await expect(stat(dirname(staged))).rejects.toThrow();
  expect(audit).toHaveLength(1);
  expect(audit[0]).toEqual({ name: 'app.svg', size: svg.length, sha256: createHash('sha256').update(svg).digest('hex'), origin: 'https://api.slack.com', result: failure ? 'failed' : 'completed' });
});

test('auto mode falls back to the page\'s file input when no chooser is open; modes run their script', async () => {
  const calls: string[][] = [];
  const scripts: string[] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'tab-list') return tabs;
    if (args[0] === 'upload') return { status: 0, stdout: '### Error\nError: No file chooser visible', stderr: '' };
    scripts.push(await readFile(args[2], 'utf8'));
    return { status: 0, stdout: `### Ran Playwright code\n\`\`\`js\nawait (${scripts.at(-1)})(page);\n\`\`\`\n### Result\n"done"`, stderr: '' };
  };
  const auto = await receiveUpload({ policy: {}, payload, args: ['upload'], audit: () => {}, run });
  expect(auto.status).toBe(0);
  expect(calls.map(c => c[0])).toEqual(['tab-list', 'upload', 'run-code']);
  expect(scripts[0]).toContain("input[type=file]");
  // The echoed script (it can embed the file as base64) and the private dir never reach the client.
  expect(auto.stdout).not.toContain('Ran Playwright code');
  expect(auto.stdout).not.toContain('rech-upload-');
  const dropped = await receiveUpload({ policy: {}, payload: { ...payload, mode: 'drop', target: 'e7' }, args: ['upload'], audit: () => {}, run });
  expect(dropped.status).toBe(0);
  expect(scripts[1]).toContain('aria-ref=e7');
  expect(dropped.stdout).not.toContain(payload.data);
  // into/drop need a target; chooser/auto take none.
  for (const bad of [{ ...payload, mode: 'into' }, { ...payload, mode: 'drop' }, { ...payload, mode: 'chooser', target: 'e1' }, { ...payload, mode: 'eval' }])
    expect((await receiveUpload({ policy: {}, payload: bad, args: ['upload'], audit: () => {}, run: async () => { throw Error('must not run'); } })).status).toBe(1);
});

test('untrusted payloads cannot become host paths, types, or unbounded allocations', async () => {
  for (const p of [
    { ...payload, name: '../secret.svg' }, { ...payload, name: 'C:\\secret.svg' },
    { ...payload, name: 'x\nforged-log.svg' }, { ...payload, path: '/etc/passwd' },
    { ...payload, data: '@@@' }, { ...payload, data: 'YQ===' }, { ...payload, data: '' },
    { ...payload, contentType: 'image/png' }, { ...payload, contentType: 'text/html' },
    { ...payload, data: Buffer.from('<!DOCTYPE svg SYSTEM "file:///etc/passwd"><svg/>').toString('base64') },
    { ...payload, data: 'a'.repeat(4 * Math.ceil(MAX_UPLOAD_BYTES / 3) + 4) },
  ]) {
    let ran = false;
    const audit: UploadAudit[] = [];
    const result = await receiveUpload({ policy: {}, payload: p, args: ['upload'], audit: a => audit.push(a), run: async () => { ran = true; return tabs; } });
    expect(result.status).toBe(1);
    expect(ran).toBe(false);
    expect(audit).toHaveLength(1);
  }
  for (const policy of [undefined, { maxBytes: svg.length - 1 }, { contentTypes: ['image/png'] }]) {
    const result = await receiveUpload({ policy, payload, args: ['upload'], audit: () => {}, run: async () => { throw Error('must not run'); } });
    expect(result.status).toBe(1);
  }
});

test('document uploads: allowed only when the listener opts in, and the bytes must match the type', async () => {
  const xlsx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]); // ZIP container
  const csv = Buffer.from('a,b,c\n1,2,3\n');
  const xlsxType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const xlsxPayload = { name: 'data.xlsx', contentType: xlsxType, data: xlsx.toString('base64') };
  const csvPayload = { name: 'data.csv', contentType: 'text/csv', data: csv.toString('base64') };
  const run = async (args: string[]) => args[0] === 'tab-list' ? tabs : { status: 0, stdout: `uploaded ${args[1]}`, stderr: '' };
  // Default policy ({}) is images only → a document is refused before any command runs.
  for (const p of [xlsxPayload, csvPayload]) {
    let ran = false;
    expect((await receiveUpload({ policy: {}, payload: p, args: ['upload'], audit: () => {}, run: async () => { ran = true; return tabs; } })).status).toBe(1);
    expect(ran).toBe(false);
  }
  // Opted in → accepted, staged under the original name, the larger cap honoured.
  const big = { maxBytes: 50 * 1024 * 1024, contentTypes: [...UPLOAD_TYPES, xlsxType, 'text/csv'] };
  expect((await receiveUpload({ policy: big, payload: xlsxPayload, args: ['upload'], audit: () => {}, run })).status).toBe(0);
  expect((await receiveUpload({ policy: big, payload: csvPayload, args: ['upload'], audit: () => {}, run })).status).toBe(0);
  // Type is opted in but the bytes lie (xlsx claimed over non-ZIP bytes) → refused.
  expect((await receiveUpload({ policy: big, payload: { ...xlsxPayload, data: csv.toString('base64') }, args: ['upload'], audit: () => {}, run: async () => { throw Error('must not run'); } })).status).toBe(1);
  // A NUL byte disqualifies a text/csv upload.
  expect((await receiveUpload({ policy: big, payload: { ...csvPayload, data: Buffer.from('a,b\0c').toString('base64') }, args: ['upload'], audit: () => {}, run: async () => { throw Error('must not run'); } })).status).toBe(1);
});

test('origin requires exactly one selected HTTP(S) tab; credentials/query never enter audit', () => {
  expect(currentPageOrigin('- 0: (current) [x](https://user:secret@example.com:444/path?q=secret#hash)')).toBe('https://example.com:444');
  for (const text of ['No tabs', '- 0: (current) [x](file:///secret)', tabs.stdout + '\n' + tabs.stdout]) expect(() => currentPageOrigin(text)).toThrow();
});

test('JSON request size is bounded while streaming, even without Content-Length', async () => {
  const req = new Request('http://localhost/run', { method: 'POST', body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_REQUEST_BYTES + 1)); c.close(); } }), duplex: 'half' } as any);
  await expect(readRequestJson(req)).rejects.toThrow(`${MAX_REQUEST_BYTES / 1024 / 1024} MiB`);
  expect(await readRequestJson(new Request('http://localhost/run', { method: 'POST', body: '{"args":[]}' }))).toEqual({ args: [] });
});

test('PNG signature check and exact listener size boundary', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1sAAAAASUVORK5CYII=', 'base64');
  const prepared = await prepareStdinUpload(['upload', '--name=icon.png', '--content-type=image/png'], input(png));
  for (const limit of [png.length, png.length - 1]) {
    const result = await receiveUpload({ policy: { maxBytes: limit }, payload: prepared.upload, args: ['upload'], audit: () => {}, run: async args => args[0] === 'tab-list' ? tabs : { status: 0, stdout: 'uploaded', stderr: '' } });
    expect(result.status).toBe(limit === png.length ? 0 : 1);
  }
});

test('host-path uploads: off unless the listener lists the directory; never outside it', async () => {
  const { mkdtemp, writeFile, symlink, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'rech-host-'));
  const allowed = join(root, 'allowed'); await mkdir(allowed);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1sAAAAASUVORK5CYII=', 'base64');
  await writeFile(join(allowed, 'a.png'), png);
  await writeFile(join(root, 'secret.png'), png);
  await symlink(join(root, 'secret.png'), join(allowed, 'link.png'));
  expect(await readHostFile(join(allowed, 'a.png'), [allowed], MAX_UPLOAD_BYTES)).toEqual(png);
  await expect(readHostFile(join(allowed, 'a.png'), undefined, MAX_UPLOAD_BYTES)).rejects.toThrow(/off on this listener/);
  await expect(readHostFile(join(root, 'secret.png'), [allowed], MAX_UPLOAD_BYTES)).rejects.toThrow(/not an existing file in the listener's allowed directories/);
  await expect(readHostFile(join(allowed, '..', 'secret.png'), [allowed], MAX_UPLOAD_BYTES)).rejects.toThrow(/not an existing file in the listener's allowed directories/);
  await expect(readHostFile(join(allowed, 'link.png'), [allowed], MAX_UPLOAD_BYTES)).rejects.toThrow(/not an existing file in the listener's allowed directories/);
  await expect(readHostFile(join(allowed, 'a.png'), [allowed], 10)).rejects.toThrow(/maxBytes/);
  // A missing path gets the same answer as one outside, so the link can't probe what exists.
  const missing = await readHostFile(join(root, 'nope.png'), [allowed], MAX_UPLOAD_BYTES).catch(e => e.message);
  const outside = await readHostFile(join(root, 'secret.png'), [allowed], MAX_UPLOAD_BYTES).catch(e => e.message);
  expect(missing).toBe(outside);
  expect(() => validateUploadPolicy({ hostDirs: ['/'] })).toThrow();
  expect(() => validateUploadPolicy({ hostDirs: ['relative'] })).toThrow();
});

test('--host with --drop/--paste puts the bytes read on the host into the page script', async () => {
  const { mkdtemp, writeFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const allowed = await mkdtemp(join(tmpdir(), 'rech-host-drop-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1sAAAAASUVORK5CYII=', 'base64');
  await writeFile(join(allowed, 'a.png'), png);
  const tabs = { status: 0, stdout: '- 0: (current) [Page](https://example.com/)', stderr: '' };
  for (const mode of ['drop', 'paste'] as const) {
    let script = '';
    const result = await receiveUpload({
      policy: { hostDirs: [allowed] }, payload: { name: 'a.png', contentType: 'image/png', hostPath: join(allowed, 'a.png'), mode, target: '#zone' }, args: ['upload'], audit: () => {},
      run: async args => { if (args[0] === 'tab-list') return tabs; script = await readFile(args[2], 'utf8'); return { status: 0, stdout: 'ok', stderr: '' }; },
    });
    expect(result.status).toBe(0);
    expect(script).toContain(JSON.stringify(png.toString('base64')));
    expect(script).not.toContain('data: undefined');
  }
});

test('the client sends only the host path for --host, never bytes', async () => {
  const { upload } = await prepareUpload(['upload', '--host', '/srv/shots/a.png'], null, () => Promise.reject(new Error('must not read locally')));
  expect(upload).toEqual({ name: 'a.png', contentType: 'image/png', hostPath: '/srv/shots/a.png' });
  await expect(prepareUpload(['upload', 'local.png', '--host', '/srv/a.png'], null)).rejects.toThrow();
});

test('chunkUploadPayloads: small stays single, large splits with one shared id, host untouched', () => {
  const small: UploadPayload = { name: 'a.txt', contentType: 'text/plain', data: Buffer.from('hi').toString('base64') };
  expect(chunkUploadPayloads(small)).toEqual([small]);          // below the single-request threshold
  const host: UploadPayload = { name: 'h.txt', contentType: 'text/plain', hostPath: '/srv/h.txt' };
  expect(chunkUploadPayloads(host)).toEqual([host]);            // --host sends no bytes to chunk
  const data = Buffer.from('0123456789abcdefghij');             // 20 bytes
  const parts = chunkUploadPayloads({ name: 'b.txt', contentType: 'text/plain', data: data.toString('base64') }, 8);
  expect(parts.length).toBe(3);                                 // 8 + 8 + 4
  expect(parts.every((p, i) => p.chunk?.id === parts[0].chunk!.id && p.chunk?.seq === i && p.chunk?.total === 3)).toBe(true);
  expect(Buffer.concat(parts.map(p => Buffer.from(p.data!, 'base64')))).toEqual(data);  // reassembles exactly
});

test('chunked upload stages ordered chunks and delivers once on the final chunk', async () => {
  const csv = Buffer.from('col1,col2\n' + Array.from({ length: 6 }, (_, i) => `${i},${i * 2}`).join('\n') + '\n');
  const parts = chunkUploadPayloads({ name: 'big.csv', contentType: 'text/csv', data: csv.toString('base64') }, 8);
  expect(parts.length).toBeGreaterThan(1);
  const policy = { contentTypes: [...UPLOAD_TYPES, 'text/csv'] };
  const calls: string[][] = [];
  const audits: UploadAudit[] = [];
  const run = async (args: string[]) => { calls.push(args); return args[0] === 'tab-list' ? tabs : { status: 0, stdout: `uploaded ${args[1]}`, stderr: '' }; };
  let final: any;
  for (let i = 0; i < parts.length; i++) {
    final = await receiveUpload({ policy, payload: parts[i], args: ['upload'], stagingKey: 'sess1', audit: a => audits.push(a), run });
    if (i < parts.length - 1) { expect(final.status).toBe(0); expect(final.stdout).toContain('staged chunk'); }
  }
  expect(final.status).toBe(0);
  expect(calls.some(c => c[0] === 'tab-list')).toBe(true);      // delivery ran only at the end
  expect(audits).toHaveLength(1);                               // one audit for the whole upload
  expect(audits[0].size).toBe(csv.length);
  expect(audits[0].result).toBe('completed');
});

test('chunked upload rejects out-of-order, unknown, mutated, or bad-id chunks', async () => {
  const data = Buffer.from('hello world, a small payload for chunk tests!!');
  const parts = chunkUploadPayloads({ name: 'x.txt', contentType: 'text/plain', data: data.toString('base64') }, 8);
  const policy = { contentTypes: [...UPLOAD_TYPES, 'text/plain'] };
  const run = async () => { throw new Error('must not run'); };          // no delivery on any of these
  const recv = (payload: any, key = 'k') => receiveUpload({ policy, payload, args: ['upload'], stagingKey: key, audit: () => {}, run });
  expect((await recv(parts[1])).status).toBe(1);                         // seq>0 with no seq 0 → unknown
  expect((await recv(parts[0])).status).toBe(0);                         // start
  expect((await recv(parts[2])).status).toBe(1);                         // skipped seq 1 → out of order (drops staging)
  expect((await recv(parts[1])).status).toBe(1);                         // staging gone → unknown
  expect((await recv(parts[0], 'k2')).status).toBe(0);                   // fresh session
  expect((await recv({ ...parts[1], name: 'other.txt' }, 'k2')).status).toBe(1);  // metadata changed mid-stream
  expect((await recv({ ...parts[0], chunk: { id: 'has space!', seq: 0, total: parts.length } }, 'k3')).status).toBe(1);  // bad id
});

test('no size cap for into/auto; drop/paste are bounded with a clear message', async () => {
  // A file over the drop/paste practical limit (so also over any old fixed cap).
  const big = Buffer.alloc(DROP_PASTE_MAX_BYTES + 1, 0x61); // 'a' bytes: valid text, no NUL
  const data = big.toString('base64');
  const policy = { contentTypes: [...UPLOAD_TYPES, 'text/plain'] }; // no maxBytes → no size cap
  const run = async (args: string[]) => args[0] === 'tab-list' ? tabs : { status: 0, stdout: `uploaded ${args[1]}`, stderr: '' };
  // into: Chrome gets the host path (setInputFiles), so a huge file is accepted.
  const into = await receiveUpload({ policy, payload: { name: 'big.txt', contentType: 'text/plain', data, mode: 'into', target: 'e1' }, args: ['upload'], audit: () => {}, run });
  expect(into.status).toBe(0);
  // drop: must embed base64 through the page, so it is refused with a clear, actionable message.
  const dropped = await receiveUpload({ policy, payload: { name: 'big.txt', contentType: 'text/plain', data, mode: 'drop', target: '.zone' }, args: ['upload'], audit: () => {}, run });
  expect(dropped.status).toBe(1);
  expect(dropped.stderr).toMatch(/too large for --drop/);
  expect(dropped.stderr).toMatch(/--into/);
});
