import { expect, test } from 'bun:test';
import { createPcmGateway } from './audio-stream-server.ts';
import { connectPcmStream } from './audio-stream-client.ts';
import { streamOptions, frameBytes } from './audio-stream.ts';
const options = () => streamOptions(['audio', 'stream', 'open', '--source', 'fixture', '--destination', 'browser']);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function mockGateway(onEnd: () => void = () => { }) {
    let alive = true, started = false;
    const gateway = createPcmGateway(options(), async (url, key) => {
        const headers = { Authorization: `Bearer ${key}` };
        const post = async (path: string, data: any = {}) => (await fetch(url + path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(data) })).json();
        await post('/start');
        started = true;
        while (alive) {
            const m = await (await fetch(url + '/input', { headers })).json();
            if (m.stop)
                break;
            if (m.data) {
                await post('/ack');
                if ((await post('/output', { phase: 'capturing', frames: [m.data] })).stop)
                    break;
            }
            if (m.endInput) {
                onEnd();
                await post('/ended');
            }
        }
    }, () => { alive = false; });
    return { ...gateway, get started() { return started; } };
}
test('duplex produces output before EOF and half-close does not stop output/control', async () => {
    let ended = false;
    const gateway = mockGateway(() => { ended = true; });
    const received: Uint8Array[] = [];
    const stream = await connectPcmStream(gateway.ticket, async (frame) => { received.push(frame); });
    try {
        const frame = new Uint8Array(gateway.ticket.maxFrameBytes);
        frame[0] = 17;
        await stream.write(frame);
        for (let n = 0; n < 100 && !received.length; n++)
            await sleep(5);
        expect(received).toHaveLength(1);
        expect(received[0]![0]).toBe(17);
        expect(ended).toBe(false);
        await stream.endInput();
        for (let n = 0; n < 100 && !ended; n++)
            await sleep(5);
        expect(ended).toBe(true);
        await expect(stream.write(frame)).rejects.toThrow('input closed');
        stream.cancel();
        expect(await stream.done).toBe('cancelled');
    }
    finally {
        gateway.stop();
    }
});
test('capability is one use and bad Origin cannot launch a renderer', async () => {
    const gateway = mockGateway();
    const wrong = new WebSocket(gateway.ticket.url, { headers: { Origin: 'https://untrusted.example' } } as any);
    await new Promise<void>(resolve => { wrong.onclose = () => resolve(); wrong.onerror = () => resolve(); });
    expect(gateway.started).toBe(false);
    const stream = await connectPcmStream(gateway.ticket, async () => { });
    const replay = new WebSocket(gateway.ticket.url);
    await new Promise<void>(resolve => { replay.onclose = () => resolve(); replay.onerror = () => resolve(); });
    stream.cancel();
    gateway.stop();
});
test('bounded output acknowledgements cannot prevent cancellation', async () => {
    let writes = 0, done = false;
    const opts = options();
    const gateway = createPcmGateway(opts, async (url, key) => {
        const headers = { Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
        const post = async (path: string, data: any = {}) => (await fetch(url + path, { method: 'POST', headers, body: JSON.stringify(data) })).json();
        await post('/start');
        const data = Buffer.alloc(frameBytes(opts.pcm)).toString('base64');
        for (let n = 0; n < 30; n++) {
            if ((await post('/output', { phase: 'capturing', frames: [data] })).stop)
                break;
            writes++;
        }
        done = true;
    });
    const controller = new AbortController();
    const stream = await connectPcmStream(gateway.ticket, async () => new Promise(() => { }), controller.signal);
    await sleep(150);
    expect(writes).toBeLessThanOrEqual(8);
    controller.abort();
    expect(await stream.done).toBe('cancelled');
    for (let n = 0; n < 100 && !done; n++)
        await sleep(5);
    expect(done).toBe(true);
    gateway.stop();
});
test('format negotiation and source/target validation fail before opening sockets', () => {
    for (const rest of [['--rate', '44100'], ['--channels', '8'], ['--source', 'same', '--destination', 'same'], ['--client-origin', 'http://remote.example']]) {
        const args = rest[0] === '--source' ? ['audio', 'stream', 'open', ...rest] : ['audio', 'stream', 'open', '--source', 'fixture', '--destination', 'browser', ...rest];
        expect(() => streamOptions(args)).toThrow();
    }
});
test('graceful close waits for all received PCM frames to reach a delayed sink', async () => {
    const opts = options();
    let consumed: number[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req, s) {
            if (s.upgrade(req))
                return;
            return new Response('no', { status: 400 });
        }, websocket: { message(ws) {
                ws.send(JSON.stringify({ type: 'ready', input: opts.pcm, output: opts.pcm, inputWindowBytes: 5120 }));
                for (let sequence = 0; sequence < 2; sequence++) {
                    ws.send(JSON.stringify({ type: 'frame', sequence, sampleOffset: sequence * 320, byteLength: 640, sourceId: 'browser', destinationId: 'fixture' }));
                    ws.send(Buffer.alloc(640, sequence + 1));
                }
                ws.send(JSON.stringify({ type: 'closed', reason: 'duration-limit' }));
                ws.close();
            } } });
    try {
        const stream = await connectPcmStream({ version: 1, url: `ws://127.0.0.1:${server.port}/stream`, capability: 'synthetic', clientOrigin: 'null', expiresAt: Date.now() + 30000, sourceId: 'fixture', destinationId: 'browser', input: opts.pcm, output: opts.pcm, frameMs: 20, maxFrameBytes: 640, inputWindowBytes: 5120 }, async (frame) => { await sleep(20); consumed.push(frame[0]!); });
        expect(await stream.done).toBe('duration-limit');
        expect(consumed).toEqual([1, 2]);
    }
    finally {
        server.stop(true);
    }
});
test('generated relay works in the actual page-only VM and disposes HTTP responses', async () => {
    const { runInNewContext } = await import('node:vm');
    const { buildPcmRelayCode } = await import('./audio-stream-server.ts');
    let disposed = 0, responses = 0;
    const response = (value: any) => { responses++; return { ok: () => true, json: async () => value, dispose: async () => { disposed++; } }; };
    const page = { evaluate: async (_fn: any, arg: any) => arg.fn === 'readPcm' ? { id: 'b-' + 'a'.repeat(32), phase: 'capturing', frames: [] } : {}, waitForTimeout: async () => { }, request: { post: async (path: string) => response({ stop: path.endsWith('/output') }), get: async () => response({ stop: true }) } };
    const fn = runInNewContext('(' + buildPcmRelayCode('http://127.0.0.1:1', 'synthetic', 'b-' + 'a'.repeat(32), 'https://example.test', options()) + ')', {});
    expect(JSON.parse(await fn(page))).toEqual({ closed: true });
    expect(disposed).toBe(responses);
});
test('raw CLI adapter streams output before stdin EOF, half-closes and rejects partial samples', async () => {
    const run = async (ticket: any, input?: Uint8Array) => {
        const code = `import {runAudioStreamCommand} from ${JSON.stringify(import.meta.dir + '/audio-stream-client.ts')}; await runAudioStreamCommand(['audio','stream','--source','fixture','--destination','browser'],async()=>({status:0,audioStream:JSON.parse(process.env.PCM_TEST_TICKET)})).catch(()=>{console.error('synthetic PCM pipe failure');process.exitCode=1});`;
        const child = Bun.spawn([process.execPath, '-e', code], { env: { ...process.env, PCM_TEST_TICKET: JSON.stringify(ticket) }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
        if (input) {
            child.stdin.write(input);
            child.stdin.end();
        }
        return child;
    };
    let ended = false;
    const gateway = mockGateway(() => { ended = true; });
    const child = await run(gateway.ticket);
    try {
        const frame = Buffer.alloc(640, 23);
        child.stdin.write(frame);
        const reader = child.stdout.getReader();
        const first = await Promise.race([reader.read(), sleep(2000).then(() => { throw Error('output waits for EOF'); })]);
        expect(first.done).toBe(false);
        expect(Buffer.from(first.value!)).toEqual(frame);
        expect(ended).toBe(false);
        child.stdin.end();
        for (let n = 0; n < 100 && !ended; n++)
            await sleep(5);
        expect(ended).toBe(true);
        gateway.stop('duration-limit');
        while (!(await reader.read()).done) { }
        expect(await child.exited).toBe(0);
    }
    finally {
        child.kill();
        gateway.stop();
    }
    const invalidGateway = mockGateway();
    const invalid = await run(invalidGateway.ticket, new Uint8Array([1]));
    try {
        const [code, out] = await Promise.all([invalid.exited, new Response(invalid.stdout).text()]);
        expect(code).toBe(1);
        expect(out).toBe('');
    }
    finally {
        invalid.kill();
        invalidGateway.stop();
    }
}, 10000);
test('raw CLI reports output pipe failure instead of a successful cancellation', async () => {
    const gateway = mockGateway();
    const code = `import {runAudioStreamCommand} from ${JSON.stringify(import.meta.dir + '/audio-stream-client.ts')}; await runAudioStreamCommand(['audio','stream','--source','fixture','--destination','browser'],async()=>({status:0,audioStream:JSON.parse(process.env.PCM_TEST_TICKET)})).catch(()=>{process.exitCode=1});`;
    const child = Bun.spawn([process.execPath, '-e', code], { env: { ...process.env, PCM_TEST_TICKET: JSON.stringify(gateway.ticket) }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    try {
        await child.stdout.cancel();
        child.stdin.write(Buffer.alloc(640));
        child.stdin.end();
        expect(await child.exited).toBe(1);
    }
    finally {
        child.kill();
        gateway.stop();
    }
}, 5000);
test('expired capabilities fail at handshake even if the expiry timer has not run yet', async () => {
    const gateway = mockGateway();
    const original = Date.now;
    try {
        Date.now = () => gateway.ticket.expiresAt + 1;
        const ws = new WebSocket(gateway.ticket.url);
        await new Promise<void>(resolve => { ws.onerror = () => resolve(); ws.onclose = () => resolve(); });
        expect(gateway.started).toBe(false);
    }
    finally {
        Date.now = original;
        gateway.stop();
    }
});
test('management stream stop cancels the renderer and permits a new generation', async () => {
    const { createAudioHandler } = await import('./audio-bridge-server.ts');
    const { runInNewContext } = await import('node:vm');
    const id = 'b-' + 'a'.repeat(32);
    let stopped = false;
    const status = { id, phase: 'ready', bufferedBytes: 0, droppedBytes: 0, streamCount: 0, queuedSeconds: 0, unsupported: [] };
    const handler = createAudioHandler(async (request) => {
        if (request.code.includes('page.addInitScript'))
            return { isError: false, text: JSON.stringify(status) };
        const response = (r: Response) => ({ ok: () => r.ok, json: () => r.json(), dispose: async () => { } });
        const page = { evaluate: async (_fn: any, arg: any) => {
                if (arg.fn === 'stop')
                    stopped = true;
                return arg.fn === 'readPcm' ? { id, phase: 'capturing', frames: [] } : status;
            }, waitForTimeout: sleep, request: { get: async (url: string, o: any) => response(await fetch(url, { headers: o.headers })), post: async (url: string, o: any) => response(await fetch(url, { method: 'POST', headers: { ...o.headers, 'content-type': 'application/json' }, body: JSON.stringify(o.data) })) } };
        return { isError: false, text: await runInNewContext('(' + request.code + ')', {})(page) };
    });
    const req = (args: string[]) => ({ args, socketRoot: '/tmp', session: 'synthetic', cwd: '/tmp' });
    await handler(req(['audio', 'install', 'https://example.test']));
    const reply = await handler(req(['audio', 'stream', 'open', '--source', 'fixture', '--destination', 'browser']));
    expect(reply.status).toBe(0);
    expect(Boolean(reply.audioStream)).toBe(true);
    const stream = await connectPcmStream(reply.audioStream as any, async () => { });
    expect((await handler(req(['audio', 'stream', 'stop']))).status).toBe(0);
    await stream.done;
    for (let n = 0; n < 100 && !stopped; n++)
        await sleep(5);
    expect(stopped).toBe(true);
    await sleep(30);
    expect((await handler(req(['audio', 'install', 'https://example.test']))).status).toBe(0);
});
