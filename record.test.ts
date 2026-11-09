import { expect, test } from "bun:test";
import {
  parseRecordStart,
  parseRecordStop,
  buildRecordStartCode,
  buildRecordStopCode,
  ffmpegArgs,
  resolveFormat,
  ffmpegAvailable,
  resolveFfmpeg,
  frameFileName,
  RECORD_FRAME_PATTERN,
  RECORD_DEFAULT_FPS,
  RECORD_DEFAULT_QUALITY,
  RECORD_MAX_FRAMES,
} from "./record.ts";
import { authorizeProfileRequest, type Listener } from "./listeners.ts";

test("parseRecordStart: defaults, inline and spaced options, bounds", () => {
  expect(parseRecordStart(["record", "start"])).toEqual({ fps: RECORD_DEFAULT_FPS, quality: RECORD_DEFAULT_QUALITY, maxWidth: undefined });
  expect(parseRecordStart(["record", "start", "--fps=24", "--quality=60", "--max-width=1280"])).toEqual({ fps: 24, quality: 60, maxWidth: 1280 });
  expect(parseRecordStart(["record", "start", "--fps", "30"])).toEqual({ fps: 30, quality: RECORD_DEFAULT_QUALITY, maxWidth: undefined });
  expect(() => parseRecordStart(["record", "start", "--fps=0"])).toThrow(/--fps/);
  expect(() => parseRecordStart(["record", "start", "--fps=61"])).toThrow(/--fps/);
  expect(() => parseRecordStart(["record", "start", "--quality=101"])).toThrow(/--quality/);
  expect(() => parseRecordStart(["record", "start", "--bogus"])).toThrow(/unknown option/);
});

test("parseRecordStop: filename safety and format whitelist", () => {
  expect(parseRecordStop(["record", "stop"])).toEqual({ filename: undefined, format: "mp4" });
  expect(parseRecordStop(["record", "stop", "--filename=clip.mp4", "--format=webm"])).toEqual({ filename: "clip.mp4", format: "webm" });
  expect(() => parseRecordStop(["record", "stop", "--filename=../escape.mp4"])).toThrow(/--filename/);
  expect(() => parseRecordStop(["record", "stop", "--filename=a/b.mp4"])).toThrow(/--filename/);
  expect(() => parseRecordStop(["record", "stop", "--format=gif"])).toThrow(/--format/);
});

test("buildRecordStartCode: starts a jpeg screencast and stashes the buffer on globalThis", () => {
  const code = buildRecordStartCode({ fps: 10, quality: 70, maxWidth: 800 });
  expect(code).toContain("newCDPSession");
  expect(code).toContain('"Page.startScreencast"');
  expect(code).toContain('format: "jpeg"');
  expect(code).toContain("quality: 70");
  expect(code).toContain("maxWidth: 800");
  expect(code).toContain("Page.screencastFrameAck");
  expect(code).toContain("g.__rechRec");
  expect(code).toContain(String(RECORD_MAX_FRAMES));
  // no max-width key when not requested
  expect(buildRecordStartCode({ fps: 10, quality: 70 })).not.toContain("maxWidth");
});

test("buildRecordStopCode: stops, detaches, returns frames + timing", () => {
  const code = buildRecordStopCode();
  expect(code).toContain('"Page.stopScreencast"');
  expect(code).toContain("no recording in progress");
  expect(code).toContain("frames: rec.frames.map");
  expect(code).toContain("durationMs");
  expect(code).toContain("detach");
});

test("resolveFormat: downgrades to mjpeg only when ffmpeg is absent", () => {
  expect(resolveFormat("mp4", true)).toBe("mp4");
  expect(resolveFormat("webm", true)).toBe("webm");
  expect(resolveFormat("mjpeg", true)).toBe("mjpeg");
  expect(resolveFormat("mp4", false)).toBe("mjpeg");
  expect(resolveFormat("webm", false)).toBe("mjpeg");
});

test("ffmpegArgs: numbered-jpeg input at the capture fps, codec per format", () => {
  const mp4 = ffmpegArgs("/tmp/frames", RECORD_FRAME_PATTERN, 12, "mp4", "/tmp/out.mp4");
  expect(mp4).toEqual(["-y", "-framerate", "12", "-i", "/tmp/frames/frame-%06d.jpg", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "/tmp/out.mp4"]);
  const webm = ffmpegArgs("/tmp/frames", RECORD_FRAME_PATTERN, 8, "webm", "/tmp/out.webm");
  expect(webm).toContain("libvpx-vp9");
  expect(webm).toContain("/tmp/out.webm");
});

test("ffmpegAvailable: true only when the probe exits 0", () => {
  expect(ffmpegAvailable(() => ({ status: 0 }))).toBe(true);
  expect(ffmpegAvailable(() => ({ status: 1 }))).toBe(false);
  expect(ffmpegAvailable(() => { throw new Error("ENOENT"); })).toBe(false);
});

test("resolveFfmpeg: returns the first candidate that answers, probing absolute paths too", () => {
  // bare ffmpeg missing (PATH lacks it), but the Homebrew absolute path answers
  const bin = resolveFfmpeg((b) => ({ status: b === "/opt/homebrew/bin/ffmpeg" ? 0 : 1 }), ["ffmpeg", "/opt/homebrew/bin/ffmpeg"]);
  expect(bin).toBe("/opt/homebrew/bin/ffmpeg");
  expect(resolveFfmpeg(() => ({ status: 1 }), ["ffmpeg"])).toBeNull();
});

test("frameFileName: 1-based, zero-padded to the pattern width", () => {
  expect(frameFileName(0)).toBe("frame-000001.jpg");
  expect(frameFileName(41)).toBe("frame-000042.jpg");
});

// record is page-level (like screenshot): allowed on profile-scoped listeners, with only its own options.
const scoped: Listener = { name: "qa", host: "100.80.1.2", port: 13775, key: "a".repeat(24), profiles: ["qa"] };
const request = (args: string[]) => ({ args, identity: { key: "/worktree", profile: "qa" } });

test("record is allowed on a profile-scoped listener, with only its capture/output options", () => {
  expect(authorizeProfileRequest(scoped, request(["record", "start"]))).toBe("qa");
  expect(authorizeProfileRequest(scoped, request(["record", "start", "--fps=24", "--quality=60", "--max-width=1280"]))).toBe("qa");
  expect(authorizeProfileRequest(scoped, request(["record", "stop", "--filename=clip.mp4", "--format=webm"]))).toBe("qa");
  // an unrelated option is still refused
  expect(() => authorizeProfileRequest(scoped, request(["record", "start", "--profile=/x"]))).toThrow(/option overrides/);
});
