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
