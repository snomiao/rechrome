import { test, expect } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import { buildListenChoices, chooseListenAddress, listenUrl } from "./rechrome.ts";

const ip = (address: string, internal = false): NetworkInterfaceInfo => ({
  address, internal, family: address.includes(":") ? "IPv6" : "IPv4",
  netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null,
});

test("network menu orders local, LAN, confirmed Tailscale, then detected tunnels", () => {
  const choices = buildListenChoices({
    lo0: [ip("127.0.0.1", true)], en0: [ip("192.168.1.10")],
    utun3: [ip("100.80.43.42")], wg0: [ip("10.9.0.2")],
  }, ["100.80.43.42"]);
  expect(choices.map(c => c.kind)).toEqual(["local", "lan", "tailscale", "other"]);
  expect(chooseListenAddress(choices, "lan")).toBe("192.168.1.10");
  expect(chooseListenAddress(choices, "tailscale")).toBe("100.80.43.42");
  expect(chooseListenAddress(choices, "10.9.0.2")).toBe("10.9.0.2");
  expect(choices.some(c => c.address === "0.0.0.0")).toBe(false);
});

test("offline Tailscale and unconfirmed CGNAT are not advertised as Tailscale", () => {
  const choices = buildListenChoices({ en0: [ip("100.90.0.1")] }, ["100.80.43.42"]);
  expect(choices.some(c => c.kind === "tailscale")).toBe(false);
  expect(() => chooseListenAddress(choices, "tailscale")).toThrow("not detected");
});

test("filters loopback, link-local and IPv6; deduplicates addresses", () => {
  const choices = buildListenChoices({
    lo: [ip("127.0.0.2", true)], en0: [ip("169.254.1.2"), ip("fe80::1"), ip("10.0.0.2")],
    en1: [ip("10.0.0.2")],
  });
  expect(choices.map(c => c.address)).toEqual(["127.0.0.1", "10.0.0.2"]);
  expect(buildListenChoices({})).toHaveLength(1);
});

test("multiple LANs require an explicit address in non-interactive setup", () => {
  const choices = buildListenChoices({ en0: [ip("10.0.0.2")], en1: [ip("192.168.2.3")] });
  expect(() => chooseListenAddress(choices, "lan")).toThrow("Multiple lan addresses");
  expect(chooseListenAddress(choices, "local")).toBe("127.0.0.1");
  expect(() => chooseListenAddress(choices, "203.0.113.10")).toThrow("not detected");
});

test("rebind updates connection host while preserving authentication and profile", () => {
  const url = new URL(listenUrl("http://example-key@127.0.0.1:13775/?profile=Profile+4&token=example", "100.80.43.42"));
  expect(url.hostname).toBe("100.80.43.42");
  expect(url.username).toBe("example-key");
  expect(url.searchParams.get("profile")).toBe("Profile 4");
  expect(new URL(listenUrl(url.toString(), "192.168.1.10")).hostname).toBe("192.168.1.10");
  expect(new URL(listenUrl(url.toString(), "0.0.0.0")).hostname).toBe("127.0.0.1");
  expect(new URL(listenUrl(url.toString(), "::")).hostname).toBe("[::1]");
});
