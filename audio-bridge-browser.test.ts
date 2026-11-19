import { afterEach, describe, expect, it } from "bun:test";
import { installAudioBridge, type AudioBridge } from "./audio-bridge-browser";

const saved = new Map<string, PropertyDescriptor | undefined>();
const bridges: AudioBridge[] = [];
function global(name: string, value: unknown) {
  if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.stop();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});
const tick = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function environment() {
  class Track extends EventTarget {
    kind = "audio";
    stopped = false;
    stop() {
      this.stopped = true;
    }
    clone() {
      const result = new Track();
      result.kind = this.kind;
      return result;
    }
  }
  class Stream {
    constructor(public tracks: Track[] = [new Track()]) {}
    getTracks() {
      return this.tracks;
    }
    getAudioTracks() {
      return this.tracks.filter((track) => track.kind === "audio");
    }
  }
  class Node {
    edges: { destination: unknown; output: number; input: number }[] = [];
    constructor(public context: Context) {}
    connect(destination: unknown, output = 0, input = 0) {
      this.edges.push({ destination, output, input });
      return destination;
    }
    disconnect(destination?: unknown, output?: number, input?: number) {
      if (arguments.length === 0) {
        this.edges = [];
        return;
      }
      const before = this.edges.length;
      if (typeof destination === "number")
        this.edges = this.edges.filter((edge) => edge.output !== destination);
      else
        this.edges = this.edges.filter(
          (edge) =>
            edge.destination !== destination ||
            (output !== undefined && edge.output !== output) ||
            (input !== undefined && edge.input !== input),
        );
      if (before === this.edges.length) throw new Error("not connected");
    }
  }
  class Destination extends Node {
    stream = new Stream();
  }
  class Buffer {
    data: Float32Array[];
    constructor(
      public numberOfChannels: number,
      frames: number,
    ) {
      this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(frames));
    }
    getChannelData(channel: number) {
      return this.data[channel];
    }
  }
  class Source extends Node {
    buffer: Buffer | null = null;
    onended: (() => void) | null = null;
    started: number | null = null;
    stopped = false;
    start(when: number) {
      this.started = when;
    }
    stop() {
      this.stopped = true;
      this.onended?.();
    }
    end() {
      this.onended?.();
    }
  }
  const contexts: Context[] = [];
  class Context {
    destination = new Node(this);
    currentTime = 0;
    state = "running";
    closed = false;
    sources: Source[] = [];
    destinations: Destination[] = [];
    constructor() {
      contexts.push(this);
    }
    createMediaStreamDestination() {
      const value = new Destination(this);
      this.destinations.push(value);
      return value;
    }
    createBuffer(channels: number, frames: number) {
      return new Buffer(channels, frames);
    }
    createBufferSource() {
      const value = new Source(this);
      this.sources.push(value);
      return value;
    }
    createMediaElementSource(_element: Element) {
      return new Node(this);
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
  }
  class Element {
    private muteValue = false;
    get muted() {
      return this.muteValue;
    }
    set muted(value: boolean) {
      this.muteValue = value;
    }
    mediaKeys: unknown = null;
    played = 0;
    play() {
      this.played++;
      return Promise.resolve();
    }
    querySelectorAll(_selector: string) {
      return [];
    }
  }
  class Document {
    elements: Element[] = [];
    createElement(_tag: string) {
      const element = new Element();
      this.elements.push(element);
      return element;
    }
    createElementNS(_namespace: string, _tag: string) {
      return this.createElement(_tag);
    }
    querySelectorAll(_selector: string) {
      return this.elements;
    }
  }
  const observers: MutationObserver[] = [];
  class MutationObserver {
    constructor(public callback: (records: { addedNodes: Element[] }[]) => void) {
      observers.push(this);
    }
    observe(_target: unknown, _options: unknown) {}
  }
  const document = new Document();
  const recorders: Recorder[] = [];
  class Recorder extends EventTarget {
    static isTypeSupported(_type: string) {
      return true;
    }
    state = "inactive";
    mimeType: string;
    constructor(
      public stream: Stream,
      options: { mimeType: string },
    ) {
      super();
      this.mimeType = options.mimeType;
      recorders.push(this);
    }
    start(_slice: number) {
      this.state = "recording";
    }
    data(blob: Blob) {
      const event = new Event("dataavailable");
      Object.defineProperty(event, "data", { value: blob });
      this.dispatchEvent(event);
    }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        this.data(new Blob([new Uint8Array([99])]));
        this.dispatchEvent(new Event("stop"));
      });
    }
  }
  const calls: MediaStreamConstraints[] = [];
  const video = new Track();
  video.kind = "video";
  const devices = {
    async getUserMedia(constraints: MediaStreamConstraints) {
      calls.push(constraints);
      return new Stream([video]);
    },
  };
  const page: Record<string, unknown> = {
    location: { origin: "https://bridge.example" },
    AudioContext: Context,
    AudioNode: Node,
    HTMLMediaElement: Element,
    Document,
    document,
    MutationObserver,
    Audio: class Audio extends Element {},
  };
  global("window", page);
  global("navigator", { mediaDevices: devices });
  global("MediaStream", Stream);
  global("MediaRecorder", Recorder);
  return {
    contexts,
    recorders,
    calls,
    page,
    devices,
    Context,
    Node,
    Element,
    video,
    document,
    observers,
  };
}
function wave(frames = 160, rate = 16000, sample = 16384) {
  const bytes = new Uint8Array(44 + frames * 2),
    view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => {
    for (let n = 0; n < value.length; n++) bytes[at + n] = value.charCodeAt(n);
  };
  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * 2, true);
  for (let n = 0; n < frames; n++) view.setInt16(44 + n * 2, sample, true);
  return btoa(String.fromCharCode(...bytes));
}
async function install(config: Partial<Parameters<typeof installAudioBridge>[0]> = {}) {
  const bridge = await installAudioBridge({ origin: "https://bridge.example", ...config });
  bridges.push(bridge);
  return bridge;
}

describe("serialized renderer audio bridge", () => {
  it("is self-contained and exact-origin scoped before touching browser APIs", async () => {
    const env = environment();
    await expect(install({ origin: "https://other.example" })).rejects.toThrow("origin");
    expect(env.contexts).toHaveLength(0);
    expect(env.page.__rechAudioBridge).toBeUndefined();
    const serialized = (0, eval)(`(${installAudioBridge.toString()})`) as typeof installAudioBridge;
    const bridge = await serialized({ origin: "https://bridge.example" });
    bridges.push(bridge);
    expect(bridge.status().id).toMatch(/^b-[0-9a-f]{32}$/);
    expect(env.contexts).toHaveLength(0);
    expect(bridge.status().phase).toBe("ready");
  });

  it("provides independent virtual audio clones without ever requesting a physical microphone", async () => {
    const env = environment();
    const bridge = await install();
    const first = (await env.devices.getUserMedia({ audio: true })) as unknown as MediaStream;
    const second = (await env.devices.getUserMedia({
      audio: { echoCancellation: true },
    })) as unknown as MediaStream;
    expect(env.calls).toEqual([]);
    expect(first.getAudioTracks()[0]).not.toBe(second.getAudioTracks()[0]);
    expect(env.contexts).toHaveLength(1);
    expect(env.contexts[0].sources).toHaveLength(0);
    first.getAudioTracks()[0].stop();
    expect((second.getAudioTracks()[0] as unknown as { stopped: boolean }).stopped).toBe(false);
    await bridge.stop();
    expect((second.getAudioTracks()[0] as unknown as { stopped: boolean }).stopped).toBe(true);
    await expect(env.devices.getUserMedia({ audio: true })).rejects.toThrow();
    expect(env.calls).toEqual([]);
  });

  it("preserves a requested camera through native video-only constraints", async () => {
    const env = environment();
    await install();
    const stream = (await env.devices.getUserMedia({
      audio: true,
      video: { width: 320 },
    })) as unknown as MediaStream;
    expect(env.calls).toEqual([{ video: { width: 320 }, audio: false }]);
    expect(stream.getTracks()).toHaveLength(2);
  });

  it("queues bounded PCM WAV only into a virtual destination and clears owned samples when ended", async () => {
    const env = environment();
    const bridge = await install();
    await bridge.feedWav(wave());
    const context = env.contexts[0],
      source = context.sources[0];
    expect(source.edges[0].destination).toBe(context.destinations[0]);
    expect(source.edges.some((edge) => edge.destination === context.destination)).toBe(false);
    expect(source.buffer!.getChannelData(0)[0]).toBeCloseTo(0.5);
    expect(bridge.status().bufferedBytes).toBe(640);
    source.end();
    expect(source.buffer!.getChannelData(0).every((value) => value === 0)).toBe(true);
    expect(bridge.status().bufferedBytes).toBe(0);
  });

  it("rejects malformed/encoded non-WAV input without a decoder or microphone fallback", async () => {
    const env = environment();
    const bridge = await install();
    for (const input of [
      "not-base64",
      btoa("an MP3 is not PCM WAV"),
      wave().replace(/=$/, ""),
      wave().slice(4),
    ])
      await expect(bridge.feedWav(input)).rejects.toThrow("wav");
    expect(env.contexts).toHaveLength(0);
    expect(env.calls).toEqual([]);
  });

  it("fails closed on input memory/queue overflow and never restores destination output", async () => {
    const env = environment();
    const bridge = await install({ maxBufferedBytes: 1024 });
    await bridge.feedWav(wave());
    await expect(bridge.feedWav(wave())).rejects.toThrow("overflow");
    await bridge.stop();
    expect(bridge.status().phase).toBe("failed");
    expect(env.contexts[0].closed).toBe(true);
    const context = new env.Context(),
      source = new env.Node(context);
    expect(() => source.connect(context.destination)).toThrow("stopped");
  });

  it("routes destination connect/disconnect correctly, with no recorder before explicit start", async () => {
    const env = environment();
    const bridge = await install();
    const context = new env.Context(),
      source = new env.Node(context),
      other = new env.Node(context);
    expect(source.connect(context.destination, 1, 0)).toBe(context.destination);
    source.connect(other);
    expect(env.recorders).toHaveLength(0);
    const capture = context.destinations[0];
    expect(source.edges.some((edge) => edge.destination === context.destination)).toBe(false);
    source.disconnect(context.destination, 1, 0);
    expect(source.edges.map((edge) => edge.destination)).toEqual([other]);
    source.connect(context.destination);
    await bridge.startCapture();
    expect(env.recorders).toHaveLength(1);
    source.disconnect();
    expect(source.edges).toEqual([]);
    expect(capture.stream.getAudioTracks()[0].stopped).toBe(false);
  });

  it("serializes asynchronous Blob conversion, counts pending bytes, and emits ordered fragments", async () => {
    const env = environment();
    const bridge = await install();
    await bridge.startCapture();
    const context = new env.Context();
    new env.Node(context).connect(context.destination);
    const hold = deferred<ArrayBuffer>();
    class SlowBlob extends Blob {
      override arrayBuffer() {
        return hold.promise;
      }
    }
    env.recorders[0].data(new SlowBlob([new Uint8Array([1, 2])]));
    env.recorders[0].data(new Blob([new Uint8Array([3])]));
    expect(bridge.status().bufferedBytes).toBe(3);
    let done = false;
    const draining = bridge.drain().then((value) => {
      done = true;
      return value;
    });
    await tick();
    expect(done).toBe(false);
    hold.resolve(new Uint8Array([1, 2]).buffer);
    const drained = await draining;
    expect(drained.streams).toEqual([
      {
        id: "s-1",
        mimeType: "audio/webm;codecs=opus",
        seq: 0,
        chunks: [btoa("\x01\x02"), btoa("\x03")],
        final: false,
      },
    ]);
    expect(drained.bufferedBytes).toBe(0);
    await bridge.stop();
    const final = await bridge.drain();
    expect(final.streams[0]).toMatchObject({ seq: 2, chunks: [btoa("c")], final: true });
    expect((await bridge.drain()).streams).toEqual([]);
  });

  it("stop awaits final data without draining it and repeated empty drains terminate", async () => {
    const env = environment();
    const bridge = await install();
    await bridge.startCapture();
    const context = new env.Context();
    new env.Node(context).connect(context.destination);
    env.recorders[0].data(new Blob([new Uint8Array([7])]));
    const stopped = await bridge.stop();
    expect(stopped.phase).toBe("stopped");
    expect(stopped.bufferedBytes).toBe(2);
    const drained = await bridge.drain();
    expect(drained.streams[0].chunks).toEqual([btoa("\x07"), btoa("c")]);
    expect(drained.streams[0].final).toBe(true);
    expect((await bridge.drain()).streams).toEqual([]);
    expect((await bridge.stop()).phase).toBe("stopped");
  });

  it("overflow stops capture while preserving already accepted data and accounting for rejected bytes", async () => {
    const env = environment();
    const bridge = await install({ maxBufferedBytes: 1024 });
    await bridge.startCapture();
    const context = new env.Context();
    new env.Node(context).connect(context.destination);
    env.recorders[0].data(new Blob([new Uint8Array(900)]));
    env.recorders[0].data(new Blob([new Uint8Array(200)]));
    await bridge.stop();
    const drained = await bridge.drain();
    expect(drained.phase).toBe("failed");
    expect(drained.droppedBytes).toBeGreaterThanOrEqual(200);
    expect(drained.streams[0].chunks).toHaveLength(1);
    expect(drained.bufferedBytes).toBe(0);
    expect(context.destinations[0].stream.getAudioTracks()[0].stopped).toBe(true);
  });

  it("reinstall refuses pending data and establishes a new generation only after stop and drain", async () => {
    const env = environment();
    const bridge = await install();
    const firstId = bridge.status().id;
    await bridge.startCapture();
    const context = new env.Context();
    new env.Node(context).connect(context.destination);
    await expect(installAudioBridge({ origin: "https://bridge.example" })).rejects.toThrow(
      "pending-data",
    );
    await bridge.stop();
    await expect(installAudioBridge({ origin: "https://bridge.example" })).rejects.toThrow(
      "pending-data",
    );
    await bridge.drain();
    const next = await installAudioBridge({ origin: "https://bridge.example" });
    expect(next.status().id).not.toBe(firstId);
    expect(next.status().phase).toBe("ready");
    const source = new env.Node(context);
    source.connect(context.destination);
    expect(source.edges[0].destination).not.toBe(context.destination);
  });

  it("routes supported media element play through a silent Web Audio destination and refuses DRM", async () => {
    const env = environment();
    const bridge = await install();
    await bridge.startCapture();
    const element = new env.Element();
    await element.play();
    expect(element.played).toBe(1);
    expect(env.recorders).toHaveLength(1);
    const drm = new env.Element();
    drm.mediaKeys = {};
    await expect(drm.play()).rejects.toThrow("unsupported");
    expect(drm.muted).toBe(true);
    expect(drm.played).toBe(0);
    await bridge.stop();
    await expect(element.play()).rejects.toThrow("stopped");
    expect(element.muted).toBe(true);
  });

  it("automatically stops at the configured duration without a timer extending the capture", async () => {
    environment();
    const bridge = await install({ maxCaptureMs: 100 });
    await bridge.startCapture();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(bridge.status().phase).toBe("stopped");
  });

  it("mutes existing/new/parser media, rejects unrouted unmuting, and keeps guards after stop", async () => {
    const env = environment();
    const existing = env.document.createElement("audio");
    const bridge = await install();
    expect(existing.muted).toBe(true);
    existing.muted = false;
    expect(existing.muted).toBe(true);
    const created = env.document.createElement("audio");
    expect(created.muted).toBe(true);
    created.muted = false;
    expect(created.muted).toBe(true);
    const parserCreated = new env.Element();
    env.observers[0].callback([{ addedNodes: [parserCreated] }]);
    expect(parserCreated.muted).toBe(true);
    const Audio = env.page.Audio as new () => InstanceType<typeof env.Element>;
    expect(new Audio().muted).toBe(true);
    await created.play();
    expect(created.muted).toBe(false); // Only after the owned silent graph exists.
    await bridge.stop();
    expect(created.muted).toBe(true);
    created.muted = false;
    expect(created.muted).toBe(true);
    const afterStop = env.document.createElement("video");
    expect(afterStop.muted).toBe(true);
  });

  it("waits for queued final events when recorder is already inactive", async () => {
    const env = environment();
    const bridge = await install();
    await bridge.startCapture();
    const context = new env.Context();
    new env.Node(context).connect(context.destination);
    env.recorders[0].state = "inactive";
    const stopped = bridge.stop();
    setTimeout(() => {
      env.recorders[0].data(new Blob([new Uint8Array([8])]));
      env.recorders[0].dispatchEvent(new Event("stop"));
    }, 0);
    expect((await stopped).bufferedBytes).toBe(1);
    expect((await bridge.drain()).streams[0].chunks).toEqual([btoa("\x08")]);
  });

  it("emits an empty finalized stream once and rejects late chunks after finalization", async () => {
    const env = environment();
    const bridge = await install();
    await bridge.startCapture();
    const context = new env.Context();
    new env.Node(context).connect(context.destination);
    env.recorders[0].stop = function () {
      this.state = "inactive";
      queueMicrotask(() => this.dispatchEvent(new Event("stop")));
    };
    await bridge.stop();
    expect((await bridge.drain()).streams).toEqual([
      { id: "s-1", mimeType: "audio/webm;codecs=opus", seq: 0, chunks: [], final: true },
    ]);
    env.recorders[0].data(new Blob([new Uint8Array([1])]));
    expect((await bridge.drain()).streams).toEqual([]);
    expect(bridge.status().droppedBytes).toBe(1);
  });
});
