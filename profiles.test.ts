import { expect, test } from "bun:test";
import { buildProfileRows, resolveGlobalProfile } from "./rechrome.ts";

const entry = { extensionId: "extension", token: "must-not-be-listed", profileDir: "Default" };

test("unifies registered Chrome and isolated test profiles without merging equal folder names", () => {
  const rows = buildProfileRows({ Default: { name: "Personal", user_name: "me@example.com" } }, {
    "me@example.com": { ...entry, userDataDir: "/chrome" },
    testing: { ...entry, userDataDir: "/test", loadExtension: "/extension" },
  }, "/chrome");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ kind: "Chrome", registered: true, name: "Personal" });
  expect(rows[1]).toMatchObject({ kind: "Managed test", selector: "testing" });
  expect(JSON.stringify(rows)).not.toContain(entry.token);
});

test("registered profiles remain visible without Chrome Local State", () => {
  expect(buildProfileRows(null, { testing: entry }, null)).toMatchObject([
    { selector: "testing", registered: true, kind: "Registered" },
  ]);
});

test("unconfigured Chrome profiles are distinct from registered ones", () => {
  expect(buildProfileRows({ Default: { name: "Personal" } }, {}, "/chrome")[0].registered).toBe(false);
});

test("a renamed registered no-email profile resolves through its unchanged folder", async () => {
  const registered = { ...entry, profileDir: "team-dev", userDataDir: "/chrome" };
  expect(await resolveGlobalProfile({ "team-dev": registered }, { "team-dev": { name: "Team Dev" } }, "Team Dev"))
    .toEqual({ email: "team-dev", entry: registered });
});

import { registeredProfileChoices } from "./rechrome.ts";

test("picker label never shows a bare folder without saying names are unknown", () => {
  const entry = { extensionId: "x", token: "t", profileDir: "Profile 1" };
  expect(registeredProfileChoices({ "Profile 1": entry }, null)[0].label).toBe("Profile 1  (no email or name known)");
  expect(registeredProfileChoices({ "me@example.com": entry }, { "Profile 1": { name: "Work", user_name: "me@example.com" } })[0].label)
    .toBe("Work · me@example.com  [Profile 1]");
});

test("unreadable Local State is reported explicitly, not silently", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "rech-ls-"));
  mkdirSync(join(home, "Library/Application Support/Google/Chrome"), { recursive: true });
  writeFileSync(join(home, "Library/Application Support/Google/Chrome/Local State"), "{ not json");
  const proc = Bun.spawnSync(["bun", "-e",
    `import {readChromeProfileCache, warnIfProfileNamesUnavailable} from "${import.meta.dir}/rechrome.ts"; warnIfProfileNamesUnavailable(await readChromeProfileCache());`],
    { env: { ...process.env, HOME: home }, stderr: "pipe" });
  const err = proc.stderr.toString();
  expect(err).toContain("profile emails and names are unavailable");
  expect(err).toContain("unreadable");
});
