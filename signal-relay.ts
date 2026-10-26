// The rech-signal-1 relay: `rech signal serve`. A rendezvous only: it forwards hello / offer /
// answer / candidate frames between one host and its clients in a room, in memory, and forgets
// the room when everyone has left. It never sees a share secret (room ids and auth tokens are
// one-way HKDF outputs of it), and after the handshake traffic goes peer to peer, so running
// your own changes availability and who sees connection metadata, not who can read the browser.
// signal/cloudflare/worker.ts is the same protocol on Cloudflare Workers.
import type { Server, ServerWebSocket } from "bun";

export const SIGNAL_PROTO = "rech-signal-1";
const MAX_CLIENTS = 32;
const MAX_MSG = 64 * 1024;
const PING = '{"type":"ping"}', PONG = '{"type":"pong"}';
const ROOM = /^\/([1-9A-HJ-NP-Za-km-z]{8,32})$/; // base58 room id

type Peer = { room: string; authed: boolean; role?: "host" | "client"; peer?: string };
type Room = { auth: string; host?: ServerWebSocket<Peer>; clients: Map<string, ServerWebSocket<Peer>> };

const LANDING = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>rech signal</title><body style="font:16px/1.6 system-ui;max-width:40em;margin:12vh auto;padding:0 16px">
<h1>rech signal server</h1><p>A WebRTC rendezvous for <a href="https://github.com/snomiao/rechrome">rechrome</a> shares.</p>
<p id=c></p><script>if(/^#rech1_/.test(location.hash)){document.getElementById("c").textContent=
"Connect from a terminal: bunx rechrome connect '"+location.href+"'";}</script>`;

export function startSignalRelay(opts: { host?: string; port?: number; log?: (m: string) => void } = {}): Server<Peer> {
  const rooms = new Map<string, Room>();
  const log = opts.log ?? (() => {});
  const send = (ws: ServerWebSocket<Peer> | undefined, obj: unknown) => ws?.send(JSON.stringify(obj));
  return Bun.serve<Peer>({
    hostname: opts.host ?? "127.0.0.1",
    port: opts.port ?? 8787,
    fetch(req, server) {
      const url = new URL(req.url);
      // `rech connect` probes this to tell a signal host from a rech daemon.
      if (url.pathname === "/ping") return Response.json({ "rech-signal": 1 });
      const m = ROOM.exec(url.pathname);
      if (m && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const offered = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map(s => s.trim());
        if (!offered.includes(SIGNAL_PROTO)) return new Response("bad subprotocol", { status: 400 });
        if (server.upgrade(req, { data: { room: m[1], authed: false }, headers: { "Sec-WebSocket-Protocol": SIGNAL_PROTO } })) return;
        return new Response("upgrade failed", { status: 400 });
      }
      // The share secret rides in the #fragment, which browsers never send here.
      return new Response(LANDING, { headers: { "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer" } });
    },
    websocket: {
      maxPayloadLength: MAX_MSG,
      idleTimeout: 120, // hosts ping every 25 s
      message(ws, raw) {
        if (raw === PING) return void ws.send(PONG);
        let msg: any;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (!msg || typeof msg !== "object") return;
        const self = ws.data;
        if (!self.authed) {
          if (msg.type !== "hello" || typeof msg.auth !== "string" || !msg.auth) return ws.close(1008, "expected hello");
          const role = msg.role === "host" ? "host" : "client";
          let room = rooms.get(self.room);
          if (!room) {
            if (role !== "host") return ws.close(4404, "host offline");
            room = { auth: msg.auth, clients: new Map() };
            rooms.set(self.room, room);
          } else if (room.auth !== msg.auth) return ws.close(1008, "forbidden");
          if (role === "host") {
            if (room.host && room.host !== ws) room.host.close(1000, "replaced by a newer host connection");
            room.host = ws;
            self.peer = "host";
          } else {
            if (room.clients.size >= MAX_CLIENTS) return ws.close(1013, "room full");
            self.peer = crypto.randomUUID().slice(0, 8);
            room.clients.set(self.peer, ws);
          }
          self.authed = true;
          self.role = role;
          send(ws, { type: "welcome", peer: self.peer, hostPresent: !!room.host });
          if (role === "client") send(room.host, { type: "peer-join", peer: self.peer });
          log(`${role} joined a room (${rooms.size} rooms)`);
          return;
        }
        const room = rooms.get(self.room);
        if (!room) return;
        if (self.role === "client") send(room.host, { ...msg, from: self.peer });
        else if (typeof msg.to === "string") send(room.clients.get(msg.to), msg);
      },
      close(ws) {
        const self = ws.data;
        const room = rooms.get(self.room);
        if (!self.authed || !room) return;
        if (self.role === "host" && room.host === ws) {
          room.host = undefined;
          for (const c of room.clients.values()) send(c, { type: "host-leave" });
        } else if (self.role === "client" && self.peer) {
          room.clients.delete(self.peer);
          send(room.host, { type: "peer-leave", peer: self.peer });
        }
        if (!room.host && !room.clients.size) rooms.delete(self.room);
      },
    },
  });
}
