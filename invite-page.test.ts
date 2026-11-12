import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { deriveRoom, fetchInviteInfo, inviteLines, renderInvite, type InviteResult, type PingInfo } from "./invite-page.ts";
import { newToken, roomAuthOf, roomOf } from "./secret.ts";
import { BUNDLE, sourceHash } from "./scripts/build-invite-page.ts";

test("the committed bundle is built from the current sources (bun run build-invite-page)", async () => {
  expect(readFileSync(BUNDLE, "utf8").split("\n")[0]).toContain(`source-sha256: ${await sourceHash()}`);
});

test("the page's derivations equal the CLI's", async () => {
  for (let i = 0; i < 20; i++) {
    const token = newToken();
    expect(await deriveRoom(token)).toEqual({ room: roomOf(token), auth: roomAuthOf(token) });
  }
});

test("the bundle and the landing page never build HTML from host data, and don't log", () => {
  const source = readFileSync(new URL("./invite-page.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|console\./);
});

const text = (r: InviteResult) => inviteLines(r).map(l => l.text).join("\n");
const full: PingInfo = {
  share: "alice", kind: "invite", expiresAt: Date.UTC(2030, 0, 2, 3, 4),
  invite: { state: "open", maxDevices: 1, used: 0, expiresAt: Date.UTC(2030, 0, 1) },
  profileInfo: [{ key: "you@example.com", name: "Work", registered: true }, { key: "qa", name: "", registered: false }],
  sessions: [{ name: "default", device: "laptop" }],
};

test("online: share, invite, profiles and sessions", () => {
  const t = text({ state: "online", info: full });
  expect(t).toContain("Host online");
  expect(t).toContain("Share: alice, until 2030-01-02 03:04 UTC");
  expect(t).toContain("Invite: open, 0 of 1 device joined, expires 2030-01-01 00:00 UTC");
  expect(t).toContain("Work (you@example.com)");
  expect(t).toContain("qa: not set up on the host");
  expect(t).toContain("Open sessions:");
  expect(t).toContain("default (device laptop)");
  expect(t).not.toContain("older version");
});

test("sessions: none is said, and an older daemon's missing field is left out", () => {
  expect(text({ state: "online", info: { ...full, sessions: [] } })).toContain("No open sessions.");
  const old = text({ state: "online", info: { share: "alice", kind: "invite", profiles: ["qa"] } });
  expect(old).not.toMatch(/sessions/i);
  expect(old).toContain("Profiles: qa");
  expect(old).toContain("older version");
});

test("used and expired invites say the command won't work", () => {
  const with_ = (state: "used" | "expired") => text({ state: "online", info: { ...full, invite: { state, maxDevices: 1, used: state === "used" ? 1 : 0 } } });
  expect(with_("used")).toContain("already used");
  expect(with_("used")).toContain("someone else did");
  expect(with_("expired")).toContain("expired unused");
});

test("problems on the host are shown", () => {
  const t = text({ state: "online", info: { ...full, chromeAccessProblem: "cannot read the profile folder", degraded: true } });
  expect(t).toContain("Host problem: cannot read the profile folder");
  expect(t).toContain("timed out");
});

test("offline, no path, unknown and failure read differently and hold no details", () => {
  expect(text({ state: "offline" })).toContain("Host offline");
  expect(text({ state: "no-path" })).toContain("Host online, but no direct path");
  expect(text({ state: "unknown" })).toContain("Couldn't check");
  expect(text({ state: "failed", reason: "nope" })).toContain("nope");
});

test("host data reaches the page only as text", () => {
  const made: any[] = [];
  const doc = { createElement: () => { const e = { textContent: "" }; made.push(e); return e; } };
  const el = { textContent: "old", children: [] as any[], append(c: any) { this.children.push(c); } };
  renderInvite(el, { state: "online", info: { ...full, share: "<img src=x onerror=alert(1)>" } }, doc);
  expect(el.textContent).toBe("");
  expect(el.children).toEqual(made);
  expect(made[1].textContent).toContain("<img src=x");
});

// ---- the connection, against a fake signal server and peer -------------------------------------
const RealWebSocket = globalThis.WebSocket;
afterEach(() => { globalThis.WebSocket = RealWebSocket; });

/** A WebSocket whose server side is `script`: called with the hello, and able to send or close. */
function fakeSignal(script: (hello: any, ws: { say: (m: unknown) => void; close: (code: number) => void }) => void) {
  const urls: string[] = [], sent: any[] = [];
  class WS {
    onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: (e: { code: number; reason: string }) => void; onerror?: () => void;
    constructor(url: string) { urls.push(url); queueMicrotask(() => this.onopen?.()); }
    send(raw: string) {
      const m = JSON.parse(raw); sent.push(m);
      if (m.type === "hello") script(m, { say: x => this.onmessage?.({ data: JSON.stringify(x) }), close: code => this.onclose?.({ code, reason: "" }) });
    }
    close() {}
  }
  globalThis.WebSocket = WS as any;
  return { urls, sent };
}

test("a client with no host, or an empty welcome, is offline; the secret stays out of the wire", async () => {
  const token = newToken();
  const a = fakeSignal((_h, ws) => ws.close(4404));
  expect(await fetchInviteInfo(token, { signal: "https://s.example/" })).toEqual({ state: "offline" });
  expect(a.urls[0]).toBe(`wss://s.example/${roomOf(token)}`);
  expect(a.sent[0]).toEqual({ type: "hello", role: "client", auth: roomAuthOf(token) });
  expect(JSON.stringify(a.sent) + a.urls[0]).not.toContain(token);
  fakeSignal((_h, ws) => ws.say({ type: "welcome", peer: "p", hostPresent: false }));
  expect(await fetchInviteInfo(token, { signal: "https://s.example/" })).toEqual({ state: "offline" });
});

test("a host that never gets a peer connection is 'no path', and says so as soon as it's known", async () => {
  fakeSignal((_h, ws) => ws.say({ type: "welcome", peer: "p", hostPresent: true }));
  let seen = false;
  expect(await fetchInviteInfo(newToken(), { signal: "https://s.example/", timeoutMs: 30, onHost: () => { seen = true; } })).toEqual({ state: "no-path" });
  expect(seen).toBe(true);
});

const SDP = (ufrag: string) => `v=0\r\na=setup:actpass\r\na=ice-ufrag:${ufrag}\r\na=fingerprint:sha-256 AA:BB\r\n`;
/** A peer whose DataChannel opens at once, for a host that answers with `frames`. */
function fakePeer(frames: (ArrayBuffer | string)[]) {
  return class {
    onicecandidate?: unknown; onconnectionstatechange?: unknown; connectionState = "new";
    ondatachannel?: (e: { channel: any }) => void;
    localDescription?: { sdp: string };
    async setRemoteDescription() {}
    async createAnswer() { return { type: "answer", sdp: SDP("b") }; }
    async setLocalDescription(d: { sdp: string }) {
      this.localDescription = d;
      const channel: any = { readyState: "open", bufferedAmount: 0, send() {}, close() {} };
      queueMicrotask(() => {
        this.ondatachannel?.({ channel });
        setTimeout(() => { for (const f of frames) channel.onmessage?.({ data: f }); }, 5);
      });
    }
    async addIceCandidate() {}
    close() {}
  };
}
const offering = () => fakeSignal((_h, ws) => {
  ws.say({ type: "welcome", peer: "p", hostPresent: true });
  ws.say({ type: "offer", sdp: SDP("a"), ice: [] });
});

test("a peer that can't prove the secret is a failure, and nothing it sent is shown", async () => {
  offering();
  const forged = new Uint8Array(64); forged[0] = 1;
  const r = await fetchInviteInfo(newToken(), { signal: "https://s.example/", RTCPeerConnection: fakePeer([forged.buffer]) });
  expect(r.state).toBe("failed");
  expect(text(r)).toContain("couldn't prove");
});

test("a plaintext answer is refused too, however convincing", async () => {
  offering();
  const r = await fetchInviteInfo(newToken(), { signal: "https://s.example/", RTCPeerConnection: fakePeer([JSON.stringify({ t: "res", share: "evil" })]) });
  expect(r.state).toBe("failed");
  expect(text(r)).not.toContain("evil");
});
