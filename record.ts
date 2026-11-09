// rech record: record the attached tab to a video file under .rechrome/output.
//
// Design note — why a single timed call, not open-ended start/stop:
// The extension relay does not support opening a new CDP session (newCDPSession fails with
// "Target.attachToBrowserTarget: Unsupported command"), so CDP Page.startScreencast is unavailable
// through it. And each run-code call on the cliDaemon runs in a FRESH context — globalThis does not
// persist between calls — so a start/stop pair cannot share a frame buffer. Both were verified on real
// Chrome (sym003). What DOES work over the relay is `page.screenshot()`, so record captures a window
// of JPEG frames by polling screenshots inside ONE run-code call (`--seconds N` at `--fps`), then serve
// assembles them (mp4 via ffmpeg; webm; or a raw MJPEG stream when ffmpeg is absent). No click, no new
// permission, background tabs fine, no audio. Open-ended start/stop can come later if serve itself runs
// the capture loop (it would hold the frames, not the cliDaemon).

import { spawnSync } from "child_process";

export const RECORD_USAGE = `Usage:
  rech record [--seconds <n>] [--fps <n>] [--quality <1-100>] [--filename <name>] [--format mp4|webm|mjpeg]
  Records the active tab for <n> seconds by polling page screenshots (default ${"5"}s), then writes a
  video to .rechrome/output, deleted on this host after the client fetches it (unless the listener keeps
  downloads). No click, no new permission, works on a background tab, no audio. mp4/webm need ffmpeg;
  without it the video falls back to a raw MJPEG stream. Effective fps is capped by screenshot latency
  over the bridge (typically ~5-8).`;

export const RECORD_DEFAULT_SECONDS = 5;
export const RECORD_MAX_SECONDS = 60;
export const RECORD_DEFAULT_FPS = 8;
export const RECORD_MAX_FPS = 30;
export const RECORD_DEFAULT_QUALITY = 70;
// A hard cap so a long/fast request can't blow up memory or the socket payload.
export const RECORD_MAX_FRAMES = 1200;
export const RECORD_FORMATS = ["mp4", "webm", "mjpeg"] as const;
export type RecordFormat = (typeof RECORD_FORMATS)[number];

export const FFMPEG_CANDIDATES = [process.env.FFMPEG_BIN, "ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].filter((x): x is string => !!x);

export type RecordArgs = { seconds: number; fps: number; quality: number; filename?: string; format: RecordFormat };

function intOpt(value: string | undefined, name: string, min: number, max: number): number {
  const n = Number(value);
  if (!value || !Number.isInteger(n) || n < min || n > max) throw new Error(`record: ${name} must be an integer ${min}-${max}`);
  return n;
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** Parse `record …` client args (single timed capture). */
export function parseRecordArgs(args: string[]): RecordArgs {
  if (args[0] !== "record") throw new Error("Expected `record`");
  let seconds = RECORD_DEFAULT_SECONDS, fps = RECORD_DEFAULT_FPS, quality = RECORD_DEFAULT_QUALITY, filename: string | undefined, format: RecordFormat = "mp4";
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    const val = (): string | undefined => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++i]);
    if (a.startsWith("--seconds")) seconds = intOpt(val(), "--seconds", 1, RECORD_MAX_SECONDS);
    else if (a.startsWith("--fps")) fps = intOpt(val(), "--fps", 1, RECORD_MAX_FPS);
    else if (a.startsWith("--quality")) quality = intOpt(val(), "--quality", 1, 100);
    else if (a.startsWith("--filename")) {
      filename = val();
      if (!filename || !SAFE_NAME.test(filename) || filename.includes("..")) throw new Error("record: --filename must be a plain name like clip.mp4 (no path separators)");
    } else if (a.startsWith("--format")) {
      const f = val() as RecordFormat;
      if (!RECORD_FORMATS.includes(f)) throw new Error(`record: --format must be one of ${RECORD_FORMATS.join("|")}`);
      format = f;
    } else throw new Error(`record: unknown option ${a}`);
  }
  return { seconds, fps, quality, filename, format };
}

/** Wire args round-trip (serve re-parses the same flags; keeps a stable order). */
export function recordWireArgs(a: RecordArgs): string[] {
  return ["record", `--seconds=${a.seconds}`, `--fps=${a.fps}`, `--quality=${a.quality}`, `--format=${a.format}`, ...(a.filename ? [`--filename=${a.filename}`] : [])];
}

/** run-code the cliDaemon executes: poll page.screenshot() for the window, return base64 JPEG frames. */
export function buildRecordCode(a: RecordArgs): string {
  return `async page => {
  const endAt = Date.now() + ${a.seconds} * 1000;
  const interval = Math.max(1, Math.round(1000 / ${a.fps}));
  const frames = [], offsets = [], t0 = Date.now();
  while (Date.now() < endAt && frames.length < ${RECORD_MAX_FRAMES}) {
    const shotAt = Date.now();
    let b;
    try { b = await page.screenshot({ type: "jpeg", quality: ${a.quality} }); }
    catch (e) { if (!frames.length) throw new Error("record: could not screenshot the tab (" + (e && e.message || e) + ")"); break; }
    frames.push(Buffer.from(b).toString("base64"));
    offsets.push(Date.now() - t0);
    const rest = interval - (Date.now() - shotAt);
    if (rest > 0) await page.waitForTimeout(rest);
  }
  return JSON.stringify({ frames, offsets, durationMs: Date.now() - t0, fps: ${a.fps} });
}`;
}

export type RecordResult = { fps: number; durationMs: number; frames: string[]; offsets: number[] };

type ProbeRun = (bin: string, args: string[]) => { status: number | null };
const defaultProbe: ProbeRun = (bin, args) => spawnSync(bin, args, { stdio: "ignore" });

/** The first ffmpeg binary that answers `-version`, or null if none is installed. */
export function resolveFfmpeg(run: ProbeRun = defaultProbe, candidates: string[] = FFMPEG_CANDIDATES): string | null {
  for (const bin of candidates) {
    try { if (run(bin, ["-version"]).status === 0) return bin; } catch {}
  }
  return null;
}

/** Is ffmpeg available on this host? */
export function ffmpegAvailable(run: ProbeRun = defaultProbe): boolean {
  return resolveFfmpeg(run) !== null;
}

/** The format actually produced: the request, downgraded to mjpeg when ffmpeg is missing. */
export function resolveFormat(requested: RecordFormat, hasFfmpeg: boolean): RecordFormat {
  return hasFfmpeg ? requested : "mjpeg";
}

/** The ffmpeg argv to turn the numbered JPEG frames in `dir` into `out` at `fps`. */
export function ffmpegArgs(dir: string, pattern: string, fps: number, format: RecordFormat, out: string): string[] {
  const base = ["-y", "-framerate", String(fps), "-i", `${dir}/${pattern}`];
  if (format === "webm") return [...base, "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", out];
  return [...base, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out];
}

export const RECORD_FRAME_PATTERN = "frame-%06d.jpg";

/** Pad a frame index to the fixed width the ffmpeg pattern expects. */
export function frameFileName(index: number): string {
  return `frame-${String(index + 1).padStart(6, "0")}.jpg`;
}
