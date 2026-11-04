import { expect, test } from "bun:test";
import { parseTransportPicks, transportMenu } from "./rechrome.ts";
import { defaultRtcListener } from "./listeners.ts";

const local = { name: "local", host: "127.0.0.1", port: 1, key: "k", profiles: "*" as const };
const lan = { name: "share-a", host: "192.168.1.5", port: 2, key: "k", profiles: ["a@example.com"] };
const home = { name: "home", kind: "webrtc" as const, signal: "https://signal.example.com/" };

test("the share picker: existing listeners, WebRTC listeners, then new ones for the networks here", () => {
  const menu = transportMenu([local, lan], [home, defaultRtcListener()], [
    { kind: "local", address: "127.0.0.1", label: "" },
    { kind: "lan", address: "192.168.1.5", label: "" },
    { kind: "tailscale", address: "100.64.0.1", label: "" },
  ], "mac.tailnet.ts.net");
  expect(menu.map(m => m.via ?? `+${m.kind}`)).toEqual(["share-a", "home", "webrtc-default", "+lan", "+tailscale", "+webrtc"]);
  expect(menu.map(m => m.key)).toEqual(["1", "2", "3", "4", "5", "6"]);
  expect(menu.find(m => m.kind === "tailscale")!.label).toContain("mac.tailnet.ts.net");
  expect(menu.find(m => m.via === "webrtc-default")!.label).toContain("best effort");
  expect(menu.some(m => m.via === "local")).toBe(false);   // the management listener is never offered
});

test("networks that aren't there aren't offered", () => {
  const menu = transportMenu([local], [defaultRtcListener()], [{ kind: "local", address: "127.0.0.1", label: "" }]);
  expect(menu.map(m => m.via ?? `+${m.kind}`)).toEqual(["webrtc-default", "+webrtc"]);
});

test("picks: numbers separated by commas or spaces; empty shares nothing; anything else asks again", () => {
  const menu = transportMenu([local, lan], [defaultRtcListener()], [{ kind: "local", address: "127.0.0.1", label: "" }]);
  expect(parseTransportPicks("", menu)).toEqual([]);
  expect(parseTransportPicks("1, 2", menu).map(m => m.key)).toEqual(["1", "2"]);
  expect(parseTransportPicks("2 1 2", menu).map(m => m.key)).toEqual(["2", "1"]);
  for (const bad of ["0", "9", "lan", "1,x"]) expect(() => parseTransportPicks(bad, menu)).toThrow(/numbers from 1 to 3/);
});
