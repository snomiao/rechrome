/** Generated PCM only, owned muted headless browser, no microphone/speaker devices or external services. */
import { createPcmGateway, buildPcmRelayCode } from '../audio-stream-server.ts';
import { connectPcmStream } from '../audio-stream-client.ts';
import { streamOptions } from '../audio-stream.ts';
import { buildAudioInstallCode } from '../audio-bridge.ts';
import { runInNewContext } from 'node:vm';
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
function ensure(value: unknown, message: string): asserts value {
    if (!value)
        throw Error(message);
}
export async function smoke() {
    const module = process.env.RECH_AUDIO_PLAYWRIGHT, executablePath = process.env.RECH_AUDIO_CHROME;
    ensure(module && executablePath, 'explicit-browser-paths-required');
    const { chromium } = await import(module);
    const browser = await chromium.launch({ executablePath, headless: true, args: ['--mute-audio', '--use-fake-device-for-media-stream', '--disable-background-networking', '--autoplay-policy=no-user-gesture-required'] });
    const fixture = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<!doctype html><title>PCM fixture</title>', { headers: { 'content-type': 'text/html' } }) });
    const origin = `http://127.0.0.1:${fixture.port}`;
    const options = streamOptions(['audio', 'stream', 'open', '--source', 'synthetic-input', '--destination', 'synthetic-browser', '--max-seconds', '8']);
    let gateway: ReturnType<typeof createPcmGateway> | undefined, connection: Awaited<ReturnType<typeof connectPcmStream>> | undefined;
    let relayDone = false;
    try {
        const context = await browser.newContext();
        await context.route('**/*', (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        await context.addInitScript(() => {
            (window as any).__probe = { physicalMic: 0, physicalOutput: 0 };
            Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, writable: true, value: async () => { (window as any).__probe.physicalMic++; throw Error('physical mic disabled'); } });
            const connect = AudioNode.prototype.connect;
            AudioNode.prototype.connect = function (this: AudioNode, ...args: any[]) {
                if (args[0] === this.context.destination)
                    (window as any).__probe.physicalOutput++;
                return Reflect.apply(connect, this, args);
            } as any;
        });
        const page = await context.newPage();
        const install = runInNewContext('(' + buildAudioInstallCode({ action: 'install', url: origin, capture: false, maxSeconds: 8 }) + ')', {});
        const status = JSON.parse(await install(page));
        gateway = createPcmGateway(options, async (url, key) => {
            try {
                const fn = runInNewContext('(' + buildPcmRelayCode(url, key, status.id, origin, options) + ')', {});
                await fn(page);
            }
            finally {
                relayDone = true;
            }
        });
        let count = 0, inputEof = false, outputBeforeEof = false, outputRms = 0;
        connection = await connectPcmStream(gateway.ticket, async (bytes) => {
            count++;
            if (!inputEof)
                outputBeforeEof = true;
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            let sum = 0;
            for (let n = 0; n < bytes.length; n += 2)
                sum += (view.getInt16(n, true) / 32768) ** 2;
            outputRms = Math.max(outputRms, Math.sqrt(sum / (bytes.length / 2)));
        });
        await page.evaluate(async () => {
            const audio = new AudioContext();
            const oscillator = audio.createOscillator();
            oscillator.frequency.value = 880;
            const gain = audio.createGain();
            gain.gain.value = .2;
            oscillator.connect(gain);
            gain.connect(audio.destination);
            await audio.resume();
            oscillator.start();
            const virtual = await navigator.mediaDevices.getUserMedia({ audio: true });
            const source = audio.createMediaStreamSource(virtual), analyser = audio.createAnalyser();
            source.connect(analyser);
            analyser.connect(audio.createMediaStreamDestination());
            (window as any).__fixture = { audio, oscillator, analyser };
        });
        let micRms = 0;
        for (let n = 0; n < 35; n++) {
            const frame = Buffer.alloc(gateway.ticket.maxFrameBytes);
            for (let k = 0; k < 320; k++)
                frame.writeInt16LE(Math.round(Math.sin((n * 320 + k) * 2 * Math.PI * 440 / 16000) * 6000), k * 2);
            await connection.write(frame);
            await wait(20);
            if (n === 25)
                micRms = await page.evaluate(() => { const analyser = (window as any).__fixture.analyser; const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples); return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length); });
        }
        ensure(outputBeforeEof && count > 0 && outputRms > .01, 'output-before-eof');
        ensure(micRms > .01, 'virtual-input-nonsilent');
        inputEof = true;
        await connection.endInput();
        const before = count;
        await wait(150);
        ensure(count > before, 'half-close-keeps-output');
        const beforeNavigation = await page.evaluate(() => (window as any).__probe);
        ensure(beforeNavigation.physicalMic === 0 && beforeNavigation.physicalOutput === 0, 'physical-device-before-navigation');
        // Navigation must terminate the stream rather than feeding another document.
        await page.goto(origin + '/navigated');
        const reason = await Promise.race([connection.done, wait(4000).then(() => { throw Error('navigation-cleanup-timeout'); })]);
        for (let n = 0; n < 100 && !relayDone; n++)
            await wait(10);
        ensure(relayDone, 'relay-cleanup');
        const probe = await page.evaluate(() => (window as any).__probe);
        ensure(probe.physicalMic === 0 && probe.physicalOutput === 0, 'physical-device');
        return { passed: true, outputBeforeInputEof: outputBeforeEof, outputFrames: count, outputRms, virtualMicRms: micRms, halfCloseOutputFrames: count - before, navigationReason: reason, rendererReleased: relayDone, physicalMicRequests: beforeNavigation.physicalMic + probe.physicalMic, physicalOutputConnections: beforeNavigation.physicalOutput + probe.physicalOutput, muted: true };
    }
    finally {
        connection?.cancel();
        gateway?.stop();
        await browser.close();
        fixture.stop(true);
    }
}
if (import.meta.main)
    smoke().then(result => console.log(JSON.stringify(result, null, 2))).catch(() => { console.error('Synthetic PCM duplex smoke failed; no page/audio excerpts logged.'); process.exitCode = 1; });
