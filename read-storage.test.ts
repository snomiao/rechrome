import { expect, test } from "bun:test";
import { parseReadStorageArgs, readStorageWireArgs, parseReadStorageWire, parseStoragePath, buildReadStorageCode } from "./fill-secret.ts";
import { authorizeProfileRequest } from "./listeners.ts";

test("path parsing handles dot and bracket forms", () => {
  expect(parseStoragePath("teams.T0123.token")).toEqual(["teams", "T0123", "token"]);
  expect(parseStoragePath("teams[T011VHWQY3T].token")).toEqual(["teams", "T011VHWQY3T", "token"]);
  expect(parseStoragePath("")).toEqual([]);
});

test("read-storage requires area, key, --allow-domain", () => {
  expect(() => parseReadStorageArgs(["read-storage", "local"])).toThrow(/<local\|session> <key>/);
  expect(() => parseReadStorageArgs(["read-storage", "local", "k"])).toThrow(/--allow-domain/);
  expect(() => parseReadStorageArgs(["read-storage", "disk", "k", "--allow-domain=x"])).toThrow(/local.*session/);
  const req = parseReadStorageArgs(["read-storage", "local", "localConfig_v2", "teams[T0].token", "--allow-domain", "app.slack.com"]);
  expect(req).toEqual({ area: "local", key: "localConfig_v2", path: ["teams", "T0", "token"], allowDomains: ["app.slack.com"] });
  expect(parseReadStorageWire(readStorageWireArgs(req))).toEqual(req);
  expect(() => parseReadStorageWire(["read-storage", "local", "k"])).toThrow();
});

test("the code checks host before reading and embeds no value", () => {
  const code = buildReadStorageCode("local", "localConfig_v2", ["teams", "T0", "token"], ["app.slack.com"]);
  expect(code.indexOf("read-storage refused")).toBeLessThan(code.indexOf("getItem"));
  expect(code).toContain("window.localStorage");
  expect(() => eval("(" + code + ")")).not.toThrow();
});

const listener = { name: "dede", host: "127.0.0.1", port: 1, key: "k", profiles: ["qa"] };
const body = (args: string[]) => ({ args, identity: { key: "k", profile: "qa" } });
test("read-storage uses the read-secrets gate", () => {
  expect(() => authorizeProfileRequest(listener as any, body(["read-storage", "local", "k", "--allow-domain=x.com"]))).toThrow(/read-storage is off/);
  const on = { ...listener, readSecrets: true };
  expect(authorizeProfileRequest(on as any, body(["read-storage", "local", "k", "--allow-domain=x.com"]))).toBe("qa");
  expect(() => authorizeProfileRequest(on as any, body(["read-storage", "local", "k", "--filename=/x"]))).toThrow();
});
