import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CDPClient, provisionExtensionToken, seedExtensionToken } from './rechrome.ts';

const roots: string[] = [];
const originalCache = process.env.PLAYWRIGHT_BROWSERS_PATH;
afterEach(() => {
  if (originalCache === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  else process.env.PLAYWRIGHT_BROWSERS_PATH = originalCache;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeChrome(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'rech-provision-test-'));
  roots.push(root);
  const exe = process.platform === 'darwin'
    ? join(root, 'chromium-99999/chrome-mac-arm64/Test.app/Contents/MacOS/Test')
    : join(root, 'chromium-99999/chrome-linux/chrome');
  mkdirSync(join(exe, '..'), { recursive: true });
  writeFileSync(exe, `#!${process.execPath}\n${source}`, { mode: 0o755 });
  process.env.PLAYWRIGHT_BROWSERS_PATH = root;
  return { userDataDir: join(root, 'profile'), profileDir: 'qa', dist: root, token: 'secret-test-token' };
}

test('CDP disconnection rejects a pending command immediately', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1',
    fetch(req, server) { if (server.upgrade(req)) return; return new Response('', { status: 400 }); },
    websocket: { message(ws) { ws.close(); } },
  });
  const client = new CDPClient(`ws://127.0.0.1:${server.port}`, 1_000);
  try {
    await client.open();
    await expect(client.send('Target.createTarget')).rejects.toThrow('CDP WebSocket closed or failed');
  } finally { client.close(); server.stop(true); }
});

test('CDP WebSocket handshake has a deadline', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() { return new Promise<Response>(() => {}); } });
  const client = new CDPClient(`ws://127.0.0.1:${server.port}`, 100);
  try { await expect(client.open()).rejects.toThrow('CDP WebSocket connection timed out'); }
  finally { client.close(); server.stop(true); }
});

test('CDP command timeout reports the method and can be closed', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1',
    fetch(req, server) { if (server.upgrade(req)) return; return new Response('', { status: 400 }); },
    websocket: { message() {} },
  });
  const client = new CDPClient(`ws://127.0.0.1:${server.port}`, 100);
  try {
    await client.open();
    await expect(client.send('Runtime.evaluate')).rejects.toThrow('CDP Runtime.evaluate timed out');
  } finally { client.close(); server.stop(true); }
});

test.skipIf(process.platform === 'win32')('Chrome startup failure preserves stderr and exit status, redacting the token', async () => {
  const opts = fakeChrome(`console.error('startup fixture failure secret-test-token'); process.exit(23);`);
  await expect(provisionExtensionToken(opts)).rejects.toThrow('Chrome exited before opening the DevTools port (23)\nChrome stderr:\nstartup fixture failure [redacted]');
});

test.skipIf(process.platform === 'win32')('failure kills a SIGTERM-resistant browser and its helper without hiding the error', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() { return Response.json({ webSocketDebuggerUrl: 'invalid' }); } });
  const opts = fakeChrome(`
    import { writeFileSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    const root = process.argv.find(a => a.startsWith('--user-data-dir=')).split('=')[1];
    process.on('SIGTERM', () => {});
    const helper = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: 'ignore' });
    writeFileSync(root + '/pids', JSON.stringify([process.pid, helper.pid]));
    writeFileSync(root + '/DevToolsActivePort', '${server.port}');
    setInterval(() => {}, 1000);
  `);
  try {
    await expect(provisionExtensionToken(opts)).rejects.toThrow();
    const pids = JSON.parse(readFileSync(join(opts.userDataDir, 'pids'), 'utf8'));
    for (let i = 0; i < 40; i++) {
      if (pids.every((pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } })) break;
      await Bun.sleep(50);
    }
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  } finally { server.stop(true); }
}, 10_000);


test('token seeding re-navigates an extension target stuck on its initial error document', async () => {
  let navigated = false;
  const methods: string[] = [];
  await seedExtensionToken({ async send(method, params, sessionId) {
    methods.push(method);
    if (method === 'Target.createTarget') return { targetId: 'target' };
    if (method === 'Target.attachToTarget') return { sessionId: 'session' };
    expect(sessionId).toBe('session');
    if (method === 'Page.navigate') { navigated = true; expect(params?.url).toContain('/status.html'); return {}; }
    if (method === 'Runtime.evaluate') return { result: { value: navigated ? 'fixture-token' : 'ERR:Access is denied for this document' } };
    throw Error('Unexpected method: ' + method);
  } }, 'fixture-token');
  expect(methods).toContain('Page.navigate');
});
