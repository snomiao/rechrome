/** Optional FFmpeg pipe interoperability check. Generated PCM only; no audio output device. */
import { createPcmGateway } from '../audio-stream-server.ts';
import { streamOptions } from '../audio-stream.ts';
async function main() {
    if (!Bun.which('ffmpeg'))
        throw Error('ffmpeg-required');
    const producer = Bun.spawn(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '0.2', '-ac', '1', '-f', 's16le', 'pipe:1'], { stdout: 'pipe', stderr: 'pipe' });
    const [raw, producerCode] = await Promise.all([new Response(producer.stdout).arrayBuffer(), producer.exited]);
    if (producerCode !== 0 || raw.byteLength !== 6400)
        throw Error('ffmpeg-generation');
    const options = streamOptions(['audio', 'stream', 'open', '--source', 'ffmpeg', '--destination', 'echo']);
    const gateway = createPcmGateway(options, async (url, key) => {
        const headers = { Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
        const post = async (path: string, data: unknown = {}) => (await fetch(url + path, { method: 'POST', headers, body: JSON.stringify(data) })).json();
        await post('/start');
        for (;;) {
            const m = await (await fetch(url + '/input', { headers })).json();
            if (m.stop)
                break;
            if (m.data) {
                await post('/ack');
                if ((await post('/output', { phase: 'capturing', frames: [m.data] })).stop)
                    break;
            }
            if (m.endInput) {
                await post('/ended');
                break;
            }
        }
    });
    const code = `import {runAudioStreamCommand} from ${JSON.stringify(import.meta.dir + '/../audio-stream-client.ts')};await runAudioStreamCommand(['audio','stream','--source','ffmpeg','--destination','echo'],async()=>({status:0,audioStream:JSON.parse(process.env.PCM_TEST_TICKET)}));`;
    const child = Bun.spawn([process.execPath, '-e', code], { env: { ...process.env, PCM_TEST_TICKET: JSON.stringify(gateway.ticket) }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const decoder = Bun.spawn(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', 'pipe:0', '-f', 'null', '-'], { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' });
    let outputBytes = 0, outputBeforeEof = false, eof = false;
    const consumed = (async () => { for await (const chunk of child.stdout) {
        outputBytes += chunk.byteLength;
        if (!eof)
            outputBeforeEof = true;
        decoder.stdin.write(chunk);
    } decoder.stdin.end(); })();
    try {
        const bytes = new Uint8Array(raw);
        for (let at = 0; at < bytes.length; at += 640) {
            child.stdin.write(bytes.subarray(at, at + 640));
            await Bun.sleep(20);
        }
        for (let n = 0; n < 100 && !outputBeforeEof; n++)
            await Bun.sleep(5);
        eof = true;
        child.stdin.end();
        const [childCode] = await Promise.all([child.exited, consumed]);
        if (childCode !== 0 || await decoder.exited !== 0 || outputBytes !== bytes.length || !outputBeforeEof)
            throw Error('ffmpeg-duplex');
        console.log(JSON.stringify({ passed: true, ffmpegProducer: true, ffmpegConsumer: true, outputBeforeInputEof: outputBeforeEof, rawPcmBytes: outputBytes, playback: false }));
    }
    finally {
        gateway.stop();
        child.kill();
        decoder.kill();
    }
}
if (import.meta.main)
    main().catch(() => { console.error('Synthetic FFmpeg duplex pipe test failed.'); process.exitCode = 1; });
