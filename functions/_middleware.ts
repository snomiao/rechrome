// rechrome.pages.dev as the default rech-signal-1 server (see docs/signal-selfhost.md).
//
// Only two kinds of request are ours: GET /ping and a WebSocket upgrade to /<room>. They go to
// the Room Durable Object of the `rech-signal` Worker (signal/cloudflare/), bound to this Pages
// project as ROOMS. Everything else, including every /<file> without an Upgrade header, falls
// through to the static site untouched. Until ROOMS is bound, the signal routes answer 503.
interface Env { ROOMS?: DurableObjectNamespace }

const ROOM = /^\/([1-9A-HJ-NP-Za-km-z]{8,32})$/;
const NOT_CONFIGURED = "rechrome.pages.dev's signal backend is not enabled yet. Share with --signal <your own server> (docs/signal-selfhost.md) or --via tailscale.";

export const onRequest: PagesFunction<Env> = async ({ request, env, next }) => {
  const url = new URL(request.url);
  if (url.pathname === "/ping")
    return env.ROOMS ? Response.json({ "rech-signal": 1 }) : new Response(NOT_CONFIGURED, { status: 503 });
  const room = ROOM.exec(url.pathname);
  if (room && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    if (!env.ROOMS) return new Response(NOT_CONFIGURED, { status: 503 });
    return env.ROOMS.get(env.ROOMS.idFromName(room[1]!)).fetch(request);
  }
  return next();
};
