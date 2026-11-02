import { expect, test } from "bun:test";
import { parseReadCookieArgs, readCookieWireArgs, parseReadCookieWire, buildReadCookieCode } from "./fill-secret.ts";
import { authorizeProfileRequest } from "./listeners.ts";

test("read-cookie requires name, domain and --allow-domain", () => {
  expect(() => parseReadCookieArgs(["read-cookie", "d"])).toThrow(/<name> <domain>/);
  expect(() => parseReadCookieArgs(["read-cookie", "d", "slack.com"])).toThrow(/--allow-domain/);
  expect(() => parseReadCookieArgs(["read-cookie", "d", "x", "y", "--allow-domain=x"])).toThrow(/<name> <domain>/);
  expect(() => parseReadCookieArgs(["read-cookie", "bad name", "slack.com", "--allow-domain=slack.com"])).toThrow(/valid token/);
  expect(() => parseReadCookieArgs(["read-cookie", "d", "not a host", "--allow-domain=slack.com"])).toThrow(/plain host/);
  expect(() => parseReadCookieArgs(["read-cookie", "d", "slack.com", "--to-file=/x"])).toThrow(/unknown option/);
  const req = parseReadCookieArgs(["read-cookie", "d", "symphoneed.slack.com", "--allow-domain", "symphoneed.slack.com"]);
  expect(req).toEqual({ name: "d", domain: "symphoneed.slack.com", allowDomains: ["symphoneed.slack.com"] });
  expect(parseReadCookieWire(readCookieWireArgs(req))).toEqual(req);
  expect(() => parseReadCookieWire(["read-cookie", "d", "symphoneed.slack.com"])).toThrow();
});

test("the cookie code checks the domain before reading, and embeds no value", () => {
  const code = buildReadCookieCode("d", "symphoneed.slack.com", ["symphoneed.slack.com"]);
  expect(code.indexOf("read-cookie refused")).toBeLessThan(code.indexOf("context().cookies"));
  expect(code).toContain('c.name === "d"');
  expect(() => eval("(" + code + ")")).not.toThrow();
});

const listener = { name: "dede", host: "127.0.0.1", port: 1, key: "k", profiles: ["qa"] };
const body = (args: string[]) => ({ args, identity: { key: "k", profile: "qa" } });

test("read-cookie is off on a scoped listener until --read-cookies, separate from read-secret", () => {
  expect(() => authorizeProfileRequest(listener as any, body(["read-cookie", "d", "slack.com", "--allow-domain=slack.com"]))).toThrow(/read-cookie is off/);
  const sec = { ...listener, readSecrets: true };
  expect(() => authorizeProfileRequest(sec as any, body(["read-cookie", "d", "slack.com", "--allow-domain=slack.com"]))).toThrow(/read-cookie is off/);
  const on = { ...listener, readCookies: true };
  expect(authorizeProfileRequest(on as any, body(["read-cookie", "d", "slack.com", "--allow-domain=slack.com"]))).toBe("qa");
  expect(() => authorizeProfileRequest(on as any, body(["read-cookie", "d", "slack.com", "--filename=/x"]))).toThrow();
});
