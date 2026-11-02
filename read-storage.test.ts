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

test("the code returns the value only when the host it read from is allowed", async () => {
  const code = buildReadStorageCode("local", "localConfig_v2", ["teams", "T0", "token"], ["app.example.com"]);
  expect(code).toContain("window.localStorage");
  const fn = eval("(" + code + ")");
  // A fake page: evaluate runs the callback against a fake window/location.
  const page = (host: string, stored: string | null) => ({
    evaluate: async (cb: any, arg: any) => {
      const g = globalThis as any;
      const saved = { location: g.location, window: g.window };
      g.location = { hostname: host };
      g.window = { localStorage: { getItem: () => stored } };
      try { return cb(arg); } finally { g.location = saved.location; g.window = saved.window; }
    },
  });
  const cfg = JSON.stringify({ teams: { T0: { token: "SECRET-VALUE" } } });
  expect(JSON.parse(await fn(page("app.example.com", cfg))).value).toBe("SECRET-VALUE");
  const refused = await fn(page("evil.example.net", cfg)).then(() => "returned", (e: Error) => e.message);
  expect(refused).toContain("read-storage refused");
  expect(refused).not.toContain("SECRET-VALUE");
  await expect(fn(page("app.example.com", null))).rejects.toThrow(/no localStorage key/);
});

const listener = { name: "team", host: "127.0.0.1", port: 1, key: "k", profiles: ["qa"] };
const body = (args: string[]) => ({ args, identity: { key: "k", profile: "qa" } });
test("read-storage uses the read-secrets gate", () => {
  expect(() => authorizeProfileRequest(listener as any, body(["read-storage", "local", "k", "--allow-domain=x.com"]))).toThrow(/read-storage is off/);
  const on = { ...listener, readSecrets: true };
  expect(authorizeProfileRequest(on as any, body(["read-storage", "local", "k", "--allow-domain=x.com"]))).toBe("qa");
  expect(() => authorizeProfileRequest(on as any, body(["read-storage", "local", "k", "--filename=/x"]))).toThrow();
});
