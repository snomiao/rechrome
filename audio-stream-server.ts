import { randomBytes, timingSafeEqual } from 'node:crypto';
import { frameBytes, pcmFormat, PCM_MAX_QUEUE, type StreamOptions, type StreamTicket } from './audio-stream.ts';
const secret = () => randomBytes(32).toString('base64url');
const equal = (a: unknown, b: string) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
type Client = {
    send(data: string | Uint8Array): number;
    close(code?: number, reason?: string): void;
    getBufferedAmount(): number;
    data: {
        origin: string;
        auth: boolean;
    };
};
/** Gateway is loopback-only. Minting it is reachable only through authorized management /run. */
export function createPcmGateway(options: StreamOptions, renderer: (url: string, key: string) => Promise<void>, closed: () => void = () => { }) {
    const capability = secret(), rendererKey = secret(), bytes = frameBytes(options.pcm), windowBytes = bytes * 8;
    let consumed = false, ended = false, inputNotified = false, started = false, stopped = false, inputSeq = 0, outputSeq = 0;
    let outstanding = 0, outputOutstanding = 0, outputAck = 0, queue: Buffer[] = [], client: Client | undefined;
    let notify: (() => void) | undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const waiters = new Set<() => void>();
    const pause = (ms: number) => new Promise<void>(resolve => { const finish = () => { waiters.delete(finish); resolve(); }; waiters.add(finish); later(finish, ms); });
    const later = (fn: () => void, ms: number) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer; };
    let reason = 'stopped';
    const stop = (why = 'stopped') => {
        if (stopped)
            return;
        stopped = true;
        reason = why;
        queue = [];
        outstanding = 0;
        notify?.();
        for (const finish of waiters)
            finish();
        for (const timer of timers)
            clearTimeout(timer);
        timers.clear();
        try {
            client?.send(JSON.stringify({ type: 'closed', reason: why }));
            client?.close(1000, 'audio stream closed');
        }
        catch { }
        closed();
        // Let a pending renderer request observe cancellation before releasing the port.
        const timer = setTimeout(() => server.stop(true), 1000);
        timer.unref?.();
    };
    const control = (data: object) => {
        if (!client || client.getBufferedAmount() > PCM_MAX_QUEUE || client.send(JSON.stringify(data)) < 0) {
            stop('slow-consumer');
            return false;
        }
        return true;
    };
    const server = Bun.serve<{
        origin: string;
        auth: boolean;
    }>({
        hostname: '127.0.0.1', port: 0, maxRequestBodySize: 128 * 1024,
        fetch(req, server) {
            const path = new URL(req.url).pathname;
            if (path === '/stream' && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
                const origin = req.headers.get('origin') ?? 'null';
                if (origin !== options.clientOrigin || consumed || stopped || Date.now() >= expiresAt)
                    return new Response('Unavailable', { status: 403 });
                if (server.pendingWebSockets >= 4)
                    return new Response('Unavailable', { status: 429 });
                if (server.upgrade(req, { data: { origin, auth: false } }))
                    return;
                return new Response('Unavailable', { status: 400 });
            }
            if (!equal(req.headers.get('authorization'), `Bearer ${rendererKey}`))
                return new Response('Unavailable', { status: 403 });
            if (path === '/start' && req.method === 'POST') {
                if (stopped)
                    return Response.json({ stop: true });
                started = true;
                control({ type: 'ready', version: 1, sourceId: options.sourceId, destinationId: options.destinationId, input: options.pcm, output: options.pcm, frameMs: 20, maxFrameBytes: bytes, inputWindowBytes: windowBytes, outputWindowBytes: windowBytes });
                return Response.json({ ok: true });
            }
            if (path === '/input' && req.method === 'GET')
                return (async () => {
                    if (!queue.length && !stopped && (!ended || inputNotified))
                        await new Promise<void>(resolve => {
                            const done = () => { notify = undefined; resolve(); };
                            notify = done;
                            later(done, 20);
                        });
                    if (stopped)
                        return Response.json({ stop: true, reason });
                    const frame = queue.shift();
                    return Response.json(frame ? { data: frame.toString('base64') } : { endInput: ended && !inputNotified });
                })();
            if (path === '/ack' && req.method === 'POST') {
                if (stopped)
                    return Response.json({ stop: true });
                if (outstanding < bytes) {
                    stop('invalid-credit');
                    return Response.json({ stop: true });
                }
                outstanding -= bytes;
                control({ type: 'credit', bytes, inputSequence: inputSeq++ });
                return Response.json({ ok: true });
            }
            if (path === '/ended' && req.method === 'POST') {
                inputNotified = true;
                control({ type: 'input-ended' });
                return Response.json({ ok: true });
            }
            if (path === '/output' && req.method === 'POST')
                return (async () => {
                    if (stopped)
                        return Response.json({ stop: true });
                    try {
                        const body = await req.json();
                        if (!Array.isArray(body.frames) || body.frames.length > 128)
                            throw Error();
                        for (const data of body.frames) {
                            if (typeof data !== 'string' || data.length > Math.ceil(bytes / 3) * 4)
                                throw Error();
                            const frame = Buffer.from(data, 'base64');
                            if (frame.length !== bytes || frame.toString('base64') !== data)
                                throw Error();
                            const deadline = Date.now() + 2000;
                            while (!stopped && outputOutstanding + bytes > windowBytes && Date.now() < deadline)
                                await pause(5);
                            if (stopped)
                                break;
                            if (outputOutstanding + bytes > windowBytes) {
                                stop('slow-consumer');
                                break;
                            }
                            if (!control({ type: 'frame', sequence: outputSeq, sampleOffset: outputSeq * options.pcm.sampleRate / 50, byteLength: frame.length, sourceId: options.destinationId, destinationId: options.sourceId }))
                                break;
                            if (!client || client.getBufferedAmount() + frame.length > PCM_MAX_QUEUE || client.send(frame) < 0) {
                                stop('slow-consumer');
                                break;
                            }
                            outputSeq++;
                            outputOutstanding += bytes;
                        }
                        if (body.phase === 'stopped' || body.phase === 'failed')
                            stop('renderer-ended');
                        return Response.json({ stop: stopped });
                    }
                    catch {
                        stop('invalid-renderer-output');
                        return Response.json({ stop: true });
                    }
                })();
            if (path === '/close' && req.method === 'POST') {
                stop('renderer-ended');
                return Response.json({ ok: true });
            }
            return new Response('Unavailable', { status: 404 });
        },
        websocket: {
            maxPayloadLength: 16 * 1024, idleTimeout: 30,
            open(ws) {
                later(() => {
                    if (!ws.data.auth)
                        ws.close(1008, 'authentication timeout');
                }, 2000);
            },
            message(ws, raw) {
                if (stopped)
                    return ws.close(1000, 'closed');
                if (!ws.data.auth) {
                    try {
                        if (typeof raw !== 'string' || raw.length > 2048)
                            throw Error();
                        const h = JSON.parse(raw);
                        if (consumed || Date.now() >= expiresAt || h.type !== 'hello' || h.version !== 1 || !equal(h.capability, capability) || h.sourceId !== options.sourceId || h.destinationId !== options.destinationId || JSON.stringify(pcmFormat(h.input)) !== JSON.stringify(options.pcm) || JSON.stringify(pcmFormat(h.output)) !== JSON.stringify(options.pcm) || h.frameMs !== 20)
                            throw Error();
                        consumed = true;
                        ws.data.auth = true;
                        client = ws;
                        void renderer(`http://127.0.0.1:${server.port}`, rendererKey).catch(() => stop('renderer-error')).finally(() => stop('renderer-ended'));
                    }
                    catch {
                        ws.close(1008, 'invalid handshake');
                    }
                    return;
                }
                if (typeof raw === 'string') {
                    try {
                        if (raw.length > 1024)
                            throw Error();
                        const m = JSON.parse(raw);
                        if (m.type === 'output-ack' && Number.isSafeInteger(m.sequence) && m.sequence === outputAck && outputAck < outputSeq) {
                            outputAck++;
                            outputOutstanding -= bytes;
                            return;
                        }
                        if (m.type === 'cancel' || m.type === 'stop') {
                            stop('cancelled');
                            return;
                        }
                        if (m.type === 'end-input' && !ended) {
                            ended = true;
                            notify?.();
                            return;
                        }
                        throw Error();
                    }
                    catch {
                        stop('invalid-control');
                    }
                    return;
                }
                if (!started || ended || raw.byteLength !== bytes || outstanding + raw.byteLength > windowBytes) {
                    stop('input-overflow');
                    return;
                }
                outstanding += raw.byteLength;
                queue.push(Buffer.from(raw));
                notify?.();
            },
            close(ws) {
                if (ws.data.auth)
                    stop('disconnected');
            },
        },
    });
    const expiresAt = Date.now() + 30000;
    later(() => {
        if (!consumed)
            stop('capability-expired');
    }, 30000);
    later(() => stop('duration-limit'), options.maxSeconds * 1000 + 30000);
    const ticket: StreamTicket = { version: 1, url: `ws://127.0.0.1:${server.port}/stream`, capability, clientOrigin: options.clientOrigin, expiresAt, sourceId: options.sourceId, destinationId: options.destinationId, input: options.pcm, output: options.pcm, frameMs: 20, maxFrameBytes: bytes, inputWindowBytes: windowBytes };
    return { ticket, stop, get closed() { return stopped; }, get authenticated() { return consumed && !stopped; } };
}
/** Only an explicit terminal same-generation stop result can retire a renderer. */
export function pcmStopConfirmed(text: string): boolean {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 8192)
        return false;
    try {
        let value: any;
        try {
            value = JSON.parse(text);
        }
        catch {
            const matches = [...text.matchAll(/(?:^|\n)### Result\r?\n([\s\S]*?)(?=\r?\n### |$)/g)];
            if (matches.length !== 1)
                return false;
            value = JSON.parse(matches[0]![1]!);
        }
        for (let n = 0; n < 5; n++) {
            if (typeof value === 'string') {
                value = JSON.parse(value);
                continue;
            }
            if (!value || typeof value !== 'object' || value.isError || value.error)
                return false;
            if (Object.hasOwn(value, 'result')) {
                value = value.result;
                continue;
            }
            return value.closed === true && value.stopConfirmed === true;
        }
    }
    catch { }
    return false;
}
/** Runs inside the browser's existing local session process, never in renderer argv. */
export function buildPcmRelayCode(url: string, key: string, id: string, origin: string, options: StreamOptions) {
    return `async page => {
    const base=${JSON.stringify(url)}, headers={Authorization:${JSON.stringify(`Bearer ${key}`)}};
    const generation=${JSON.stringify(id)}, origin=${JSON.stringify(origin)};
    const check=async(fn,data)=>page.evaluate(async ({generation,origin,fn,data})=>{
      const bridge=window.__rechAudioBridge;
      if(location.origin!==origin||!bridge||bridge.status().id!==generation)throw new Error('audio generation changed');
      return await bridge[fn](data);
    },{generation,origin,fn,data});
    let stopping=false, stopConfirmed=false;
    const post=async(path,data)=>{const r=await page.request.post(base+path,{headers,data,timeout:3000});try{if(!r.ok())throw new Error('audio relay unavailable');return await r.json()}finally{await r.dispose()}};
    try {
      await check('startPcm',${JSON.stringify({ ...options.pcm, maxSeconds: options.maxSeconds })});
      await post('/start',{});
      await Promise.race([
        (async()=>{while(!stopping){const r=await page.request.get(base+'/input',{headers,timeout:3000});let m;try{m=await r.json()}finally{await r.dispose()}if(m.stop){stopping=true;break}
          if(m.data){await check('feedPcm',m.data);await post('/ack',{})}
          if(m.endInput){await check('endPcmInput');await post('/ended',{})}
        }})(),
        (async()=>{while(!stopping){const value=await check('readPcm');if((await post('/output',value)).stop){stopping=true;break}await page.waitForTimeout(20)}})()
      ]);
    } finally {
      stopping=true;
      try {
        const stopped=await Promise.race([check('stop').catch(()=>null),page.waitForTimeout(2000).then(()=>null)]);
        stopConfirmed=stopped?.id===generation&&['stopped','failed'].includes(stopped.phase);
      } finally {
        await post('/close',{}).catch(()=>{});
      }
    }
    return JSON.stringify({closed:true,stopConfirmed});
  }`;
}
