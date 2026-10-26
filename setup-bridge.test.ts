import { expect, test } from "bun:test";
import { probeSetupBridge } from "./rechrome.ts";

const identity = { key: "/test/worktree", label: "test", profile: "Profile 1" };
const env = { PLAYWRIGHT_MCP_PROFILE_DIRECTORY: "Profile 1" };
const ok = { status: 0, stdout: "connected", stderr: "" };

test("setup reaches the bridge with supported open options and closes only its probe session", async () => {
  const calls: string[][] = [];
  const result = await probeSetupBridge("unused", "setup-test", env, identity, async (_url, args, actualEnv, actualIdentity, throwOnFailure) => {
    calls.push(args);
    expect(actualEnv).toBe(env);
    expect(actualIdentity).toBe(identity);
    expect(throwOnFailure).toBe(true);
    // The bundled CLI rejects unknown options before attempting the extension handshake.
    if (args.includes("--wait")) return { status: 1, stdout: "", stderr: "Unknown option: --wait" };
    return ok;
  });
  expect(result.status).toBe(0);
  expect(calls).toEqual([["-s=setup-test", "open", "about:blank"], ["-s=setup-test", "close"]]);
});

test("setup preserves a failed handshake and still releases its probe session", async () => {
  const calls: string[][] = [];
  const failure = { status: 1, stdout: "", stderr: "Extension connection timeout" };
  const result = await probeSetupBridge("unused", "setup-failed", env, identity, async (_url, args) => {
    calls.push(args);
    if (args[1] === "close") throw new Error("cleanup failed");
    return failure;
  });
  expect(result).toBe(failure);
  expect(calls.at(-1)).toEqual(["-s=setup-failed", "close"]);
});

test("setup preserves transport errors even when closing the temporary session also fails", async () => {
  const commands: string[] = [];
  await expect(probeSetupBridge("unused", "setup-error", env, identity, async (_url, args) => {
    commands.push(args[1]!);
    throw new Error(args[1] === "open" ? "daemon unreachable" : "cleanup failed");
  })).rejects.toThrow("daemon unreachable");
  expect(commands).toEqual(["open", "close"]);
});
