// rech record: record the attached tab's video via CDP Page.startScreencast, then assemble the
// captured JPEG frames into a video file (mp4 by ffmpeg; webm/mjpeg fallbacks) under .rechrome/output.
//
// Design (why it is serve-handled, not a playwright-cli passthrough): `record start` and `record stop`
// are two separate `rech` calls, but a CDP screencast started in one call must keep delivering frames
// until the other. The only per-session actor that persists between calls is the cliDaemon, so the
// screencast and its frame buffer live there, stashed on `globalThis.__rechRec`, reached over the
// session socket with run-code (like fill-secret / read-storage). On stop the frames come back and
// serve encodes them. No click, no new permission, background tabs are fine, no audio (a later PR adds
// tabCapture with audio).

import { spawnSync } from "child_process";

export const RECORD_USAGE = `Usage:
  rech record start [--fps <n>] [--quality <1-100>] [--max-width <px>]   begin recording the active tab
  rech record stop  [--filename <name>] [--format mp4|webm|mjpeg]        stop and write the video
  Records the attached tab's screen via CDP Page.startScreencast (no click, no new permission, works
  on a background tab, no audio). The file lands in .rechrome/output and is deleted on this host after
  the client fetches it (unless the listener keeps downloads). mp4 needs ffmpeg; without it the video
  falls back to webm (if ffmpeg can) or a raw MJPEG stream.`;

export const RECORD_DEFAULT_FPS = 10;
export const RECORD_MAX_FPS = 60;
export const RECORD_DEFAULT_QUALITY = 80;
// A cap so a forgotten recording can't exhaust memory: at the default 10 fps this is ~10 minutes.
export const RECORD_MAX_FRAMES = 6000;
export const RECORD_FORMATS = ["mp4", "webm", "mjpeg"] as const;
export type RecordFormat = (typeof RECORD_FORMATS)[number];

// The daemon's PATH (oxmgr/launchd) often lacks Homebrew's dir, so probe common absolute paths too,
// not just a bare "ffmpeg". FFMPEG_BIN overrides and is tried first.
export const FFMPEG_CANDIDATES = [process.env.FFMPEG_BIN, "ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].filter((x): x is string => !!x);

export type RecordStartArgs = { fps: number; quality: number; maxWidth?: number };
export type RecordStopArgs = { filename?: string; format: RecordFormat };

function intOpt(value: string | undefined, name: string, min: number, max: number): number {
  const n = Number(value);
  if (!value || !Number.isInteger(n) || n < min || n > max) throw new Error(`record: ${name} must be an integer ${min}-${max}`);
  return n;
}

/** Parse `record start …` client args. */
export function parseRecordStart(args: string[]): RecordStartArgs {
  if (args[0] !== "record" || args[1] !== "start") throw new Error("Expected `record start`");
  let fps = RECORD_DEFAULT_FPS, quality = RECORD_DEFAULT_QUALITY, maxWidth: number | undefined;
  for (let i = 2; i < args.length; i++) {
    const a = args[i]!;
    const eat = (inline?: string) => inline ?? args[++i];
    if (a.startsWith("--fps")) fps = intOpt(a.includes("=") ? a.slice(a.indexOf("=") + 1) : eat(), "--fps", 1, RECORD_MAX_FPS);
    else if (a.startsWith("--quality")) quality = intOpt(a.includes("=") ? a.slice(a.indexOf("=") + 1) : eat(), "--quality", 1, 100);
    else if (a.startsWith("--max-width")) maxWidth = intOpt(a.includes("=") ? a.slice(a.indexOf("=") + 1) : eat(), "--max-width", 1, 10000);
    else throw new Error(`record start: unknown option ${a}`);
  }
  return { fps, quality, maxWidth };
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** Parse `record stop …` client args. */
export function parseRecordStop(args: string[]): RecordStopArgs {
  if (args[0] !== "record" || args[1] !== "stop") throw new Error("Expected `record stop`");
  let filename: string | undefined, format: RecordFormat = "mp4";
  for (let i = 2; i < args.length; i++) {
    const a = args[i]!;
    const eat = (inline?: string) => inline ?? args[++i];
    if (a.startsWith("--filename")) {
      filename = a.includes("=") ? a.slice(a.indexOf("=") + 1) : eat();
      if (!filename || !SAFE_NAME.test(filename) || filename.includes("..")) throw new Error("record stop: --filename must be a plain name like clip.mp4 (no path separators)");
    } else if (a.startsWith("--format")) {
      const f = (a.includes("=") ? a.slice(a.indexOf("=") + 1) : eat()) as RecordFormat;
      if (!RECORD_FORMATS.includes(f)) throw new Error(`record stop: --format must be one of ${RECORD_FORMATS.join("|")}`);
      format = f;
    } else throw new Error(`record stop: unknown option ${a}`);
  }
  return { filename, format };
}

// ---- run-code the cliDaemon executes against the live tab (page APIs only; no host fs) ----

/** run-code: open a CDP session, start the screencast, and keep the frame buffer on globalThis. */
export function buildRecordStartCode(a: RecordStartArgs): string {
  return `async page => {
  const g = globalThis;
  if (g.__rechRec && g.__rechRec.active) return JSON.stringify({ already: true, startedAt: g.__rechRec.startedAt });
  const client = await page.context().newCDPSession(page);
  const frames = [];
  const onFrame = async (e) => {
    try {
      if (frames.length < ${RECORD_MAX_FRAMES}) frames.push({ data: e.data, t: Date.now() });
      await client.send("Page.screencastFrameAck", { sessionId: e.sessionId });
    } catch {}
  };
  client.on("Page.screencastFrame", onFrame);
  await client.send("Page.startScreencast", { format: "jpeg", quality: ${a.quality}, everyNthFrame: 1${a.maxWidth ? `, maxWidth: ${a.maxWidth}` : ""} });
  g.__rechRec = { active: true, client, frames, onFrame, startedAt: Date.now(), fps: ${a.fps} };
  return JSON.stringify({ recording: true, startedAt: g.__rechRec.startedAt, fps: ${a.fps} });
}`;
}

/** run-code: stop the screencast, detach, and return the captured frames (base64 JPEG) + meta. */
export function buildRecordStopCode(): string {
  return `async page => {
  const g = globalThis;
  const rec = g.__rechRec;
  if (!rec || !rec.active) throw new Error("record: no recording in progress; run \`rech record start\` first");
  try { await rec.client.send("Page.stopScreencast"); } catch {}
  try { rec.client.off("Page.screencastFrame", rec.onFrame); } catch {}
  try { await rec.client.detach(); } catch {}
  rec.active = false;
  g.__rechRec = undefined;
  const base = rec.frames[0] ? rec.frames[0].t : rec.startedAt;
  return JSON.stringify({
    fps: rec.fps,
    durationMs: Date.now() - rec.startedAt,
    frames: rec.frames.map(f => f.data),
    offsets: rec.frames.map(f => f.t - base),
  });
}`;
}

export type StopResult = { fps: number; durationMs: number; frames: string[]; offsets: number[] };

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

/** The video format actually produced: the request, downgraded to mjpeg when ffmpeg is missing. */
export function resolveFormat(requested: RecordFormat, hasFfmpeg: boolean): RecordFormat {
  if (hasFfmpeg) return requested;
  return "mjpeg"; // no encoder available: a raw concatenated-JPEG stream is the only no-dep option
}

/** The ffmpeg argv to turn the numbered JPEG frames in `dir` into `out` at `fps`. */
export function ffmpegArgs(dir: string, pattern: string, fps: number, format: RecordFormat, out: string): string[] {
  const base = ["-y", "-framerate", String(fps), "-i", `${dir}/${pattern}`];
  if (format === "webm") return [...base, "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", out];
  // mp4
  return [...base, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out];
}

export const RECORD_FRAME_PATTERN = "frame-%06d.jpg";

/** Pad a frame index to the fixed width the ffmpeg pattern expects. */
export function frameFileName(index: number): string {
  return `frame-${String(index + 1).padStart(6, "0")}.jpg`;
}
