import { open } from 'node:fs/promises';
import { once } from 'node:events';
import { pcmFormat, frameBytes, streamOptions, type StreamTicket } from './audio-stream.ts';
type Connection = {
    write(frame: Uint8Array): Promise<void>;
    endInput(): Promise<void>;
    cancel(): void;
    done: Promise<string>;
};
/** Library sink acknowledgement is after consumption, not after enqueueing it. */
export async function connectPcmStream(ticket: StreamTicket, consume: (frame: Uint8Array, metadata: any) => Promise<void>, signal?: AbortSignal): Promise<Connection> {
    if (ticket.version !== 1 || ticket.expiresAt <= Date.now() || !/^ws:\/\/127\.0\.0\.1:[0-9]+\/stream$/.test(ticket.url) || !ticket.capability || ticket.maxFrameBytes !== frameBytes(pcmFormat(ticket.input)))
        throw Error('audio stream: invalid ticket');
    const ws = new WebSocket(ticket.url);
    ws.binaryType = 'arraybuffer';
    let credit = 0, ended = false, closed = false, cancelled = false, metadata: any, outputSequence = 0;
    let wake: () => void = () => { };
    let resolveReady!: () => void, rejectReady!: (e: Error) => void, resolveDone!: (reason: string) => void;
    const ready = new Promise<void>((r, j) => { resolveReady = r; rejectReady = j; });
    const done = new Promise<string>(r => { resolveDone = r; });
    let output = Promise.resolve();
    const finish = (reason: string) => {
        if (closed)
            return;
        closed = true;
        wake();
        rejectReady(Error('audio stream: connection closed'));
        ws.close();
        let timer: ReturnType<typeof setTimeout>;
        void Promise.race([output.then(() => reason), new Promise<string>(resolve => { timer = setTimeout(() => resolve('slow-consumer'), 2000); })]).then(result => { clearTimeout(timer!); signal?.removeEventListener('abort', cancel); resolveDone(result); });
    };
    const cancel = () => { cancelled = true; if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'cancel' })); finish('cancelled'); resolveDone('cancelled'); signal?.removeEventListener('abort', cancel); };
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { cancel(); rejectReady(Error('audio stream: handshake timed out')); }, 5000);
    ws.onopen = () => { if (signal?.aborted) {
        cancel();
        return;
    } ws.send(JSON.stringify({ type: 'hello', version: 1, capability: ticket.capability, sourceId: ticket.sourceId, destinationId: ticket.destinationId, input: ticket.input, output: ticket.output, frameMs: 20 })); };
    ws.onerror = () => finish('connection-error');
    ws.onclose = () => finish('disconnected');
    ws.onmessage = event => {
        try {
            if (typeof event.data === 'string') {
                const message = JSON.parse(event.data);
                if (message.type === 'ready') {
                    if (JSON.stringify(pcmFormat(message.input)) !== JSON.stringify(ticket.input) || JSON.stringify(pcmFormat(message.output)) !== JSON.stringify(ticket.output) || message.inputWindowBytes !== ticket.inputWindowBytes)
                        throw Error();
                    credit = message.inputWindowBytes;
                    resolveReady();
                }
                else if (message.type === 'credit') {
                    if (message.bytes !== ticket.maxFrameBytes || credit + message.bytes > ticket.inputWindowBytes)
                        throw Error();
                    credit += message.bytes;
                    wake();
                }
                else if (message.type === 'frame') {
                    if (metadata || message.sequence !== outputSequence || message.byteLength !== ticket.maxFrameBytes || message.sampleOffset !== outputSequence * ticket.output.sampleRate / 50 || message.sourceId !== ticket.destinationId || message.destinationId !== ticket.sourceId)
                        throw Error();
                    metadata = message;
                }
                else if (message.type === 'closed')
                    finish(message.reason);
                else if (message.type !== 'input-ended')
                    throw Error();
            }
            else {
                if (!metadata || !(event.data instanceof ArrayBuffer) || event.data.byteLength !== metadata.byteLength)
                    throw Error();
                const frame = new Uint8Array(event.data), descriptor = metadata;
                metadata = undefined;
                outputSequence++;
                output = output.then(async () => { if (cancelled)
                    return; await consume(frame, descriptor); if (!closed)
                    ws.send(JSON.stringify({ type: 'output-ack', sequence: descriptor.sequence })); }).catch(() => cancel());
            }
        }
        catch {
            cancel();
        }
    };
    try {
        await ready;
    }
    finally {
        clearTimeout(timer);
    }
    let writing = false;
    return {
        done, cancel,
        async write(frame) {
            if (writing)
                throw Error('audio stream: concurrent input writes');
            writing = true;
            try {
                if (frame.byteLength !== ticket.maxFrameBytes)
                    throw Error('audio stream: invalid frame');
                while (!closed && !ended && credit < frame.byteLength)
                    await new Promise<void>(r => { wake = r; });
                if (closed || ended)
                    throw Error('audio stream: input closed');
                credit -= frame.byteLength;
                ws.send(Uint8Array.from(frame).buffer);
            }
            finally {
                writing = false;
            }
        },
        async endInput() { if (writing)
            throw Error('audio stream: input write pending'); if (!closed && !ended) {
            ended = true;
            ws.send(JSON.stringify({ type: 'end-input' }));
        } },
    };
}
export async function runAudioStreamCommand(args: string[], serve: (args: string[]) => Promise<any>) {
    const sessions = args.filter(a => a.startsWith('-s='));
    if (sessions.some(a => a.startsWith('-s=iso-')))
        throw Error('audio stream: stable session required');
    const command = args.filter(a => !a.startsWith('-s='));
    if (command[2] === 'stop') {
        const reply = await serve([...sessions, 'audio', 'stream', 'stop']);
        if (reply.status)
            throw Error('audio stream: stop failed');
        return;
    }
    let ticketPath: string | undefined;
    const ticketMode = command[2] === 'ticket';
    const flags = command.slice(ticketMode ? 3 : 2);
    const filtered: string[] = [];
    for (let n = 0; n < flags.length; n++) {
        if (flags[n] === '--ticket-file') {
            if (ticketPath)
                throw Error('audio stream: duplicate ticket path');
            ticketPath = flags[++n];
            if (!ticketPath)
                throw Error('audio stream: ticket path required');
        }
        else
            filtered.push(flags[n]!);
    }
    if (ticketMode !== Boolean(ticketPath))
        throw Error('audio stream: ticket file required only for ticket mode');
    const wire = ['audio', 'stream', 'open', ...filtered];
    streamOptions(wire);
    const reply = await serve([...sessions, ...wire]);
    if (reply.status !== 0 || !reply.audioStream)
        throw Error('audio stream: unavailable; install the bridge on the selected management session first');
    const ticket = reply.audioStream as StreamTicket;
    if (ticketMode) {
        try {
            const file = await open(ticketPath!, 'wx', 0o600);
            try {
                await file.writeFile(JSON.stringify(ticket));
                await file.sync();
            }
            finally {
                await file.close();
            }
        }
        catch {
            await serve([...sessions, 'audio', 'stream', 'stop']).catch(() => { });
            throw Error('audio stream: private ticket could not be saved');
        }
        console.error('audio stream: private one-use ticket saved; expires in 30 seconds');
        return;
    }
    let pumpFailed = false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    const connection = await connectPcmStream(ticket, async (frame) => {
        if (!process.stdout.write(frame))
            await once(process.stdout, 'drain', { signal: controller.signal });
    }, controller.signal);
    const outputError = () => { pumpFailed = true; connection.cancel(); controller.abort(); };
    process.stdout.once('error', outputError);
    console.error(`audio stream: s16le ${ticket.input.sampleRate}Hz ${ticket.input.channels}ch; stdin/stdout are PCM only`);
    const reader = Bun.stdin.stream().getReader();
    const input = (async () => {
        let pending = Buffer.alloc(0);
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done)
                    break;
                let chunk = Buffer.from(value), offset = 0;
                if (pending.length) {
                    const amount = Math.min(ticket.maxFrameBytes - pending.length, chunk.length);
                    pending = Buffer.concat([pending, chunk.subarray(0, amount)]);
                    offset = amount;
                    if (pending.length === ticket.maxFrameBytes) {
                        await connection.write(pending);
                        pending = Buffer.alloc(0);
                    }
                }
                while (offset + ticket.maxFrameBytes <= chunk.length) {
                    await connection.write(chunk.subarray(offset, offset + ticket.maxFrameBytes));
                    offset += ticket.maxFrameBytes;
                }
                if (offset < chunk.length)
                    pending = Buffer.from(chunk.subarray(offset));
            }
            if (pending.length) {
                if (pending.length % (ticket.input.channels * 2))
                    throw Error('partial PCM sample');
                const last = Buffer.alloc(ticket.maxFrameBytes);
                pending.copy(last);
                await connection.write(last);
            }
            await connection.endInput();
        }
        catch {
            if (!controller.signal.aborted)
                pumpFailed = true;
            connection.cancel();
        }
    })();
    try {
        const reason = await connection.done;
        if (pumpFailed)
            throw Error('audio stream: PCM pipe failed');
        if (!['stopped', 'cancelled', 'renderer-ended', 'duration-limit'].includes(reason))
            throw Error('audio stream: disconnected or failed');
    }
    finally {
        controller.abort();
        connection.cancel();
        void reader.cancel().catch(() => { });
        void input.catch(() => { });
        process.removeListener('SIGINT', abort);
        process.removeListener('SIGTERM', abort);
        process.stdout.removeListener('error', outputError);
    }
}
