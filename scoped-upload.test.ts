import { expect, test } from 'bun:test';
import { stat, readFile } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareUpload, prepareStdinUpload, uploadScript, receiveUpload, validateUploadPolicy, currentPageOrigin, readRequestJson, MAX_UPLOAD_BYTES, MAX_REQUEST_BYTES, type UploadAudit } from './scoped-upload.ts';
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
  await expect(prepareStdinUpload(['upload', '--name', 'app.svg'], input(Buffer.alloc(MAX_UPLOAD_BYTES + 1)))).rejects.toThrow('10 MiB');
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

test('uploads default off; enabling uploads does not enable eval or host paths', () => {
  expect(() => authorizeProfileRequest(listener, body(['upload']))).toThrow();
  const enabled = { ...listener, uploads: {} };
  expect(authorizeProfileRequest(enabled, body(['upload', '-s=qa']))).toBe('qa');
  for (const args of [['eval', '() => 1'], ['upload', '/etc/passwd'], ['upload', '../secret'], ['upload', '--filename=/etc/passwd'], ['upload', '--config=evil']])
    expect(() => authorizeProfileRequest(enabled, body(args))).toThrow();
  expect(() => authorizeProfileRequest(enabled, body(['upload'], null))).toThrow();
  for (const p of [true, null, { directory: '/tmp' }, { maxBytes: 0 }, { maxBytes: MAX_UPLOAD_BYTES + 1 }, { contentTypes: ['text/html'] }])
    expect(() => validateUploadPolicy(p)).toThrow();
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
