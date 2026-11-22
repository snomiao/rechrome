import { readPairResult, type PairTarget } from "./audio-pairing.ts";
import { createHash } from "node:crypto";
import { createPcmGateway, buildPcmRelayCode, pcmStopConfirmed } from "./audio-stream-server.ts";
import { streamOptions } from "./audio-stream.ts";
// Audio bytes travel in a body field and on the existing local session socket,
// never in CLI argv, daemon log messages, or ordinary command output.
import { randomUUID } from "node:crypto";
import { runCodeOnSession } from "./fill-secret.ts";
import {
  parseAudioWire,
  validateAudioUpload,
  buildAudioInstallCode,
  buildAudioActionCode,
  parseAudioResult,
  validateAudioDrain,
  validateAudioStatus,
} from "./audio-bridge.ts";

type Reply = {
  status: number;
  stdout: string;
  stderr: string;
  files: string[];
  audioOut?: unknown;
  audioStream?: unknown;
};
type Session = {
  id: string;
  origin: string;
  phase: string;
  stopConfirmed: boolean;
  drained: boolean;
  pending?: any;
  stream?: ReturnType<typeof createPcmGateway>;
  request?: Request;
};
type RunCode = typeof runCodeOnSession;
type Request = {
  args: string[];
  upload?: unknown;
  socketRoot: string;
  session: string;
  cwd: string;
  expectedGeneration?: string;
};
const MAX_SESSIONS = 8;
function summary(value: any) {
  return validateAudioStatus(
    Object.fromEntries(
      [
        "id",
        "phase",
        "bufferedBytes",
        "droppedBytes",
        "streamCount",
        "queuedSeconds",
        "unsupported",
      ].map((key) => [key, value?.[key]]),
    ),
  );
}

export function createAudioHandler(runCode: RunCode = runCodeOnSession) {
  const sessions = new Map<string, Session>();
  const queues = new Map<string, Promise<void>>();
  const admissions = new Set<string>();
  const retired = (state: Session) =>
    (state.phase === "stopped" || state.phase === "failed") &&
    state.stopConfirmed &&
    state.drained &&
    !state.pending && !state.stream;
  async function execute(request: Request): Promise<Reply> {
    const ok = (value: unknown, audioOut?: unknown): Reply => ({
      status: 0,
      stdout: JSON.stringify(value) + "\n",
      stderr: "",
      files: [],
      ...(audioOut ? { audioOut } : {}),
    });
    const fail = (): Reply => ({
      status: 1,
      stdout: "",
      stderr:
        "audio: operation failed; check the selected page, bridge generation, input format and pending output\n",
      files: [],
    });
    try {
      const state = sessions.get(request.session);
      if (request.expectedGeneration && state?.id !== request.expectedGeneration) return fail();
      if (request.args[1] === "ack") {
        if (
          request.args.length !== 3 ||
          request.upload !== undefined ||
          !state?.pending ||
          request.args[2] !== state.pending.receipt
        )
          return fail();
        state.pending = undefined;
        return ok({ acknowledged: true });
      }
      if (request.args[1] === "stream") {
        if (!state || request.upload !== undefined) return fail();
        if (request.args[2] === "stop" && request.args.length === 3) {
          state.stream?.stop("cancelled");
          return ok({ id: state.id, phase: state.phase });
        }
        if (state.stream || state.phase !== "ready" || state.pending) return fail();
        const options = streamOptions(request.args);
        let running = false;
        const stream = createPcmGateway(options, async (url, key) => {
          running = true;
          let confirmed = false;
          try {
            const reply = await runCode({
              socketRoot: request.socketRoot, session: request.session, cwd: request.cwd,
              code: buildPcmRelayCode(url, key, state.id, state.origin, options),
              json: true, timeoutMs: (options.maxSeconds + 45) * 1000,
            });
            if (reply.isError) throw Error("stream renderer failed");
            confirmed = pcmStopConfirmed(reply.text);
          } finally {
            state.stream = undefined;
            state.phase = confirmed ? "stopped" : "failed";
            state.stopConfirmed = confirmed;
            state.drained = confirmed;
          }
        }, () => { if (!running) state.stream = undefined; });
        state.stream = stream;
        return { ...ok({ id: state.id, phase: state.phase }), audioStream: stream.ticket };
      }
      if (state?.stream) return fail();
      const command = parseAudioWire(request.args);
      if (command.action !== "feed" && request.upload !== undefined) return fail();
      const evaluate = async (code: string) => {
        const result = await runCode({
          socketRoot: request.socketRoot,
          session: request.session,
          cwd: request.cwd,
          code,
          json: true,
        });
        if (result.isError) throw new Error("page operation failed");
        return parseAudioResult(result.text);
      };
      if (command.action === "install") {
        // Never navigate away from an active or incompletely drained document.
        if (state && !retired(state)) return fail();
        if (!state) {
          if (sessions.size + admissions.size >= MAX_SESSIONS) {
            const free = [...sessions].find(([session, s]) => retired(s) && !queues.has(session));
            if (!free) return fail();
            sessions.delete(free[0]);
          }
          // Reserve synchronously before the first browser await: other sessions
          // cannot race this install past the global session limit.
          admissions.add(request.session);
        }
        try {
          const value = summary(await evaluate(buildAudioInstallCode(command)));
          sessions.set(request.session, {
            id: value.id,
            origin: new URL(command.url).origin,
            phase: value.phase,
            stopConfirmed: false,
            drained: false,
            request,
          });
          return ok(value);
        } finally {
          admissions.delete(request.session);
        }
      }
      if (!state) return fail();
      const action = async (name: string, upload?: any) => {
        const result = await evaluate(
          buildAudioActionCode(name as any, upload, state.id, state.origin),
        );
        if (result?.id !== state.id) throw new Error("bridge generation changed");
        return result;
      };
      if (command.action === "feed") {
        validateAudioUpload(request.upload);
        const value = await action("feed", request.upload);
        const safe = summary(value);
        state.phase = safe.phase;
        state.stopConfirmed = false;
        state.drained = false;
        return ok(safe);
      }
      if (command.action === "capture-start" || command.action === "status") {
        const value = summary(await action(command.action));
        state.phase = value.phase;
        if (command.action === "capture-start") {
          state.stopConfirmed = false;
          state.drained = false;
        }
        return ok(value);
      }
      if (command.action === "stop") {
        const stopped = summary(await action("stop"));
        state.phase = stopped.phase;
        // phase alone is insufficient: timer/overflow cleanup can still be
        // waiting for terminal recorder events while reporting a terminal phase.
        state.stopConfirmed = true;
      }
      if (command.action === "drain" || command.action === "stop") {
        // Retain the exact batch until the client durably saves and acknowledges
        // it. A bad output directory or interrupted client must not lose audio.
        if (!state.pending) {
          const raw = await action("drain");
          const batch = validateAudioDrain(raw);
          const safe = summary(raw);
          state.phase = safe.phase;
          state.drained =
            state.stopConfirmed &&
            (safe.phase === "stopped" || safe.phase === "failed") &&
            safe.bufferedBytes === 0 &&
            batch.streams.length === 0;
          if (batch.streams.some((stream: any) => stream.chunks.length || stream.final))
            state.pending = { ...batch, receipt: randomUUID() };
          if (!state.pending) return ok(safe);
        }
        return ok({ id: state.id, phase: state.phase, pending: true }, state.pending);
      }
      return fail();
    } catch {
      // Do not forward page exceptions: they may echo the source or audio bytes.
      return fail();
    }
  }
  const handle = async function handle(request: Request): Promise<Reply> {
    // All generation changes, destructive drains and acknowledgements share
    // the same queue. A drain receipt remains stable until its serialized ack.
    const previous = queues.get(request.session) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    queues.set(request.session, next);
    try {
      await previous;
      return await execute(request);
    } finally {
      release();
      if (queues.get(request.session) === next) queues.delete(request.session);
    }
  };
  const targetId = (session: string, state: Session) => createHash("sha256").update(`${session}\0${state.id}\0${state.origin}`).digest("hex").slice(0, 16);
  const pairTargets = async (): Promise<PairTarget[]> => {
    const entries = await Promise.all([...sessions].map(async ([session, state]) => {
      if (state.phase !== "ready" || state.stream || state.pending || !state.request) return null;
      try {
        const reply = await runCode({ ...state.request, code: `async page => JSON.stringify(await page.evaluate(({id,origin})=>{if(location.origin!==origin||window.__rechAudioBridge?.status().id!==id)throw new Error('chat changed');return{title:document.title}},${JSON.stringify({ id: state.id, origin: state.origin })}))`, json: true, timeoutMs: 3000 });
        if (reply.isError) return null;
        const value = readPairResult(reply.text);
        if (typeof value?.title !== "string" || !value.title.trim()) return null;
        return { id: targetId(session, state), title: value.title.trim().slice(0, 160), origin: state.origin };
      } catch { return null; }
    }));
    return entries.filter((entry): entry is PairTarget => entry !== null);
  };
  return Object.assign(handle, {
    pairTargets,
    async pairGrant(id: string, options: { sourceId: string; origin: string; pcm: { sampleRate: number; channels: number } }) {
      const entry = [...sessions].find(([session, state]) => targetId(session, state) === id);
      if (!entry?.[1].request) throw Error("chat unavailable");
      const [session, state] = entry;
      const request = state.request!;
      const reply = await handle({ ...request, session, expectedGeneration: state.id, args: ["audio", "stream", "open", "--source", options.sourceId, "--destination", `chat-${id}`, "--client-origin", options.origin, "--rate", String(options.pcm.sampleRate), "--channels", String(options.pcm.channels)] });
      if (reply.status !== 0 || !reply.audioStream) throw Error("chat unavailable");
      const stream = state.stream!;
      return { ticket: reply.audioStream as import("./audio-stream.ts").StreamTicket, isActive: () => stream.authenticated, revoke: () => stream.stop("pairing-cancelled") };
    },
  });
}
