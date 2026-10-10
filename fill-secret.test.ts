import { describe, expect, test } from "bun:test";
import {
  SecretMasker, base32Decode, buildFillCode, domainGlobToRegExp, fillSecretWireArgs, hostAllowed,
  parseDotenv, parseFillSecretArgs, parseFillSecretWire, readSecretSource, sessionSocketCandidates, totpCode, totpWaitMs,
} from "./fill-secret.ts";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { authorizeProfileRequest } from "./listeners.ts";

// RFC 6238 appendix B, SHA1 seed "12345678901234567890".
const RFC_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp", () => {
  test("matches the RFC 6238 SHA1 test vectors", () => {
    expect(totpCode(RFC_SEED, 59_000, { digits: 8 })).toBe("94287082");
    expect(totpCode(RFC_SEED, 1111111109_000, { digits: 8 })).toBe("07081804");
    expect(totpCode(RFC_SEED, 1234567890_000, { digits: 8 })).toBe("89005924");
    expect(totpCode(RFC_SEED, 20000000000_000, { digits: 8 })).toBe("65353130");
    expect(totpCode(RFC_SEED, 59_000)).toBe("287082"); // default: 6 digits
  });
  test("accepts lowercase, spaced, padded seeds", () => {
    expect(totpCode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq==", 59_000)).toBe("287082");
  });
  test("rejects a non-base32 seed without quoting it", () => {
    expect(() => base32Decode("NOT-A-SEED!1")).toThrow("TOTP seed is not valid base32");
    try { base32Decode("SECRET!VALUE"); } catch (e) { expect(String(e)).not.toContain("SECRET"); }
  });
  test("waits for the next window only when the current code is about to expire", () => {
    expect(totpWaitMs(10_000)).toBe(0);
    expect(totpWaitMs(27_000)).toBe(3_050);
  });
});

describe("parseFillSecretArgs", () => {
  test("reads each source form", () => {
    expect(parseFillSecretArgs(["e5", "--from-env", "PW"])).toMatchObject({ ref: "e5", source: { kind: "env", name: "PW" }, totp: false });
    expect(parseFillSecretArgs(["e5", "--totp-from-env=SEED", "--env-file", "/x/.env"])).toMatchObject({ totp: true, source: { kind: "env", name: "SEED", envFile: "/x/.env" } });
    expect(parseFillSecretArgs(["--from-stdin", "e5", "--submit", "--allow-domain", "*.a.com,b.com"])).toMatchObject({ source: { kind: "stdin" }, submit: true, allowDomains: ["*.a.com", "b.com"] });
  });
  test("refuses a secret typed as an argument, without echoing it", () => {
    let message = "";
    try { parseFillSecretArgs(["e5", "hunter2-CANARY"]); } catch (e) { message = String(e); }
    expect(message).toContain("never as an argument");
    expect(message).not.toContain("hunter2-CANARY");
  });
  test("needs exactly one source and a valid var name", () => {
    expect(() => parseFillSecretArgs(["e5"])).toThrow("needs --from-env");
    expect(() => parseFillSecretArgs(["e5", "--from-env", "A", "--from-stdin"])).toThrow("exactly one");
    expect(() => parseFillSecretArgs(["e5", "--from-env", "not a var"])).toThrow("not an environment variable");
    expect(() => parseFillSecretArgs(["e5", "--from-stdin", "--env-file", "x"])).toThrow("--env-file goes with");
    // An explicitly empty guard (an unset shell var) must not silently become "no guard".
    expect(() => parseFillSecretArgs(["e5", "--from-stdin", "--allow-domain", ""])).toThrow("empty host");
    expect(() => parseFillSecretArgs(["e5", "--from-stdin", "--allow-domain=,"])).toThrow("empty host");
  });
  test("the wire args carry the ref and flags, never the var name or value", () => {
    const req = parseFillSecretArgs(["e5", "--from-env", "SALESFORCE_PASSWORD", "--allow-domain", "*.my.salesforce.com", "--submit"]);
    expect(fillSecretWireArgs(req)).toEqual(["fill-secret", "e5", "--allow-domain=*.my.salesforce.com", "--submit"]);
    expect(parseFillSecretWire(fillSecretWireArgs(req))).toEqual({ ref: "e5", allowDomains: ["*.my.salesforce.com"], submit: true, totp: false });
    expect(() => parseFillSecretWire(["fill-secret", "e5", "leaked-value"])).toThrow("(positional)");
    const totp = parseFillSecretArgs(["e5", "--totp-from-env", "SEED"]);
    expect(fillSecretWireArgs(totp)).toEqual(["fill-secret", "e5", "--totp"]);
    expect(parseFillSecretWire(fillSecretWireArgs(totp)).totp).toBe(true);
  });
});

describe("readSecretSource", () => {
  test("env, env file and stdin", async () => {
    expect(await readSecretSource({ kind: "env", name: "X" }, { X: "v1" })).toBe("v1");
    await expect(readSecretSource({ kind: "env", name: "X" }, {})).rejects.toThrow("X is not set");
    expect(await readSecretSource({ kind: "stdin" }, {}, async () => "v2\nrest\n")).toBe("v2");
    const path = `${process.env.TMPDIR || "/tmp"}/fill-secret-test-${process.pid}.env`;
    await Bun.write(path, "# c\nexport A='q v'\nB=\"x\\\"y\" \nC=plain # note\n");
    try {
      expect(await readSecretSource({ kind: "env", name: "B", envFile: path }, {})).toBe('x"y');
    } finally { await Bun.file(path).delete(); }
  });
  test("parseDotenv", () => {
    expect(parseDotenv("export A='q v'\nB=\"x\\\"y\"\nC=plain # note\nbad line\n")).toEqual({ A: "q v", B: 'x"y', C: "plain" });
  });
});

describe("--allow-domain guard", () => {
  test("accepts matching hosts", () => {
    expect(hostAllowed("taku.my.salesforce.com", ["*.my.salesforce.com"])).toBe(true);
    expect(hostAllowed("a.b.my.salesforce.com", ["*.my.salesforce.com"])).toBe(true);
    expect(hostAllowed("LOGIN.salesforce.com", ["login.salesforce.com"])).toBe(true);
    expect(hostAllowed("anything.example", [])).toBe(true);
  });
  test("rejects look-alikes", () => {
    expect(hostAllowed("my.salesforce.com", ["*.my.salesforce.com"])).toBe(false); // apex
    expect(hostAllowed("evil-my.salesforce.com", ["*.my.salesforce.com"])).toBe(false);
    expect(hostAllowed("x.my.salesforce.com.evil.com", ["*.my.salesforce.com"])).toBe(false);
    expect(hostAllowed("loginxsalesforce.com", ["login.salesforce.com"])).toBe(false);
  });
  test("rejects malformed globs", () => {
    expect(() => domainGlobToRegExp("*")).toThrow();
    expect(() => domainGlobToRegExp("a.*.com")).toThrow();
    expect(() => domainGlobToRegExp("https://a.com")).toThrow();
  });
  test("the generated code embeds the guard", () => {
    const code = buildFillCode("e5", "v", ["*.a.com"], false);
    expect(code).toContain("fill-secret refused");
    expect(code).toContain('page.locator("aria-ref=e5").elementHandle(');
    expect(code).toContain("e.ownerDocument.location.hostname"); // the field's own frame, not the top page
    expect(buildFillCode("#pw", "v", [], true)).toContain('page.locator("#pw")');
  });
});

describe("sessionSocketCandidates", () => {
  test("matches exactly this session, never another client's sub-session with the same suffix", () => {
    const dir = mkdtempSync(join(tmpdir(), "rech-sock-"));
    try {
      for (const n of ["0123456789abcdef-aaaaaaaa.sock", "0123456789abcdef-bbbbbbbb-aaaaaaaa.sock", "aaaaaaaa.sock", "xx-aaaaaaaa.sock", "0123456789abcdef-aaaaaaaa-x.sock"]) writeFileSync(join(dir, n), "");
      expect(sessionSocketCandidates(dir, "aaaaaaaa").map(p => p.slice(dir.length + 1)).sort()).toEqual(["0123456789abcdef-aaaaaaaa.sock", "aaaaaaaa.sock"]);
      expect(sessionSocketCandidates(dir, "bbbbbbbb-aaaaaaaa").map(p => p.slice(dir.length + 1))).toEqual(["0123456789abcdef-bbbbbbbb-aaaaaaaa.sock"]);
    } finally { rmSync(dir, { recursive: true }); }
  });
});

describe("SecretMasker", () => {
  test("masks raw and JS-literal spellings until the TTL ends", () => {
    let now = 0;
    const m = new SecretMasker(1000, () => now);
    expect(m.active).toBe(false);
    m.add('pa"ss');
    expect(m.mask(`fill("pa\\"ss") and pa"ss`)).toBe(`fill("***") and ***`);
    now = 1001;
    expect(m.active).toBe(false);
    expect(m.mask('pa"ss')).toBe('pa"ss');
    m.add("pw-forever", Infinity);
    now = 10 ** 12;
    expect(m.mask("x pw-forever")).toBe("x ***");
  });
});

describe("profile-scoped listener", () => {
  const listener = { name: "s", host: "127.0.0.1", port: 1, key: "k".repeat(24), profiles: ["p"], prefix: "/" } as any;
  const body = (args: string[]) => ({ identity: { key: "/w", profile: "p" }, args });
  test("allows fill-secret with its own flags only", () => {
    expect(authorizeProfileRequest(listener, body(["fill-secret", "e5", "--allow-domain=*.a.com", "--submit", "--totp"]))).toBe("p");
    expect(() => authorizeProfileRequest(listener, body(["fill-secret", "e5", "--filename=/etc/passwd"]))).toThrow("option overrides");
    expect(() => authorizeProfileRequest(listener, body(["fill", "e5", "--allow-domain=x.com"]))).toThrow("option overrides");
  });
});
