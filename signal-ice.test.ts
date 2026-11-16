import { expect, test } from "bun:test";
import { discoverSignal, iceTransportPolicy, signalIceServers } from "./webrtc.ts";
import { newToken, roomAuthOf, roomOf } from "./secret.ts";

test("host discovers the signal server's ice endpoint and gets TURN for its room", async () => {
  const token = newToken();
  const seen: any[] = [];
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/rechrome") return Response.json({ version: 1, signaling: `ws://${u.host}/rechrome/signaling`, ice: `http://${u.host}/rechrome/ice` });
      if (u.pathname === "/rechrome/ice") { seen.push(await req.json()); return Response.json({ iceServers: [{ urls: ["turn:turn.example:3478"], username: "u", credential: "c" }], ttl: 3600 }); }
      return new Response("rech signal server\n");
    },
  });
  try {
    const base = `http://127.0.0.1:${srv.port}/rechrome`;
    expect((await discoverSignal(base)).ice).toBe(`http://127.0.0.1:${srv.port}/rechrome/ice`);
    const ice = await signalIceServers(base, token, () => {});
    expect(ice[0]!.urls).toEqual(["turn:turn.example:3478"]);
    expect(seen).toEqual([{ room: roomOf(token), auth: roomAuthOf(token) }]);
    await signalIceServers(base, token, () => {}); // cached
    expect(seen.length).toBe(1);
    // A plain signal server (no discovery) gives no TURN and no error.
    expect(await signalIceServers(`http://127.0.0.1:${srv.port}/other`, token, () => {})).toEqual([]);
  } finally { srv.stop(true); }
  expect(iceTransportPolicy({ RECH_ICE_POLICY: "relay" } as any)).toBe("relay");
  expect(iceTransportPolicy({} as any)).toBe("all");
});
