import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import vm from "vm";
import {
  parseRecordArgs,
  buildCaptureChunkCode,
  Retimer,
  Recording,
  recordSink,
  ffmpegStreamArgs,
  resolveFormat,
  resolveFfmpeg,
  freeName,
  withFormatExt,
  recordHoldMs,
  RECORD_DEFAULT_SECONDS,
  RECORD_DEFAULT_MAX_SECONDS,
  RECORD_DEFAULT_FPS,
  RECORD_DEFAULT_QUALITY,
  RECORD_MAX_SECONDS,
  RECORD_LIMIT_SECONDS,
  RECORD_MAX_FPS,
  type CaptureChunk,
  type FrameSink,
} from "./record.ts";
import { authorizeProfileRequest, type Listener } from "./listeners.ts";

test("parseRecordArgs: start / stop / timed forms, each with only its own options", () => {
  expect(parseRecordArgs(["record"])).toEqual({ mode: "timed", seconds: RECORD_DEFAULT_SECONDS, fps: RECORD_DEFAULT_FPS, quality: RECORD_DEFAULT_QUALITY, format: "mp4", filename: undefined });
  expect(parseRecordArgs(["record", "--seconds", "8", "--format=webm", "--filename=clip.webm"])).toMatchObject({ mode: "timed", seconds: 8, format: "webm", filename: "clip.webm" });
  expect(parseRecordArgs(["record", "start"])).toEqual({ mode: "start", fps: RECORD_DEFAULT_FPS, quality: RECORD_DEFAULT_QUALITY, format: "mp4", maxSeconds: RECORD_DEFAULT_MAX_SECONDS });
  expect(parseRecordArgs(["record", "start", "--fps=12", "--quality", "50", "--max-seconds=1800"])).toMatchObject({ fps: 12, quality: 50, maxSeconds: 1800 });
  expect(parseRecordArgs(["record", "stop", "--filename=demo.mp4"])).toEqual({ mode: "stop", filename: "demo.mp4" });
  // options belong to one form
  expect(() => parseRecordArgs(["record", "stop", "--fps=10"])).toThrow(/record stop: unknown option/);
  expect(() => parseRecordArgs(["record", "start", "--seconds=5"])).toThrow(/record start: unknown option/);
  expect(() => parseRecordArgs(["record", "--max-seconds=5"])).toThrow(/unknown option/);
  // bounds and safety
  expect(() => parseRecordArgs(["record", `--seconds=${RECORD_MAX_SECONDS + 1}`])).toThrow(/--seconds/);
  expect(() => parseRecordArgs(["record", "start", `--max-seconds=${RECORD_LIMIT_SECONDS + 1}`])).toThrow(/--max-seconds/);
  expect(() => parseRecordArgs(["record", "start", `--fps=${RECORD_MAX_FPS + 1}`])).toThrow(/--fps/);
  expect(() => parseRecordArgs(["record", "start", "--format=gif"])).toThrow(/--format/);
  expect(() => parseRecordArgs(["record", "stop", "--filename=../x.mp4"])).toThrow(/--filename/);
  expect(() => parseRecordArgs(["record", "stop", "--filename=a/b.mp4"])).toThrow(/--filename/);
});

test("recordHoldMs: only a timed recording holds the request (the client waits that much longer)", () => {
  expect(recordHoldMs(["record", "--seconds", "60"])).toBe(60_000);
  expect(recordHoldMs(["-s=demo", "record", "--seconds=7"])).toBe(7_000);
  expect(recordHoldMs(["record"])).toBe(RECORD_DEFAULT_SECONDS * 1000);
  expect(recordHoldMs(["record", "start"])).toBe(0);
  expect(recordHoldMs(["record", "stop"])).toBe(0);
  expect(recordHoldMs(["record", "--seconds", "9999"])).toBe(0); // refused by serve anyway
  expect(recordHoldMs(["open", "https://example.com"])).toBe(0);
});

test("withFormatExt: the saved name matches what was written", () => {
  expect(withFormatExt("clip.mp4", "mp4")).toBe("clip.mp4");
  expect(withFormatExt("clip.mp4", "mjpeg")).toBe("clip.mjpeg"); // no ffmpeg on the host
  expect(withFormatExt("clip.WEBM", "mp4")).toBe("clip.mp4");
  expect(withFormatExt("clip", "webm")).toBe("clip.webm");
  expect(withFormatExt("notes.v2", "mp4")).toBe("notes.v2.mp4");
});

test("freeName: never an existing name", () => {
  const taken = new Set(["clip.mp4", "clip-2.mp4", "notes"]);
  expect(freeName("new.mp4", n => taken.has(n))).toBe("new.mp4");
  expect(freeName("clip.mp4", n => taken.has(n))).toBe("clip-3.mp4");
  expect(freeName("notes", n => taken.has(n))).toBe("notes-2");
});

/** A fake page whose screenshots are numbered; `fail` makes the next one throw. */
function fakePage() {
  const p = {
    shots: 0, fail: false,
    screenshot: async (o: { type: string; quality: number; scale?: string }) => {
      expect(o).toEqual({ type: "jpeg", quality: 55, scale: "css" });
      if (p.fail) throw new Error("Target page, context or browser has been closed");
      p.shots++; return Buffer.from(`jpeg-${p.shots}`);
    },
    waitForTimeout: (ms: number) => new Promise(r => setTimeout(r, ms)),
  };
  return p;
}
// run-code evaluates the snippet the way tools/backend/runCode.ts does: a new context per call
// holding only `page` (no Buffer, no setTimeout).
async function runCode(page: object, code: string): Promise<CaptureChunk> {
  const context: any = { page };
  vm.createContext(context);
  return JSON.parse(await vm.runInContext("(" + code + ")", context)(page));
}

test("capture code: the browser-side loop keeps shooting between run-code calls, and the final call ends it", async () => {
  const page = fakePage();
  const code = buildCaptureChunkCode({ fps: 20, quality: 55, id: "a" }, 200);
  const first = await runCode(page, code);
  expect(first.frames.length).toBeGreaterThanOrEqual(1);
  expect(Buffer.from(first.frames[0]!, "base64").toString()).toBe("jpeg-1");
  await Bun.sleep(300); // the cliDaemon's settle between calls: capture goes on meanwhile
  const calledAt = Date.now();
  const second = await runCode(page, code);
  expect(second.times.filter(t => t < calledAt).length).toBeGreaterThanOrEqual(4); // shot during the gap
  const all = [...first.frames, ...second.frames].map(f => Buffer.from(f, "base64").toString());
  expect(all).toEqual(all.map((_, i) => `jpeg-${i + 1}`)); // nothing lost or repeated across calls
  expect(second.times.every((t, i) => i === 0 || t >= second.times[i - 1]!)).toBe(true);
  const last = await runCode(page, buildCaptureChunkCode({ fps: 20, quality: 55, id: "a", final: true }, 200));
  expect(all.length + last.frames.length).toBe(page.shots); // the final drain hands over the rest
  await Bun.sleep(150);
  const stoppedAt = page.shots;
  await Bun.sleep(150);
  expect(page.shots).toBe(stoppedAt);
});

test("capture code: a new recording id replaces a leftover loop; a failed screenshot is reported", async () => {
  const page = fakePage();
  await runCode(page, buildCaptureChunkCode({ fps: 20, quality: 55, id: "old" }, 200));
  const next = await runCode(page, buildCaptureChunkCode({ fps: 20, quality: 55, id: "new" }, 200));
  expect(next.frames.length).toBeGreaterThanOrEqual(1);
  // The old recording's final drain must not stop or steal the new one.
  expect((await runCode(page, buildCaptureChunkCode({ fps: 20, quality: 55, id: "old", final: true }, 200))).frames).toEqual([]);
  page.fail = true;
  await Bun.sleep(100);
  const code = buildCaptureChunkCode({ fps: 20, quality: 55, id: "new" }, 200);
  // Frames shot before the failure may still come back first; then the error does.
  await runCode(page, code).catch(() => {});
  await expect(runCode(page, code)).rejects.toThrow(/has been closed/);
});

const jpeg = (n: number) => new Uint8Array([n]);

test("Retimer: uneven captures become a constant-fps clock in real time", () => {
  const out: number[] = [];
  const r = new Retimer(1000, 10, j => out.push(j[0]!)); // 10 fps: one slot per 100 ms
  r.push(jpeg(1), 1000);   // slot 0
  r.push(jpeg(2), 1350);   // slot 3: frame 1 fills slots 0-2
  r.push(jpeg(3), 1360);   // same slot: replaces 2 before it is shown
  r.push(jpeg(4), 1520);   // slot 5: frame 3 fills 3-4
  expect(out).toEqual([1, 1, 1, 3, 3]);
  expect(r.finish(1800)).toBe(8); // frame 4 fills slots 5-7: 800 ms of video for 800 ms of capture
  expect(out).toEqual([1, 1, 1, 3, 3, 4, 4, 4]);
});

test("Retimer: nothing before the first frame, and at least one frame once anything arrived", () => {
  const out: number[] = [];
  const r = new Retimer(0, 10, j => out.push(j[0]!));
  expect(r.finish(500)).toBe(0); // no capture: no frames
  const r2 = new Retimer(0, 10, j => out.push(j[0]!));
  r2.push(jpeg(9), 50);
  expect(r2.finish(10)).toBe(1); // stop came before the slot ended: still one frame
  expect(out).toEqual([9]);
});

/** A fake clock + capture: each chunk advances time by `step` ms per frame. */
function fakeSource(opts: { step: number; perChunk: number; failAfter?: number }) {
  let t = 0, chunks = 0;
  return {
    now: () => t,
    capture: async (): Promise<CaptureChunk> => {
      await Bun.sleep(1);
      if (opts.failAfter !== undefined && chunks >= opts.failAfter) throw new Error("no browser is open in this session");
      chunks++;
      const frames: string[] = [], times: number[] = [];
      for (let i = 0; i < opts.perChunk; i++) { frames.push(Buffer.from([chunks]).toString("base64")); times.push(t); t += opts.step; }
      return { frames, times };
    },
  };
}
function memorySink() {
  const written: number[] = [];
  let closed = 0;
  const sink: FrameSink = { write: j => { written.push(j[0]!); return Promise.resolve(); }, close: async () => { closed++; } };
  return { sink, written, closed: () => closed };
}

test("Recording: start → stop streams every frame to the sink as it goes, and stop is idempotent", async () => {
  const src = fakeSource({ step: 100, perChunk: 5 });
  const m = memorySink();
  const rec = new Recording({ fps: 10, format: "mp4", out: "/x/out.mp4", maxMs: 60_000, capture: src.capture, sink: m.sink, now: src.now });
  while (m.written.length < 12) await Bun.sleep(2); // frames reach the sink while recording is still on
  expect(rec.active).toBe(true);
  const s = await rec.stop();
  expect(await rec.stop()).toBe(s);
  expect(rec.active).toBe(false);
  expect(m.closed()).toBe(1);
  expect(s.frames).toBe(m.written.length);
  expect(s.captured).toBeGreaterThanOrEqual(15);
  expect(s.seconds).toBeCloseTo(s.frames / 10, 5);
  expect(s.error).toBeUndefined();
  expect(s.encodeError).toBeUndefined();
});

test("Recording: --max-seconds stops it by itself, and the file is reported once", async () => {
  const src = fakeSource({ step: 100, perChunk: 5 });
  const m = memorySink();
  let auto: any;
  const rec = new Recording({ fps: 10, format: "mp4", out: "/x/out.mp4", maxMs: 2000, capture: src.capture, sink: m.sink, now: src.now, onAutoStop: s => { auto = s; } });
  while (!auto) await Bun.sleep(2);
  expect(rec.active).toBe(false);
  expect(auto.frames).toBe(20); // exactly 2 s at 10 fps
  expect(await rec.stop()).toBe(auto);
  expect(m.closed()).toBe(1);
});

test("Recording: a capture failure ends it early but keeps what was recorded", async () => {
  const src = fakeSource({ step: 100, perChunk: 5, failAfter: 2 });
  const m = memorySink();
  let auto: any;
  new Recording({ fps: 10, format: "mp4", out: "/x/out.mp4", maxMs: 60_000, capture: src.capture, sink: m.sink, now: src.now, onAutoStop: s => { auto = s; } });
  while (!auto) await Bun.sleep(2);
  expect(auto.captured).toBe(10);
  expect(auto.frames).toBeGreaterThan(0);
  expect(auto.error).toMatch(/no browser is open/);
  expect(auto.encodeError).toBeUndefined();
});

test("Recording: an encoder failure is reported, never thrown", async () => {
  const src = fakeSource({ step: 100, perChunk: 5 });
  const sink: FrameSink = { write: () => Promise.reject(new Error("EPIPE")), close: async () => { throw new Error("record: ffmpeg could not encode mp4 (bad)"); } };
  const rec = new Recording({ fps: 10, format: "mp4", out: "/x/out.mp4", maxMs: 60_000, capture: src.capture, sink, now: src.now });
  await Bun.sleep(20);
  const s = await rec.stop();
  expect(s.error).toMatch(/EPIPE/);
  expect(s.encodeError).toMatch(/ffmpeg could not encode/);
});

test("resolveFormat / resolveFfmpeg: mjpeg only without ffmpeg; absolute paths are probed", () => {
  expect(resolveFormat("webm", true)).toBe("webm");
  expect(resolveFormat("mp4", false)).toBe("mjpeg");
  expect(resolveFfmpeg(b => ({ status: b === "/opt/homebrew/bin/ffmpeg" ? 0 : 1 }), ["ffmpeg", "/opt/homebrew/bin/ffmpeg"])).toBe("/opt/homebrew/bin/ffmpeg");
  expect(resolveFfmpeg(() => { throw new Error("ENOENT"); }, ["ffmpeg"])).toBeNull();
  const args = ffmpegStreamArgs(8, "mp4", "/o/x.mp4.part");
  expect(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2)).toEqual(["-i", "-"]);
  expect(args.slice(-3)).toEqual(["-f", "mp4", "/o/x.mp4.part"]); // the .part name can't pick the muxer
});

const ffmpeg = resolveFfmpeg();

test.skipIf(!ffmpeg)("recordSink streams real JPEGs through ffmpeg into a playable mp4/webm of the right length", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rech-record-"));
  try {
    // Real JPEG frames, odd-sized on purpose (yuv420p needs even dimensions).
    const src = Bun.spawnSync([ffmpeg!, "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=321x241:rate=10", "-frames:v", "12", "-f", "image2pipe", "-c:v", "mjpeg", "-"]);
    const all = src.stdout;
    const frames: Uint8Array[] = [];
    for (let i = 0, start = -1; i < all.length - 1; i++) {
      if (all[i] === 0xff && all[i + 1] === 0xd8 && start < 0) start = i;
      if (all[i] === 0xff && all[i + 1] === 0xd9 && start >= 0) { frames.push(all.subarray(start, i + 2)); start = -1; }
    }
    expect(frames.length).toBe(12);
    for (const format of ["mp4", "webm"] as const) {
      const out = join(dir, `clip.${format}.part`);
      let t = 0, k = 0;
      const rec = new Recording({
        fps: 10, format, out, maxMs: 60_000, sink: recordSink(format, ffmpeg, 10, out), now: () => t,
        capture: async () => { await Bun.sleep(1); if (k >= frames.length) { await Bun.sleep(5); return { frames: [], times: [] }; } const f = frames[k++]!; const at = t; t += 100; return { frames: [Buffer.from(f).toString("base64")], times: [at] }; },
      });
      while (k < frames.length) await Bun.sleep(2);
      const s = await rec.stop();
      expect(s.encodeError).toBeUndefined();
      expect(s.frames).toBe(12);
      // Decode it back (ffmpeg alone, no ffprobe needed): every frame, at even dimensions.
      const probe = Bun.spawnSync([ffmpeg!, "-hide_banner", "-i", out, "-map", "0:v:0", "-f", "null", "-"]).stderr.toString();
      expect(probe).toMatch(/Video: .*\b320x240\b/);
      expect(Number([...probe.matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1])).toBe(12);
      expect(statSync(out).size).toBeGreaterThan(0);
    }
    // No ffmpeg: a raw MJPEG stream of the same frames.
    const mj = join(dir, "clip.mjpeg");
    const sink = recordSink("mjpeg", null, 10, mj);
    for (const f of frames) sink.write(f);
    await sink.close();
    expect(readFileSync(mj).length).toBe(frames.reduce((n, f) => n + f.length, 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// record is page-level (like screenshot): allowed on profile-scoped listeners, with only its own options.
const scoped: Listener = { name: "qa", host: "100.80.1.2", port: 13775, key: "a".repeat(24), profiles: ["qa"] };
const request = (args: string[]) => ({ args, identity: { key: "/worktree", profile: "qa" } });

test("record start/stop and the timed form are allowed on a profile-scoped listener, with only their options", () => {
  expect(authorizeProfileRequest(scoped, request(["record", "start", "--fps=12", "--max-seconds=900", "--format=webm"]))).toBe("qa");
  expect(authorizeProfileRequest(scoped, request(["record", "stop", "--filename=clip.mp4"]))).toBe("qa");
  expect(authorizeProfileRequest(scoped, request(["record", "--seconds=10", "--quality=60"]))).toBe("qa");
  expect(() => authorizeProfileRequest(scoped, request(["record", "start", "--profile=/x"]))).toThrow(/option overrides/);
});
