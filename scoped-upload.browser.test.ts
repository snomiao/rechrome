import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { receiveUpload, type UploadAudit } from './scoped-upload.ts';
import { playwrightCliEnv } from './serve.ts';

// Opt-in real chooser test. Use a built Playwright core CLI, not a rech listener.
// RECH_UPLOAD_TEST_CLI=/path/to/playwright-core/lib/tools/cli-client/cli.js bun test ./scoped-upload.browser.test.ts
// Creates its own headless Chromium profile; never attaches to the user's Chrome.
test.skipIf(!process.env.RECH_UPLOAD_TEST_CLI)('stdin bytes reach a real isolated file chooser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rech-upload-browser-'));
  const session = 'up-' + randomBytes(4).toString('hex');
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(`<title>Upload fixture</title><button onclick="document.querySelector('input').click()">Choose icon</button><input type="file" hidden onchange="document.querySelector('output').textContent='Uploaded '+this.files[0].size+' bytes'"><output></output>`, { headers: { 'Content-Type': 'text/html' } }) });
  const run = async (args: string[]) => {
    const child = Bun.spawn(['node', process.env.RECH_UPLOAD_TEST_CLI!, ...args, `-s=${session}`], {
      cwd: root, env: playwrightCliEnv({ PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }), stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const timer = setTimeout(() => child.kill(), 30000);
    try {
      const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { status, stdout, stderr };
    } finally { clearTimeout(timer); }
  };
  try {
    const opened = await run(['open', `http://127.0.0.1:${server.port}`, '--browser=chromium', `--profile=${join(root, 'browser')}`]);
    if (opened.status !== 0) throw Error(opened.stderr + opened.stdout);
    const snapshot = await run(['snapshot']);
    const ref = snapshot.stdout.match(/button "Choose icon" \[ref=(e\d+)\]/)?.[1];
    expect(ref).toBeDefined();
    expect((await run(['click', ref!])).status).toBe(0);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
    const audits: UploadAudit[] = [];
    const uploaded = await receiveUpload({ policy: {}, payload: { name: 'icon.svg', contentType: 'image/svg+xml', data: Buffer.from(svg).toString('base64') }, args: ['upload'], run, audit: a => audits.push(a) });
    if (uploaded.status !== 0) throw Error(uploaded.stderr + uploaded.stdout);
    expect(audits[0].origin).toBe(`http://127.0.0.1:${server.port}`);
    expect(audits[0].result).toBe('completed');
    expect((await run(['snapshot'])).stdout).toContain(`Uploaded ${Buffer.byteLength(svg)} bytes`);
  } finally {
    await run(['close']);
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
