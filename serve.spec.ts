import { describe, test, expect } from "bun:test";
import { inferSilentExtensionFailure, isUnderDir } from "./serve.ts";

describe("isUnderDir", () => {
  test("allows simple relative file", () => {
    expect(isUnderDir("/app/output", "file.png")).toBe(true);
  });

  test("allows nested relative path", () => {
    expect(isUnderDir("/app/output", "subdir/file.png")).toBe(true);
  });

  test("blocks simple traversal with ../", () => {
    expect(isUnderDir("/app/output", "../secret.txt")).toBe(false);
  });

  test("blocks traversal that shares prefix (output-evil)", () => {
    expect(isUnderDir("/app/output", "../output-evil/secret.txt")).toBe(false);
  });

  test("blocks double traversal", () => {
    expect(isUnderDir("/app/output", "../../etc/passwd")).toBe(false);
  });

  test("blocks traversal hidden in middle of path", () => {
    expect(isUnderDir("/app/output", "subdir/../../etc/passwd")).toBe(false);
  });

  test("allows deeply nested path", () => {
    expect(isUnderDir("/app/output", "a/b/c/d/file.json")).toBe(true);
  });

  test("blocks absolute path outside base", () => {
    expect(isUnderDir("/app/output", "/etc/passwd")).toBe(false);
  });

  test("blocks dot-only path that resolves to base itself", () => {
    // "." resolves to base itself, not under it
    expect(isUnderDir("/app/output", ".")).toBe(false);
  });

  test("allows path starting with dot component", () => {
    expect(isUnderDir("/app/output", "./file.png")).toBe(true);
  });

  test("blocks percent-encoded traversal after decoding", () => {
    // The caller is responsible for decoding; test the resolved path
    expect(isUnderDir("/app/output", decodeURIComponent("..%2F..%2Fetc%2Fpasswd"))).toBe(false);
  });
});

describe("inferSilentExtensionFailure", () => {
  test("explains a silent open failure at the extension handshake deadline", () => {
    expect(inferSilentExtensionFailure({
      status: 1,
      stdout: "",
      stderr: "",
      isOpenCommand: true,
      hasExtensionCredentials: true,
      elapsedMs: 30_200,
      handshakeTimeoutMs: 30_000,
    })).toContain("Automatic recovery retry failed");
  });

  test("preserves real stderr and unrelated fast failures", () => {
    const base = {
      status: 1,
      stdout: "",
      isOpenCommand: true,
      hasExtensionCredentials: true,
      elapsedMs: 30_200,
      handshakeTimeoutMs: 30_000,
    };
    expect(inferSilentExtensionFailure({ ...base, stderr: "real error\n" })).toBe("real error\n");
    expect(inferSilentExtensionFailure({ ...base, stderr: "", elapsedMs: 500 })).toBe("");
  });
});
