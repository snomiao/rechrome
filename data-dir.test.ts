import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { migrateLegacyDataDir, RECH_DIR, LOG_DIR } from "./rechrome.ts";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "rechrome-data-dir-"));
  return { root, legacy: join(root, "install", ".rech"), target: join(root, "home", ".rechrome") };
}

test("state lives under ~/.rechrome, not next to the code", () => {
  expect(RECH_DIR).toBe(join(homedir(), ".rechrome"));
  expect(LOG_DIR).toBe(join(homedir(), ".rechrome", "logs"));
});

test("moves legacy logs and output, then removes the emptied legacy dir", () => {
  const { root, legacy, target } = sandbox();
  try {
    mkdirSync(join(legacy, "logs"), { recursive: true });
    mkdirSync(join(legacy, "output", ".playwright-cli-multi-tab"), { recursive: true });
    mkdirSync(join(legacy, "tls"), { recursive: true });
    writeFileSync(join(legacy, "logs", "2026-09-01.log"), "old log\n");
    writeFileSync(join(legacy, "output", ".playwright-cli-multi-tab", "shot.png"), "png");
    expect(migrateLegacyDataDir(legacy, target).sort()).toEqual(["logs/2026-09-01.log", "output/.playwright-cli-multi-tab"]);
    expect(readFileSync(join(target, "logs", "2026-09-01.log"), "utf8")).toBe("old log\n");
    expect(existsSync(join(target, "output", ".playwright-cli-multi-tab", "shot.png"))).toBe(true);
    expect(existsSync(legacy)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("never overwrites an entry already in the new dir, and keeps the legacy copy", () => {
  const { root, legacy, target } = sandbox();
  try {
    mkdirSync(join(legacy, "logs"), { recursive: true });
    mkdirSync(join(target, "logs"), { recursive: true });
    writeFileSync(join(legacy, "logs", "2026-09-27.log"), "old\n");
    writeFileSync(join(legacy, "logs", "2026-09-26.log"), "older\n");
    writeFileSync(join(target, "logs", "2026-09-27.log"), "new\n");
    expect(migrateLegacyDataDir(legacy, target)).toEqual(["logs/2026-09-26.log"]);
    expect(readFileSync(join(target, "logs", "2026-09-27.log"), "utf8")).toBe("new\n");
    expect(readFileSync(join(legacy, "logs", "2026-09-27.log"), "utf8")).toBe("old\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("is a no-op without a legacy dir, and when both paths are the same dir", () => {
  const { root, legacy, target } = sandbox();
  try {
    expect(migrateLegacyDataDir(legacy, target)).toEqual([]);
    mkdirSync(join(target, "logs"), { recursive: true });
    writeFileSync(join(target, "logs", "a.log"), "keep\n");
    expect(migrateLegacyDataDir(target, target)).toEqual([]);
    expect(readFileSync(join(target, "logs", "a.log"), "utf8")).toBe("keep\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
