import { expect, test } from "bun:test";
import {
  parseRecordArgs,
  recordWireArgs,
  buildRecordCode,
  ffmpegArgs,
  resolveFormat,
  ffmpegAvailable,
  resolveFfmpeg,
  frameFileName,
  RECORD_FRAME_PATTERN,
  RECORD_DEFAULT_SECONDS,
  RECORD_DEFAULT_FPS,
  RECORD_DEFAULT_QUALITY,
  RECORD_MAX_SECONDS,
  RECORD_MAX_FPS,
  RECORD_MAX_FRAMES,
} from "./record.ts";
import { authorizeProfileRequest, type Listener } from "./listeners.ts";

test("parseRecordArgs: defaults, inline and spaced options, bounds", () => {
  expect(parseRecordArgs(["record"])).toEqual({ seconds: RECORD_DEFAULT_SECONDS, fps: RECORD_DEFAULT_FPS, quality: RECORD_DEFAULT_QUALITY, filename: undefined, format: "mp4" });
  expect(parseRecordArgs(["record", "--seconds=10", "--fps=12", "--quality=50", "--format=webm", "--filename=clip.webm"]))
    .toEqual({ seconds: 10, fps: 12, quality: 50, filename: "clip.webm", format: "webm" });
  expect(parseRecordArgs(["record", "--seconds", "8"]).seconds).toBe(8);
  expect(() => parseRecordArgs(["record", "--seconds=0"])).toThrow(/--seconds/);
  expect(() => parseRecordArgs(["record", `--seconds=${RECORD_MAX_SECONDS + 1}`])).toThrow(/--seconds/);
  expect(() => parseRecordArgs(["record", `--fps=${RECORD_MAX_FPS + 1}`])).toThrow(/--fps/);
  expect(() => parseRecordArgs(["record", "--quality=101"])).toThrow(/--quality/);
  expect(() => parseRecordArgs(["record", "--format=gif"])).toThrow(/--format/);
  expect(() => parseRecordArgs(["record", "--filename=../escape.mp4"])).toThrow(/--filename/);
  expect(() => parseRecordArgs(["record", "--filename=a/b.mp4"])).toThrow(/--filename/);
  expect(() => parseRecordArgs(["record", "--bogus"])).toThrow(/unknown option/);
});

test("recordWireArgs round-trips through parseRecordArgs", () => {
  for (const a of [
    { seconds: 5, fps: 8, quality: 70, filename: undefined, format: "mp4" as const },
    { seconds: 30, fps: 15, quality: 40, filename: "x.webm", format: "webm" as const },
  ]) {
    expect(parseRecordArgs(recordWireArgs(a))).toEqual(a);
  }
});

test("buildRecordCode: a bounded screenshot-poll loop returning base64 frames (no CDP, no persistence)", () => {
  const code = buildRecordCode({ seconds: 5, fps: 8, quality: 70, format: "mp4" });
  expect(code).toContain("page.screenshot({ type: \"jpeg\", quality: 70 })");
  expect(code).toContain("Date.now() + 5 * 1000");
  expect(code).toContain("Math.round(1000 / 8)");
  expect(code).toContain("page.waitForTimeout");
  expect(code).toContain('toString("base64")');
  expect(code).toContain(String(RECORD_MAX_FRAMES));
  // single-call capture: it must NOT rely on a CDP session or cross-call globalThis state
  expect(code).not.toContain("newCDPSession");
  expect(code).not.toContain("startScreencast");
  expect(code).not.toContain("globalThis");
});

test("resolveFormat: downgrades to mjpeg only when ffmpeg is absent", () => {
  expect(resolveFormat("mp4", true)).toBe("mp4");
  expect(resolveFormat("webm", true)).toBe("webm");
  expect(resolveFormat("mp4", false)).toBe("mjpeg");
  expect(resolveFormat("webm", false)).toBe("mjpeg");
});

test("ffmpegArgs: numbered-jpeg input at the capture fps, codec per format", () => {
  expect(ffmpegArgs("/tmp/frames", RECORD_FRAME_PATTERN, 12, "mp4", "/tmp/out.mp4"))
    .toEqual(["-y", "-framerate", "12", "-i", "/tmp/frames/frame-%06d.jpg", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "/tmp/out.mp4"]);
  expect(ffmpegArgs("/tmp/frames", RECORD_FRAME_PATTERN, 8, "webm", "/tmp/out.webm")).toContain("libvpx-vp9");
});

test("resolveFfmpeg: first candidate that answers, probing absolute paths too; null when none", () => {
  expect(resolveFfmpeg((b) => ({ status: b === "/opt/homebrew/bin/ffmpeg" ? 0 : 1 }), ["ffmpeg", "/opt/homebrew/bin/ffmpeg"])).toBe("/opt/homebrew/bin/ffmpeg");
  expect(resolveFfmpeg(() => ({ status: 1 }), ["ffmpeg"])).toBeNull();
  expect(ffmpegAvailable(() => ({ status: 0 }))).toBe(true);
  expect(ffmpegAvailable(() => { throw new Error("ENOENT"); })).toBe(false);
});

test("frameFileName: 1-based, zero-padded to the pattern width", () => {
  expect(frameFileName(0)).toBe("frame-000001.jpg");
  expect(frameFileName(41)).toBe("frame-000042.jpg");
});

// record is page-level (like screenshot): allowed on profile-scoped listeners, with only its options.
const scoped: Listener = { name: "qa", host: "100.80.1.2", port: 13775, key: "a".repeat(24), profiles: ["qa"] };
const request = (args: string[]) => ({ args, identity: { key: "/worktree", profile: "qa" } });

test("record is allowed on a profile-scoped listener, with only its capture/output options", () => {
  expect(authorizeProfileRequest(scoped, request(["record"]))).toBe("qa");
  expect(authorizeProfileRequest(scoped, request(["record", "--seconds=10", "--fps=12", "--quality=50", "--format=webm", "--filename=clip.webm"]))).toBe("qa");
  expect(() => authorizeProfileRequest(scoped, request(["record", "--profile=/x"]))).toThrow(/option overrides/);
});
