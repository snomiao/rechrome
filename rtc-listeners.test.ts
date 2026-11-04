import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, copyFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { validateListeners, parseIceUrl, iceLabel, rtcListeners, shareRtcListeners, DEFAULT_RTC, type ListenerConfig } from "./listeners.ts";
import { DEFAULT_SIGNAL, webrtcCredentials, type ShareConfig } from "./shares.ts";
import { addRtcListenerTo, iceFromOptions, noTransportError, rtcListenerRows, transportTokens } from "./rechrome.ts";

const local = { name: "local", host: "127.0.0.1", port: 13775, key: "m".repeat(24), profiles: "*" as const };
const config = (rtc: unknown[]): ListenerConfig => ({ version: 1, listeners: [{ ...local }], rtcListeners: rtc as any });

test("WebRTC listeners: a name and a signal server; built-in and duplicate names are refused", () => {
  const ok = validateListeners(config([{ name: "home", kind: "webrtc", signal: "https://signal.example.com" }]));
  expect(ok.rtcListeners![0]!.signal).toBe("https://signal.example.com/");
  for (const bad of [
    [{ name: "home", kind: "webrtc" }],                                              // no signal
    [{ name: "home", kind: "webrtc", signal: "ftp://signal.example.com/" }],
    [{ name: DEFAULT_RTC, kind: "webrtc", signal: "https://signal.example.com/" }],  // built in
    [{ name: "webrtc", kind: "webrtc", signal: "https://signal.example.com/" }],     // legacy name
    [{ name: "local", kind: "webrtc", signal: "https://signal.example.com/" }],      // a socket listener's name
    [{ name: "a", kind: "webrtc", signal: "https://a.example.com/" }, { name: "a", kind: "webrtc", signal: "https://b.example.com/" }],
    [{ name: "home", kind: "webrtc", signal: "https://signal.example.com/", ice: [{ username: "x" }] }],
  ]) expect(() => validateListeners(config(bad))).toThrow();
});

test("a daemon from before WebRTC listeners reads the file unchanged", async () => {
  // Load the validator as released before rtcListeners existed, when git can show it.
  const proc = Bun.spawnSync(["git", "show", "274334d:listeners.ts"], { cwd: import.meta.dir, stderr: "ignore" });
  if (proc.exitCode !== 0) return; // shallow clone: nothing to compare against
  const dir = mkdtempSync(join(tmpdir(), "rech-old-listeners-"));
  writeFileSync(join(dir, "listeners.ts"), proc.stdout);
  copyFileSync(join(import.meta.dir, "scoped-upload.ts"), join(dir, "scoped-upload.ts"));
  const old = await import(join(dir, "listeners.ts"));
  const file = config([{ name: "home", kind: "webrtc", signal: "https://signal.example.com/", ice: [{ urls: "turns:turn.example.com:5349", username: "u", credential: "p" }] }]);
  const read = old.validateListeners(JSON.parse(JSON.stringify(file)));
  expect(read.listeners.map((l: any) => l.name)).toEqual(["local"]);
  expect(read.rtcListeners).toHaveLength(1);   // kept as is, so an old CLI writing the file back keeps it
});

test("TURN credentials go in as one URL and come back without the password", () => {
  expect(parseIceUrl("turns://team:p%40ss@turn.example.com:5349?transport=tcp")).toEqual({ urls: "turns:turn.example.com:5349?transport=tcp", username: "team", credential: "p@ss" });
  expect(parseIceUrl("turn:turn.example.com:3478")).toEqual({ urls: "turn:turn.example.com:3478" });
  expect(parseIceUrl("stun:stun.example.com:3478")).toEqual({ urls: "stun:stun.example.com:3478" });
  for (const bad of ["https://turn.example.com/", "stun://u:p@stun.example.com:3478", "turn://user@turn.example.com:3478", "turn://u:p@turn.example.com:3478?x=1", "turn://u:%zz@turn.example.com:1"])
    expect(() => parseIceUrl(bad)).toThrow();
  const label = iceLabel(parseIceUrl("turns://team:s3cret-pass@turn.example.com:5349"));
  expect(label).toBe("turns://team:…@turn.example.com:5349");
  // The error for a bad URL never repeats it (it can hold a password).
  expect(() => parseIceUrl("turn://u:s3cret-pass@bad host")).toThrow();
  try { parseIceUrl("turn://u:s3cret-pass@bad host"); } catch (e) { expect(String(e)).not.toContain("s3cret-pass"); }
  // listener ls shows the label, never the credential.
  const rows = rtcListenerRows(config([{ name: "home", kind: "webrtc", signal: "https://signal.example.com/", ice: [parseIceUrl("turns://team:s3cret-pass@turn.example.com:5349")] }])).flat().join(" ");
  expect(rows).toContain("turns://team:…@turn.example.com:5349");
  expect(rows).not.toContain("s3cret-pass");
  expect(rows).toContain(DEFAULT_RTC);
});

test("--turn and --turn-env: URLs from flags, then from the named variables", () => {
  expect(iceFromOptions(["stun:stun.example.com:3478"], ["TEAM_TURN"], { TEAM_TURN: "turn://u:p@turn.example.com:3478" }))
    .toEqual([{ urls: "stun:stun.example.com:3478" }, { urls: "turn:turn.example.com:3478", username: "u", credential: "p" }]);
  expect(() => iceFromOptions([], ["MISSING"], {})).toThrow(/MISSING/);
});

test("a new WebRTC listener gets a free name from its signal host", () => {
  const c = config([]);
  expect(addRtcListenerTo(c, { signal: "https://signal.example.com" }).name).toBe("webrtc-signal");
  expect(addRtcListenerTo(c, { signal: "https://signal.example.org" }).name).toBe("webrtc-signal-2");
  expect(addRtcListenerTo(c, { signal: "http://127.0.0.1:8787/" }).name).toBe("webrtc-127-0-0-1");
  expect(() => addRtcListenerTo(c, { name: "local", signal: "https://x.example.com/" })).toThrow(/already exists/);
  expect(() => validateListeners(c)).not.toThrow();
});

test("a share's WebRTC listeners: names in via, the built-in default, and the legacy webrtc + signal", () => {
  const c = config([{ name: "home", kind: "webrtc", signal: "https://signal.example.com/", ice: [{ urls: "turn:turn.example.com:3478" }] }]);
  expect(rtcListeners(c).map(l => l.name)).toEqual(["home", DEFAULT_RTC]);
  expect(shareRtcListeners({ via: ["lan1", "home", DEFAULT_RTC] }, c).map(l => [l.name, l.signal])).toEqual([["home", "https://signal.example.com/"], [DEFAULT_RTC, DEFAULT_SIGNAL]]);
  // Shares made before WebRTC listeners: via ["webrtc"] and their own signal server (or the default).
  expect(shareRtcListeners({ via: ["webrtc"], signal: "https://old.example.com/" }, null)).toEqual([{ name: "webrtc", kind: "webrtc", signal: "https://old.example.com/", builtin: true }]);
  expect(shareRtcListeners({ via: ["webrtc"] }, null)[0]!.signal).toBe(DEFAULT_SIGNAL);
  expect(shareRtcListeners({ via: ["gone"] }, c)).toEqual([]);
});

test("the daemon listens for shares on any WebRTC listener, legacy ones too, and skips socket-only shares", () => {
  const share = (label: string, via: string[]) => ({ id: label, label, invite: `rech1_${label}`, profiles: ["qa"], via, createdAt: 0, maxDevices: 1, devices: [], ...(via.includes("webrtc") ? { signal: DEFAULT_SIGNAL } : {}) });
  const shares: ShareConfig = { version: 1, shares: [share("legacy", ["webrtc"]), share("home", ["home"]), share("dflt", [DEFAULT_RTC]), share("lan", ["lan1"])] } as any;
  expect(webrtcCredentials(shares, 1, ["home"]).map(c => c.share.label)).toEqual(["legacy", "home", "dflt"]);
  expect(webrtcCredentials(shares, 1).map(c => c.share.label)).toEqual(["legacy", "dflt"]);
});

test("rech share has no default transport: flags map to via entries, and none is an error that lists them", () => {
  expect(transportTokens({})).toEqual([]);
  expect(transportTokens({ lan: true, tailscale: true, webrtc: [""] })).toEqual(["lan", "tailscale", "webrtc"]);
  expect(transportTokens({ via: ["lan1,home"], webrtc: ["https://a.example.com/", "https://b.example.com/"] }))
    .toEqual(["lan1", "home", "webrtc=https://a.example.com/", "webrtc=https://b.example.com/"]);
  expect(transportTokens({ signal: "https://a.example.com/" })).toEqual(["webrtc"]);   // --signal alone is WebRTC on it
  expect(transportTokens({ signal: "https://a.example.com/", lan: true })).toEqual(["lan"]);
  const message = noTransportError("qa").message;
  for (const flag of ["--lan", "--tailscale", "--webrtc ", "--webrtc=<url>", "--via <listener>", "no default", "best effort"]) expect(message).toContain(flag);
});
