import { expect, test } from "bun:test";
import { createAudioHandler } from "./audio-bridge-server.ts";

const id = "b-" + "a".repeat(32);
const status = (phase = "ready") => ({
  id,
  phase,
  bufferedBytes: 0,
  droppedBytes: 0,
  streamCount: 1,
  queuedSeconds: 0,
  unsupported: ["existing-graph"],
});
const request = (args: string[], upload?: unknown) => ({
  args,
  upload,
  socketRoot: "/fixture",
  session: "fixture-session",
  cwd: "/fixture",
});

test("pending audio is cached across retries and acknowledged only by its receipt", async () => {
  let drains = 0;
  const handler = createAudioHandler(async (opts) => {
    if (opts.code.includes('"action":"drain"')) {
      drains++;
      return {
        isError: false,
        text: JSON.stringify({
          ...status("capturing"),
          streams: [
            {
              id: "s-1",
              mimeType: "audio/webm",
              seq: 0,
              chunks: [Buffer.from("fixture-packet").toString("base64")],
              final: false,
            },
          ],
        }),
      };
    }
    return { isError: false, text: JSON.stringify(status()) };
  });
  expect((await handler(request(["audio", "install", "https://example.test/live"]))).status).toBe(
    0,
  );
  const first = await handler(request(["audio", "drain"]));
  expect(first.status).toBe(0);
  expect(first.audioOut).toBeDefined();
  const again = await handler(request(["audio", "drain"]));
  expect(again.audioOut).toEqual(first.audioOut);
  expect(drains).toBe(1);
  expect(first.stdout).not.toContain(Buffer.from("fixture-packet").toString("base64"));
  expect((await handler(request(["audio", "ack", "incorrect"]))).status).toBe(1);
  expect((await handler(request(["audio", "install", "https://example.test/live"]))).status).toBe(
    1,
  );
  expect((await handler(request(["audio", "ack", (first.audioOut as any).receipt]))).status).toBe(
    0,
  );
  await handler(request(["audio", "drain"]));
  expect(drains).toBe(2);
});

test("page errors and malformed data never appear in command output", async () => {
  const privateText = "fixture-private-audio";
  const handler = createAudioHandler(async () => ({ isError: true, text: privateText }));
  const reply = await handler(request(["audio", "install", "https://example.test/live"]));
  expect(reply.status).toBe(1);
  expect(JSON.stringify(reply)).not.toContain(privateText);
  const invalid = createAudioHandler(async () => ({
    isError: false,
    text: JSON.stringify({ ...status(), id: "../../output" }),
  }));
  expect((await invalid(request(["audio", "install", "https://example.test/live"]))).status).toBe(
    1,
  );
});

test("actions need the installed generation in the same session and use origin fencing", async () => {
  let code = "";
  const handler = createAudioHandler(async (opts) => {
    code = opts.code;
    return { isError: false, text: JSON.stringify(status()) };
  });
  expect((await handler(request(["audio", "status"]))).status).toBe(1);
  await handler(request(["audio", "install", "https://example.test/live"]));
  expect(
    (await handler({ ...request(["audio", "status"]), session: "another-session" })).status,
  ).toBe(1);
  expect((await handler(request(["audio", "status"]))).status).toBe(0);
  expect(code).toContain('"expectedId":"' + id + '"');
  expect(code).toContain('"expectedOrigin":"https://example.test"');
  expect((await handler(request(["audio", "feed"], { data: "not-wav" }))).status).toBe(1);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};
const jsonReply = (value: unknown) => ({ isError: false, text: JSON.stringify(value) });
const inSession = (session: string, args: string[]) => ({ ...request(args), session });

test("concurrent destructive drains share one retained batch and receipt", async () => {
  const blocked = deferred();
  let drains = 0;
  const handler = createAudioHandler(async (opts) => {
    if (opts.code.includes('"action":"drain"')) {
      drains++;
      await blocked.promise;
      return jsonReply({
        ...status("capturing"),
        streams: [{ id: "s-1", mimeType: "audio/webm", seq: 0, chunks: ["AQID"], final: false }],
      });
    }
    return jsonReply(status());
  });
  await handler(request(["audio", "install", "https://example.test/live"]));
  const first = handler(request(["audio", "drain"])),
    second = handler(request(["audio", "drain"]));
  await flush();
  expect(drains).toBe(1);
  blocked.resolve();
  const [a, b] = await Promise.all([first, second]);
  expect(a.status).toBe(0);
  expect(b.status).toBe(0);
  expect(a.audioOut).toEqual(b.audioOut);
  expect(drains).toBe(1);
  expect((await handler(request(["audio", "ack", (a.audioOut as any).receipt]))).status).toBe(0);
});

test("concurrent installs reserve global capacity before browser work begins and release failures", async () => {
  const blocked = deferred();
  let started = 0;
  const handler = createAudioHandler(async (opts) => {
    started++;
    await blocked.promise;
    if (opts.session === "session-0") throw new Error("synthetic private failure");
    return jsonReply(status());
  });
  const installs = Array.from({ length: 9 }, (_, n) =>
    handler(inSession(`session-${n}`, ["audio", "install", "https://example.test/live"])),
  );
  await flush();
  expect(started).toBe(8);
  expect((await installs[8]!).status).toBe(1);
  blocked.resolve();
  const results = await Promise.all(installs);
  expect(results.filter((result) => result.status === 0)).toHaveLength(7);
  expect(
    (await handler(inSession("replacement", ["audio", "install", "https://example.test/live"])))
      .status,
  ).toBe(0);
  expect(started).toBe(9);
});

test("active reinstall is refused before navigation and final acknowledgements need an empty drain", async () => {
  let phase = "ready",
    installs = 0,
    emitted = false;
  const handler = createAudioHandler(async (opts) => {
    if (opts.code.includes("page.addInitScript")) {
      installs++;
      phase = "ready";
      return jsonReply(status());
    }
    if (opts.code.includes('"action":"capture-start"')) phase = "capturing";
    if (opts.code.includes('"action":"stop"')) phase = "stopped";
    if (opts.code.includes('"action":"drain"')) {
      const streams = emitted
        ? []
        : [{ id: "s-1", mimeType: "audio/webm", seq: 0, chunks: [], final: true }];
      emitted = true;
      return jsonReply({ ...status(phase), streams });
    }
    return jsonReply(status(phase));
  });
  await handler(request(["audio", "install", "https://example.test/live"]));
  await handler(request(["audio", "capture", "start"]));
  expect((await handler(request(["audio", "install", "https://different.test/"]))).status).toBe(1);
  expect(installs).toBe(1);
  const stopped = await handler(request(["audio", "stop"]));
  expect(stopped.audioOut).toBeDefined();
  await handler(request(["audio", "ack", (stopped.audioOut as any).receipt]));
  expect((await handler(request(["audio", "install", "https://example.test/live"]))).status).toBe(
    1,
  );
  await handler(request(["audio", "drain"]));
  expect((await handler(request(["audio", "install", "https://example.test/live"]))).status).toBe(
    0,
  );
  expect(installs).toBe(2);
});

test("timer-stopped sessions cannot be evicted until explicit stop and final empty drain", async () => {
  const phases = new Map<string, string>();
  const handler = createAudioHandler(async (opts) => {
    if (opts.code.includes("page.addInitScript")) {
      phases.set(opts.session, "ready");
      return jsonReply(status());
    }
    if (opts.code.includes('"action":"stop"')) phases.set(opts.session, "stopped");
    const value = status(phases.get(opts.session));
    return jsonReply(opts.code.includes('"action":"drain"') ? { ...value, streams: [] } : value);
  });
  for (let n = 0; n < 8; n++)
    await handler(inSession(`session-${n}`, ["audio", "install", "https://example.test/live"]));
  phases.set("session-0", "stopped");
  await handler(inSession("session-0", ["audio", "status"]));
  await handler(inSession("session-0", ["audio", "drain"]));
  expect(
    (await handler(inSession("ninth", ["audio", "install", "https://example.test/live"]))).status,
  ).toBe(1);
  expect((await handler(inSession("session-0", ["audio", "status"]))).status).toBe(0);
  await handler(inSession("session-0", ["audio", "stop"]));
  expect(
    (await handler(inSession("ninth", ["audio", "install", "https://example.test/live"]))).status,
  ).toBe(0);
  expect((await handler(inSession("session-0", ["audio", "status"]))).status).toBe(1);
});

test("capacity never evicts a retired session with queued browser work", async () => {
  const blocked = deferred();
  let hold = false;
  const handler = createAudioHandler(async (opts) => {
    if (hold && opts.code.includes('"action":"status"')) await blocked.promise;
    if (opts.code.includes("page.addInitScript")) return jsonReply(status());
    return jsonReply(
      opts.code.includes('"action":"drain"')
        ? { ...status("stopped"), streams: [] }
        : status("stopped"),
    );
  });
  for (let n = 0; n < 8; n++) {
    await handler(inSession(`session-${n}`, ["audio", "install", "https://example.test/live"]));
    await handler(inSession(`session-${n}`, ["audio", "stop"]));
  }
  hold = true;
  const reads = Array.from({ length: 8 }, (_, n) =>
    handler(inSession(`session-${n}`, ["audio", "status"])),
  );
  await flush();
  expect(
    (await handler(inSession("ninth", ["audio", "install", "https://example.test/live"]))).status,
  ).toBe(1);
  blocked.resolve();
  expect((await Promise.all(reads)).every((value) => value.status === 0)).toBe(true);
  expect(
    (await handler(inSession("ninth", ["audio", "install", "https://example.test/live"]))).status,
  ).toBe(0);
});

test("failed bridges can restart after explicit stop and confirmed final drain", async () => {
  let installs = 0;
  const handler = createAudioHandler(async (opts) => {
    if (opts.code.includes("page.addInitScript")) {
      installs++;
      return jsonReply(status());
    }
    const value = { ...status("failed"), unsupported: ["buffer-overflow"] };
    return jsonReply(opts.code.includes('"action":"drain"') ? { ...value, streams: [] } : value);
  });
  await handler(request(["audio", "install", "https://example.test/live"]));
  await handler(request(["audio", "status"]));
  expect((await handler(request(["audio", "install", "https://example.test/live"]))).status).toBe(
    1,
  );
  await handler(request(["audio", "stop"]));
  expect((await handler(request(["audio", "install", "https://example.test/live"]))).status).toBe(
    0,
  );
  expect(installs).toBe(2);
});
