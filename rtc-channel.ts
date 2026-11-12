// What both ends of a WebRTC connection share, with no Node imports: the invite page
// (public/invite.js) runs this too. See webrtc.ts for the overall design.
import { CONFIRM_TIMEOUT_MS, FLAG_CONFIRM, deriveDirKeys, newRecvState, newSendState, open, pack, randomHex, seal, unpack, type RecvState, type SendState } from "./e2e.ts";

export const SIGNAL_PROTO = "rech-signal-1";
const PING = '{"type":"ping"}';
const KEEPALIVE_MS = 25_000;

export function signalSocketUrl(signal: string, room: string): string {
  const u = new URL(signal);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/${room}`;
  u.search = ""; u.hash = "";
  return u.toString();
}

// ---- sealed channel (shared by both ends) -------------------------------------------------
export type Role = "host" | "client";

/** A DataChannel with the e2e seal/open and confirmation handshake on top. */
export class SealedChannel {
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
    if (this.closed) return Promise.resolve(false);
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
export class SignalSocket {
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
