import { expect, test } from "bun:test";
import vm from "vm";
import {
  parseReadHeadersArgs,
  readHeadersWireArgs,
  parseReadHeadersWire,
  redactHeaders,
  redactCaptured,
  readHeadersEvidence,
  hostFromUrl,
  buildReadHeadersCode,
  REDACTED_HEADERS,
  HEADER_REDACTION,
  READ_HEADERS_DEFAULT_SECONDS,
  READ_HEADERS_MAX_SECONDS,
  SecretMasker,
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
  for (const name of REDACTED_HEADERS) expect(redactHeaders({ [name]: "v" })[name]).toBe(HEADER_REDACTION);
  // named like a credential
  const more = redactHeaders({ "WWW-Authenticate": "Bearer realm=x", "X-Api-Key": "k", "x-csrf-token": "c", "X-Amz-Security-Token": "t", "x-client-secret": "s", "x_auth_token": "u", "x-tokenizer": "fine", "x-request-id": "r-1" });
  expect(Object.entries(more).filter(([, v]) => v === HEADER_REDACTION).map(([k]) => k))
    .toEqual(["WWW-Authenticate", "X-Api-Key", "x-csrf-token", "X-Amz-Security-Token", "x-client-secret", "x_auth_token"]);
  expect(more["x-tokenizer"]).toBe("fine");
  expect(more["x-request-id"]).toBe("r-1");
});

test("redactCaptured: URL query values, fragments and userinfo are redacted in url and location", () => {
  const r = redactCaptured({
    url: "https://user:pw@app.example.com/cb?code=abc123&state=xyz&flag#access_token=tok",
    status: "302",
    headers: { Location: "https://app.example.com/home?session=s3cr3t#frag", "content-type": "text/html", link: "</x>; rel=next" },
  });
  expect(r.url).toBe("https://<redacted>@app.example.com/cb?code=<redacted>&state=<redacted>&<redacted>#<redacted>");
  expect(r.status).toBe(302);
  expect(r.headers.Location).toBe("https://app.example.com/home?session=<redacted>#<redacted>");
  expect(r.headers["content-type"]).toBe("text/html");
  expect(redactCaptured({ url: "https://app.example.com/plain/path" }).url).toBe("https://app.example.com/plain/path");
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
  expect(withGoto).toContain("page.waitForTimeout(");
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

test("buildReadHeadersCode runs in run-code's sandbox and redacts in the browser", async () => {
  // A fresh vm context with only `page`, like run-code: no setTimeout, no module scope.
  const handlers: ((r: unknown) => unknown)[] = [];
  const response = (url: string, headers: Record<string, string>) => ({ url: () => url, status: () => 200, allHeaders: async () => headers });
  let gone = "";
  const page = {
    on: (_: string, fn: (r: unknown) => unknown) => handlers.push(fn),
    off: () => { handlers.length = 0; },
    goto: async (url: string) => { gone = url; },
    waitForTimeout: async () => {
      for (const h of handlers) {
        await h(response("https://app.example.com/api?key=abc#t", { "set-cookie": "sid=1", "x-api-key": "k", location: "/next?code=9", "content-type": "application/json" }));
        await h(response("https://other.example.org/x", { "content-type": "text/plain" }));
      }
    },
  };
  const fn = vm.runInContext(`(${buildReadHeadersCode(["app.example.com"], 2, "https://app.example.com/home")})`, vm.createContext({ page }));
  const out = JSON.parse(await fn(page));
  expect(gone).toBe("https://app.example.com/home");
  expect(out.count).toBe(1); // only the allowed host
  expect(out.captured[0]).toEqual({
    url: "https://app.example.com/api?key=<redacted>#<redacted>",
    status: 200,
    headers: { "set-cookie": "<redacted>", "x-api-key": "<redacted>", location: "/next?code=<redacted>", "content-type": "application/json" },
  });
});

test("readHeadersEvidence: the file also drops what the masker knows and what the secret scanner finds", () => {
  const pat = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"; // a GitHub token shape, in a header nobody listed
  const masker = new SecretMasker();
  masker.add("hunter2-filled-password", Infinity);
  const text = readHeadersEvidence([{ url: "https://app.example.com/", status: 200, headers: { "x-debug": `user=${pat}`, "x-echo": "hunter2-filled-password", "set-cookie": "sid=raw" } }], t => masker.mask(t));
  expect(text).not.toContain(pat);
  expect(text).toContain("[redacted:github-pat]");
  expect(text).not.toContain("hunter2-filled-password");
  expect(text).not.toContain("sid=raw"); // redacted again even if a caller passed it raw
  expect(JSON.parse(text)[0].status).toBe(200);
});
