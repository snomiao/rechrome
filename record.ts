// rech record: record the attached tab to a video file under .rechrome/output, streamed into ffmpeg.
//
// How it works, and why:
// - The extension relay can't open a new CDP session (newCDPSession fails with
//   "Target.attachToBrowserTarget: Unsupported command"), so Page.startScreencast is out. What works
//   over the relay is page.screenshot(), so frames are JPEG screenshots taken in a loop.
// - run-code state does not persist between calls (each call gets a fresh vm context), so the capture
//   loop is owned by serve, not the cliDaemon: serve runs short run-code chunks (~1 s of screenshots
//   each) back to back and pipes every frame straight into ffmpeg's stdin as it arrives. Memory stays
//   at one chunk, so `record start` / `record stop` can run as long as --max-seconds allows.
// - Screenshots arrive at an uneven rate, so the Retimer lays them onto a constant --fps clock by
//   their capture time (repeating the last frame for a slot nothing landed in): the video plays back
//   in real time.
// No click, no new permission, works on a background tab, no audio. Without ffmpeg the frames go to a
// raw MJPEG stream instead.

import { spawnSync } from "child_process";

export const RECORD_DEFAULT_SECONDS = 5;
export const RECORD_MAX_SECONDS = 60;
export const RECORD_DEFAULT_MAX_SECONDS = 600;
export const RECORD_LIMIT_SECONDS = 3600;
export const RECORD_DEFAULT_FPS = 8;
export const RECORD_MAX_FPS = 30;
export const RECORD_DEFAULT_QUALITY = 70;
export const RECORD_CHUNK_MS = 1000;
// Per chunk: bounds one run-code reply even if screenshots are very fast.
export const RECORD_MAX_CHUNK_FRAMES = 60;
export const RECORD_FORMATS = ["mp4", "webm", "mjpeg"] as const;
export type RecordFormat = (typeof RECORD_FORMATS)[number];

export const FFMPEG_CANDIDATES = [process.env.FFMPEG_BIN, "ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].filter((x): x is string => !!x);

export type RecordArgs =
  | { mode: "start"; fps: number; quality: number; format: RecordFormat; maxSeconds: number }
  | { mode: "stop"; filename?: string }
  | { mode: "timed"; seconds: number; fps: number; quality: number; format: RecordFormat; filename?: string };

// The options each form takes; everything else is refused (here and on scoped listeners).
export const RECORD_OPTIONS = {
  start: ["--fps", "--quality", "--format", "--max-seconds"],
  stop: ["--filename"],
  timed: ["--seconds", "--fps", "--quality", "--format", "--filename"],
} as const;

function intOpt(value: string | undefined, name: string, min: number, max: number): number {
  const n = Number(value);
  if (!value || !Number.isInteger(n) || n < min || n > max) throw new Error(`record: ${name} must be an integer ${min}-${max}`);
  return n;
}

/** How long a timed `record --seconds N` holds its request, so the client waits that much longer. */
export function recordHoldMs(args: string[]): number {
  const at = args.findIndex(a => !a.startsWith("-"));
  if (args[at] !== "record") return 0;
  try {
    const parsed = parseRecordArgs(args.slice(at));
    return parsed.mode === "timed" ? parsed.seconds * 1000 : 0;
  } catch { return 0; }
}

/** `name` with the extension of what was actually written: `clip.mp4` saved as mjpeg is `clip.mjpeg`. */
export function withFormatExt(name: string, format: RecordFormat): string {
  const m = /^(.+)\.(mp4|webm|mjpeg|mjpg|mkv|mov|avi)$/i.exec(name);
  if (m && m[2]!.toLowerCase() === format) return name;
  return `${m ? m[1] : name}.${format}`;
}

/** `name`, or `name-2`, `name-3`… before the extension: the first that is not taken. */
export function freeName(name: string, taken: (name: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) if (!taken(`${stem}-${n}${ext}`)) return `${stem}-${n}${ext}`;
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** Parse `record [start|stop] …` client args. */
export function parseRecordArgs(args: string[]): RecordArgs {
  if (args[0] !== "record") throw new Error("Expected `record`");
  const sub = args[1] === "start" || args[1] === "stop" ? args[1] : undefined;
  const mode = sub ?? "timed";
  let seconds = RECORD_DEFAULT_SECONDS, maxSeconds = RECORD_DEFAULT_MAX_SECONDS, fps = RECORD_DEFAULT_FPS, quality = RECORD_DEFAULT_QUALITY;
  let filename: string | undefined, format: RecordFormat = "mp4";
  for (let i = sub ? 2 : 1; i < args.length; i++) {
    const a = args[i]!;
    const flag = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (!(RECORD_OPTIONS[mode] as readonly string[]).includes(flag)) throw new Error(`record${sub ? " " + sub : ""}: unknown option ${a}`);
    const val = (): string | undefined => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++i]);
    if (flag === "--seconds") seconds = intOpt(val(), "--seconds", 1, RECORD_MAX_SECONDS);
    else if (flag === "--max-seconds") maxSeconds = intOpt(val(), "--max-seconds", 1, RECORD_LIMIT_SECONDS);
    else if (flag === "--fps") fps = intOpt(val(), "--fps", 1, RECORD_MAX_FPS);
    else if (flag === "--quality") quality = intOpt(val(), "--quality", 1, 100);
    else if (flag === "--filename") {
      filename = val();
      if (!filename || !SAFE_NAME.test(filename) || filename.includes("..")) throw new Error("record: --filename must be a plain name like clip.mp4 (no path separators)");
    } else if (flag === "--format") {
      const f = val() as RecordFormat;
      if (!RECORD_FORMATS.includes(f)) throw new Error(`record: --format must be one of ${RECORD_FORMATS.join("|")}`);
      format = f;
    }
  }
  if (mode === "start") return { mode, fps, quality, format, maxSeconds };
  if (mode === "stop") return { mode, filename };
  return { mode, seconds, fps, quality, format, filename };
}

/** run-code the cliDaemon executes: screenshot the tab for ~chunkMs, return base64 JPEGs + capture times. */
export function buildCaptureChunkCode(a: { fps: number; quality: number }, chunkMs = RECORD_CHUNK_MS): string {
  return `async page => {
  const endAt = Date.now() + ${chunkMs};
  const interval = Math.max(1, Math.round(1000 / ${a.fps}));
  const frames = [], times = [];
  while (frames.length < ${RECORD_MAX_CHUNK_FRAMES}) {
    const shotAt = Date.now();
    // The sandbox has no Buffer global, but page.screenshot() returns a Buffer whose own
    // .toString("base64") works without it.
    // CSS pixels, not device pixels: a retina tab would otherwise be a 2x-sized video.
    const b = await page.screenshot({ type: "jpeg", quality: ${a.quality}, scale: "css" });
    frames.push(b.toString("base64"));
    times.push(shotAt);
    if (Date.now() >= endAt) break;
    const rest = interval - (Date.now() - shotAt);
    if (rest > 0) await page.waitForTimeout(rest);
  }
  return JSON.stringify({ frames, times });
}`;
}

export type CaptureChunk = { frames: string[]; times: number[] };

/** Lays frames captured at uneven times onto a constant-fps clock: each output slot shows the
 *  newest frame captured before the slot ends, so playback runs in real time. */
export class Retimer {
  private last: Uint8Array | undefined;
  private slot = 0; // output frames written so far
  constructor(private readonly startAt: number, private readonly fps: number, private readonly write: (jpeg: Uint8Array) => void) {}
  private slotOf(t: number): number { return Math.floor(((t - this.startAt) * this.fps) / 1000); }
  /** A frame captured at time t. */
  push(jpeg: Uint8Array, t: number): void {
    const s = this.slotOf(t);
    if (this.last) while (this.slot < s) { this.write(this.last); this.slot++; }
    else this.slot = Math.max(this.slot, s); // nothing to show before the first frame
    this.last = jpeg;
  }
  /** Close the clock at time t: the last frame fills the slots through t (at least one frame). */
  finish(t: number): number {
    if (!this.last) return this.slot;
    const s = Math.max(this.slotOf(t), this.slot + 1);
    while (this.slot < s) { this.write(this.last); this.slot++; }
    return this.slot;
  }
}

type ProbeRun = (bin: string, args: string[]) => { status: number | null };
const defaultProbe: ProbeRun = (bin, args) => spawnSync(bin, args, { stdio: "ignore" });

/** The first ffmpeg binary that answers `-version`, or null if none is installed. */
export function resolveFfmpeg(run: ProbeRun = defaultProbe, candidates: string[] = FFMPEG_CANDIDATES): string | null {
  for (const bin of candidates) {
    try { if (run(bin, ["-version"]).status === 0) return bin; } catch {}
  }
  return null;
}

/** The format actually produced: the request, downgraded to mjpeg when ffmpeg is missing. */
export function resolveFormat(requested: RecordFormat, hasFfmpeg: boolean): RecordFormat {
  return hasFfmpeg ? requested : "mjpeg";
}

/** The ffmpeg argv that reads a JPEG stream on stdin at `fps` and encodes `out`. */
export function ffmpegStreamArgs(fps: number, format: Exclude<RecordFormat, "mjpeg">, out: string): string[] {
  // yuv420p needs even dimensions; screenshots of an odd-sized viewport would make the encoder fail.
  const base = ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p"];
  if (format === "webm") return [...base, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "35", "-deadline", "realtime", "-f", "webm", out];
  return [...base, "-c:v", "libx264", "-preset", "veryfast", "-movflags", "+faststart", "-f", "mp4", out];
}

// error: why capture ended early (the file is still good). encodeError: the file is not usable.
export type RecordingSummary = { frames: number; captured: number; seconds: number; fps: number; format: RecordFormat; out: string; error?: string; encodeError?: string };

/** Where the retimed frames go: ffmpeg's stdin, or a raw MJPEG file. */
export type FrameSink = { write(jpeg: Uint8Array): unknown; close(): Promise<void> }; // write may return a promise: backpressure

/** One recording: runs capture chunks back to back and streams them through the Retimer into the sink. */
export class Recording {
  readonly startAt: number;
  private stopping = false;
  private captured = 0;
  private error: string | undefined;
  private readonly retimer: Retimer;
  private readonly pending: Promise<unknown>[] = [];
  private readonly loop: Promise<void>;
  private summary: Promise<RecordingSummary> | undefined;
  constructor(private readonly opts: {
    fps: number; format: RecordFormat; out: string; maxMs: number;
    capture: () => Promise<CaptureChunk>; sink: FrameSink; now?: () => number;
    onAutoStop?: (s: RecordingSummary) => void;
  }) {
    const now = opts.now ?? Date.now;
    const startAt = this.startAt = now();
    const retimer = this.retimer = new Retimer(startAt, opts.fps, jpeg => { const p = opts.sink.write(jpeg); if (p instanceof Promise) this.pending.push(p); });
    this.loop = (async () => {
      // A failed screenshot (tab closed, session gone) or a dead encoder ends the capture; stop()
      // still closes the file and reports why.
      try {
        while (!this.stopping && now() - startAt < opts.maxMs) {
          const chunk = await opts.capture();
          for (let i = 0; i < chunk.frames.length; i++) {
            if (chunk.times[i]! - startAt > opts.maxMs) break;
            retimer.push(Buffer.from(chunk.frames[i]!, "base64"), chunk.times[i]!);
            this.captured++;
          }
          if (this.pending.length) await Promise.all(this.pending.splice(0)); // backpressure from ffmpeg
        }
      } catch (e) { this.error = e instanceof Error ? e.message : String(e); }
    })();
    // Hit --max-seconds or the tab went away: finish the file on our own; stop() then just reports it.
    this.loop.then(() => { if (!this.stopping) this.stop().then(s => opts.onAutoStop?.(s)); });
  }
  get active(): boolean { return !this.stopping; }
  /** Settles when capturing ends: stopped, --max-seconds reached, or the tab went away. */
  get ended(): Promise<void> { return this.loop; }
  /** Stop capturing, flush the sink, and report what was written. Never rejects; safe to call twice. */
  stop(): Promise<RecordingSummary> {
    if (this.summary) return this.summary;
    this.stopping = true;
    const end = (this.opts.now ?? Date.now)();
    this.summary = (async () => {
      await this.loop;
      let frames = 0, encodeError: string | undefined;
      const why = (e: unknown) => (encodeError ??= e instanceof Error ? e.message : String(e));
      try { frames = this.retimer.finish(Math.min(end, this.startAt + this.opts.maxMs)); await Promise.all(this.pending.splice(0)); } catch (e) { why(e); }
      // Always close, so ffmpeg never lingers; its error (with ffmpeg's own last line) wins.
      try { await this.opts.sink.close(); } catch (e) { encodeError = e instanceof Error ? e.message : String(e); }
      return { frames, captured: this.captured, seconds: frames / this.opts.fps, fps: this.opts.fps, format: this.opts.format, out: this.opts.out, ...(this.error ? { error: this.error } : {}), ...(encodeError ? { encodeError } : {}) };
    })();
    return this.summary;
  }
}

/** ffmpeg reading JPEGs on stdin, or (no ffmpeg) a raw MJPEG file. */
export function recordSink(format: RecordFormat, ffmpegBin: string | null, fps: number, out: string): FrameSink {
  if (format === "mjpeg" || !ffmpegBin) {
    const w = Bun.file(out).writer();
    return { write: jpeg => { w.write(jpeg); }, close: async () => { await w.end(); } };
  }
  const proc = Bun.spawn([ffmpegBin, ...ffmpegStreamArgs(fps, format, out)], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  return {
    write: jpeg => { proc.stdin.write(jpeg); return proc.stdin.flush(); },
    close: async () => {
      await proc.stdin.end();
      const code = await proc.exited;
      if (code !== 0) throw new Error(`record: ffmpeg could not encode ${format} (${(await new Response(proc.stderr).text()).split("\n").filter(Boolean).slice(-1)[0] ?? "exit " + code})`);
    },
  };
}
