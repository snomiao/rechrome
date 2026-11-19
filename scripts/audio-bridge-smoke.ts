/**
 * Isolated browser smoke test. Uses generated tones, a temporary Chromium profile,
 * and muted output; never connects to a user's Chrome, microphone, or daemon.
 *
 * RECH_AUDIO_PLAYWRIGHT: Playwright module path/specifier (for example playwright-core).
 * RECH_AUDIO_CHROME: Chrome for Testing / Chromium executable path.
 * RECH_AUDIO_SMOKE_OUT: artifact parent directory (default /private/tmp/rechrome-audio-smoke).
 * RECH_AUDIO_SMOKE_HTML=1: also test an explicitly played HTML audio element.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installAudioBridge, type AudioBridge, type AudioBridgeDrain } from "../audio-bridge-browser.ts";

const MAX_BYTES = 512 * 1024;
const MAX_WAIT_MS = 15_000;

type ProbeWindow = Window & typeof globalThis & {
  __rechAudioBridge: AudioBridge;
  __smokeReady: Promise<boolean>;
  __smokeProbe: { physicalMicrophones: number; physicalDestinations: number };
};

function ensure(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}

async function bounded<T>(operation: Promise<T>, code: string, milliseconds = MAX_WAIT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(code)), milliseconds);
    })]);
  } finally { clearTimeout(timer!); }
}

/** A small mono PCM16 RIFF fixture, generated rather than recorded. */
function toneWav(frequency: number, seconds = 1.2): Buffer {
  const rate = 16_000, samples = Math.round(seconds * rate);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(0.3 * 32767 * Math.sin(2 * Math.PI * frequency * i / rate)), 44 + i * 2);
  return wav;
}

/** Runs before the SDK so its cached native connect is itself instrumented. */
function installProbe() {
  const page = window as ProbeWindow;
  page.__smokeProbe = { physicalMicrophones: 0, physicalDestinations: 0 };
  if (navigator.mediaDevices) Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
    configurable: true, writable: true,
    value: async () => {
      page.__smokeProbe.physicalMicrophones++;
      throw new DOMException("Physical media is disabled in this synthetic test.", "NotAllowedError");
    },
  });
  for (const key of ["getUserMedia", "webkitGetUserMedia", "mozGetUserMedia"]) {
    if (typeof (navigator as unknown as Record<string, unknown>)[key] === "function") Object.defineProperty(navigator, key, {
      configurable: true, value: (_constraints: unknown, _success: unknown, failure: (error: DOMException) => void) => {
        page.__smokeProbe.physicalMicrophones++;
        failure(new DOMException("Physical media is disabled in this synthetic test.", "NotAllowedError"));
      },
    });
  }
  const original = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
    if (args[0] === this.context.destination && !("startRendering" in this.context)) page.__smokeProbe.physicalDestinations++;
    return Reflect.apply(original, this, args);
  } as AudioNode["connect"];
}

async function main() {
  const modulePath = process.env.RECH_AUDIO_PLAYWRIGHT;
  const executablePath = process.env.RECH_AUDIO_CHROME;
  ensure(modulePath && executablePath, "Set RECH_AUDIO_PLAYWRIGHT and RECH_AUDIO_CHROME explicitly.");
  const artifactDir = join(resolve(process.env.RECH_AUDIO_SMOKE_OUT || "/private/tmp/rechrome-audio-smoke"), `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  const wav = toneWav(440);
  await writeFile(join(artifactDir, "synthetic-440hz.wav"), wav, { flag: "wx", mode: 0o600 });
  const summary: Record<string, unknown> = { synthetic: true, headless: true, muted: true, artifactDir, checks: {} };
  const checks = summary.checks as Record<string, unknown>;
  let step = "load-playwright";
  let browser: any;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const specifier = isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath;
    const { chromium } = await import(specifier);
    ensure(chromium?.launch, "playwright-module");
    step = "start-loopback-fixture";
    server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/tone.wav") return new Response(wav, { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
        if (pathname !== "/" && pathname !== "/html") return new Response("Not found", { status: 404 });
        return new Response("<!doctype html><meta charset=utf-8><title>Synthetic audio bridge fixture</title><p>Generated tones only. No devices.</p>", { headers: { "content-type": "text/html", "cache-control": "no-store" } });
      },
    });
    const origin = `http://127.0.0.1:${server.port}`;
    step = "launch-owned-headless-chromium";
    browser = await chromium.launch({
      executablePath, headless: true, timeout: 20_000,
      args: ["--mute-audio", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--disable-background-networking", "--disable-component-update", "--no-first-run"],
    });
    const context = await browser.newContext({ serviceWorkers: "block" });
    context.setDefaultTimeout(MAX_WAIT_MS);
    // Keep the browser away from all external services, even if a fixture regresses.
    await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.addInitScript({ content: `(${installProbe.toString()})(); window.__smokeReady = Promise.resolve((${installAudioBridge.toString()})(${JSON.stringify({ origin, maxBufferedBytes: MAX_BYTES, maxCaptureMs: 8000, maxQueuedSeconds: 4 })})).then(() => true);` });
    const page = await context.newPage();
    step = "install-before-navigation";
    await page.goto(origin, { waitUntil: "load", timeout: MAX_WAIT_MS });
    ensure(await bounded(page.evaluate(async () => await (window as ProbeWindow).__smokeReady), "install-timeout"), "bridge-install");
    checks.installedBeforeNavigation = true;

    step = "virtual-microphone-record-and-decode";
    const microphone: any = await bounded(page.evaluate(async (input: string) => {
      const page = window as ProbeWindow;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      let total = 0;
      recorder.ondataavailable = event => {
        total += event.data.size;
        if (total > 512 * 1024) { recorder.stop(); return; }
        if (event.data.size) chunks.push(event.data);
      };
      const stopped = new Promise<void>((resolve, reject) => {
        recorder.onstop = () => resolve(); recorder.onerror = () => reject(new Error("virtual-recorder"));
      });
      recorder.start(250);
      await page.__rechAudioBridge.feedWav(input);
      await new Promise(resolve => setTimeout(resolve, 1500));
      if (recorder.state !== "inactive") recorder.stop();
      await stopped;
      stream.getTracks().forEach(track => track.stop());
      const bytes = new Uint8Array(await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer());
      if (bytes.length > 512 * 1024) throw new Error("virtual-bytes");
      const decoded = await new OfflineAudioContext(1, 1, 16_000).decodeAudioData(bytes.slice().buffer);
      let sum = 0;
      const samples = decoded.getChannelData(0);
      for (const sample of samples) sum += sample * sample;
      let binary = "";
      for (let at = 0; at < bytes.length; at += 0x4000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x4000));
      return { rms: Math.sqrt(sum / samples.length), duration: decoded.duration, bytes: bytes.length, chunks: chunks.length, audioTracks: stream.getAudioTracks().length, data: btoa(binary), probe: { ...page.__smokeProbe } };
    }, wav.toString("base64")), "virtual-timeout");
    ensure(microphone.rms > 0.01 && microphone.duration > 0.5 && microphone.duration < 4, "virtual-microphone-silent");
    ensure(microphone.audioTracks === 1, "virtual-microphone-tracks");
    ensure(microphone.probe.physicalMicrophones === 0 && microphone.probe.physicalDestinations === 0, "virtual-physical-device");
    await writeFile(join(artifactDir, "virtual-microphone.webm"), Buffer.from(microphone.data, "base64"), { flag: "wx", mode: 0o600 });
    const { data: _microphoneData, ...microphoneMetrics } = microphone;
    checks.virtualMicrophone = microphoneMetrics;

    step = "downstream-capture-stop-and-final-drain";
    const downstream: any = await bounded(page.evaluate(async () => {
      const page = window as ProbeWindow;
      await page.__rechAudioBridge.startCapture();
      const audio = new AudioContext();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.frequency.value = 880; gain.gain.value = 0.2;
      oscillator.connect(gain); gain.connect(audio.destination);
      await audio.resume(); oscillator.start();
      await new Promise(resolve => setTimeout(resolve, 1200));
      oscillator.stop();
      const stopped = await page.__rechAudioBridge.stop();
      const drained = await page.__rechAudioBridge.drain();
      const second = await page.__rechAudioBridge.drain();
      let stoppedGumRejected = false;
      try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(track => track.stop()); }
      catch { stoppedGumRejected = true; }
      const metrics = [];
      for (const stream of drained.streams) {
        const parts = stream.chunks.map(chunk => Uint8Array.from(atob(chunk), character => character.charCodeAt(0)));
        const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
        if (bytes.length > 512 * 1024) throw new Error("downstream-bytes");
        let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
        if (!bytes.length) continue;
        const byteLength = bytes.length;
        const decoded = await new OfflineAudioContext(1, 1, 16_000).decodeAudioData(bytes.buffer);
        let sum = 0;
        const samples = decoded.getChannelData(0);
        for (const sample of samples) sum += sample * sample;
        metrics.push({ id: stream.id, final: stream.final, chunks: stream.chunks.length, bytes: byteLength, duration: decoded.duration, rms: Math.sqrt(sum / samples.length) });
      }
      await audio.close();
      return { stopped, drained, secondStreamCount: second.streams.length, stoppedGumRejected, metrics, probe: { ...page.__smokeProbe } };
    }), "downstream-timeout");
    ensure(downstream.stopped.phase === "stopped", "capture-stop-phase");
    ensure(downstream.metrics.length > 0 && downstream.metrics.some((stream: any) => stream.rms > 0.01), "downstream-silent");
    ensure(downstream.drained.droppedBytes === 0 && downstream.drained.streams.length <= 16, "capture-overflow");
    ensure(downstream.drained.streams.every((stream: any) => stream.final), "capture-final-marker");
    ensure(downstream.secondStreamCount === 0, "capture-drain-not-once");
    ensure(downstream.stoppedGumRejected, "stopped-gum-fallback");
    ensure(downstream.probe.physicalMicrophones === 0 && downstream.probe.physicalDestinations === 0, "downstream-physical-device");
    for (const [index, stream] of (downstream.drained as AudioBridgeDrain).streams.entries()) {
      const bytes = Buffer.concat(stream.chunks.map(chunk => Buffer.from(chunk, "base64")));
      if (bytes.length) await writeFile(join(artifactDir, `downstream-${index + 1}.webm`), bytes, { flag: "wx", mode: 0o600 });
    }
    const { drained: _drainData, ...downstreamMetrics } = downstream;
    checks.downstreamCapture = downstreamMetrics;
    checks.htmlMediaElement = { tested: false, reason: "Set RECH_AUDIO_SMOKE_HTML=1 for the optional explicit-play test." };

    if (process.env.RECH_AUDIO_SMOKE_HTML === "1") {
      step = "html-media-element-explicit-play";
      const htmlPage = await context.newPage();
      await htmlPage.goto(`${origin}/html`, { waitUntil: "load", timeout: MAX_WAIT_MS });
      const html: any = await bounded(htmlPage.evaluate(async () => {
        const page = window as ProbeWindow;
        await page.__smokeReady;
        await page.__rechAudioBridge.startCapture();
        const element = new Audio("/tone.wav");
        document.body.append(element);
        await element.play();
        await new Promise(resolve => setTimeout(resolve, 1500));
        const stopped = await page.__rechAudioBridge.stop();
        element.pause();
        const drained = await page.__rechAudioBridge.drain();
        let maximumRms = 0;
        for (const stream of drained.streams) {
          const parts = stream.chunks.map(chunk => Uint8Array.from(atob(chunk), character => character.charCodeAt(0)));
          const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
          if (bytes.length > 512 * 1024) throw new Error("html-bytes");
          let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
          if (!bytes.length) continue;
          const decoded = await new OfflineAudioContext(1, 1, 16_000).decodeAudioData(bytes.buffer);
          const samples = decoded.getChannelData(0);
          let sum = 0; for (const sample of samples) sum += sample * sample;
          maximumRms = Math.max(maximumRms, Math.sqrt(sum / samples.length));
        }
        return { tested: true, maximumRms, stopped: stopped.phase, actuallyMutedAfterStop: element.muted, probe: { ...page.__smokeProbe } };
      }), "html-timeout");
      ensure(html.maximumRms > 0.01 && html.stopped === "stopped" && html.actuallyMutedAfterStop, "html-silent-or-unmuted");
      ensure(html.probe.physicalMicrophones === 0 && html.probe.physicalDestinations === 0, "html-physical-device");
      checks.htmlMediaElement = html;
      await htmlPage.close();
    }
    summary.passed = true;
    step = "done";
  } catch (error) {
    summary.passed = false;
    summary.failureStep = step;
    // Keep arbitrary browser errors and evaluated source (possibly containing binary data) off stdout.
    summary.failure = error instanceof Error && /^[a-z][a-z-]{1,100}$/.test(error.message) ? error.message : "browser-or-environment-error";
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.stop(true);
    await writeFile(join(artifactDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify(summary, null, 2));
  }
}

if (import.meta.main) main().catch(() => {
  console.error("Synthetic audio smoke could not initialize; check its explicit environment paths and output directory.");
  process.exitCode = 1;
});
