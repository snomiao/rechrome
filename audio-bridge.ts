import { installAudioBridge } from "./audio-bridge-browser.ts";

export const AUDIO_DEFAULT_SECONDS = 60;
export const AUDIO_MAX_SECONDS = 60;
export const AUDIO_MAX_WAV_BYTES = 2 * 1024 * 1024;
export const AUDIO_MAX_DRAIN_BYTES = 2 * 1024 * 1024;
export const AUDIO_MAX_QUEUED_SECONDS = 30;
export const AUDIO_MAX_STREAMS = 16;
export const AUDIO_UNSUPPORTED_CODES = [
  "existing-graph",
  "html-autoplay",
  "html-media-element",
  "media-devices",
  "audio-node",
  "audio-context",
  "drm-media-element",
  "media-recorder",
  "recorder-timeout",
  "buffer-overflow",
  "connection-overflow",
  "capture-data",
  "track-overflow",
  "input-overflow",
] as const;
export const AUDIO_MAX_RESULT_BYTES = Math.ceil(AUDIO_MAX_DRAIN_BYTES / 3) * 4 + 128 * 1024;
export const AUDIO_USAGE = `Usage: rech audio install <url> [--capture] [--max-seconds 1..60]
       rech audio status
       rech audio feed <wav-file>
       rech audio capture start
       rech audio drain --dir <client-dir>
       rech audio stop [--dir <client-dir>]
       rech audio stream --source <id> --destination <id> [--rate 16000|48000] [--channels 1|2]
       rech audio stream ticket --source <id> --destination <id> --client-origin <origin> --ticket-file <path>
       rech audio stream stop
  Stream stdin/stdout are raw negotiated PCM16, metadata is on stderr. EOF closes only input.
  Files and directories stay on this client. Feed accepts at most 2 MiB of PCM16/float32 WAV,
  mono/stereo at 8–96 kHz, at most 30 seconds. Capture is opt-in and limited to 60 seconds.`;

export class AudioBridgeError extends Error {
  constructor(public readonly code: "args" | "upload" | "wav" | "result" | "bridge") {
    super(
      `audio bridge: ${code === "args" ? "invalid arguments" : code === "upload" ? "invalid audio upload" : code === "wav" ? "invalid PCM WAV" : code === "result" ? "invalid browser result" : "browser action failed"}`,
    );
  }
}
export interface AudioInstall {
  action: "install";
  url: string;
  capture: boolean;
  maxSeconds: number;
}
export type AudioAction = "status" | "feed" | "capture-start" | "drain" | "stop";
export type AudioWire = AudioInstall | { action: AudioAction };
export type AudioArgs =
  | AudioInstall
  | { action: "status" | "capture-start" }
  | { action: "feed"; file: string }
  | { action: "drain"; dir: string }
  | { action: "stop"; dir?: string };
export interface AudioUpload {
  name: "input.wav";
  contentType: "audio/wav";
  data: string;
}
export interface AudioWavInfo {
  format: 1 | 3;
  channels: 1 | 2;
  sampleRate: number;
  frames: number;
  durationSeconds: number;
  dataOffset: number;
  dataBytes: number;
}
export interface AudioStatus {
  id: string;
  phase: "ready" | "capturing" | "stopped" | "failed";
  bufferedBytes: number;
  droppedBytes: number;
  streamCount: number;
  queuedSeconds: number;
  unsupported: string[];
}
export interface AudioDrainStream {
  id: string;
  mimeType: "audio/webm" | "audio/webm;codecs=opus";
  seq: number;
  chunks: string[];
  final: boolean;
}
export interface AudioDrain extends AudioStatus {
  streams: AudioDrainStream[];
  receipt?: string;
}
const bridgeId = /^b-[a-f0-9]{32}$/;
const streamId = /^s-[1-9][0-9]{0,8}$/;
const receiptId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

export function audioInstallUrl(raw: string): URL {
  if (
    typeof raw !== "string" ||
    !raw ||
    raw.length > 8192 ||
    raw !== raw.trim() ||
    /[\x00-\x20\x7f]/.test(raw)
  )
    throw new AudioBridgeError("args");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AudioBridgeError("args");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    (/^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname) &&
      url.hostname.split(".").every((n) => Number(n) <= 255));
  if (
    url.username ||
    url.password ||
    !url.hostname ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
  )
    throw new AudioBridgeError("args");
  return url;
}
function localPath(value: string | undefined): string {
  if (!value || value.startsWith("-") || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))
    throw new AudioBridgeError("args");
  return value;
}
function checkArgs(args: string[]): void {
  if (
    !Array.isArray(args) ||
    args.length > 12 ||
    args.some((a) => typeof a !== "string" || a.length > 8192) ||
    args[0] !== "audio"
  )
    throw new AudioBridgeError("args");
}
function installArgs(args: string[]): AudioInstall {
  const url = audioInstallUrl(args[2] ?? "").href;
  let capture = false,
    maxSeconds = AUDIO_DEFAULT_SECONDS;
  const seen = new Set<string>();
  for (let i = 3; i < args.length; i++) {
    const token = args[i]!,
      equals = token.indexOf("="),
      flag = equals < 0 ? token : token.slice(0, equals);
    if (seen.has(flag)) throw new AudioBridgeError("args");
    seen.add(flag);
    if (flag === "--capture" && equals < 0) capture = true;
    else if (flag === "--max-seconds") {
      const raw = equals < 0 ? args[++i] : token.slice(equals + 1);
      if (
        !raw ||
        !/^[0-9]+$/.test(raw) ||
        !integer(Number(raw), AUDIO_MAX_SECONDS) ||
        Number(raw) < 1
      )
        throw new AudioBridgeError("args");
      maxSeconds = Number(raw);
    } else throw new AudioBridgeError("args");
  }
  return { action: "install", url, capture, maxSeconds };
}
function directoryArgs(args: string[], optional: boolean): string | undefined {
  if (optional && args.length === 2) return;
  if (args.length === 4 && args[2] === "--dir") return localPath(args[3]);
  if (args.length === 3 && args[2]!.startsWith("--dir=")) return localPath(args[2]!.slice(6));
  throw new AudioBridgeError("args");
}
export function parseAudioArgs(args: string[]): AudioArgs {
  checkArgs(args);
  if (args[1] === "install") return installArgs(args);
  if (args[1] === "status" && args.length === 2) return { action: "status" };
  if (args[1] === "feed" && args.length === 3) return { action: "feed", file: localPath(args[2]) };
  if (args[1] === "capture" && args[2] === "start" && args.length === 3)
    return { action: "capture-start" };
  if (args[1] === "drain") return { action: "drain", dir: directoryArgs(args, false)! };
  if (args[1] === "stop") {
    const dir = directoryArgs(args, true);
    return { action: "stop", ...(dir ? { dir } : {}) };
  }
  throw new AudioBridgeError("args");
}
/** Only these path-free arguments are allowed to cross to the daemon. */
export function audioWireArgs(command: AudioArgs | AudioWire): string[] {
  if (command.action === "install") {
    const install = parseAudioArgs([
      "audio",
      "install",
      command.url,
      ...(command.capture ? ["--capture"] : []),
      `--max-seconds=${command.maxSeconds}`,
    ]) as AudioInstall;
    return [
      "audio",
      "install",
      install.url,
      ...(install.capture ? ["--capture"] : []),
      `--max-seconds=${install.maxSeconds}`,
    ];
  }
  if (command.action === "capture-start") return ["audio", "capture", "start"];
  if (["status", "feed", "drain", "stop"].includes(command.action))
    return ["audio", command.action];
  throw new AudioBridgeError("args");
}
export function parseAudioWire(args: string[]): AudioWire {
  checkArgs(args);
  if (args[1] === "install") return installArgs(args);
  if (["status", "feed", "drain", "stop"].includes(args[1] ?? "") && args.length === 2)
    return { action: args[1] as AudioAction };
  if (args[1] === "capture" && args[2] === "start" && args.length === 3)
    return { action: "capture-start" };
  throw new AudioBridgeError("args");
}

function base64(raw: unknown, maximum: number, kind: "upload" | "result"): Buffer {
  if (
    typeof raw !== "string" ||
    !raw.length ||
    raw.length % 4 !== 0 ||
    raw.length > Math.ceil(maximum / 3) * 4
  )
    throw new AudioBridgeError(kind);
  const decoded = Buffer.from(raw, "base64");
  if (!decoded.length || decoded.length > maximum || decoded.toString("base64") !== raw)
    throw new AudioBridgeError(kind);
  return decoded;
}
/** Strict RIFF bounds and format checks before any bytes reach browser code. */
export function validatePcmWav(bytes: Uint8Array): AudioWavInfo {
  if (!(bytes instanceof Uint8Array) || bytes.length < 44 || bytes.length > AUDIO_MAX_WAV_BYTES)
    throw new AudioBridgeError("wav");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) =>
    String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || view.getUint32(4, true) !== bytes.length - 8)
    throw new AudioBridgeError("wav");
  let fmt: { format: 1 | 3; channels: 1 | 2; sampleRate: number; align: number } | undefined,
    dataOffset = -1,
    dataBytes = 0;
  for (let at = 12; at < bytes.length; ) {
    if (at + 8 > bytes.length) throw new AudioBridgeError("wav");
    const id = tag(at),
      length = view.getUint32(at + 4, true),
      from = at + 8,
      end = from + length,
      padded = end + (length % 2);
    if (end > bytes.length || padded > bytes.length) throw new AudioBridgeError("wav");
    if (id === "fmt ") {
      if (fmt || ![16, 18].includes(length)) throw new AudioBridgeError("wav");
      const format = view.getUint16(from, true),
        channels = view.getUint16(from + 2, true),
        sampleRate = view.getUint32(from + 4, true),
        rate = view.getUint32(from + 8, true),
        align = view.getUint16(from + 12, true),
        bits = view.getUint16(from + 14, true);
      if (
        ![1, 3].includes(format) ||
        ![1, 2].includes(channels) ||
        sampleRate < 8000 ||
        sampleRate > 96000 ||
        bits !== (format === 1 ? 16 : 32) ||
        align !== (channels * bits) / 8 ||
        rate !== sampleRate * align ||
        (length === 18 && view.getUint16(from + 16, true) !== 0)
      )
        throw new AudioBridgeError("wav");
      fmt = { format: format as 1 | 3, channels: channels as 1 | 2, sampleRate, align };
    } else if (id === "data") {
      if (!fmt || dataOffset !== -1 || !length || length % fmt.align !== 0)
        throw new AudioBridgeError("wav");
      dataOffset = from;
      dataBytes = length;
    }
    at = padded;
  }
  if (!fmt || dataOffset < 0) throw new AudioBridgeError("wav");
  const frames = dataBytes / fmt.align;
  if (frames > fmt.sampleRate * AUDIO_MAX_QUEUED_SECONDS) throw new AudioBridgeError("wav");
  if (fmt.format === 3)
    for (let at = dataOffset; at < dataOffset + dataBytes; at += 4)
      if (!Number.isFinite(view.getFloat32(at, true))) throw new AudioBridgeError("wav");
  return {
    format: fmt.format,
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    frames,
    durationSeconds: frames / fmt.sampleRate,
    dataOffset,
    dataBytes,
  };
}
export function validateAudioUpload(value: unknown): AudioUpload {
  if (
    !object(value) ||
    !onlyKeys(value, ["name", "contentType", "data"]) ||
    value.name !== "input.wav" ||
    value.contentType !== "audio/wav"
  )
    throw new AudioBridgeError("upload");
  const bytes = base64(value.data, AUDIO_MAX_WAV_BYTES, "upload");
  validatePcmWav(bytes);
  return { name: "input.wav", contentType: "audio/wav", data: value.data as string };
}

const statusKeys = [
  "id",
  "phase",
  "bufferedBytes",
  "droppedBytes",
  "streamCount",
  "queuedSeconds",
  "unsupported",
];
export function validateAudioStatus(value: unknown): AudioStatus {
  if (
    !object(value) ||
    !onlyKeys(value, statusKeys) ||
    typeof value.id !== "string" ||
    !bridgeId.test(value.id) ||
    !["ready", "capturing", "stopped", "failed"].includes(value.phase as string) ||
    !integer(value.bufferedBytes, AUDIO_MAX_DRAIN_BYTES) ||
    !integer(value.droppedBytes) ||
    !integer(value.streamCount, AUDIO_MAX_STREAMS) ||
    typeof value.queuedSeconds !== "number" ||
    !Number.isFinite(value.queuedSeconds) ||
    value.queuedSeconds < 0 ||
    value.queuedSeconds > AUDIO_MAX_QUEUED_SECONDS ||
    !Array.isArray(value.unsupported) ||
    value.unsupported.length > AUDIO_UNSUPPORTED_CODES.length ||
    value.unsupported.some(
      (code) => !(AUDIO_UNSUPPORTED_CODES as readonly unknown[]).includes(code),
    )
  )
    throw new AudioBridgeError("result");
  return {
    id: value.id,
    phase: value.phase as AudioStatus["phase"],
    bufferedBytes: value.bufferedBytes,
    droppedBytes: value.droppedBytes,
    streamCount: value.streamCount,
    queuedSeconds: value.queuedSeconds,
    unsupported: [...value.unsupported],
  };
}
export function validateAudioDrain(value: unknown): AudioDrain {
  if (
    !object(value) ||
    !onlyKeys(value, [...statusKeys, "streams", "receipt"]) ||
    !Array.isArray(value.streams) ||
    value.streams.length > AUDIO_MAX_STREAMS ||
    (value.receipt !== undefined &&
      (typeof value.receipt !== "string" || !receiptId.test(value.receipt)))
  )
    throw new AudioBridgeError("result");
  const { streams: rawStreams, receipt, ...rawStatus } = value;
  const status = validateAudioStatus(rawStatus);
  let total = 0;
  const ids = new Set<string>();
  const streams: AudioDrainStream[] = (rawStreams as unknown[]).map((stream) => {
    if (
      !object(stream) ||
      !onlyKeys(stream, ["id", "mimeType", "seq", "chunks", "final"]) ||
      typeof stream.id !== "string" ||
      !streamId.test(stream.id) ||
      ids.has(stream.id) ||
      !integer(stream.seq) ||
      typeof stream.final !== "boolean" ||
      !Array.isArray(stream.chunks) ||
      stream.chunks.length > 4096 ||
      typeof stream.mimeType !== "string" ||
      !/^audio\/webm(?:;\s*codecs=(?:opus|"opus"))?$/i.test(stream.mimeType)
    )
      throw new AudioBridgeError("result");
    ids.add(stream.id);
    const chunks = stream.chunks.map((chunk) => {
      const bytes = base64(chunk, AUDIO_MAX_DRAIN_BYTES - total, "result");
      total += bytes.length;
      return chunk as string;
    });
    return {
      id: stream.id,
      mimeType: stream.mimeType.includes(";") ? "audio/webm;codecs=opus" : "audio/webm",
      seq: stream.seq,
      chunks,
      final: stream.final,
    };
  });
  return { ...status, streams, ...(receipt !== undefined ? { receipt: receipt as string } : {}) };
}
/** Supports JSON and legacy run-code wrappers; errors contain no page output excerpts. */
export function parseAudioResult(text: string, isError = false): AudioStatus | AudioDrain {
  if (isError) throw new AudioBridgeError("bridge");
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > AUDIO_MAX_RESULT_BYTES)
    throw new AudioBridgeError("result");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    if ([...text.matchAll(/(?:^|\n)### Result\r?\n/g)].length !== 1)
      throw new AudioBridgeError("result");
    const result = /(?:^|\n)### Result\r?\n([\s\S]*?)(?=\r?\n### |$)/.exec(text)?.[1];
    if (!result) throw new AudioBridgeError("result");
    try {
      raw = JSON.parse(result.trim());
    } catch {
      throw new AudioBridgeError("result");
    }
  }
  for (let depth = 0; depth < 4; depth++) {
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
        continue;
      } catch {
        throw new AudioBridgeError("result");
      }
    }
    if (!object(raw) || raw.isError || Object.hasOwn(raw, "error"))
      throw new AudioBridgeError("result");
    if (Object.hasOwn(raw, "result")) {
      raw = raw.result;
      continue;
    }
    return Object.hasOwn(raw, "streams") ? validateAudioDrain(raw) : validateAudioStatus(raw);
  }
  throw new AudioBridgeError("result");
}

export function buildAudioInstallCode(options: AudioInstall): string {
  const url = audioInstallUrl(options.url);
  if (
    typeof options.capture !== "boolean" ||
    !integer(options.maxSeconds, AUDIO_MAX_SECONDS) ||
    options.maxSeconds < 1
  )
    throw new AudioBridgeError("args");
  const config = {
    origin: url.origin,
    maxBufferedBytes: AUDIO_MAX_DRAIN_BYTES,
    maxCaptureMs: options.maxSeconds * 1000,
    maxQueuedSeconds: AUDIO_MAX_QUEUED_SECONDS,
  };
  const content = `if (location.origin === ${JSON.stringify(url.origin)}) { window.__rechAudioBridgeReady = Promise.resolve((${installAudioBridge.toString()})(${JSON.stringify(config)})).then(() => true, () => false); }`;
  return `async page => {
    await page.addInitScript({ content: ${JSON.stringify(content)} });
    await page.goto(${JSON.stringify(url.href)});
    return JSON.stringify(await page.evaluate(async ({ origin, capture }) => {
      if (location.origin !== origin || await window.__rechAudioBridgeReady !== true) throw new Error("audio bridge unavailable");
      const bridge = window.__rechAudioBridge;
      if (!bridge) throw new Error("audio bridge unavailable");
      if (capture) await bridge.startCapture();
      return bridge.status();
    }, ${JSON.stringify({ origin: url.origin, capture: options.capture })}));
  }`;
}
export function buildAudioActionCode(
  action: AudioAction,
  payload?: unknown,
  expectedId?: string,
  expectedOrigin?: string,
): string {
  if (
    !["status", "feed", "capture-start", "drain", "stop"].includes(action) ||
    (expectedId !== undefined && !bridgeId.test(expectedId))
  )
    throw new AudioBridgeError("args");
  const upload = action === "feed" ? validateAudioUpload(payload) : undefined;
  if (action !== "feed" && payload !== undefined) throw new AudioBridgeError("upload");
  if (expectedOrigin !== undefined && audioInstallUrl(expectedOrigin).origin !== expectedOrigin)
    throw new AudioBridgeError("args");
  return `async page => JSON.stringify(await page.evaluate(async ({ action, data, expectedId, expectedOrigin }) => {
    const bridge = window.__rechAudioBridge;
    if (!bridge || (expectedOrigin && location.origin !== expectedOrigin) || (expectedId && bridge.status().id !== expectedId)) throw new Error("audio bridge unavailable");
    if (action === "status") return bridge.status();
    if (action === "feed") return await bridge.feedWav(data);
    if (action === "capture-start") return await bridge.startCapture();
    if (action === "drain") return await bridge.drain();
    if (action === "stop") return await bridge.stop();
    throw new Error("audio bridge unavailable");
  }, ${JSON.stringify({ action, ...(upload ? { data: upload.data } : {}), ...(expectedId ? { expectedId } : {}), ...(expectedOrigin ? { expectedOrigin } : {}) })}))`;
}
