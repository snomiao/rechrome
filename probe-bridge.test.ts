import { describe, expect, test } from "bun:test";
import { cliRejectsWaitOption, probeBridgeOpen } from "./rechrome.ts";

// rechrome 1.35.1 bundled a Playwright CLI without `open --wait`; setup must still verify the bridge.
describe("probeBridgeOpen", () => {
  const ok = { status: 0, stdout: "### Browser `s1` opened", stderr: "" };

  test("probes with --wait none when the CLI supports it", async () => {
    const calls: string[][] = [];
    const result = await probeBridgeOpen(async args => { calls.push(args); return ok; });
    expect(result).toBe(ok);
    expect(calls).toEqual([["open", "about:blank", "--wait", "none"]]);
  });

  test("retries without --wait when an older CLI rejects the option", async () => {
    const calls: string[][] = [];
    const notes: string[] = [];
    const result = await probeBridgeOpen(async args => {
      calls.push(args);
      return args.includes("--wait") ? { status: 1, stdout: "", stderr: "Unknown option: --wait\n" } : ok;
    }, n => notes.push(n));
    expect(result).toBe(ok);
    expect(calls).toEqual([["open", "about:blank", "--wait", "none"], ["open", "about:blank"]]);
    expect(notes[0]).toContain("--wait");
  });

  test("does not retry other failures", async () => {
    const calls: string[][] = [];
    const failure = { status: 1, stdout: "", stderr: "Extension connection timeout after 30000ms.\n" };
    expect(await probeBridgeOpen(async args => { calls.push(args); return failure; })).toBe(failure);
    expect(calls).toHaveLength(1);
  });
});

describe("cliRejectsWaitOption", () => {
  test("matches the CLI's unknown-option error", () => {
    expect(cliRejectsWaitOption("Unknown option: --wait")).toBe(true);
    expect(cliRejectsWaitOption("error: unknown option '--wait'")).toBe(true);
    expect(cliRejectsWaitOption("Unknown options: --foo, --wait")).toBe(true);
  });
  test("ignores unrelated output", () => {
    expect(cliRejectsWaitOption("Unknown option: --waitress-mode")).toBe(false);
    expect(cliRejectsWaitOption("timed out waiting for --wait")).toBe(false);
  });
});
