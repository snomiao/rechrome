// WebRTC transport for shares: the same HTTP API (/ping, /run, /files, …) carried over an
// end-to-end-encrypted DataChannel, so a host behind NAT needs no open port.
//
//   host (rech serve)  ── hello{role:host} ──▶  signal room  ◀── hello{role:client} ──  client
//         offer, candidates ─────────────────────────────▶  answer, candidates
//   ═════════════ DataChannel, peer to peer, sealed with keys the signal server never had ═════════════
//
// One room per credential (an unused invite or a device): room id and room auth are one-way
// HKDF outputs of that credential's rech1_ secret (secret.ts), and so are the AES keys (e2e.ts).
// The client side runs as a small loopback HTTP "bridge", so every existing fetch-based client
// path works unchanged against it.
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
import { roomAuthOf, roomOf } from "./secret.ts";
import { CONFIRM_TIMEOUT_MS, FLAG_CONFIRM, MAX_CHUNK, deriveDirKeys, newRecvState, newSendState, open, pack, randomHex, seal, transcriptHash, unpack, type RecvState, type SendState } from "./e2e.ts";

export const SIGNAL_PROTO = "rech-signal-1";
const PING = '{"type":"ping"}';
const KEEPALIVE_MS = 25_000;
const CONNECT_TIMEOUT_MS = 25_000;
const MAX_PEERS_PER_ROOM = 8;
const DEFAULT_STUN = [{ urls: "stun:stun.cloudflare.com:3478" }, { urls: "stun:stun.l.google.com:19302" }];

type IceServer = { urls: string | string[]; username?: string; credential?: string };
type Log = (msg: string) => void;

// ---- runtime: node-datachannel ---------------------------------------------------------
// A native module. Inside this repo it is a (trusted) dev dependency; a global `bun i -g
// rechrome` can't run its postinstall, so on first use we install it once into
// ~/.rechrome/webrtc, where our own package.json marks it trusted.
export const WEBRTC_RUNTIME_DIR = join(homedir(), ".rechrome", "webrtc");
let rtcModule: Promise<any> | undefined;
export function loadRTC(log: Log = m => console.error(m)): Promise<{ RTCPeerConnection: any }> {
  return rtcModule ??= (async () => {
    try { return await import("node-datachannel/polyfill"); } catch { /* fall through to the runtime dir */ }
    const entry = () => { try { return Bun.resolveSync("node-datachannel/polyfill", WEBRTC_RUNTIME_DIR); } catch { return null; } };
    let path = entry();
    if (path) try { return await import(path); } catch { path = null; }
    log(`[rech] one-time setup: installing WebRTC support (node-datachannel) into ${WEBRTC_RUNTIME_DIR}`);
    mkdirSync(WEBRTC_RUNTIME_DIR, { recursive: true });
    writeFileSync(join(WEBRTC_RUNTIME_DIR, "package.json"), JSON.stringify({
      private: true, dependencies: { "node-datachannel": "^0.32.3" }, trustedDependencies: ["node-datachannel"],
    }, null, 2));
    const proc = Bun.spawn([process.execPath, "install"], { cwd: WEBRTC_RUNTIME_DIR, stdout: "ignore", stderr: "pipe", env: { ...process.env, BUN_BE_BUN: "1" } });
    const [status, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    path = entry();
    if (status !== 0 || !path) throw new Error(`Could not install WebRTC support (node-datachannel): ${stderr.trim().slice(-400) || `bun install exited ${status}`}`);
    return import(path);
  })();
}

export function iceServersFromEnv(env = process.env): IceServer[] {
  if (env.RECH_ICE_SERVERS) {
    try { return JSON.parse(env.RECH_ICE_SERVERS); } catch { throw new Error("RECH_ICE_SERVERS must be a JSON array of {urls, username?, credential?}"); }
  }
  return DEFAULT_STUN;
}

// Short-lived Cloudflare TURN credentials from the HOST owner's own TURN key (CF_TURN_KEY_ID +
// CF_TURN_API_TOKEN), handed to each peer in the offer. Without them: STUN only.
let turnCache: { servers: IceServer[]; exp: number } | null = null;
export async function hostIceServers(log: Log, env = process.env): Promise<IceServer[]> {
  const base = iceServersFromEnv(env);
  const keyId = env.CF_TURN_KEY_ID, apiToken = env.CF_TURN_API_TOKEN;
  if (!keyId || !apiToken) return base;
  if (turnCache && turnCache.exp > Date.now()) return [...base, ...turnCache.servers];
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
      method: "POST", headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 3600 }), signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json() as { iceServers: IceServer | IceServer[] };
    const servers = [body.iceServers].flat();
    turnCache = { servers, exp: Date.now() + 50 * 60_000 };
    return [...base, ...servers];
  } catch (error) {
    log(`Cloudflare TURN credentials unavailable, using STUN only: ${error}`);
    return base;
  }
}

export function signalSocketUrl(signal: string, room: string): string {
  const u = new URL(signal);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/${room}`;
  u.search = ""; u.hash = "";
  return u.toString();
}

// ---- sealed channel (shared by both ends) -------------------------------------------------
type Role = "host" | "client";

/** A DataChannel with the e2e seal/open and confirmation handshake on top. */
class SealedChannel {
  private send = newSendState() as SendState;
  private recv = newRecvState() as RecvState;
  private sendChain = Promise.resolve();
  private recvChain = Promise.resolve();
  private keys?: { mine: CryptoKey; theirs: CryptoKey; th: Uint8Array };
  // Frames can arrive the moment the channel opens, before this side has derived its keys
  // (an async HKDF): hold them until then rather than dropping the connection.
  private keysSet!: () => void;
  private keysReady = new Promise<void>(r => (this.keysSet = r));
  confirmed = false;
  private confirmWaiters: Array<(ok: boolean) => void> = [];
  onFrame: (frame: any) => void = () => {};
  onClose: () => void = () => {};
  private closed = false;

  constructor(private dc: any, private role: Role) {
    dc.binaryType = "arraybuffer";
    dc.onmessage = (e: { data: ArrayBuffer | Uint8Array | string }) => {
      this.recvChain = this.recvChain.then(() => this.receive(e.data)).catch(() => this.close());
    };
    dc.onclose = () => this.close();
  }

  async setKeys(token: string, th: Uint8Array): Promise<void> {
    const { h2c, c2h } = await deriveDirKeys(token, th);
    this.keys = this.role === "host" ? { mine: h2c, theirs: c2h, th } : { mine: c2h, theirs: h2c, th };
    this.keysSet();
  }

  /** Send our confirm frame (counter 0) and wait for the peer's; false on timeout or failure. */
  confirm(): Promise<boolean> {
    const done = new Promise<boolean>(resolve => {
      this.confirmWaiters.push(resolve);
      setTimeout(() => resolve(false), CONFIRM_TIMEOUT_MS);
    });
    void this.sendFrame({ t: "confirm", nonce: randomHex(16), proto: "rech-e2e-1" }, FLAG_CONFIRM);
    return done;
  }

  sendFrame(obj: unknown, flags = 0): Promise<void> {
    this.sendChain = this.sendChain.then(async () => {
      if (this.closed || !this.keys || this.dc.readyState !== "open") return;
      const frame = await seal(this.keys.mine, this.send, flags, this.keys.th, pack(obj));
      // A DataChannel queues without bound; wait out a large backlog (screenshots) instead.
      while (this.dc.bufferedAmount > 4 * 1024 * 1024 && this.dc.readyState === "open") await new Promise(r => setTimeout(r, 10));
      try { this.dc.send(new Uint8Array(frame)); } catch { this.close(); }
    }).catch(() => this.close());
    return this.sendChain;
  }

  private async receive(data: ArrayBuffer | Uint8Array | string): Promise<void> {
    if (this.closed) return;
    if (typeof data === "string") return this.close(); // plaintext is never accepted
    await Promise.race([this.keysReady, new Promise(r => setTimeout(r, CONFIRM_TIMEOUT_MS))]);
    if (!this.keys) return this.close();
    const { plaintext } = await open(this.keys.theirs, data, this.keys.th, this.recv);
    const frame = unpack(plaintext);
    if (!this.confirmed) {
      // The first frame must be the peer's confirm: decrypting it proves the same secret and the
      // same DTLS transcript (no relay in the middle); the transcript makes it unreplayable.
      if (frame?.t !== "confirm") return this.close();
      this.confirmed = true;
      for (const w of this.confirmWaiters.splice(0)) w(true);
      return;
    }
    if (frame?.t === "confirm") return;
    this.onFrame(frame);
  }

  get open(): boolean { return !this.closed && this.dc.readyState === "open"; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.confirmWaiters.splice(0)) w(false);
    try { this.dc.close(); } catch {}
    this.onClose();
  }
}

// Wire frames inside the sealed channel:
//   client → host : {t:"req", id, method, path, ct?, body?} | {t:"abort", id}
//   host → client : {t:"res", id, status, ct} | {t:"data", id, b64} | {t:"end", id, error?}

// ---- signal socket ---------------------------------------------------------------------
class SignalSocket {
  ws?: WebSocket;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private url: string, private hello: { role: Role; auth: string }, private onMessage: (m: any) => void, private onClose: (code: number, reason: string) => void) {}
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, [SIGNAL_PROTO]);
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        ws.send(JSON.stringify({ type: "hello", ...this.hello }));
        this.timer = setInterval(() => { try { ws.send(PING); } catch {} }, KEEPALIVE_MS);
        resolve();
      };
      ws.onmessage = e => { try { const m = JSON.parse(String(e.data)); if (m?.type !== "pong") this.onMessage(m); } catch {} };
      ws.onclose = e => { clearInterval(this.timer); if (!opened) reject(new Error(`signal server ${new URL(this.url).host}: ${e.reason || `closed (${e.code})`}`)); this.onClose(e.code, e.reason); };
      ws.onerror = () => {};
    });
  }
  send(obj: unknown): void { try { this.ws?.send(JSON.stringify(obj)); } catch {} }
  close(): void { clearInterval(this.timer); try { this.ws?.close(); } catch {} }
}

// ---- host ------------------------------------------------------------------------------
export type HostCredential = { token: string; signal: string; label: string };
export type HostHandler = (req: Request, token: string) => Promise<Response>;

/** Keeps one signal room per credential and serves each joining peer through `handler`. */
export class WebrtcHost {
  private rooms = new Map<string, { cred: HostCredential; signal?: SignalSocket; peers: Map<string, { pc: any; channel?: SealedChannel }>; backoff: number; stopped: boolean; retry?: ReturnType<typeof setTimeout> }>();
  constructor(private handler: HostHandler, private log: Log) {}

  /** Open rooms for new credentials, close rooms for ones that are gone. */
  sync(creds: HostCredential[]): void {
    const wanted = new Map(creds.map(c => [`${c.signal}\0${c.token}`, c]));
    for (const [key, room] of this.rooms) if (!wanted.has(key)) { this.stopRoom(room); this.rooms.delete(key); }
    for (const [key, cred] of wanted) {
      if (this.rooms.has(key)) continue;
      const room = { cred, peers: new Map(), backoff: 1000, stopped: false } as any;
      this.rooms.set(key, room);
      void this.connect(room);
    }
  }

  stop(): void { for (const room of this.rooms.values()) this.stopRoom(room); this.rooms.clear(); }

  get size(): number { return this.rooms.size; }

  private stopRoom(room: any): void {
    room.stopped = true;
    clearTimeout(room.retry);
    room.signal?.close();
    for (const peer of room.peers.values()) { peer.channel?.close(); try { peer.pc.close(); } catch {} }
    room.peers.clear();
  }

  private async connect(room: any): Promise<void> {
    if (room.stopped) return;
    const { token, signal } = room.cred;
    const sock = new SignalSocket(signalSocketUrl(signal, roomOf(token)), { role: "host", auth: roomAuthOf(token) },
      m => void this.onSignal(room, m).catch(e => this.log(`webrtc ${room.cred.label}: ${e}`)),
      (code, reason) => {
        if (room.stopped) return;
        if (code === 1000 && /replaced/.test(reason)) { this.log(`webrtc ${room.cred.label}: another host took this room over; not reconnecting`); return; }
        room.retry = setTimeout(() => void this.connect(room), room.backoff);
        room.backoff = Math.min(room.backoff * 2, 30_000);
      });
    room.signal = sock;
    try { await sock.open(); room.backoff = 1000; }
    catch (error) { this.log(`webrtc ${room.cred.label}: ${error instanceof Error ? error.message : error}`); }
  }

  private async onSignal(room: any, m: any): Promise<void> {
    // The relay tags everything a client sends with `from`; only the relay's own notices lack it,
    // so a client can't forge peer-join to make this host open connections.
    if (m.type === "peer-join" && typeof m.peer === "string" && m.from === undefined) {
      if (room.peers.has(m.peer)) this.closePeer(room, m.peer);
      if (room.peers.size >= MAX_PEERS_PER_ROOM) { this.log(`webrtc ${room.cred.label}: too many peers connecting; ignoring ${m.peer}`); return; }
      return this.startPeer(room, m.peer);
    }
    const peer = room.peers.get(m.from);
    if (!peer) return;
    if (m.type === "answer" && typeof m.sdp === "string") {
      await peer.pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
      const th = await transcriptHash(peer.pc.localDescription.sdp, m.sdp);
      peer.keysReady(th);
    } else if (m.type === "candidate" && m.candidate) {
      await peer.pc.addIceCandidate(m.candidate).catch(() => {});
    } else if (m.type === "peer-leave" && m.from === undefined && !peer.channel?.confirmed) {
      this.closePeer(room, m.from);
    }
  }

  private closePeer(room: any, id: string): void {
    const peer = room.peers.get(id);
    if (!peer) return;
    room.peers.delete(id);
    peer.channel?.close();
    try { peer.pc.close(); } catch {}
  }

  private async startPeer(room: any, peerId: string): Promise<void> {
    const { RTCPeerConnection } = await loadRTC(this.log);
    const ice = await hostIceServers(this.log);
    const pc = new RTCPeerConnection({ iceServers: ice });
    let keysReady!: (th: Uint8Array) => void;
    const keys = new Promise<Uint8Array>(r => (keysReady = r));
    const peer: any = { pc, keysReady };
    room.peers.set(peerId, peer);
    const send = (obj: object) => room.signal?.send({ ...obj, to: peerId });
    pc.onicecandidate = (e: any) => { if (e.candidate) send({ type: "candidate", candidate: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid } }); };
    pc.onconnectionstatechange = () => { if (["failed", "closed"].includes(pc.connectionState)) this.closePeer(room, peerId); };
    const dc = pc.createDataChannel("rech");
    const channel = new SealedChannel(dc, "host");
    peer.channel = channel;
    const aborts = new Map<string, AbortController>();
    channel.onClose = () => { for (const a of aborts.values()) a.abort(); this.closePeer(room, peerId); };
    channel.onFrame = frame => void this.onFrame(channel, room.cred.token, aborts, frame);
    dc.onopen = async () => {
      await channel.setKeys(room.cred.token, await keys);
      if (await channel.confirm()) this.log(`webrtc ${room.cred.label}: peer ${peerId} connected`);
      else { this.log(`webrtc ${room.cred.label}: peer ${peerId} failed key confirmation`); channel.close(); }
    };
    // Give up on a peer that never completes the handshake (e.g. ICE never connects).
    setTimeout(() => { if (!channel.confirmed) this.closePeer(room, peerId); }, CONNECT_TIMEOUT_MS + 5000);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: "offer", sdp: pc.localDescription.sdp, ice });
  }

  private async onFrame(channel: SealedChannel, token: string, aborts: Map<string, AbortController>, f: any): Promise<void> {
    if (f?.t === "abort") { aborts.get(f.id)?.abort(); aborts.delete(f.id); return; }
    if (f?.t !== "req" || typeof f.id !== "string" || typeof f.path !== "string" || !f.path.startsWith("/")) return;
    const ac = new AbortController();
    aborts.set(f.id, ac);
    try {
      const req = new Request(`http://webrtc.rech${f.path}`, {
        method: f.method || "GET",
        headers: f.ct ? { "Content-Type": f.ct } : {},
        body: f.body != null && !["GET", "HEAD"].includes(f.method) ? f.body : undefined,
        signal: ac.signal,
      });
      const res = await this.handler(req, token);
      await channel.sendFrame({ t: "res", id: f.id, status: res.status, ct: res.headers.get("content-type") ?? "" });
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done || ac.signal.aborted) break;
          for (let i = 0; i < value.length; i += MAX_CHUNK)
            void channel.sendFrame({ t: "data", id: f.id, b64: Buffer.from(value.subarray(i, i + MAX_CHUNK)).toString("base64") });
        }
      }
      await channel.sendFrame({ t: "end", id: f.id });
    } catch (error) {
      if (!ac.signal.aborted) await channel.sendFrame({ t: "end", id: f.id, error: String(error instanceof Error ? error.message : error) });
    } finally { aborts.delete(f.id); }
  }
}

// ---- client ----------------------------------------------------------------------------
type Pending = { onRes: (status: number, ct: string) => void; onData: (chunk: Uint8Array) => void; onEnd: (error?: string) => void };

/** One client connection to a host's room. `request` sends an HTTP-shaped request over it. */
export class WebrtcClient {
  private channel?: SealedChannel;
  private pc?: any;
  private pending = new Map<string, Pending>();
  onClose: () => void = () => {};
  constructor(private token: string, private signal: string, private log: Log = () => {}) {}

  get connected(): boolean { return !!this.channel?.open && this.channel.confirmed; }

  async connect(): Promise<void> {
    const { RTCPeerConnection } = await loadRTC(this.log);
    const token = this.token;
    let sock: SignalSocket | undefined;
    const result = new Promise<void>((resolve, reject) => {
      const fail = (message: string) => { reject(new Error(message)); };
      const timer = setTimeout(() => fail("timed out connecting to the host over WebRTC (no direct path; the host may be behind a strict NAT: ask them to enable TURN, or use a Tailscale/LAN share)"), CONNECT_TIMEOUT_MS);
      sock = new SignalSocket(signalSocketUrl(this.signal, roomOf(token)), { role: "client", auth: roomAuthOf(token) }, async m => {
        try {
          if (m.type === "welcome" && m.hostPresent === false) fail("the host is offline (its rech daemon isn't connected to the signal server)");
          else if (m.type === "host-leave" && !this.connected) fail("the host left before the connection finished");
          else if (m.type === "offer" && typeof m.sdp === "string" && !this.pc) {
            const pc = new RTCPeerConnection({ iceServers: Array.isArray(m.ice) ? m.ice : iceServersFromEnv() });
            this.pc = pc;
            pc.onicecandidate = (e: any) => { if (e.candidate) sock!.send({ type: "candidate", candidate: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid } }); };
            pc.onconnectionstatechange = () => { if (["failed", "closed"].includes(pc.connectionState)) this.close(); };
            const th = new Promise<Uint8Array>(r => {
              pc.ondatachannel = (e: any) => {
                const channel = new SealedChannel(e.channel, "client");
                this.channel = channel;
                channel.onFrame = f => this.onFrame(f);
                channel.onClose = () => this.close();
                const ready = async () => {
                  await channel.setKeys(token, await th);
                  if (await channel.confirm()) { clearTimeout(timer); resolve(); }
                  else fail("the host could not prove it holds this link's secret (key confirmation failed)");
                };
                if (e.channel.readyState === "open") void ready(); else e.channel.onopen = ready;
              };
              void (async () => {
                await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                sock!.send({ type: "answer", sdp: pc.localDescription.sdp });
                r(await transcriptHash(m.sdp, pc.localDescription.sdp));
              })().catch(e => fail(String(e)));
            });
          } else if (m.type === "candidate" && m.candidate && this.pc) {
            await this.pc.addIceCandidate(m.candidate).catch(() => {});
          }
        } catch (error) { fail(String(error)); }
      }, (code, reason) => { if (!this.connected) fail(code === 4404 ? "the host is offline (its rech daemon isn't connected to the signal server)" : code === 1008 ? `the signal server refused this link (${reason || "forbidden"})` : `signal server closed the connection (${reason || code})`); });
      sock.open().catch(e => fail(e.message));
    });
    try { await result; }
    catch (error) { sock?.close(); this.close(); throw error; }
    // Connected peer to peer: the signal room is no longer needed.
    sock?.close();
  }

  private onFrame(f: any): void {
    const p = this.pending.get(f?.id);
    if (!p) return;
    if (f.t === "res") p.onRes(f.status, f.ct);
    else if (f.t === "data" && typeof f.b64 === "string") p.onData(new Uint8Array(Buffer.from(f.b64, "base64")));
    else if (f.t === "end") { this.pending.delete(f.id); p.onEnd(f.error); }
  }

  /** Send a request; resolves with a streaming Response once the host answers. */
  request(method: string, path: string, body?: string, ct?: string, signal?: AbortSignal): Promise<Response> {
    if (!this.channel || !this.connected) return Promise.reject(new Error("not connected"));
    const id = randomHex(8), channel = this.channel;
    return new Promise((resolve, reject) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start: c => { controller = c; }, cancel: () => { void channel.sendFrame({ t: "abort", id }); this.pending.delete(id); } });
      let answered = false;
      this.pending.set(id, {
        onRes: (status, resCt) => { answered = true; resolve(new Response(stream, { status, headers: resCt ? { "Content-Type": resCt } : {} })); },
        onData: chunk => { try { controller.enqueue(chunk); } catch {} },
        onEnd: error => {
          if (!answered) reject(new Error(error || "the host closed the request"));
          try { error ? controller.error(new Error(error)) : controller.close(); } catch {}
        },
      });
      signal?.addEventListener("abort", () => { void channel.sendFrame({ t: "abort", id }); this.pending.get(id)?.onEnd("aborted"); });
      void channel.sendFrame({ t: "req", id, method, path, ct, body });
    });
  }

  close(): void {
    const had = !!this.pc;
    this.channel?.close();
    try { this.pc?.close(); } catch {}
    this.channel = undefined; this.pc = undefined;
    for (const p of this.pending.values()) p.onEnd("connection closed");
    this.pending.clear();
    if (had) this.onClose();
  }
}

// ---- client bridge: loopback HTTP in front of a WebrtcClient ----------------------------------
export const BRIDGE_DIR = join(homedir(), ".rechrome", "bridges");
export type BridgeInfo = { pid: number; port: number; key: string; signal: string; room: string };
const BRIDGE_IDLE_MS = Number(process.env.RECH_BRIDGE_IDLE_MS) || 15 * 60_000;

export const bridgeFile = (token: string, dir = BRIDGE_DIR) => join(dir, `${roomOf(token)}.json`);

export function readBridge(token: string, dir = BRIDGE_DIR): BridgeInfo | null {
  try { return JSON.parse(readFileSync(bridgeFile(token, dir), "utf8")); } catch { return null; }
}

/** Run a bridge in this process until idle. Writes its port and key to the bridge file. */
export async function runBridge(token: string, signal: string, opts: { dir?: string; log?: Log; port?: number; onStop?: () => void } = {}): Promise<{ info: BridgeInfo; stop: () => void }> {
  const log = opts.log ?? (() => {});
  const dir = opts.dir ?? BRIDGE_DIR;
  const client = new WebrtcClient(token, signal, log);
  let connecting: Promise<void> | null = null;
  const ensure = async () => {
    if (client.connected) return;
    connecting ??= client.connect().finally(() => { connecting = null; });
    await connecting;
  };
  const key = randomBytes(24).toString("base64url");
  let lastUsed = Date.now();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/__bridge") return Response.json({ ok: true, connected: client.connected, pid: process.pid, room: roomOf(token) });
      if (req.headers.get("authorization") !== `Bearer ${key}`) return new Response("Unauthorized", { status: 401 });
      lastUsed = Date.now();
      try { await ensure(); }
      catch (error) { return Response.json({ status: 1, stdout: "", stderr: `[rech] WebRTC: ${error instanceof Error ? error.message : error}\n` }, { status: 502 }); }
      const body = ["GET", "HEAD"].includes(req.method) ? undefined : await req.text();
      try { return await client.request(req.method, url.pathname + url.search, body, req.headers.get("content-type") ?? undefined, req.signal); }
      catch (error) { return Response.json({ status: 1, stdout: "", stderr: `[rech] WebRTC: ${error instanceof Error ? error.message : error}\n` }, { status: 502 }); }
    },
  });
  const info: BridgeInfo = { pid: process.pid, port: server.port!, key, signal, room: roomOf(token) };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = bridgeFile(token, dir);
  writeFileSync(path, JSON.stringify(info), { mode: 0o600 });
  const idle = setInterval(() => { if (Date.now() - lastUsed > BRIDGE_IDLE_MS) stop(); }, 30_000);
  const stop = () => {
    clearInterval(idle);
    client.close();
    server.stop(true);
    try { if (readBridge(token, dir)?.pid === process.pid) unlinkSync(path); } catch {}
    opts.onStop?.();
  };
  // Connect eagerly so the first command doesn't pay for the handshake twice.
  void ensure().catch(error => log(`[rech] WebRTC: ${error instanceof Error ? error.message : error}`));
  return { info, stop };
}

/** A live bridge for this credential, if one answers. */
export async function liveBridge(token: string, dir = BRIDGE_DIR): Promise<BridgeInfo | null> {
  const info = readBridge(token, dir);
  if (!info) return null;
  // Something else may hold a dead bridge's port by now: it must be the bridge for this room.
  const body = await fetch(`http://127.0.0.1:${info.port}/__bridge`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok ? r.json() : null, () => null) as { room?: string; pid?: number } | null;
  if (body?.room === info.room && body.pid === info.pid) return info;
  try { unlinkSync(bridgeFile(token, dir)); } catch {}
  return null;
}

/** Start a detached bridge process (`rech bridge`) and wait for it to answer. */
export async function spawnBridge(token: string, signal: string, entry: string[], dir = BRIDGE_DIR): Promise<BridgeInfo> {
  const existing = await liveBridge(token, dir);
  if (existing) return existing;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logPath = join(dir, `${roomOf(token)}.log`);
  // The token goes through the environment, not argv, so `ps` never shows it.
  const proc = Bun.spawn([...entry, "bridge"], {
    env: { ...process.env, RECH_BRIDGE_TOKEN: token, RECH_BRIDGE_SIGNAL: signal },
    stdin: "ignore", stdout: Bun.file(logPath), stderr: Bun.file(logPath), windowsHide: true,
  });
  proc.unref();
  for (let i = 0; i < 100; i++) {
    const info = await liveBridge(token, dir);
    if (info) return info;
    if (proc.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const tail = existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").slice(-3).join("\n") : "";
  throw new Error(`the local WebRTC bridge did not start${tail ? `:\n${tail}` : ""}`);
}
