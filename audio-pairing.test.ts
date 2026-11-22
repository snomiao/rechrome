import { expect, test } from 'bun:test';
import { createAudioPairing } from './audio-pairing.ts';
const base = 'http://127.0.0.1:13775', remote = 'https://li.example', pcm = { sampleRate: 16000 as const, channels: 1 as const, format: 's16le' as const };
function fixture() {
    let now = 1000, mints = 0, revokes = 0, active = false;
    let target = { id: 'generation-a', title: 'Selected local chat', origin: 'https://voice.example' };
    let hold: Promise<void> | undefined;
    const service = createAudioPairing({ now: () => now, targets: async () => [target], grant: async (id, options) => {
            mints++;
            if (hold)
                await hold;
            return { ticket: { version: 1 as const, url: 'ws://127.0.0.1:23456/stream', capability: 'synthetic', clientOrigin: options.origin, expiresAt: now + 30000, sourceId: options.sourceId, destinationId: 'chat-' + id, input: pcm, output: pcm, frameMs: 20 as const, maxFrameBytes: 640, inputWindowBytes: 5120 }, isActive: () => active, revoke: () => { revokes++; active = false; } };
        } });
    const call = (path: string, data?: any, origin = remote, cookie?: string, extra: Record<string, string> = {}) => service.handle(new Request(base + '/audio/pair/' + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: origin, ...(data !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) }), base);
    const operator = async () => { const r = await call('operator', { token: service.bootstrap() }, base); expect(r.status).toBe(200); expect(r.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict'); return r.headers.get('set-cookie')!.split(';')[0]!; };
    const pending = async () => { const r = await call('request', { sourceId: 'li-source', input: pcm, output: pcm, frameMs: 20 }); expect(r.status).toBe(200); return r.json(); };
    return { service, call, operator, pending, stats: () => ({ mints, revokes }), advance: (value: number) => { now = value; }, activate: () => { active = true; }, replaceTarget: () => { target = { ...target, id: 'generation-b' }; }, hold: (value: Promise<void>) => { hold = value; } };
}
test('public requests expose no tabs or audio grant; nonce and exact Origin bind status', async () => {
    const f = fixture();
    try {
        const d = await f.call('discovery');
        expect(d.headers.get('access-control-allow-origin')).toBe(remote);
        expect((await d.json()).version).toBe(2);
        expect((await f.call('targets')).status).toBe(403);
        const p = await f.pending();
        expect(p.requestId).toHaveLength(36);
        expect(p.requestNonce).toHaveLength(43);
        expect(p.ticket).toBeUndefined();
        expect(f.stats().mints).toBe(0);
        expect((await f.call('approve', { requestId: p.requestId, action: 'approve', targetId: 'generation-a' })).status).toBe(403);
        expect((await f.call('status', p, 'https://other.example')).status).toBe(403);
        expect((await f.call('status', { ...p, requestNonce: 'wrong' })).status).toBe(403);
        expect((await (await f.call('status', p)).json()).state).toBe('pending');
    }
    finally {
        f.service.close();
    }
});
test('local operator selects a named chat; cancellation revokes an approved stream', async () => {
    const f = fixture();
    try {
        const cookie = await f.operator(), p = await f.pending();
        const targets = await (await f.call('targets', undefined, base, cookie)).json();
        expect(targets.targets[0].title).toBe('Selected local chat');
        expect((await f.call('approve', { requestId: p.requestId, action: 'approve', targetId: 'generation-a' }, base, cookie)).status).toBe(200);
        const approved = await (await f.call('status', p)).json();
        expect(approved.state).toBe('approved');
        expect(approved.approvedChat.title).toBe('Selected local chat');
        expect(approved.ticket.destinationId).toBe('chat-generation-a');
        expect((await (await f.call('cancel', p)).json()).state).toBe('cancelled');
        expect(f.stats().revokes).toBe(1);
    }
    finally {
        f.service.close();
    }
});
test('cancel wins an in-flight approval and revokes its eventual capability', async () => {
    const f = fixture();
    let release!: () => void;
    f.hold(new Promise(r => { release = r; }));
    try {
        const cookie = await f.operator(), p = await f.pending();
        const approving = f.call('approve', { requestId: p.requestId, action: 'approve', targetId: 'generation-a' }, base, cookie);
        for (let n = 0; n < 20 && !f.stats().mints; n++)
            await Bun.sleep(1);
        await f.call('cancel', p);
        release();
        await approving;
        expect(f.stats().revokes).toBe(1);
        const status = await (await f.call('status', p)).json();
        expect(status.state).toBe('cancelled');
        expect(status.ticket).toBeUndefined();
    }
    finally {
        release?.();
        f.service.close();
    }
});
test('pending TTL does not truncate an approved active stream', async () => {
    const f = fixture();
    try {
        const cookie = await f.operator(), p = await f.pending();
        f.advance(120000);
        await f.call('approve', { requestId: p.requestId, action: 'approve', targetId: 'generation-a' }, base, cookie);
        f.activate();
        f.advance(121001);
        expect((await (await f.call('status', p)).json()).state).toBe('approved');
        expect(f.stats().revokes).toBe(0);
        f.advance(160000);
        expect((await (await f.call('status', p)).json()).state).toBe('approved');
    }
    finally {
        f.service.close();
    }
});
test('pending expiry, stale target, malformed PCM and operator CSRF fail closed', async () => {
    const f = fixture();
    try {
        const cookie = await f.operator(), p = await f.pending();
        expect((await f.call('approve', { requestId: p.requestId, action: 'approve', targetId: 'generation-a' }, remote, cookie)).status).toBe(403);
        f.replaceTarget();
        expect((await f.call('approve', { requestId: p.requestId, action: 'approve', targetId: 'generation-a' }, base, cookie)).status).toBe(409);
        expect(f.stats().mints).toBe(0);
        expect((await f.call('request', { sourceId: 'li-source', input: { ...pcm, sampleRate: 44100 }, output: pcm, frameMs: 20 })).status).toBe(400);
        const later = await f.pending();
        f.advance(130000);
        expect((await (await f.call('status', later)).json()).state).toBe('expired');
    }
    finally {
        f.service.close();
    }
});
test('operator bootstrap is single use and only local-origin; public panel is frame protected', async () => {
    const f = fixture();
    try {
        const token = f.service.bootstrap();
        expect((await f.call('operator', { token })).status).toBe(403);
        expect((await f.call('operator', { token }, base)).status).toBe(200);
        expect((await f.call('operator', { token }, base)).status).toBe(403);
        const page = await f.call('approve');
        expect(page.status).toBe(200);
        expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
        expect(await page.text()).not.toContain('Selected local chat');
    }
    finally {
        f.service.close();
    }
});
test('real handler generation replacement changes target ID and rejects the stale selection', async () => {
    const { createAudioHandler } = await import('./audio-bridge-server.ts');
    let generation = 0, phase = 'ready';
    const status = () => ({ id: 'b-' + String(generation).padStart(32, '0'), phase, bufferedBytes: 0, droppedBytes: 0, streamCount: 0, queuedSeconds: 0, unsupported: [] });
    const handler = createAudioHandler(async (request) => {
        if (request.code.includes('page.addInitScript')) {
            generation++;
            phase = 'ready';
            return { isError: false, text: JSON.stringify(status()) };
        }
        if (request.code.includes('document.title'))
            return { isError: false, text: JSON.stringify({ title: 'Actual local chat' }) };
        if (request.code.includes('"action":"stop"'))
            phase = 'stopped';
        return { isError: false, text: JSON.stringify({ ...status(), ...(request.code.includes('"action":"drain"') ? { streams: [] } : {}) }) };
    });
    const req = (args: string[]) => ({ args, socketRoot: '/tmp', session: 'synthetic', cwd: '/tmp' });
    await handler(req(['audio', 'install', 'https://voice.example']));
    const before = (await handler.pairTargets())[0]!;
    await handler(req(['audio', 'stop']));
    await handler(req(['audio', 'drain']));
    await handler(req(['audio', 'install', 'https://voice.example']));
    const after = (await handler.pairTargets())[0]!;
    expect(before.title).toBe('Actual local chat');
    expect(after.id).not.toBe(before.id);
    await expect(handler.pairGrant(before.id, { sourceId: 'li-source', origin: remote, pcm })).rejects.toThrow('chat unavailable');
});
test('only registered operator wakes, rate bounded and never concurrent or audio-authorizing', async () => {
    const f = fixture();
    let wakes = 0, release!: () => void;
    try {
        const first = await f.pending();
        expect(wakes).toBe(0);
        await f.call('cancel', first);
        f.service.setOperatorWake(async () => { wakes++; await new Promise<void>(r => release = r); });
        const a = await f.pending();
        f.advance(7000);
        const b = await f.pending();
        expect(wakes).toBe(1);
        expect(f.stats().mints).toBe(0);
        await f.call('cancel', a);
        await f.call('cancel', b);
        release();
        await Bun.sleep(0);
        const c = await f.pending();
        expect(wakes).toBe(2);
        await f.call('cancel', c);
        release();
    }
    finally {
        release?.();
        f.service.close();
    }
});
test('stalled public request body is bounded and creates no audio or pending request', async () => {
    const f = fixture();
    try {
        const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{')); } });
        const r = await f.service.handle(new Request(base + '/audio/pair/request', { method: 'POST', headers: { Origin: remote, 'content-type': 'application/json' }, body, duplex: 'half' } as RequestInit), base);
        expect(r.status).toBe(400);
        expect(f.stats().mints).toBe(0);
    }
    finally {
        f.service.close();
    }
});
test('shutdown revokes a capability minted by an already in-flight approval', async () => {
    const f = fixture();
    let release!: () => void;
    f.hold(new Promise(r => release = r));
    try {
        const cookie = await f.operator(), p = await f.pending();
        const approving = f.call('approve', { requestId: p.requestId, action: 'approve', targetId: 'generation-a' }, base, cookie);
        for (let n = 0; n < 20 && !f.stats().mints; n++)
            await Bun.sleep(1);
        f.service.close();
        release();
        await approving;
        expect(f.stats().revokes).toBe(1);
    }
    finally {
        release?.();
        f.service.close();
    }
});
