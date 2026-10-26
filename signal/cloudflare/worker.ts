// rech-signal-1 relay on Cloudflare Workers + a SQLite-backed Durable Object (free plan).
// Same wire as lab/signal.ts. One Durable Object per room; hibernation keeps an idle host's
// socket free of duration charges, and setWebSocketAutoResponse answers its keepalive pings
// without waking the object (waking per ping was ~99.9% of agent-yes's DO time).

export interface Env { ROOMS: DurableObjectNamespace }

const PROTO = "rech-signal-1";
const MAX_CLIENTS = 32;
const PING = '{"type":"ping"}', PONG = '{"type":"pong"}';
const ROOM = /^\/([1-9A-HJ-NP-Za-km-z]{8,32})$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/ping") return Response.json({ "rech-signal": 1 });
    const m = ROOM.exec(url.pathname);
    if (m && req.headers.get("Upgrade")?.toLowerCase() === "websocket")
      return env.ROOMS.get(env.ROOMS.idFromName(m[1]!)).fetch(req);
    return new Response("rech signal server (rech-signal-1)\n");
  },
};

type Attach = { authed: boolean; role?: "host" | "client"; peer?: string };

export class Room {
  constructor(private state: DurableObjectState) {
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch(req: Request): Promise<Response> {
    const offered = (req.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map(s => s.trim());
    if (!offered.includes(PROTO)) return new Response("bad subprotocol", { status: 400 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ authed: false } satisfies Attach);
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": PROTO } });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (raw === PING) return void ws.send(PONG); // fallback; normally auto-answered
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const self = ws.deserializeAttachment() as Attach;

    if (!self.authed) {
      if (msg.type !== "hello" || typeof msg.auth !== "string" || !msg.auth) return ws.close(1008, "expected hello");
      const role = msg.role === "host" ? "host" : "client";
      const host = this.find(a => a.role === "host", ws);
      // The room's auth lives only while someone is in it, like the in-memory relay.
      let auth = await this.state.storage.get<string>("auth");
      if (!host && !this.find(a => a.role === "client", ws)) auth = undefined;
      if (auth === undefined) {
        if (role !== "host") return ws.close(4404, "host offline");
        await this.state.storage.put("auth", msg.auth);
      } else if (auth !== msg.auth) return ws.close(1008, "forbidden");
      let peer = "host";
      if (role === "host") host?.close(1000, "replaced by a newer host connection");
      else {
        if (this.all(a => a.role === "client").length >= MAX_CLIENTS) return ws.close(1013, "room full");
        peer = crypto.randomUUID().slice(0, 8);
      }
      ws.serializeAttachment({ authed: true, role, peer } satisfies Attach);
      ws.send(JSON.stringify({ type: "welcome", peer, hostPresent: role === "host" || !!host }));
      if (role === "client") host?.send(JSON.stringify({ type: "peer-join", peer }));
      return;
    }

    if (self.role === "client") this.find(a => a.role === "host")?.send(JSON.stringify({ ...msg, from: self.peer }));
    else if (typeof msg.to === "string") this.find(a => a.peer === msg.to)?.send(JSON.stringify(msg));
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const self = ws.deserializeAttachment() as Attach;
    if (!self?.authed) return;
    if (self.role === "host") for (const c of this.all(a => a.role === "client", ws)) c.send('{"type":"host-leave"}');
    else this.find(a => a.role === "host", ws)?.send(JSON.stringify({ type: "peer-leave", peer: self.peer }));
    if (!this.all(() => true, ws).length) await this.state.storage.delete("auth");
  }

  private all(pred: (a: Attach) => boolean, except?: WebSocket): WebSocket[] {
    return this.state.getWebSockets().filter(s => {
      if (s === except) return false;
      const a = s.deserializeAttachment() as Attach | null;
      return !!a?.authed && pred(a);
    });
  }
  private find(pred: (a: Attach) => boolean, except?: WebSocket): WebSocket | undefined {
    return this.all(pred, except)[0];
  }
}
