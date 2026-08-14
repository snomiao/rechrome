import { describe, test, expect } from "bun:test";
import { inferSilentExtensionFailure, isUnderDir, provesRelayAlive, shouldExitOrphanedServe } from "./serve.ts";

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

describe("provesRelayAlive", () => {
  const no = (stdout: string, stderr = "") => provesRelayAlive({ stdout, stderr });

  test("a real reply from the browser counts as proof", () => {
    expect(no('{"title":"Example"}')).toBe(true);
    expect(no("", "TimeoutError: locator.click: Timeout 5000ms exceeded.")).toBe(true);
    expect(no("", 'Error: "#nope" does not match any elements.')).toBe(true);
  });

  test("a missing session does NOT count — the CLI never reached the relay", () => {
    expect(no("", "Browser '48b8ed6c' is not open. Run\n\n  playwright-cli -s=48b8ed6c open")).toBe(false);
    expect(no("The browser 'default' is not open, please run open first")).toBe(false);
  });

  test("either stream is enough to disqualify", () => {
    expect(no("Browser 'x' is not open.", "")).toBe(false);
    expect(no("", "Browser 'x' is not open.")).toBe(false);
  });

  test("tolerates empty/missing output", () => {
    expect(no("", "")).toBe(true);
  });
});

// The bug this guards, as a sequence rather than a predicate: a wedged relay must
// eventually trip the global watchdog. Before the fix, the "browser is not open" reply
// that the per-session heal itself provokes reset the streak, so the threshold was
// unreachable and only a manual `oxmgr restart rechrome` recovered.
describe("watchdog reaches its threshold on a wedged relay", () => {
  const WATCHDOG = 3;
  function run(replies: Array<{ timedOut: boolean; out?: string }>) {
    let consecutive = 0;
    let fired = false;
    for (const r of replies) {
      if (r.timedOut) {
        consecutive++;
        if (consecutive >= WATCHDOG) fired = true;
      } else if (provesRelayAlive({ stdout: r.out ?? "", stderr: "" })) {
        consecutive = 0;
      }
    }
    return fired;
  }
  const NOT_OPEN = "Browser 'x' is not open.";

  test("timeouts interleaved with session-heal noise still trip it", () => {
    expect(run([
      { timedOut: true }, { timedOut: true },
      { timedOut: false, out: NOT_OPEN },  // the heal's own side effect
      { timedOut: true },
    ])).toBe(true);
  });

  test("a genuine success still forgives, so healthy relays never restart", () => {
    expect(run([
      { timedOut: true }, { timedOut: true },
      { timedOut: false, out: '{"title":"ok"}' },
      { timedOut: true }, { timedOut: true },
    ])).toBe(false);
  });
});

// A foreground `rech serve` leaked by a dead agent must self-exit once orphaned AND
// idle, but a serve that is still actively driving commands (or not orphaned) must not.
describe("shouldExitOrphanedServe", () => {
  test("exits only when orphaned and idle past the timeout", () => {
    expect(shouldExitOrphanedServe({ orphaned: true, idleMs: 300_000, idleTimeoutMs: 300_000 })).toBe(true);
    expect(shouldExitOrphanedServe({ orphaned: true, idleMs: 300_001, idleTimeoutMs: 300_000 })).toBe(true);
  });

  test("never exits while still serving commands (idle below timeout)", () => {
    expect(shouldExitOrphanedServe({ orphaned: true, idleMs: 299_999, idleTimeoutMs: 300_000 })).toBe(false);
  });

  test("never exits a managed (non-orphaned) daemon regardless of idle", () => {
    expect(shouldExitOrphanedServe({ orphaned: false, idleMs: 1_000_000, idleTimeoutMs: 300_000 })).toBe(false);
  });

  test("a non-positive timeout disables orphan self-exit entirely", () => {
    expect(shouldExitOrphanedServe({ orphaned: true, idleMs: 1_000_000, idleTimeoutMs: 0 })).toBe(false);
  });
});
