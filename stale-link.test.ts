import { test, expect } from "bun:test";
import { staleLinkHint } from "./rechrome.ts";
import type { Listener } from "./listeners.ts";

const local: Listener = { name: "local", host: "127.0.0.1", port: 13775, key: "m".repeat(24), profiles: "*", prefix: "/" };
const shareAll: Listener = { name: "share-all", host: "127.0.0.1", port: 13777, key: "a".repeat(24), profiles: ["snomiao@gmail.com", "work@x"], prefix: "/rechrome-all/" };

test("a link whose listener was removed and whose port share --all reused names the exact fix", () => {
  // The Lianki case: `rech share snomiao --save` wrote /rechrome/snomiao/ on 13777; that listener
  // was removed and `rech share --all` took the free port with its own prefix and key.
  const stale = `http://127.0.0.1:13777/rechrome/snomiao/?profile=snomiao%40gmail.com#key=${"s".repeat(24)}`;
  const hint = staleLinkHint(stale, [local, shareAll], "/repo/.rechrome/.env.local")!;
  expect(hint).toContain("matches no listener on this machine");
  expect(hint).toContain(`127.0.0.1:13777 belongs to listener "share-all" (/rechrome-all/)`);
  expect(hint).toContain("/repo/.rechrome/.env.local");
  expect(hint).toContain(`rech share "snomiao@gmail.com" --listener share-all --local --save`);
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
