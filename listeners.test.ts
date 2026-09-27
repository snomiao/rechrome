import { expect, test } from "bun:test";
import { validateListeners, authorizeProfileRequest, canReadProfileFile, profileOutputPrefix, normalizePrefix, serviceUrl, allowProfiles, denyProfiles, rotateListenerKey, setPublicUrl, normalizePublicUrl, canonicalProfileKeys, resolveAllowedProfile, type Listener, type ListenerConfig } from "./listeners.ts";

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

const managementAnd = (...scoped: Array<Partial<Listener> & { name: string }>): ListenerConfig => ({
  version: 1,
  listeners: [
    { name: "local", host: "127.0.0.1", port: 13775, key: "m".repeat(16), profiles: "*" },
    ...scoped.map((l, i) => ({ host: "127.0.0.1", port: 13776 + i, key: String(i).repeat(24), profiles: ["qa"], ...l }) as Listener),
  ],
});

test("allow and deny edit a scoped allowlist, deduplicated, never emptying it", () => {
  const config = managementAnd({ name: "share" });
  expect(allowProfiles(config, "share", ["dev", "qa", "dev"])).toEqual(["dev"]);
  expect(config.listeners[1].profiles).toEqual(["qa", "dev"]);
  expect(denyProfiles(config, "share", ["qa", "nope"])).toEqual(["qa"]);
  expect(config.listeners[1].profiles).toEqual(["dev"]);
  expect(() => denyProfiles(config, "share", ["dev"])).toThrow(/rech listener remove share/);
  expect(() => allowProfiles(config, "missing", ["qa"])).toThrow(/Unknown listener/);
});

test("the management listener cannot be edited, re-keyed, or narrowed", () => {
  const config = managementAnd({ name: "share" });
  for (const edit of [() => allowProfiles(config, "local", ["qa"]), () => denyProfiles(config, "local", ["qa"]), () => rotateListenerKey(config, "local")])
    expect(edit).toThrow(/management listener/);
});

test("rotate-key replaces the key with a fresh valid one", () => {
  const config = managementAnd({ name: "share" });
  const before = config.listeners[1].key;
  const after = rotateListenerKey(config, "share");
  expect(after).not.toBe(before);
  expect(config.listeners[1].key).toBe(after);
  expect(() => validateListeners(config)).not.toThrow();
});

test("public URLs are plain http(s) bases, normalized with a trailing slash, and can be cleared", () => {
  expect(normalizePublicUrl("https://host.example.ts.net/rechrome")).toBe("https://host.example.ts.net/rechrome/");
  expect(normalizePublicUrl("http://proxy.lan:8080")).toBe("http://proxy.lan:8080/");
  for (const bad of ["ftp://x/", "https://KEY@host/", "https://host/?profile=qa", "https://host/#key=x", "not a url"])
    expect(() => normalizePublicUrl(bad)).toThrow();
  const config = managementAnd({ name: "share" });
  expect(setPublicUrl(config, "share", "https://h.ts.net/rechrome").publicUrl).toBe("https://h.ts.net/rechrome/");
  expect(validateListeners(JSON.parse(JSON.stringify(config))).listeners[1].publicUrl).toBe("https://h.ts.net/rechrome/");
  expect(setPublicUrl(config, "share", null).publicUrl).toBeUndefined();
  expect(() => validateListeners({ ...config, listeners: [{ ...config.listeners[1], publicUrl: "https://KEY@h/" }] })).toThrow();
});

const registry = {
  "taku@corp.jp": { profileDir: "Profile 2" },
  "Profile 5": { profileDir: "Profile 5" },
  "taku2": { profileDir: "Profile 5" },                                    // alias of Profile 5
  "symval-dev": { profileDir: "symval-dev" },
  "qa-box": { profileDir: "Default", userDataDir: "/managed/qa" },          // same folder name, other data dir
  "Default": { profileDir: "Default" },
};

test("canonical keys: one per Chrome profile, aliases collapse (email preferred), data dirs kept apart", () => {
  expect(canonicalProfileKeys(registry).sort()).toEqual(["Default", "Profile 5", "qa-box", "symval-dev", "taku@corp.jp"]);
  expect(canonicalProfileKeys({ "Profile 2": { profileDir: "Profile 2" }, "me@x.com": { profileDir: "Profile 2" } })).toEqual(["me@x.com"]);
  expect(canonicalProfileKeys({})).toEqual([]);
});

test("the host resolves what a client typed among the link's profiles only", () => {
  const allowed = ["taku@corp.jp", "Profile 5", "symval-dev"];
  const names = { "Profile 2": "Work", "Profile 5": "Personal" };
  const resolve = (s?: string) => resolveAllowedProfile(s, allowed, registry, names);
  expect(resolve("TAKU@corp.jp")).toBe("taku@corp.jp");        // exact, case-insensitive
  expect(resolve("taku2")).toBe("Profile 5");                   // alias → canonical key (one session)
  expect(resolve("profile 5")).toBe("Profile 5");               // folder
  expect(resolve("work")).toBe("taku@corp.jp");                 // Chrome display name
  expect(resolve("taku")).toBe("taku@corp.jp");                 // email part before @
  expect(resolve("symv")).toBe("symval-dev");                   // unique 3+ char prefix
  expect(() => resolve("sy")).toThrow(/not shared/);            // prefixes need 3+ characters
  expect(() => resolve("Default")).toThrow(/not shared by this link\. It shares: taku@corp.jp, Profile 5, symval-dev/);
  expect(() => resolve(undefined)).toThrow(/Pick a profile: this link shares/);
  expect(() => resolve(" ")).toThrow(/Pick a profile/);
  expect(() => resolveAllowedProfile("pro", ["Profile 5", "taku@corp.jp"], registry, { "Profile 2": "Profile Work" })).toThrow(/several shared profiles/);
});

test("a managed profile's folder name doesn't borrow a real Chrome profile's display name", () => {
  expect(() => resolveAllowedProfile("Person 1", ["qa-box"], registry, { Default: "Person 1" })).toThrow(/not shared/);
  expect(resolveAllowedProfile("Person 1", ["Default"], registry, { Default: "Person 1" })).toBe("Default");
});
