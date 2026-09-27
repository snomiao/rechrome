import { expect, test } from "bun:test";
import { detectSetupAgent, setupAgentGuidance } from "./rechrome.ts";

test("detects agent environment hints without treating generic CI as an agent", () => {
  expect(detectSetupAgent({ CODEX_THREAD_ID: "thread" })).toBe("Codex");
  expect(detectSetupAgent({ CODEX_SANDBOX: "seatbelt" })).toBe("Codex");
  expect(detectSetupAgent({ CLAUDECODE: "1" })).toBe("Claude Code");
  expect(detectSetupAgent({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe("Claude Code");
  expect(detectSetupAgent({ CI: "1", TERM_PROGRAM: "vscode" })).toBeNull();
  expect(detectSetupAgent({ CODEX_CI: "0", CLAUDECODE: "false" })).toBeNull();
});

test("explicit overrides take precedence in inherited agent environments", () => {
  expect(detectSetupAgent({ CODEX_THREAD_ID: "thread", RECH_SETUP_AGENT: "claude" })).toBe("Claude Code");
  expect(detectSetupAgent({ CLAUDECODE: "1", RECH_SETUP_AGENT: "codex" })).toBe("Codex");
  expect(detectSetupAgent({ CODEX_THREAD_ID: "thread", RECH_SETUP_AGENT: "none" })).toBeNull();
});

test("guidance links a shipped skill and limits native Mac instructions to macOS", async () => {
  expect(await Bun.file(new URL("./skills/rechrome-setup/SKILL.md", import.meta.url)).exists()).toBe(true);
  expect(setupAgentGuidance("Codex", "darwin")).toContain("Command+Shift+G");
  expect(setupAgentGuidance("Claude Code", "linux")).not.toContain("Command+Shift+G");
  const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json();
  expect(pkg.files).toContain("skills/rechrome-setup");
});
