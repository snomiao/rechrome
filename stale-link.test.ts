import { test, expect } from "bun:test";
import { staleLinkHint, savedLinksBrokenBy, freeListenerPort } from "./rechrome.ts";
import { retirePorts, type Listener } from "./listeners.ts";

const local: Listener = { name: "local", host: "127.0.0.1", port: 13775, key: "m".repeat(24), profiles: "*", prefix: "/" };
const shareAll: Listener = { name: "share-all", host: "127.0.0.1", port: 13777, key: "a".repeat(24), profiles: ["me@example.com", "work@x"], prefix: "/rechrome-all/" };

test("a link whose listener was removed and whose port share --all reused names the exact fix", () => {
  // The reported case: `rech share me --save` wrote /rechrome/me/ on 13777; that listener
  // was removed and `rech share --all` took the free port with its own prefix and key.
  const stale = `http://127.0.0.1:13777/rechrome/me/?profile=me%40example.com#key=${"s".repeat(24)}`;
  const hint = staleLinkHint(stale, [local, shareAll], "/repo/.rechrome/.env.local")!;
  expect(hint).toContain("matches no listener on this machine");
  expect(hint).toContain(`127.0.0.1:13777 belongs to listener "share-all" (/rechrome-all/)`);
  expect(hint).toContain("/repo/.rechrome/.env.local");
  expect(hint).toContain(`rech share "me@example.com" --listener share-all --local --save`);
});

test("a link whose listener moved points at its listener", () => {
  const moved = { ...shareAll, port: 13790 };
  const hint = staleLinkHint(`http://127.0.0.1:13777/rechrome-all/#key=${"a".repeat(24)}`, [local, moved])!;
  expect(hint).toContain(`listener "share-all" moved: it now serves 127.0.0.1:13790/rechrome-all/`);
  expect(hint).toContain("rech share --save");
});

test("no hint for a current link or another machine's daemon", () => {
  expect(staleLinkHint(`http://127.0.0.1:13777/rechrome-all/?profile=work%40x#key=${"a".repeat(24)}`, [local, shareAll])).toBeNull();
  expect(staleLinkHint(`https://other.ts.net/rechrome/#key=${"z".repeat(24)}`, [local, shareAll])).toBeNull();
});

test("without a single listener for the profile, the fix creates a fresh link", () => {
  const hint = staleLinkHint(`http://127.0.0.1:13777/rechrome/x/?profile=nobody%40x#key=${"s".repeat(24)}`, [local, shareAll])!;
  expect(hint).toContain(`rech share "nobody@x" --save`);
});

test("a working link through a proxy is not called stale", () => {
  const served = { ...shareAll, publicUrl: "https://node.example.ts.net/rechrome-all/" };
  const key = "a".repeat(24);
  // Its recorded public URL, and a proxy rech knows nothing about (the user's own Caddy).
  expect(staleLinkHint(`https://node.example.ts.net/rechrome-all/?profile=work%40x#key=${key}`, [local, served])).toBeNull();
  expect(staleLinkHint(`https://proxy.example.com/rech/?profile=work%40x#key=${key}`, [local, served])).toBeNull();
  // ...but its key still has to allow the profile it names.
  expect(staleLinkHint(`https://proxy.example.com/rech/?profile=gone%40x#key=${key}`, [local, served])).toContain(`"share-all" no longer allows "gone@x"`);
});

test("a listener that no longer allows the link's profile points at one that does", () => {
  const tailnet: Listener = { name: "tailnet", host: "100.64.0.1", port: 13775, key: "t".repeat(24), profiles: ["work@x"], prefix: "/" };
  const hint = staleLinkHint(`http://100.64.0.1:13775/?profile=me%40example.com#key=${"t".repeat(24)}`, [local, tailnet, shareAll])!;
  expect(hint).toContain(`listener "tailnet" no longer allows "me@example.com" (it serves: work@x)`);
  expect(hint).toContain(`rech share "me@example.com" --listener share-all --local --save`);
});

test("savedLinksBrokenBy warns only for links this change broke", () => {
  const mine: Listener = { name: "me", host: "127.0.0.1", port: 13779, key: "k".repeat(24), profiles: ["me@example.com"], prefix: "/rechrome/me/" };
  const link = { path: "/p/.rechrome/.env.local", url: `http://127.0.0.1:13779/rechrome/me/?profile=me%40example.com#key=${"k".repeat(24)}` };
  const stale = { path: "/q/.env.local", url: `http://127.0.0.1:13790/x/#key=${"z".repeat(24)}` };
  const remote = { path: "/r/.env.local", url: `https://other.example.com/#key=${"y".repeat(24)}` };
  const warnings = savedLinksBrokenBy([local, mine, shareAll], [local, shareAll], [link, stale, remote]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("/p/.rechrome/.env.local");
  expect(savedLinksBrokenBy([local, mine], [local, mine], [link])).toEqual([]);
});

test("new listeners skip a removed listener's port", () => {
  const freed = retirePorts({ version: 1, listeners: [local, shareAll] }, { version: 1, listeners: [local] });
  expect(freed).toEqual([13777]);
  expect(freeListenerPort({ listeners: [local], retiredPorts: freed }, () => true)).toBe(13778);
  // Taken again: no longer retired. Every other port busy: the oldest retired one, as a last resort.
  expect(retirePorts({ version: 1, listeners: [local], retiredPorts: [13777] }, { version: 1, listeners: [local, shareAll] })).toEqual([]);
  expect(freeListenerPort({ listeners: [local], retiredPorts: [13777] }, port => port === 13777)).toBe(13777);
});
