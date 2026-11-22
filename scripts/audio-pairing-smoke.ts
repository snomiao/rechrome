/** Muted synthetic approval/PCM check through real sessionSocket RPC; no extension/user profile. */
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { runCodeOnSession } from '../fill-secret.ts';
import { createAudioHandler } from '../audio-bridge-server.ts';
import { createAudioPairing, buildOpenApprovalPanel } from '../audio-pairing.ts';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function main() {
    const module = process.env.RECH_AUDIO_PLAYWRIGHT, executablePath = process.env.RECH_AUDIO_CHROME;
    if (!module || !executablePath)
        throw Error('explicit-browser-paths');
    const { chromium } = await import(module), browser = await chromium.launch({ executablePath, headless: true, args: ['--mute-audio', '--use-fake-device-for-media-stream', '--disable-background-networking', '--autoplay-policy=no-user-gesture-required'] });
    const root = await mkdtemp(join(tmpdir(), 'rech-pair-smoke-'));
    const sockets: ReturnType<typeof createServer>[] = [];
    let service: ReturnType<typeof createAudioPairing> | undefined, server: ReturnType<typeof Bun.serve> | undefined;
    let stage = 'setup';
    try {
        const context = await browser.newContext();
        await context.grantPermissions(['local-network-access'], { origin: 'https://li.example' });
        await context.route('https://li.example/**', (route: any) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Li synthetic Connect</title>' }));
        await context.addInitScript(() => {
            (window as any).__physical = { mic: 0, output: 0 };
            Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, writable: true, value: async () => { (window as any).__physical.mic++; throw Error('no physical device'); } });
            const connect = AudioNode.prototype.connect;
            AudioNode.prototype.connect = function (this: AudioNode, ...args: any[]) {
                if (args[0] === this.context.destination)
                    (window as any).__physical.output++;
                return Reflect.apply(connect, this, args);
            } as any;
        });
        const chat = await context.newPage(), operator = await context.newPage();
        const pages: {
            [id: string]: any;
        } = { chat, operator };
        for (const session of ['chat', 'operator']) {
            const socket = createServer(connection => {
                let buffer = '';
                connection.setEncoding('utf8');
                connection.on('data', chunk => {
                    buffer += chunk;
                    const at = buffer.indexOf('\n');
                    if (at < 0)
                        return;
                    connection.removeAllListeners('data');
                    void (async () => {
                        try {
                            const request = JSON.parse(buffer.slice(0, at));
                            const fn = runInNewContext('(' + request.params.args._[1] + ')', {});
                            const text = await fn(pages[session]);
                            connection.end(JSON.stringify({ result: { isError: false, text } }) + '\n');
                        }
                        catch {
                            connection.end(JSON.stringify({ result: { isError: true, text: '' } }) + '\n');
                        }
                    })();
                });
            });
            await new Promise<void>(r => socket.listen(join(root, session + '.sock'), r));
            sockets.push(socket);
        }
        const handler = createAudioHandler();
        let clock = Date.now();
        service = createAudioPairing({ targets: handler.pairTargets, grant: handler.pairGrant, now: () => clock });
        server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
                if (new URL(req.url).pathname === '/fixture')
                    return new Response('<!doctype html><title>QA voice chat</title>', { headers: { 'content-type': 'text/html' } });
                return service!.handle(req, base);
            } });
        const base: string = `http://127.0.0.1:${server.port}`;
        const request = (args: string[]) => ({ args, socketRoot: root, session: 'chat', cwd: root });
        stage = 'install';
        if ((await handler(request(['audio', 'install', base + '/fixture']))).status)
            throw Error();
        const before = (await handler.pairTargets())[0];
        stage = 'bootstrap';
        const wake = async () => { const opened = await runCodeOnSession({ socketRoot: root, session: 'operator', cwd: root, code: buildOpenApprovalPanel(base, service!.bootstrap()), json: true }); if (opened.isError)
            throw Error('operator wake'); };
        await wake();
        await wake();
        let panels = context.pages().filter((p: any) => p.url().startsWith(base + '/audio/pair/approve'));
        if (panels.length !== 1)
            throw Error('panel-not-reused');
        clock += 601000;
        const expired = await panels[0].evaluate(async () => (await fetch('/audio/pair/targets', { credentials: 'same-origin' })).status);
        if (expired !== 403)
            throw Error('cookie-not-expired');
        await panels[0].close();
        service.setOperatorWake(wake);
        const after = (await handler.pairTargets())[0];
        if (before?.id !== after?.id || after?.title !== 'QA voice chat' || chat.url() !== base + '/fixture')
            throw Error('selected-target-changed');
        stage = 'request';
        const li = await context.newPage();
        await li.goto('https://li.example/');
        const recoveredPanel = context.waitForEvent('page');
        const pair = await li.evaluate(async (base: string) => { const discovery = await (await fetch(base + '/audio/pair/discovery', { credentials: 'omit' })).json(); const pcm = { sampleRate: 16000, channels: 1, format: 's16le' }; return (await fetch(discovery.requestUrl, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: 'li-source', input: pcm, output: pcm, frameMs: 20 }) })).json(); }, base);
        stage = 'approval-popup';
        const panel = await recoveredPanel;
        await panel.waitForURL(base + '/audio/pair/approve');
        await panel.waitForLoadState();
        await panel.getByRole('button', { name: 'Connect selected chat' }).waitFor();
        const shown = await panel.locator('select').innerText();
        if (!shown.includes('QA voice chat'))
            throw Error();
        if ((await handler.pairTargets()).length !== 1)
            throw Error('wake-started-audio');
        const pending = await li.evaluate(async (p: any) => (await fetch(p.statusUrl, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: p.requestId, requestNonce: p.requestNonce }) })).json(), pair);
        if (pending.state !== 'pending' || pending.ticket)
            throw Error('wake-authorized-audio');
        if (context.pages().filter((p: any) => p.url().startsWith(base + '/audio/pair/approve')).length !== 1)
            throw Error('duplicate-panel');
        clock = Date.now(); // Resume the gateway's real clock after testing operator idle expiry.
        await panel.getByRole('button', { name: 'Connect selected chat' }).click();
        stage = 'connect';
        await li.evaluate(async (p: any) => {
            const result = await (await fetch(p.statusUrl, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: p.requestId, requestNonce: p.requestNonce }) })).json();
            if (result.state !== 'approved')
                throw Error();
            (window as any).__pair = { ready: false, frames: 0, closed: false, title: result.approvedChat.title };
            const t = result.ticket, ws = new WebSocket(t.url);
            ws.binaryType = 'arraybuffer';
            (window as any).__socket = ws;
            let frame: any;
            ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', version: 1, capability: t.capability, sourceId: t.sourceId, destinationId: t.destinationId, input: t.input, output: t.output, frameMs: 20 }));
            ws.onmessage = e => {
                if (typeof e.data === 'string') {
                    const m = JSON.parse(e.data);
                    if (m.type === 'ready') {
                        (window as any).__pair.ready = true;
                        const bytes = new ArrayBuffer(640), v = new DataView(bytes);
                        for (let n = 0; n < 320; n++)
                            v.setInt16(n * 2, Math.round(Math.sin(n * 2 * Math.PI * 660 / 16000) * 5000), true);
                        ws.send(bytes);
                    }
                    if (m.type === 'frame')
                        frame = m;
                }
                else {
                    if (!frame || e.data.byteLength !== frame.byteLength)
                        throw Error();
                    (window as any).__pair.frames++;
                    ws.send(JSON.stringify({ type: 'output-ack', sequence: frame.sequence }));
                    frame = undefined;
                }
            };
            ws.onclose = () => { (window as any).__pair.closed = true; };
        }, pair);
        await li.waitForFunction(() => (window as any).__pair.ready);
        stage = 'pcm';
        await chat.evaluate(async () => { const context = new AudioContext(), osc = context.createOscillator(); osc.frequency.value = 440; osc.connect(context.destination); await context.resume(); osc.start(); (window as any).__osc = osc; });
        await li.waitForFunction(() => (window as any).__pair.frames >= 3);
        stage = 'cancel';
        await li.evaluate(async (p: any) => { await fetch(p.cancelUrl, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: p.requestId, requestNonce: p.requestNonce }) }); }, pair);
        await li.waitForFunction(() => (window as any).__pair.closed);
        const counts = await chat.evaluate(() => (window as any).__physical);
        if (counts.mic || counts.output)
            throw Error('physical-device');
        const metrics = await li.evaluate(() => (window as any).__pair);
        console.log(JSON.stringify({ passed: true, realSessionSocketRpc: true, selectedTargetStable: true, normalLocalNetworkGrant: true, operatorCookieApproval: true, expiredCookieClosedPanelRecovery: true, singlePanelReuse: true, noGrantBeforeClick: true, namedChat: metrics.title, receivedPcmFrames: metrics.frames, cancelClosedStream: metrics.closed, physicalMic: counts.mic, physicalOutput: counts.output, muted: true }));
    }
    catch {
        console.error('Synthetic pairing browser check failed at ' + stage);
        process.exitCode = 1;
    }
    finally {
        service?.close();
        server?.stop(true);
        await browser.close();
        for (const s of sockets)
            s.close();
        await rm(root, { recursive: true, force: true });
    }
}
if (import.meta.main)
    main();
