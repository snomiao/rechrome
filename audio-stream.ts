/** Browser-safe v1 PCM contract. Audio binary messages have no embedded metadata. */
export type PcmFormat = {
    sampleRate: 16000 | 48000;
    channels: 1 | 2;
    format: 's16le';
};
export type StreamOptions = {
    sourceId: string;
    destinationId: string;
    clientOrigin: string;
    pcm: PcmFormat;
    maxSeconds: number;
};
export type StreamTicket = {
    version: 1;
    url: string;
    capability: string;
    clientOrigin: string;
    expiresAt: number;
    sourceId: string;
    destinationId: string;
    input: PcmFormat;
    output: PcmFormat;
    frameMs: 20;
    maxFrameBytes: number;
    inputWindowBytes: number;
};
export const PCM_FRAME_MS = 20;
export const PCM_MAX_QUEUE = 64 * 1024;
export function pcmFormat(value: any): PcmFormat {
    if (!value || ![16000, 48000].includes(value.sampleRate) || ![1, 2].includes(value.channels) || value.format !== 's16le' || Object.keys(value).some(k => !['sampleRate', 'channels', 'format'].includes(k)))
        throw Error('audio stream: unsupported PCM format');
    return { sampleRate: value.sampleRate, channels: value.channels, format: 's16le' };
}
export const frameBytes = (pcm: PcmFormat) => pcm.sampleRate * pcm.channels * 2 * PCM_FRAME_MS / 1000;
export function streamOptions(args: string[]): StreamOptions {
    if (args[0] !== 'audio' || args[1] !== 'stream' || args[2] !== 'open')
        throw Error('audio stream: invalid open');
    const values: Record<string, string> = {};
    for (let n = 3; n < args.length; n++) {
        const m = /^--(source|destination|client-origin|rate|channels|max-seconds)(?:=(.*))?$/.exec(args[n]!);
        if (!m || Object.hasOwn(values, m[1]!))
            throw Error('audio stream: invalid options');
        const value = m[2] ?? args[++n];
        if (!value)
            throw Error('audio stream: missing option');
        values[m[1]!] = value;
    }
    for (const key of ['source', 'destination'])
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(values[key] ?? ''))
            throw Error('audio stream: explicit source and destination required');
    if (values.source === values.destination)
        throw Error('audio stream: source and destination must differ');
    const clientOrigin = values['client-origin'] ?? 'null';
    if (clientOrigin !== 'null') {
        const u = new URL(clientOrigin);
        if (u.origin !== clientOrigin || !(u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))))
            throw Error('audio stream: invalid client origin');
    }
    const maxSeconds = Number(values['max-seconds'] ?? 60);
    if (!Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 300)
        throw Error('audio stream: duration must be 1..300 seconds');
    return { sourceId: values.source!, destinationId: values.destination!, clientOrigin, pcm: pcmFormat({ sampleRate: Number(values.rate ?? 16000), channels: Number(values.channels ?? 1), format: 's16le' }), maxSeconds };
}
