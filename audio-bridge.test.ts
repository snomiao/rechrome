import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import {
  AUDIO_MAX_WAV_BYTES,
  AUDIO_MAX_DRAIN_BYTES,
  AUDIO_MAX_SECONDS,
  parseAudioArgs,
  parseAudioWire,
  audioWireArgs,
  audioInstallUrl,
  validatePcmWav,
  validateAudioUpload,
  validateAudioStatus,
  validateAudioDrain,
  parseAudioResult,
  buildAudioInstallCode,
  buildAudioActionCode,
  type AudioStatus,
  type AudioUpload,
} from "./audio-bridge.ts";

const id = `b-${"1".repeat(32)}`;
const status = (): AudioStatus => ({
  id,
  phase: "ready",
  bufferedBytes: 0,
  droppedBytes: 0,
  streamCount: 1,
  queuedSeconds: 0,
  unsupported: [],
});
function wav(format: 1 | 3 = 1, channels: 1 | 2 = 1, frames = 4, sampleRate = 16000): Buffer {
  const align = channels * (format === 1 ? 2 : 4),
    output = Buffer.alloc(44 + frames * align);
  output.write("RIFF", 0);
  output.writeUInt32LE(output.length - 8, 4);
  output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(format, 20);
  output.writeUInt16LE(channels, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * align, 28);
  output.writeUInt16LE(align, 32);
  output.writeUInt16LE(format === 1 ? 16 : 32, 34);
  output.write("data", 36);
  output.writeUInt32LE(frames * align, 40);
  return output;
}
const upload = (bytes: Uint8Array = wav()): AudioUpload => ({
  name: "input.wav",
  contentType: "audio/wav",
  data: Buffer.from(bytes).toString("base64"),
});
const drain = (data = "AQID") => ({
  ...status(),
  streams: [
    { id: "s-1", mimeType: "audio/webm;codecs=opus", seq: 0, chunks: [data], final: false },
  ],
});

describe("audio client and daemon arguments", () => {
  test("round-trips install and strips every local path before the wire", () => {
    const install = parseAudioArgs([
      "audio",
      "install",
      "https://example.test:443/app",
      "--capture",
      "--max-seconds",
      "12",
    ]);
    expect(install).toEqual({
      action: "install",
      url: "https://example.test/app",
      capture: true,
      maxSeconds: 12,
    });
    expect(parseAudioWire(audioWireArgs(install))).toEqual(install);
    const feed = parseAudioArgs(["audio", "feed", "/private/client-only/note.wav"]);
    expect(audioWireArgs(feed)).toEqual(["audio", "feed"]);
    expect(parseAudioWire(audioWireArgs(feed))).toEqual({ action: "feed" });
    expect(audioWireArgs(parseAudioArgs(["audio", "drain", "--dir", "C:\\client\\audio"]))).toEqual(
      ["audio", "drain"],
    );
    expect(audioWireArgs(parseAudioArgs(["audio", "stop", "--dir=./client-only"]))).toEqual([
      "audio",
      "stop",
    ]);
    expect(parseAudioArgs(["audio", "stop"])).toEqual({ action: "stop" });
    expect(parseAudioArgs(["audio", "capture", "start"])).toEqual({ action: "capture-start" });
    expect(parseAudioArgs(["audio", "status"])).toEqual({ action: "status" });
  });

  test("rejects unknown/duplicate flags and every path-bearing daemon form", () => {
    const bad = [
      ["audio"],
      ["audio", "capture"],
      ["audio", "capture", "stop"],
      ["audio", "status", "extra"],
      ["audio", "feed"],
      ["audio", "drain"],
      ["audio", "drain", "--dir", ""],
      ["audio", "stop", "--host", "/tmp"],
      ["audio", "install", "https://example.test", "--capture", "--capture"],
      ["audio", "install", "https://example.test", "--capture=false"],
      ["audio", "install", "https://example.test", "--max-seconds", "0"],
      ["audio", "install", "https://example.test", `--max-seconds=${AUDIO_MAX_SECONDS + 1}`],
      ["audio", "install", "https://example.test", "--max-seconds=1.5"],
      ["audio", "install", "https://example.test", "--max-seconds=2", "--max-seconds=3"],
    ];
    for (const args of bad) expect(() => parseAudioArgs(args)).toThrow();
    for (const args of [
      ["audio", "feed", "/tmp/host.wav"],
      ["audio", "drain", "--dir=/host"],
      ["audio", "stop", "--dir=/host"],
    ])
      expect(() => parseAudioWire(args)).toThrow();
  });

  test("permits HTTPS or exact loopback HTTP and rejects credentials and unsafe origins", () => {
    for (const url of [
      "https://example.test/path?x=1",
      "http://localhost:3000/app",
      "http://127.2.3.4/app",
      "http://[::1]:4000/",
    ])
      expect(audioInstallUrl(url).origin).toBe(new URL(url).origin);
    for (const url of [
      "http://example.test",
      "http://localhost.evil.test",
      "http://192.168.1.2",
      "https://user:secret@example.test",
      "file:///tmp/page",
      "data:text/html,a",
      "https://example.test/\n",
      " https://example.test",
    ])
      expect(() => audioInstallUrl(url)).toThrow();
  });
});

describe("PCM WAV admission", () => {
  test("accepts integer mono and float stereo with exact byte-range offsets", () => {
    expect(validatePcmWav(wav())).toMatchObject({
      format: 1,
      channels: 1,
      sampleRate: 16000,
      frames: 4,
      dataOffset: 44,
      dataBytes: 8,
    });
    const bytes = wav(3, 2, 6, 96000);
    bytes.writeFloatLE(0.75, 44);
    bytes.writeFloatLE(-0.5, 48);
    const backing = Buffer.concat([Buffer.alloc(7), bytes, Buffer.alloc(3)]);
    expect(validatePcmWav(backing.subarray(7, 7 + bytes.length))).toMatchObject({
      format: 3,
      channels: 2,
      frames: 6,
    });
    expect(validateAudioUpload(upload(bytes))).toEqual(upload(bytes));
  });

  test("rejects truncated/overflowing RIFF and inconsistent PCM metadata", () => {
    const mutations = [
      (b: Buffer) => b.writeUInt32LE(b.length, 4),
      (b: Buffer) => b.writeUInt32LE(0xffffffff, 16),
      (b: Buffer) => b.writeUInt32LE(0xffffffff, 40),
      (b: Buffer) => b.writeUInt16LE(6, 20),
      (b: Buffer) => b.writeUInt16LE(3, 22),
      (b: Buffer) => b.writeUInt32LE(7999, 24),
      (b: Buffer) => b.writeUInt16LE(24, 34),
      (b: Buffer) => b.writeUInt16LE(4, 32),
      (b: Buffer) => b.writeUInt32LE(1, 28),
      (b: Buffer) => b.writeUInt32LE(7, 40),
      (b: Buffer) => b.write("JUNK", 36),
    ];
    for (const change of mutations) {
      const bytes = wav();
      change(bytes);
      expect(() => validatePcmWav(bytes)).toThrow();
    }
    expect(() => validatePcmWav(wav().subarray(0, 43))).toThrow();
    expect(() => validatePcmWav(new Uint8Array(AUDIO_MAX_WAV_BYTES + 1))).toThrow();
    const extra = Buffer.concat([wav(), Buffer.from([0])]);
    expect(() => validatePcmWav(extra)).toThrow();
  });

  test("checks chunk padding/duplicates and never accepts nonfinite float samples", () => {
    const original = wav(),
      odd = Buffer.alloc(original.length + 10);
    original.copy(odd, 0, 0, 36);
    odd.write("JUNK", 36);
    odd.writeUInt32LE(1, 40);
    odd[44] = 1;
    original.copy(odd, 46, 36);
    odd.writeUInt32LE(odd.length - 8, 4);
    expect(validatePcmWav(odd).dataOffset).toBe(54);
    const noPad = Buffer.concat([odd.subarray(0, 45), odd.subarray(46)]);
    noPad.writeUInt32LE(noPad.length - 8, 4);
    expect(() => validatePcmWav(noPad)).toThrow();
    const duplicate = Buffer.concat([original, original.subarray(36)]);
    duplicate.writeUInt32LE(duplicate.length - 8, 4);
    expect(() => validatePcmWav(duplicate)).toThrow();
    for (const n of [NaN, Infinity, -Infinity]) {
      const bytes = wav(3);
      bytes.writeFloatLE(n, 44);
      expect(() => validateAudioUpload(upload(bytes))).toThrow();
    }
  });

  test("bounds decoded duration before dispatch and requires canonical base64 upload", () => {
    expect(validatePcmWav(wav(1, 1, 30 * 8000, 8000)).durationSeconds).toBe(30);
    expect(() => validateAudioUpload(upload(wav(1, 1, 30 * 8000 + 1, 8000)))).toThrow();
    const good = upload(wav(1, 1, 1));
    for (const data of [
      good.data + "\n",
      good.data.replace(/=+$/, ""),
      good.data.slice(0, -3) + "B==",
      "-___",
      "data:audio/wav;base64," + good.data,
    ])
      expect(() => validateAudioUpload({ ...good, data })).toThrow();
    expect(() => validateAudioUpload({ ...good, hostPath: "/private/host.wav" })).toThrow();
    expect(() => validateAudioUpload({ ...good, name: "../host.wav" })).toThrow();
    expect(() => validateAudioUpload({ ...good, contentType: "video/webm" })).toThrow();
  });
});

describe("bounded browser results", () => {
  test("normalizes canonical audio MIME and rejects paths, duplicate ids and unknown metadata", () => {
    const raw = drain();
    raw.streams[0]!.mimeType = 'Audio/WebM; codecs="opus"';
    expect(validateAudioDrain(raw).streams[0]!.mimeType).toBe("audio/webm;codecs=opus");
    expect(validateAudioStatus(status()).id).toBe(id);
    const bad = [
      { ...drain(), id: "../../page" },
      { ...drain(), streams: [{ ...drain().streams[0], id: "s-../page" }] },
      { ...drain(), streams: [drain().streams[0], drain().streams[0]] },
      { ...drain(), streams: [{ ...drain().streams[0], mimeType: "video/webm" }] },
      { ...drain(), streams: [{ ...drain().streams[0], mimeType: "audio/webm;codecs=vorbis" }] },
      { ...drain(), streams: [{ ...drain().streams[0], chunks: ["AB=="] }] },
      { ...drain(), streams: [{ ...drain().streams[0], seq: -1 }] },
      { ...drain(), pagePath: "/private" },
      { ...drain(), unsupported: ["https://example.test/private"] },
      { ...drain(), unsupported: ["private-secret-excerpt"] },
    ];
    for (const value of bad) expect(() => validateAudioDrain(value)).toThrow();
    expect(
      validateAudioStatus({ ...status(), unsupported: ["audio-node", "existing-graph"] })
        .unsupported,
    ).toEqual(["audio-node", "existing-graph"]);
    // A renderer connection overflow must still permit recovery of accepted audio.
    expect(validateAudioDrain({ ...drain(), phase: "failed", unsupported: ["connection-overflow"] }).streams).toHaveLength(1);
  });

  test("caps aggregate decoded drain bytes even across individually valid streams", () => {
    const chunk = Buffer.alloc(AUDIO_MAX_DRAIN_BYTES / 2).toString("base64"),
      raw = drain(chunk);
    raw.streams.push({ ...raw.streams[0]!, id: "s-2" });
    raw.streamCount = 2;
    expect(validateAudioDrain(raw).streams).toHaveLength(2);
    raw.streams[1]!.chunks.push("AQID");
    expect(() => validateAudioDrain(raw)).toThrow();
  });

  test("parses JSON/legacy wrappers and never includes browser error excerpts", () => {
    const raw = drain();
    expect(parseAudioResult(JSON.stringify({ result: JSON.stringify(raw) }))).toEqual(raw);
    expect(
      parseAudioResult(`diagnostic\n### Result\n${JSON.stringify(JSON.stringify(raw))}\n### End\n`),
    ).toEqual(raw);
    expect(parseAudioResult(JSON.stringify(status()))).toEqual(status());
    const secret = "private browser recording excerpt";
    for (const input of [
      secret,
      JSON.stringify({ error: secret }),
      JSON.stringify({ result: secret }),
      JSON.stringify({ ...status(), audio: secret }),
    ]) {
      try {
        parseAudioResult(input);
        throw new Error("Should reject");
      } catch (error) {
        expect((error as Error).message).not.toContain(secret);
        expect((error as Error).message).toContain("audio bridge:");
      }
    }
    expect(() => parseAudioResult(secret, true)).toThrow("audio bridge: browser action failed");
    expect(() =>
      parseAudioResult(
        `### Result\n${JSON.stringify(status())}\n### Result\n${JSON.stringify(status())}`,
      ),
    ).toThrow();
  });

  test("accepts only safe daemon-issued receipt metadata in an output envelope", () => {
    const receipt = "12345678-1234-4567-89ab-123456789abc";
    expect(validateAudioDrain({ ...drain(), receipt }).receipt).toBe(receipt);
    for (const value of ["../receipt", "private receipt", 1])
      expect(() => validateAudioDrain({ ...drain(), receipt: value })).toThrow();
  });
});

describe("fixed socket-code builders", () => {
  test("installs before navigating, serializes the self-contained installer, and maps capture limits", async () => {
    const code = buildAudioInstallCode({
      action: "install",
      url: "https://example.test/app",
      capture: true,
      maxSeconds: 9,
    });
    const actions: string[] = [];
    let content = "",
      captures = 0;
    const bridge = {
      status,
      async startCapture() {
        captures++;
      },
    };
    const page = {
      async addInitScript(value: { content: string }) {
        content = value.content;
        actions.push("init");
      },
      async goto(url: string) {
        expect(url).toBe("https://example.test/app");
        actions.push("goto");
      },
      async evaluate(fn: Function, args: unknown) {
        return await runInNewContext(`(${fn.toString()})`, {
          window: { __rechAudioBridge: bridge, __rechAudioBridgeReady: Promise.resolve(true) },
          location: { origin: "https://example.test" },
          Error,
        })(args);
      },
    };
    expect(JSON.parse(await runInNewContext(`(${code})`)(page))).toEqual(status());
    expect(actions).toEqual(["init", "goto"]);
    expect(captures).toBe(1);
    expect(content).toContain('"origin":"https://example.test"');
    expect(content).toContain('"maxCaptureMs":9000');
    expect(() => new Function(content)).not.toThrow();
    expect(() =>
      buildAudioInstallCode({
        action: "install",
        url: "https://example.test",
        capture: false,
        maxSeconds: 61,
      }),
    ).toThrow();
  });

  test("checks origin and bridge id atomically before any feed/action and sends bytes only as data", async () => {
    let feeds = 0;
    const input = upload();
    const bridge = {
      status,
      async feedWav(data: string) {
        expect(data).toBe(input.data);
        feeds++;
        return status();
      },
    };
    const execute = async (origin: string, expectedId: string) => {
      const code = buildAudioActionCode("feed", input, expectedId, "https://example.test");
      const page = {
        async evaluate(fn: Function, args: unknown) {
          return runInNewContext(`(${fn.toString()})`, {
            window: { __rechAudioBridge: bridge },
            location: { origin },
            Error,
          })(args);
        },
      };
      return await runInNewContext(`(${code})`)(page);
    };
    await expect(execute("https://wrong.test", id)).rejects.toThrow("audio bridge unavailable");
    await expect(execute("https://example.test", `b-${"2".repeat(32)}`)).rejects.toThrow(
      "audio bridge unavailable",
    );
    expect(feeds).toBe(0);
    expect(parseAudioResult(await execute("https://example.test", id))).toEqual(status());
    expect(feeds).toBe(1);
    expect(() =>
      buildAudioActionCode("feed", { ...input, data: "');globalThis.pwn=1;//" }),
    ).toThrow();
    expect(() => buildAudioActionCode("stop", input)).toThrow();
    expect(() => buildAudioActionCode("status", undefined, "../id")).toThrow();
    expect(() =>
      buildAudioActionCode("status", undefined, id, "https://example.test/path"),
    ).toThrow();
  });
});
