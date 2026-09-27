import { expect, test } from "bun:test";
import { validateListeners, authorizeProfileRequest, canReadProfileFile, profileOutputPrefix, normalizePrefix, serviceUrl, type Listener } from "./listeners.ts";

test("normalizes prefixes and preserves them in credential-free API URLs", () => {
  for (const value of ["rechrome", "/rechrome", "/rechrome/"]) expect(normalizePrefix(value)).toBe("/rechrome/");
  expect(normalizePrefix()).toBe("/");
  for (const value of ["../private", "a/../b", "a//b", "a?token=x", "%2e%2e", "a\\b"]) expect(() => normalizePrefix(value)).toThrow();
  expect(serviceUrl("https://secret@host.example/rechrome/?profile=qa&token=private#fragment", "run")).toBe("https://host.example/rechrome/run");
  expect(serviceUrl("http://secret@[::1]:13776/nested/rechrome", "/files/shot.png")).toBe("http://[::1]:13776/nested/rechrome/files/shot.png");
});

const listener: Listener = { name: "qa", host: "100.80.1.2", port: 13775, key: "a".repeat(24), profiles: ["qa"] };
const request = (args = ["tab-list"]) => ({ args, identity: { key: "/worktree", profile: "qa" } });

test("validates independent listener bindings and credentials", () => {
  expect(validateListeners({ version: 1, listeners: [listener, { ...listener, name: "local", host: "127.0.0.1", key: "b".repeat(24), profiles: "*" }] }).listeners).toHaveLength(2);
  for (const change of [{ profiles: "*" }, { host: "0.0.0.0" }, { host: "::" }, { port: 0 }, { key: "short" }, { profiles: [] }]) {
    expect(() => validateListeners({ version: 1, listeners: [{ ...listener, ...change }] })).toThrow();
  }
  expect(() => validateListeners({ version: 1, listeners: [listener, { ...listener, name: "other" }] })).toThrow();
});

test("denies profile switching and CLI escape routes", () => {
  expect(authorizeProfileRequest(listener, request())).toBe("qa");
  expect(() => authorizeProfileRequest(listener, { ...request(), identity: { key: "/worktree", profile: "personal" } })).toThrow();
  expect(() => authorizeProfileRequest(listener, { ...request(), env: { PLAYWRIGHT_MCP_PROFILE_DIRECTORY: "personal" } })).toThrow();
  for (const args of [["run-code", "async page => {}"], ["eval", "() => 1"], ["kill-all"], ["open", "--profile", "/personal"], ["open", "file:///secret"], ["open", "chrome://settings"], ["screenshot", "--filename", "../secret.png"], ["tab-list", "--session=other"]]) {
    expect(() => authorizeProfileRequest(listener, request(args))).toThrow();
  }
  expect(authorizeProfileRequest(listener, request(["-s=qa1", "open", "https://example.com"]))).toBe("qa");
});

test("file paths must belong to a permitted profile", () => {
  expect(canReadProfileFile(listener, profileOutputPrefix("qa") + "screenshot.png")).toBe(true);
  expect(canReadProfileFile(listener, profileOutputPrefix("personal") + "screenshot.png")).toBe(false);
  expect(canReadProfileFile(listener, "screenshot.png")).toBe(false);
});
