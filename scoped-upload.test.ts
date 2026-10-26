import { expect, test } from 'bun:test';
import { stat, readFile } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareStdinUpload, receiveUpload, validateUploadPolicy, currentPageOrigin, readRequestJson, MAX_UPLOAD_BYTES, MAX_REQUEST_BYTES, type UploadAudit } from './scoped-upload.ts';
import { authorizeProfileRequest, type Listener } from './listeners.ts';
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
const payload = { name: 'app.svg', contentType: 'image/svg+xml', data: svg.toString('base64') };
const tabs = { status: 0, stdout: '- 0: (current) [Slack](https://api.slack.com/apps/ABC?secret=x#icon)', stderr: '' };
const listener: Listener = { name: 'qa', host: '127.0.0.1', port: 13779, profiles: ['qa'], key: 'x'.repeat(24) };
const body = (args: string[], upload: any = payload) => ({ args, upload, identity: { key: 'test', profile: 'qa' } });
async function* input(bytes = svg) { yield bytes; }

test('stdin-only client accepts metadata, never a caller path', async () => {
  expect(await prepareStdinUpload(['upload', '--name', 'app.svg', '-s=qa'], input())).toEqual({ args: ['upload', '-s=qa'], upload: payload });
  for (const args of [['upload', '/etc/passwd'], ['upload', '--name', '../app.svg'], ['upload', '--name', 'app.svg', '--name', 'again.svg'], ['upload', '--name', 'app.svg', '--filename=/etc/passwd']])
    await expect(prepareStdinUpload(args, input())).rejects.toThrow();
  await expect(prepareStdinUpload(['upload', '--name', 'app.png'], input())).rejects.toThrow('content type');
  await expect(prepareStdinUpload(['upload', '--name', 'app.svg'], input(Buffer.alloc(MAX_UPLOAD_BYTES + 1)))).rejects.toThrow('2 MiB');
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
    expect(basename(staged)).toMatch(/^[a-f0-9]{32}\.svg$/);
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
  await expect(readRequestJson(req)).rejects.toThrow('3 MiB');
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
