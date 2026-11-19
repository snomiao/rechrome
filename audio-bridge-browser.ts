export interface AudioBridgeConfig {
  origin: string;
  maxBufferedBytes?: number;
  maxCaptureMs?: number;
  maxQueuedSeconds?: number;
}
export interface AudioBridgeStatus {
  id: string;
  phase: "ready" | "capturing" | "stopped" | "failed";
  bufferedBytes: number;
  droppedBytes: number;
  streamCount: number;
  queuedSeconds: number;
  unsupported: string[];
}
export interface AudioBridgeDrain extends AudioBridgeStatus {
  streams: { id: string; mimeType: string; seq: number; chunks: string[]; final: boolean }[];
}
export interface AudioBridge {
  status(): AudioBridgeStatus;
  feedWav(base64: string): Promise<AudioBridgeStatus>;
  startCapture(): Promise<AudioBridgeStatus>;
  drain(): Promise<AudioBridgeDrain>;
  stop(): Promise<AudioBridgeStatus>;
}

/** Everything executable deliberately lives inside this function: the CLI serializes toString(). */
export async function installAudioBridge(config: AudioBridgeConfig): Promise<AudioBridge> {
  const page = window as Window &
    typeof globalThis & {
      __rechAudioBridge?: AudioBridge & {
        __rechRestart?: (next: AudioBridgeConfig) => Promise<AudioBridge>;
      };
      webkitAudioContext?: typeof AudioContext;
    };
  const error = (code: string) => new DOMException(`Audio bridge ${code}.`, "NotAllowedError");
  function validate(value: AudioBridgeConfig) {
    if (
      !value ||
      value.origin !== page.location.origin ||
      new URL(value.origin).origin !== value.origin
    )
      throw error("origin");
    const bytes = value.maxBufferedBytes ?? 2 * 1024 * 1024;
    const duration = value.maxCaptureMs ?? 60000;
    const queued = value.maxQueuedSeconds ?? 30;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 1024 ||
      bytes > 2 * 1024 * 1024 ||
      !Number.isSafeInteger(duration) ||
      duration < 100 ||
      duration > 60000 ||
      !Number.isFinite(queued) ||
      queued <= 0 ||
      queued > 30
    )
      throw error("config");
    return { origin: value.origin, bytes, duration, queued };
  }
  const initial = validate(config);
  if (page.__rechAudioBridge) {
    if (typeof page.__rechAudioBridge.__rechRestart !== "function")
      throw error("already-installed");
    return page.__rechAudioBridge.__rechRestart(config);
  }
  const browser = page as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
    AudioNode?: typeof AudioNode;
    HTMLMediaElement?: typeof HTMLMediaElement;
    Audio?: typeof Audio;
    Document?: typeof Document;
    MutationObserver?: typeof MutationObserver;
    document?: Document;
  };
  const Context = browser.AudioContext ?? browser.webkitAudioContext;
  const NodeClass = browser.AudioNode;
  const MediaClass = browser.HTMLMediaElement;
  const nativeConnect = NodeClass?.prototype.connect;
  const nativeDisconnect = NodeClass?.prototype.disconnect;
  const nativePlay = MediaClass?.prototype.play;
  const muted = MediaClass
    ? Object.getOwnPropertyDescriptor(MediaClass.prototype, "muted")
    : undefined;
  const desiredMute = new WeakMap<HTMLMediaElement, boolean>();
  const devices = navigator.mediaDevices;
  const nativeGum = devices?.getUserMedia?.bind(devices);
  const MAX_STREAMS = 16;
  const MAX_CONNECTIONS = 256;
  const MAX_TRACKS = 128;
  const MAX_FEEDS = 128;
  type Limits = ReturnType<typeof validate>;
  type Recording = {
    id: string;
    mimeType: string;
    recorder: MediaRecorder;
    chunks: { text: string; bytes: number }[];
    seq: number;
    conversion: Promise<void>;
    finished: Promise<void>;
    finish(): void;
    done: boolean;
    finalSent: boolean;
  };
  type Output = {
    context: AudioContext;
    destination: MediaStreamAudioDestinationNode;
    recording: Recording | null;
  };
  type Edge = { source: AudioNode; output: Output; channel: number; input: number };
  type Feed = {
    source: AudioBufferSourceNode;
    buffer: AudioBuffer;
    bytes: number;
    released: boolean;
  };
  type State = {
    limits: Limits;
    id: string;
    phase: AudioBridgeStatus["phase"];
    bytes: number;
    dropped: number;
    unsupported: Set<string>;
    outputs: Map<AudioContext, Output>;
    recordings: Recording[];
    edges: Edge[];
    tracks: Set<MediaStreamTrack>;
    feeds: Set<Feed>;
    virtual: AudioContext | null;
    virtualDestination: MediaStreamAudioDestinationNode | null;
    mediaContext: AudioContext | null;
    elements: WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>;
    mediaElements: Set<HTMLMediaElement>;
    queueEnd: number;
    feeding: boolean;
    deadline: ReturnType<typeof setTimeout> | null;
    stopping: boolean;
    stopped: Promise<AudioBridgeStatus> | null;
  };
  function fresh(limits: Limits): State {
    return {
      limits,
      id: `b-${crypto.randomUUID().replace(/-/g, "")}`,
      phase: "ready",
      bytes: 0,
      dropped: 0,
      // Existing destination connections cannot be enumerated by a renderer SDK.
      unsupported: new Set([
        "existing-graph",
        ...(nativePlay ? ["html-autoplay"] : ["html-media-element"]),
        ...(!devices ? ["media-devices"] : []),
        ...(!nativeConnect || !nativeDisconnect ? ["audio-node"] : []),
      ]),
      outputs: new Map(),
      recordings: [],
      edges: [],
      tracks: new Set(),
      feeds: new Set(),
      virtual: null,
      virtualDestination: null,
      mediaContext: null,
      elements: new WeakMap(),
      mediaElements: new Set(),
      queueEnd: 0,
      feeding: false,
      deadline: null,
      stopping: false,
      stopped: null,
    };
  }
  let state = fresh(initial);
  function actualMute(element: HTMLMediaElement, value: boolean) {
    if (muted?.set) Reflect.apply(muted.set, element, [value]);
    else element.muted = value;
  }
  function secureElement(element: HTMLMediaElement) {
    if (!desiredMute.has(element))
      desiredMute.set(
        element,
        muted?.get ? Boolean(Reflect.apply(muted.get, element, [])) : element.muted,
      );
    if (
      !state.elements.has(element) ||
      state.phase === "stopped" ||
      state.phase === "failed" ||
      state.stopping
    )
      actualMute(element, true);
  }
  // Keep these silence guards after stop: restoring native setters/play could reopen speakers.
  if (MediaClass && muted?.get && muted.set && muted.configurable) {
    Object.defineProperty(MediaClass.prototype, "muted", {
      ...muted,
      set(this: HTMLMediaElement, value: boolean) {
        desiredMute.set(this, Boolean(value));
        actualMute(
          this,
          state.elements.has(this) &&
            state.phase !== "stopped" &&
            state.phase !== "failed" &&
            !state.stopping
            ? Boolean(value)
            : true,
        );
      },
    });
  }
  function secureCreated<T>(element: T): T {
    if (MediaClass && element instanceof MediaClass) secureElement(element);
    return element;
  }
  if (browser.Document) {
    const proto = browser.Document.prototype;
    const create = proto.createElement,
      createNS = proto.createElementNS;
    proto.createElement = function (this: Document, ...args: unknown[]) {
      return secureCreated(Reflect.apply(create, this, args));
    } as Document["createElement"];
    proto.createElementNS = function (this: Document, ...args: unknown[]) {
      return secureCreated(Reflect.apply(createNS, this, args));
    } as Document["createElementNS"];
  }
  if (browser.Audio) {
    const NativeAudio = browser.Audio;
    const WrappedAudio = new Proxy(NativeAudio, {
      construct(target, args, newTarget) {
        return secureCreated(Reflect.construct(target, args, newTarget));
      },
      apply(target, receiver, args) {
        return secureCreated(Reflect.apply(target, receiver, args));
      },
    });
    try {
      Object.defineProperty(page, "Audio", {
        configurable: true,
        writable: true,
        value: WrappedAudio,
      });
    } catch {
      state.unsupported.add("html-autoplay");
    }
  }
  if (browser.document) {
    const secureTree = (node: Node) => {
      if (MediaClass && node instanceof MediaClass) secureElement(node);
      const element = node as Element;
      if (typeof element.querySelectorAll === "function")
        for (const media of element.querySelectorAll("audio,video"))
          secureElement(media as HTMLMediaElement);
    };
    secureTree(browser.document);
    if (browser.MutationObserver) {
      const observer = new browser.MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) secureTree(node);
      });
      observer.observe(browser.document, { childList: true, subtree: true });
      // This observer is a permanent fail-closed guard, not a capture/recording resource.
    }
  }
  const checkOrigin = (s: State) => {
    if (page.location.origin !== s.limits.origin) throw error("origin");
  };
  const accepting = (s: State) => {
    checkOrigin(s);
    if (s.phase === "stopped" || s.phase === "failed" || s.stopping) throw error("stopped");
  };
  function status(s: State): AudioBridgeStatus {
    checkOrigin(s);
    return {
      id: s.id,
      phase: s.phase,
      bufferedBytes: s.bytes,
      droppedBytes: s.dropped,
      streamCount: s.recordings.length,
      queuedSeconds: s.virtual
        ? Math.max(0, Math.min(s.limits.queued, s.queueEnd - s.virtual.currentTime))
        : 0,
      unsupported: [...s.unsupported].sort(),
    };
  }
  function base64(bytes: Uint8Array): string {
    let binary = "";
    for (let n = 0; n < bytes.length; n += 0x4000)
      binary += String.fromCharCode(...bytes.subarray(n, n + 0x4000));
    return btoa(binary);
  }
  function release(s: State, feed: Feed) {
    if (feed.released) return;
    feed.released = true;
    for (let channel = 0; channel < feed.buffer.numberOfChannels; channel++)
      feed.buffer.getChannelData(channel).fill(0);
    try {
      if (nativeDisconnect) Reflect.apply(nativeDisconnect, feed.source, []);
    } catch {
      /* Already disconnected. */
    }
    s.feeds.delete(feed);
    s.bytes = Math.max(0, s.bytes - feed.bytes);
  }
  function fail(s: State, code: string, dropped = 0) {
    s.dropped = Math.min(Number.MAX_SAFE_INTEGER, s.dropped + Math.max(0, dropped));
    if (s.phase === "failed" || s.phase === "stopped") return;
    s.phase = "failed";
    s.unsupported.add(code);
    void stopState(s);
  }
  function charge(s: State, bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > s.limits.bytes - s.bytes) {
      fail(s, "buffer-overflow", Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0);
      return false;
    }
    s.bytes += bytes;
    return true;
  }
  function record(s: State, output: Output) {
    if (output.recording || s.phase !== "capturing" || s.stopping) return;
    if (typeof MediaRecorder === "undefined" || s.recordings.length >= MAX_STREAMS) {
      fail(s, "media-recorder");
      throw error("unsupported");
    }
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
    if (!mimeType) {
      fail(s, "media-recorder");
      throw error("unsupported");
    }
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(output.destination.stream, { mimeType });
    } catch {
      fail(s, "media-recorder");
      throw error("unsupported");
    }
    const item: Recording = {
      id: `s-${s.recordings.length + 1}`,
      mimeType,
      recorder,
      chunks: [],
      seq: 0,
      conversion: Promise.resolve(),
      finished,
      finish,
      done: false,
      finalSent: false,
    };
    output.recording = item;
    s.recordings.push(item);
    recorder.addEventListener("dataavailable", (event) => {
      const blob = event.data;
      if (!(blob instanceof Blob) || !Number.isSafeInteger(blob.size) || blob.size < 0) {
        fail(s, "capture-data");
        return;
      }
      if (!blob.size) return;
      if (item.done) {
        s.dropped = Math.min(Number.MAX_SAFE_INTEGER, s.dropped + blob.size);
        return;
      }
      if (s.phase === "failed") {
        s.dropped = Math.min(Number.MAX_SAFE_INTEGER, s.dropped + blob.size);
        return;
      }
      // Reserve before the asynchronous conversion; Blob memory cannot outrun this budget.
      if (!charge(s, blob.size)) return;
      item.conversion = item.conversion.then(async () => {
        try {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          if (bytes.length !== blob.size) throw error("capture-data");
          item.chunks.push({ text: base64(bytes), bytes: bytes.length });
        } catch {
          s.bytes = Math.max(0, s.bytes - blob.size);
          fail(s, "capture-data", blob.size);
        }
      });
    });
    recorder.addEventListener("stop", () => {
      item.done = true;
      finish();
    });
    recorder.addEventListener("error", () => {
      fail(s, "media-recorder");
    });
    try {
      recorder.start(250);
    } catch {
      item.done = true;
      finish();
      fail(s, "media-recorder");
      throw error("unsupported");
    }
  }
  function outputFor(s: State, context: AudioContext): Output {
    accepting(s);
    let result = s.outputs.get(context);
    if (!result) {
      if (
        s.outputs.size >= MAX_STREAMS ||
        s.tracks.size >= MAX_TRACKS ||
        typeof context.createMediaStreamDestination !== "function"
      ) {
        fail(s, "audio-context");
        throw error("unsupported");
      }
      result = { context, destination: context.createMediaStreamDestination(), recording: null };
      for (const track of result.destination.stream.getTracks()) s.tracks.add(track);
      s.outputs.set(context, result);
    }
    record(s, result);
    return result;
  }
  function connect(source: AudioNode, args: unknown[]) {
    const s = state;
    checkOrigin(s);
    const destination = args[0];
    if (destination === source.context.destination && !("startRendering" in source.context)) {
      accepting(s);
      const output = outputFor(s, source.context as AudioContext),
        channel = args[1] === undefined ? 0 : Number(args[1]) >>> 0,
        input = args[2] === undefined ? 0 : Number(args[2]) >>> 0;
      const existing = s.edges.some(
        (edge) =>
          edge.source === source &&
          edge.output === output &&
          edge.channel === channel &&
          edge.input === input,
      );
      if (!existing && s.edges.length >= MAX_CONNECTIONS) {
        fail(s, "connection-overflow");
        throw error("buffer-overflow");
      }
      // Remove a pre-install edge from this source if it exists; never add a physical edge.
      try {
        Reflect.apply(nativeDisconnect!, source, [destination, channel, input]);
      } catch {
        /* No prior physical connection. */
      }
      Reflect.apply(nativeConnect!, source, [output.destination, ...args.slice(1)]);
      if (!existing) s.edges.push({ source, output, channel, input });
      return destination;
    }
    return Reflect.apply(nativeConnect!, source, args);
  }
  if (NodeClass && nativeConnect && nativeDisconnect) {
    NodeClass.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
      return connect(this, args);
    } as AudioNode["connect"];
    NodeClass.prototype.disconnect = function (this: AudioNode, ...args: unknown[]) {
      const s = state;
      checkOrigin(s);
      const output = s.outputs.get(this.context as AudioContext);
      if (args[0] === this.context.destination && output) {
        const result = Reflect.apply(nativeDisconnect, this, [
          output.destination,
          ...args.slice(1),
        ]);
        s.edges = s.edges.filter(
          (edge) =>
            edge.source !== this ||
            edge.output !== output ||
            (args[1] !== undefined && edge.channel !== Number(args[1]) >>> 0) ||
            (args[2] !== undefined && edge.input !== Number(args[2]) >>> 0),
        );
        return result;
      }
      const result = Reflect.apply(nativeDisconnect, this, args);
      if (!args.length) s.edges = s.edges.filter((edge) => edge.source !== this);
      else if (typeof args[0] === "number")
        s.edges = s.edges.filter(
          (edge) => edge.source !== this || edge.channel !== Number(args[0]) >>> 0,
        );
      return result;
    } as AudioNode["disconnect"];
  } else state.unsupported.add("audio-node");

  function virtual(s: State) {
    accepting(s);
    if (!Context) {
      s.unsupported.add("audio-context");
      throw error("unsupported");
    }
    if (!s.virtual) {
      s.virtual = new Context();
      s.virtualDestination = s.virtual.createMediaStreamDestination();
      for (const track of s.virtualDestination.stream.getTracks()) s.tracks.add(track);
    }
    return s.virtualDestination!;
  }
  const getUserMedia = async (constraints: MediaStreamConstraints): Promise<MediaStream> => {
    const s = state;
    checkOrigin(s);
    if (!constraints?.audio) {
      if (!nativeGum) throw error("unsupported");
      return nativeGum(constraints);
    }
    const destination = virtual(s);
    if (s.tracks.size >= MAX_TRACKS) {
      fail(s, "track-overflow");
      throw error("buffer-overflow");
    }
    const audio = destination.stream.getAudioTracks()[0]?.clone();
    if (!audio) throw error("unsupported");
    s.tracks.add(audio);
    try {
      const video = constraints.video
        ? await (nativeGum
            ? nativeGum({ video: constraints.video, audio: false })
            : Promise.reject(error("unsupported")))
        : null;
      try {
        accepting(s);
      } catch {
        for (const track of video?.getTracks() ?? []) track.stop();
        throw error("stopped");
      }
      const tracks = [...(video?.getTracks() ?? []), audio];
      if (s.tracks.size + (video?.getTracks().length ?? 0) > MAX_TRACKS) {
        for (const track of tracks) track.stop();
        fail(s, "track-overflow");
        throw error("buffer-overflow");
      }
      for (const track of tracks) s.tracks.add(track);
      return new MediaStream(tracks);
    } catch {
      audio.stop();
      s.tracks.delete(audio);
      throw error("media-request");
    }
  };
  if (devices)
    Object.defineProperty(devices, "getUserMedia", {
      configurable: true,
      writable: true,
      value: getUserMedia,
    });
  else state.unsupported.add("media-devices");
  // Legacy callback APIs must not become a physical-microphone fallback.
  const legacy = navigator as Navigator & Record<string, unknown>;
  for (const key of ["getUserMedia", "webkitGetUserMedia", "mozGetUserMedia"]) {
    if (typeof legacy[key] === "function")
      Object.defineProperty(legacy, key, {
        configurable: true,
        value: (
          constraints: MediaStreamConstraints,
          success: (stream: MediaStream) => void,
          failure: (error: unknown) => void,
        ) => {
          void getUserMedia(constraints).then(success, failure);
        },
      });
  }
  if (MediaClass && nativePlay) {
    MediaClass.prototype.play = async function (this: HTMLMediaElement) {
      const s = state;
      checkOrigin(s);
      // A stopped bridge remains silent; restoring native play would reopen speakers.
      if (s.phase === "stopped" || s.phase === "failed" || s.stopping) {
        actualMute(this, true);
        throw error("stopped");
      }
      let source = s.elements.get(this);
      if (!source) {
        const previousMute =
          desiredMute.get(this) ??
          (muted?.get ? Boolean(Reflect.apply(muted.get, this, [])) : this.muted);
        actualMute(this, true);
        try {
          if (!Context || this.mediaKeys) {
            s.unsupported.add(this.mediaKeys ? "drm-media-element" : "html-media-element");
            throw error("unsupported");
          }
          s.mediaContext ??= new Context();
          source = s.mediaContext.createMediaElementSource(this);
          connect(source, [s.mediaContext.destination]);
          s.elements.set(this, source);
          s.mediaElements.add(this);
          // createMediaElementSource reroutes the element's output into our silent graph.
          actualMute(this, previousMute);
        } catch {
          s.unsupported.add("html-media-element");
          actualMute(this, true);
          throw error("unsupported");
        }
      }
      try {
        await (source.context as AudioContext).resume();
        accepting(s);
        if (state !== s) throw error("stopped");
        return await nativePlay.call(this);
      } catch {
        throw error("media-play");
      }
    };
    state.unsupported.add("html-autoplay");
  } else state.unsupported.add("html-media-element");

  async function stopState(s: State): Promise<AudioBridgeStatus> {
    if (s.stopped) return s.stopped;
    s.stopping = true;
    if (s.phase !== "failed") s.phase = "stopped";
    for (const element of s.mediaElements) actualMute(element, true);
    if (s.deadline !== null) {
      clearTimeout(s.deadline);
      s.deadline = null;
    }
    // Defer cleanup one microtask so s.stopped is installed before synchronous recorder callbacks.
    s.stopped = Promise.resolve().then(async () => {
      for (const feed of [...s.feeds]) {
        try {
          feed.source.stop();
        } catch {
          /* Already ended. */
        }
        release(s, feed);
      }
      for (const item of s.recordings) {
        if (item.done) continue;
        try {
          if (item.recorder.state !== "inactive") item.recorder.stop();
        } catch {
          item.done = true;
          item.finish();
          s.unsupported.add("media-recorder");
        }
      }
      await Promise.all(
        s.recordings.map(async (item) => {
          if (item.done) return;
          const timer = setTimeout(() => {
            item.done = true;
            item.finish();
            s.phase = "failed";
            s.unsupported.add("recorder-timeout");
          }, 2000);
          try {
            await item.finished;
          } finally {
            clearTimeout(timer);
          }
        }),
      );
      for (const edge of s.edges) {
        try {
          if (nativeDisconnect)
            Reflect.apply(nativeDisconnect, edge.source, [
              edge.output.destination,
              edge.channel,
              edge.input,
            ]);
        } catch {
          /* Page already disconnected. */
        }
      }
      s.edges.length = 0;
      for (const track of s.tracks) {
        try {
          track.stop();
        } catch {
          /* Already ended. */
        }
      }
      s.tracks.clear();
      s.mediaElements.clear();
      await Promise.all(
        [s.virtual, s.mediaContext]
          .filter((context): context is AudioContext => !!context)
          .map(async (context) => {
            try {
              await context.close();
            } catch {
              /* Already closed. */
            }
          }),
      );
      await Promise.all(s.recordings.map((item) => item.conversion));
      s.virtual = null;
      s.virtualDestination = null;
      s.mediaContext = null;
      s.queueEnd = 0;
      s.stopping = false;
      return status(s);
    });
    return s.stopped;
  }
  function wav(input: string, maximum: number) {
    if (
      typeof input !== "string" ||
      !input.length ||
      input.length > Math.ceil(maximum / 3) * 4 ||
      input.length % 4
    )
      throw error("wav");
    let raw: string;
    try {
      raw = atob(input);
    } catch {
      throw error("wav");
    }
    if (raw.length < 44 || raw.length > maximum || btoa(raw) !== input) throw error("wav");
    const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0)),
      view = new DataView(bytes.buffer);
    const text = (at: number, length: number) =>
      String.fromCharCode(...bytes.subarray(at, at + length));
    if (
      text(0, 4) !== "RIFF" ||
      text(8, 4) !== "WAVE" ||
      view.getUint32(4, true) + 8 !== bytes.length
    )
      throw error("wav");
    let format = 0,
      channels = 0,
      rate = 0,
      bits = 0,
      align = 0,
      data = -1,
      size = 0;
    for (let at = 12; at < bytes.length; ) {
      if (bytes.length - at < 8) throw error("wav");
      const name = text(at, 4),
        length = view.getUint32(at + 4, true),
        start = at + 8;
      if (length > bytes.length - start) throw error("wav");
      if (name === "fmt ") {
        if (format || length < 16) throw error("wav");
        format = view.getUint16(start, true);
        channels = view.getUint16(start + 2, true);
        rate = view.getUint32(start + 4, true);
        align = view.getUint16(start + 12, true);
        bits = view.getUint16(start + 14, true);
        if (view.getUint32(start + 8, true) !== rate * align) throw error("wav");
      } else if (name === "data") {
        if (data !== -1) throw error("wav");
        data = start;
        size = length;
      }
      at = start + length + (length % 2);
      if (at > bytes.length) throw error("wav");
    }
    if (
      ![1, 3].includes(format) ||
      ![8, 16, 24, 32].includes(bits) ||
      (format === 3 && bits !== 32) ||
      channels < 1 ||
      channels > 8 ||
      rate < 8000 ||
      rate > 192000 ||
      align !== (channels * bits) / 8 ||
      data < 0 ||
      !size ||
      size % align
    )
      throw error("wav");
    const frames = size / align,
      decodedBytes = frames * channels * 4;
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes > maximum) throw error("wav");
    return { view, data, format, channels, rate, bits, align, frames, decodedBytes };
  }
  const api: AudioBridge & { __rechRestart?: (next: AudioBridgeConfig) => Promise<AudioBridge> } = {
    status() {
      return status(state);
    },
    async feedWav(input) {
      const s = state;
      accepting(s);
      if (s.feeding) throw error("busy");
      if (s.feeds.size >= MAX_FEEDS) {
        fail(s, "input-overflow");
        throw error("buffer-overflow");
      }
      const parsed = wav(input, s.limits.bytes),
        duration = parsed.frames / parsed.rate;
      const destination = virtual(s),
        context = s.virtual!;
      if (Math.max(0, s.queueEnd - context.currentTime) + duration > s.limits.queued) {
        fail(s, "input-overflow");
        throw error("input-overflow");
      }
      if (!charge(s, parsed.decodedBytes)) throw error("buffer-overflow");
      s.feeding = true;
      let feed: Feed | null = null;
      try {
        const buffer = context.createBuffer(parsed.channels, parsed.frames, parsed.rate);
        const source = context.createBufferSource();
        source.buffer = buffer;
        feed = { source, buffer, bytes: parsed.decodedBytes, released: false };
        s.feeds.add(feed);
        for (let channel = 0; channel < parsed.channels; channel++) {
          const values = buffer.getChannelData(channel);
          for (let n = 0; n < parsed.frames; n++) {
            const at = parsed.data + n * parsed.align + (channel * parsed.bits) / 8;
            let value: number;
            if (parsed.format === 3) value = parsed.view.getFloat32(at, true);
            else if (parsed.bits === 8) value = (parsed.view.getUint8(at) - 128) / 128;
            else if (parsed.bits === 16) value = parsed.view.getInt16(at, true) / 32768;
            else if (parsed.bits === 24) {
              let integer =
                parsed.view.getUint8(at) |
                (parsed.view.getUint8(at + 1) << 8) |
                (parsed.view.getUint8(at + 2) << 16);
              if (integer & 0x800000) integer -= 0x1000000;
              value = integer / 8388608;
            } else value = parsed.view.getInt32(at, true) / 2147483648;
            if (!Number.isFinite(value) || Math.abs(value) > 1) throw error("wav");
            values[n] = value;
          }
        }
        Reflect.apply(nativeConnect!, source, [destination]);
        source.onended = () => release(s, feed!);
        accepting(s);
        // resume is requested only by this explicit feed; never connect to speakers.
        void context.resume().catch(() => {
          fail(s, "audio-context");
        });
        const start = Math.max(context.currentTime, s.queueEnd);
        source.start(start);
        s.queueEnd = start + duration;
        return status(s);
      } catch {
        if (feed) release(s, feed);
        else s.bytes = Math.max(0, s.bytes - parsed.decodedBytes);
        throw error("wav");
      } finally {
        s.feeding = false;
      }
    },
    async startCapture() {
      const s = state;
      accepting(s);
      if (s.phase === "capturing") return status(s);
      if (typeof MediaRecorder === "undefined") {
        fail(s, "media-recorder");
        throw error("unsupported");
      }
      s.phase = "capturing";
      for (const output of s.outputs.values()) record(s, output);
      s.deadline = setTimeout(() => {
        void stopState(s);
      }, s.limits.duration);
      return status(s);
    },
    async drain() {
      const s = state;
      checkOrigin(s);
      await Promise.all(s.recordings.map((item) => item.conversion));
      const streams: AudioBridgeDrain["streams"] = [];
      for (const item of s.recordings) {
        const chunks = item.chunks.splice(0),
          final = item.done;
        if (!chunks.length && (!final || item.finalSent)) continue;
        streams.push({
          id: item.id,
          mimeType: item.mimeType,
          seq: item.seq,
          chunks: chunks.map((chunk) => chunk.text),
          final,
        });
        item.seq += chunks.length;
        if (final) item.finalSent = true;
        s.bytes = Math.max(0, s.bytes - chunks.reduce((sum, chunk) => sum + chunk.bytes, 0));
      }
      return { ...status(s), streams };
    },
    async stop() {
      const s = state;
      checkOrigin(s);
      return stopState(s);
    },
  };
  Object.defineProperty(api, "__rechRestart", {
    value: async (next: AudioBridgeConfig) => {
      const limits = validate(next),
        old = state;
      if (old.phase === "capturing" || old.stopping || old.bytes > 0) throw error("pending-data");
      await stopState(old);
      state = fresh(limits);
      return api;
    },
  });
  Object.freeze(api);
  Object.defineProperty(page, "__rechAudioBridge", {
    configurable: false,
    writable: false,
    value: api,
  });
  return api;
}
