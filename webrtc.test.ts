import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startSignalRelay } from "./signal-relay.ts";
import { newToken, roomAuthOf, roomOf } from "./secret.ts";
import { WebrtcClient, WebrtcHost, liveBridge, runBridge, signalSocketUrl } from "./webrtc.ts";

// Loopback only: no STUN round trips in tests.
process.env.RECH_ICE_SERVERS = "[]";
const relay = startSignalRelay({ port: 0 });
const signal = `http://127.0.0.1:${relay.port}/`;
const quiet = () => {};
afterAll(() => relay.stop(true));

function hostFor(token: string, handler: (req: Request, token: string) => Promise<Response>) {
  const host = new WebrtcHost(handler, quiet);
  host.sync([{ token, signal, label: "test" }]);
  return host;
}
const echo = async (req: Request, token: string) => {
  const url = new URL(req.url);
  if (url.pathname === "/big") return new Response(new Uint8Array(200_000).map((_, i) => i % 251), { headers: { "content-type": "application/octet-stream" } });
  return Response.json({ method: req.method, path: url.pathname + url.search, body: req.method === "POST" ? await req.text() : null, token });
};
const settle = (ms = 300) => new Promise(r => setTimeout(r, ms));

test("relay answers the /ping probe that tells it apart from a daemon", async () => {
  expect(await (await fetch(`${signal}ping`)).json()).toEqual({ "rech-signal": 1 });
  expect(signalSocketUrl("https://x.example/sig/", "Room123abc")).toBe("wss://x.example/sig/Room123abc");
});

test("a client reaches the host's handler end to end, both directions encrypted", async () => {
  const token = newToken();
  const host = hostFor(token, echo);
  await settle();
  const client = new WebrtcClient(token, signal, quiet);
  await client.connect();
  const res = await client.request("POST", "/run?x=1", '{"args":["tab-list"]}', "application/json");
  expect(res.status).toBe(200);
  // The host learns which credential the request came over, without the client sending it.
  expect(await res.json()).toEqual({ method: "POST", path: "/run?x=1", body: '{"args":["tab-list"]}', token });
  const big = new Uint8Array(await (await client.request("GET", "/big")).arrayBuffer());
  expect(big.length).toBe(200_000);
  expect(big[1000]).toBe(1000 % 251);
  client.close(); host.stop();
}, 30_000);

test("a client with a different secret can't even enter the room", async () => {
  const token = newToken();
  const host = hostFor(token, echo);
  await settle();
  // Same room id, wrong auth: the relay refuses before any WebRTC happens.
  const ws = new WebSocket(signalSocketUrl(signal, roomOf(token)), ["rech-signal-1"]);
  const closed = new Promise<number>(r => { ws.onclose = e => r(e.code); });
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", role: "client", auth: roomAuthOf(newToken()) }));
  expect(await closed).toBe(1008);
  host.stop();
}, 15_000);

test("connecting to a room with no host fails fast with a clear reason", async () => {
  const client = new WebrtcClient(newToken(), signal, quiet);
  await expect(client.connect()).rejects.toThrow(/host is offline/);
}, 15_000);

test("the loopback bridge carries plain HTTP and needs its own key", async () => {
  const token = newToken();
  const host = hostFor(token, echo);
  await settle();
  const dir = mkdtempSync(join(tmpdir(), "rech-bridge-"));
  const { info, stop } = await runBridge(token, signal, { dir });
  expect(await liveBridge(token, dir)).toMatchObject({ port: info.port });
  expect((await fetch(`http://127.0.0.1:${info.port}/ping`)).status).toBe(401);
  const res = await fetch(`http://127.0.0.1:${info.port}/ping`, { headers: { Authorization: `Bearer ${info.key}` } });
  expect(await res.json()).toMatchObject({ path: "/ping", token });
  stop(); host.stop();
  expect(await liveBridge(token, dir)).toBeNull();
}, 30_000);

test("a host that drops is reconnected to by the bridge on the next request", async () => {
  const token = newToken();
  let host = hostFor(token, echo);
  await settle();
  const dir = mkdtempSync(join(tmpdir(), "rech-bridge-"));
  const { info, stop } = await runBridge(token, signal, { dir });
  const call = () => fetch(`http://127.0.0.1:${info.port}/ping`, { headers: { Authorization: `Bearer ${info.key}` } });
  expect((await call()).status).toBe(200);
  host.stop();
  await settle(500);
  host = hostFor(token, echo);
  await settle();
  expect((await call()).status).toBe(200);
  stop(); host.stop();
}, 45_000);
