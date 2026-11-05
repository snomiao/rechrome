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

test("the code returns the value only when the frame it read from is allowed", async () => {
  const code = buildReadStorageCode("local", "localConfig_v2", ["teams", "T0", "token"], ["app.example.com"]);
  expect(code).toContain("window.localStorage");
  const fn = eval("(" + code + ")");
  // A fake frame: url() is what Playwright reports; evaluate runs the callback against a fake
  // document/window whose URL can differ (the frame navigated after it was picked).
  const frame = (url: string, stored: string | null, liveUrl = url) => ({
    url: () => url,
    evaluate: async (cb: any, arg: any) => {
      const g = globalThis as any;
      const saved = { document: g.document, window: g.window };
      g.document = { URL: liveUrl };
      g.window = { localStorage: { getItem: () => stored } };
      try { return cb(arg); } finally { g.document = saved.document; g.window = saved.window; }
    },
  });
  const page = (...frames: any[]) => ({ url: () => frames[0].url(), frames: () => frames });
  const cfg = JSON.stringify({ teams: { T0: { token: "SECRET-VALUE" } } });
  // The top frame can be a blank wrapper over the bridge; the allowed child frame is read.
  const ok = JSON.parse(await fn(page(frame("about:blank", null), frame("https://app.example.com/client", cfg))));
  expect(ok).toEqual({ host: "app.example.com", value: "SECRET-VALUE" });
  const message = (p: any) => fn(p).then(() => "returned", (e: Error) => e.message);
  const refused = await message(page(frame("https://evil.example.net/", cfg)));
  expect(refused).toContain("read-storage refused");
  expect(refused).not.toContain("SECRET-VALUE");
  // Picked while on the allowed host, but navigated away before the read.
  const moved = await message(page(frame("https://app.example.com/", cfg, "https://evil.example.net/")));
  expect(moved).toContain("read-storage refused");
  expect(moved).not.toContain("SECRET-VALUE");
  // A look-alike host in the userinfo or path doesn't count.
  expect(await message(page(frame("https://app.example.com@evil.example.net/", cfg)))).toContain("refused");
  await expect(fn(page(frame("https://app.example.com/", null)))).rejects.toThrow(/no localStorage key/);
});

test("--goto must be http(s) on an allowed host, on the client and on the wire", () => {
  const req = parseReadStorageArgs(["read-storage", "local", "k", "--allow-domain", "app.example.com", "--goto", "https://app.example.com/client/T0"]);
  expect(req.gotoUrl).toBe("https://app.example.com/client/T0");
  expect(parseReadStorageWire(readStorageWireArgs(req))).toEqual(req);
  expect(() => parseReadStorageArgs(["read-storage", "local", "k", "--allow-domain=app.example.com", "--goto=https://evil.example.net/"])).toThrow(/must match --allow-domain/);
  expect(() => parseReadStorageArgs(["read-storage", "local", "k", "--allow-domain=app.example.com", "--goto=javascript:alert(1)"])).toThrow(/http\(s\)/);
  // serve re-checks: a crafted wire request can't navigate elsewhere.
  expect(() => parseReadStorageWire(["read-storage", "local", "k", "--allow-domain=app.example.com", "--goto=https://evil.example.net/"])).toThrow(/must match --allow-domain/);
});

const listener = { name: "team", host: "127.0.0.1", port: 1, key: "k", profiles: ["qa"] };
const body = (args: string[]) => ({ args, identity: { key: "k", profile: "qa" } });
test("read-storage uses the read-secrets gate", () => {
  expect(() => authorizeProfileRequest(listener as any, body(["read-storage", "local", "k", "--allow-domain=x.com"]))).toThrow(/read-storage is off/);
  const on = { ...listener, readSecrets: true };
  expect(authorizeProfileRequest(on as any, body(["read-storage", "local", "k", "--allow-domain=x.com"]))).toBe("qa");
  expect(() => authorizeProfileRequest(on as any, body(["read-storage", "local", "k", "--filename=/x"]))).toThrow();
});
