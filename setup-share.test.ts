import { expect, test } from "bun:test";
import { shareMenu } from "./rechrome.ts";

const local = { name: "local", host: "127.0.0.1", port: 1, key: "k", profiles: "*" as const };
const lan = { name: "share-a", host: "192.168.1.5", port: 2, key: "k", profiles: ["a@example.com"] };

test("setup's share menu: local first, existing listeners, then the new kinds", () => {
  const menu = shareMenu([local, lan], [
    { kind: "local", address: "127.0.0.1", label: "" },
    { kind: "lan", address: "192.168.1.5", label: "" },
    { kind: "tailscale", address: "100.64.0.1", label: "" },
  ]);
  expect(menu.map(m => m.kind ?? m.listener ?? "none")).toEqual(["none", "share-a", "lan", "tailscale", "webrtc", "webrtc-own"]);
  expect(menu.map(m => m.key)).toEqual(["1", "2", "3", "4", "5", "6"]);
});

test("networks that aren't there aren't offered; the management listener never is", () => {
  const menu = shareMenu([local], [{ kind: "local", address: "127.0.0.1", label: "" }]);
  expect(menu.map(m => m.kind ?? "none")).toEqual(["none", "webrtc", "webrtc-own"]);
});
