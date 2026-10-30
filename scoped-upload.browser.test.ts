import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { receiveUpload, type UploadAudit, type UploadPayload } from './scoped-upload.ts';
import { playwrightCliEnv } from './serve.ts';

// Opt-in real browser test. Use a built Playwright core CLI, not a rech listener.
// RECH_UPLOAD_TEST_CLI=/path/to/playwright-core/lib/tools/cli-client/cli.js bun test ./scoped-upload.browser.test.ts
// (the vendored vendor/playwright-cli/playwright-cli.js works too; PLAYWRIGHT_MCP_EXECUTABLE_PATH picks a browser binary).
// Creates its own headless Chromium profile; never attaches to the user's Chrome.
const report = (how: string) => `document.querySelector('output').textContent='${how} '+f.name+' '+f.size+' bytes'`;
const PAGES: Record<string, string> = {
  // A button that opens a hidden input's file chooser (the common "pick an image" UI).
  '/chooser': `<button onclick="document.querySelector('input').click()">Choose icon</button><input type="file" hidden onchange="const f=this.files[0];${report('Uploaded')}">`,
  // A hidden file input nothing on the page opens.
  '/input': `<input id="avatar" type="file" style="display:none" onchange="const f=this.files[0];${report('Uploaded')}">`,
  '/drop': `<div id="zone" style="width:200px;height:100px" ondragover="event.preventDefault()" ondrop="event.preventDefault();const f=event.dataTransfer.files[0];${report('Dropped')}">Drop here</div>`,
  '/paste': `<div id="editor" contenteditable="true" onpaste="event.preventDefault();const f=event.clipboardData.files[0];${report('Pasted')}">Write here</div>`,
};

test.skipIf(!process.env.RECH_UPLOAD_TEST_CLI)('file bytes reach a real isolated page: chooser, input, button, drop, paste', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rech-upload-browser-'));
  const session = 'up-' + randomBytes(4).toString('hex');
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: req => new Response(`<title>Upload fixture</title>${PAGES[new URL(req.url).pathname] ?? ''}<output></output>`, { headers: { 'Content-Type': 'text/html' } }) });
  const origin = `http://127.0.0.1:${server.port}`;
  const run = async (args: string[]) => {
    const child = Bun.spawn(['node', process.env.RECH_UPLOAD_TEST_CLI!, ...args, `-s=${session}`], {
      cwd: root, env: playwrightCliEnv({ PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH, ...(process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH ? { PLAYWRIGHT_MCP_EXECUTABLE_PATH: process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH } : {}) }), stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const timer = setTimeout(() => child.kill(), 30000);
    try {
      const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { status, stdout, stderr };
    } finally { clearTimeout(timer); }
  };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
  const icon = { name: 'icon.svg', contentType: 'image/svg+xml', data: Buffer.from(svg).toString('base64') };
  const upload = async (extra: Partial<UploadPayload> = {}) => {
    const audits: UploadAudit[] = [];
    const result = await receiveUpload({ policy: {}, payload: { ...icon, ...extra }, args: ['upload'], run, audit: a => audits.push(a) });
    if (result.status !== 0) throw Error(result.stderr + result.stdout);
    expect(audits[0].origin).toBe(origin);
    expect(audits[0].result).toBe('completed');
    expect(result.stdout).not.toContain(icon.data);       // the echoed script never comes back
    return result;
  };
  const shows = async (text: string) => expect((await run(['snapshot'])).stdout).toContain(text);
  const ref = async (pattern: RegExp) => (await run(['snapshot'])).stdout.match(pattern)?.[1];
  try {
    const opened = await run(['open', `${origin}/chooser`, '--browser=chromium', `--profile=${join(root, 'browser')}`]);
    if (opened.status !== 0) throw Error(opened.stderr + opened.stdout);
    const button = await ref(/button "Choose icon" \[ref=(e\d+)\]/);
    expect(button).toBeDefined();

    // 1. The chooser a previous click opened (the original flow), under the file's own name.
    expect((await run(['click', button!])).status).toBe(0);
    await upload();
    await shows(`Uploaded icon.svg ${Buffer.byteLength(svg)} bytes`);

    // 2. --into the button: one command clicks it and fills the chooser it opens.
    await run(['goto', `${origin}/chooser`]);
    await upload({ mode: 'into', target: (await ref(/button "Choose icon" \[ref=(e\d+)\]/))! });
    await shows('Uploaded icon.svg');

    // 3. --into a hidden input by selector, and auto mode finding the page's only input.
    await run(['goto', `${origin}/input`]);
    await upload({ mode: 'into', target: '#avatar' });
    await shows('Uploaded icon.svg');
    await run(['goto', `${origin}/input`]);
    await upload();
    await shows('Uploaded icon.svg');

    // 4. Drag-and-drop and paste deliver a real File.
    await run(['goto', `${origin}/drop`]);
    await upload({ mode: 'drop', target: '#zone' });
    await shows('Dropped icon.svg');
    await run(['goto', `${origin}/paste`]);
    const pasted = await upload({ mode: 'paste', target: '#editor' });
    expect(pasted.stdout).toContain('the page handled it');
    await shows('Pasted icon.svg');
  } finally {
    await run(['close']);
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 180000);
