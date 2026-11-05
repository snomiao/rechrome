import { expect, test } from "bun:test";
import {
  parseReadHeadersArgs,
  readHeadersWireArgs,
  parseReadHeadersWire,
  redactHeaders,
  hostFromUrl,
  buildReadHeadersCode,
  REDACTED_HEADERS,
  HEADER_REDACTION,
  READ_HEADERS_DEFAULT_SECONDS,
  READ_HEADERS_MAX_SECONDS,
} from "./fill-secret.ts";
import { authorizeProfileRequest, type Listener } from "./listeners.ts";

test("parseReadHeadersArgs: requires --allow-domain, defaults seconds, takes --seconds and --goto", () => {
  expect(parseReadHeadersArgs(["read-headers", "--allow-domain=app.example.com"]))
    .toEqual({ allowDomains: ["app.example.com"], seconds: READ_HEADERS_DEFAULT_SECONDS, gotoUrl: undefined });
  expect(parseReadHeadersArgs(["read-headers", "--allow-domain", "app.example.com", "--seconds", "12"]))
    .toEqual({ allowDomains: ["app.example.com"], seconds: 12, gotoUrl: undefined });
  expect(parseReadHeadersArgs(["read-headers", "--allow-domain=app.example.com", "--goto=https://app.example.com/home"]))
    .toEqual({ allowDomains: ["app.example.com"], seconds: READ_HEADERS_DEFAULT_SECONDS, gotoUrl: "https://app.example.com/home" });
  // comma-separated and repeated allow-domain both accumulate
  expect(parseReadHeadersArgs(["read-headers", "--allow-domain=a.example.com,b.example.com", "--allow-domain=c.example.com"]).allowDomains)
    .toEqual(["a.example.com", "b.example.com", "c.example.com"]);
});

test("parseReadHeadersArgs: rejects missing --allow-domain, bad seconds, mismatched --goto host", () => {
  expect(() => parseReadHeadersArgs(["read-headers"])).toThrow(/--allow-domain/);
  expect(() => parseReadHeadersArgs(["read-headers", "--allow-domain=app.example.com", "--seconds=0"])).toThrow(/--seconds/);
  expect(() => parseReadHeadersArgs(["read-headers", "--allow-domain=app.example.com", "--seconds=abc"])).toThrow(/--seconds/);
  expect(() => parseReadHeadersArgs(["read-headers", "--allow-domain=app.example.com", `--seconds=${READ_HEADERS_MAX_SECONDS + 1}`])).toThrow(/--seconds/);
  expect(() => parseReadHeadersArgs(["read-headers", "--allow-domain=app.example.com", "--goto=https://evil.com/"])).toThrow(/--goto URL host must match/);
  expect(() => parseReadHeadersArgs(["read-headers", "--allow-domain=app.example.com", "--goto=ftp://app.example.com/"])).toThrow(/http\(s\)/);
  expect(() => parseReadHeadersArgs(["read-headers", "--allow-domain=app.example.com", "--bogus"])).toThrow(/unknown option/);
  expect(() => parseReadHeadersArgs(["read-headers", "--allow-domain=app.example.com", "stray"])).toThrow(/unexpected argument/);
});

test("wire args round-trip through parseReadHeadersWire", () => {
  for (const req of [
    { allowDomains: ["app.example.com"], seconds: 5, gotoUrl: undefined },
    { allowDomains: ["a.example.com", "b.example.com"], seconds: 30, gotoUrl: "https://a.example.com/x" },
  ]) {
    const wire = readHeadersWireArgs(req);
    expect(parseReadHeadersWire(wire)).toEqual(req);
  }
});

test("redactHeaders: keeps names, redacts only credential header values, case-insensitively", () => {
  const redacted = redactHeaders({
    "content-type": "application/json",
    "Set-Cookie": "session=abc123; HttpOnly",
    "Cookie": "a=b",
    "Authorization": "Bearer secrettoken",
    "x-custom": "ok",
  });
  expect(redacted["content-type"]).toBe("application/json");
  expect(redacted["x-custom"]).toBe("ok");
  expect(redacted["Set-Cookie"]).toBe(HEADER_REDACTION);
  expect(redacted["Cookie"]).toBe(HEADER_REDACTION);
  expect(redacted["Authorization"]).toBe(HEADER_REDACTION);
  // exactly the three names are credential-bearing
  expect(REDACTED_HEADERS).toEqual(["set-cookie", "cookie", "authorization"]);
});

test("hostFromUrl: extracts lowercased host, drops userinfo and port", () => {
  expect(hostFromUrl("https://App.Example.com:443/path?q=1")).toBe("app.example.com");
  expect(hostFromUrl("http://user:pass@host.example.com/")).toBe("host.example.com");
  expect(hostFromUrl("not a url")).toBe("");
});

test("buildReadHeadersCode: embeds host filter, redaction set and window; includes goto only when given", () => {
  const withGoto = buildReadHeadersCode(["app.example.com"], 7, "https://app.example.com/home");
  expect(withGoto).toContain("page.on(\"response\"");
  expect(withGoto).toContain("<redacted>");
  expect(withGoto).toContain("7 * 1000");
  // the window-wait must use a page API that exists in the run-code sandbox; setTimeout is NOT defined there
  expect(withGoto).toContain("page.waitForTimeout(7 * 1000)");
  expect(withGoto).not.toMatch(/setTimeout\(r,/);
  expect(withGoto).toContain("page.goto(\"https://app.example.com/home\"");
  const noGoto = buildReadHeadersCode(["app.example.com"], 5);
  expect(noGoto).not.toContain("page.goto");
});

const scoped: Listener = { name: "qa", host: "100.80.1.2", port: 13775, key: "a".repeat(24), profiles: ["qa"] };
const request = (args: string[]) => ({ args, identity: { key: "/worktree", profile: "qa" } });

test("read-headers is gated behind the readHeaders listener flag", () => {
  // off by default
  expect(() => authorizeProfileRequest(scoped, request(["read-headers", "--allow-domain=app.example.com"]))).toThrow(/read-headers is off/);
  // on when the host enabled it; the allowed options pass the scoped-option filter
  const on: Listener = { ...scoped, readHeaders: true };
  expect(authorizeProfileRequest(on, request(["read-headers", "--allow-domain=app.example.com", "--seconds=5", "--goto=https://app.example.com/home"]))).toBe("qa");
  // an unlisted option is still rejected even with the flag on
  expect(() => authorizeProfileRequest(on, request(["read-headers", "--allow-domain=app.example.com", "--filename=x.json"]))).toThrow(/option overrides are unavailable/);
});
