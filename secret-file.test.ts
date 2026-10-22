import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { secretFileWarnings } from "./rechrome.ts";

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "ignore", stderr: "ignore" });

function repoWithEnv(mode = 0o600): { dir: string; env: string } {
  const dir = mkdtempSync(join(tmpdir(), "rech-secret-"));
  git(dir, "init", "-q");
  const env = join(dir, ".env.local");
  writeFileSync(env, `RECHROME_URL="http://127.0.0.1:13775/#key=abcdefghijklmnop"\n`);
  chmodSync(env, mode);
  return { dir, env };
}

test("a missing file has no warnings", async () => {
  expect(await secretFileWarnings(join(tmpdir(), "rech-no-such-file", ".env.local"))).toEqual([]);
});

test("an ignored, owner-only file is safe", async () => {
  const { dir, env } = repoWithEnv();
  writeFileSync(join(dir, ".gitignore"), "*.local\n");
  expect(await secretFileWarnings(env)).toEqual([]);
});

test("a file outside any repo only gets the permission check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rech-secret-norepo-"));
  const env = join(dir, ".env.local");
  writeFileSync(env, "RECHROME_URL=x\n");
  chmodSync(env, 0o600);
  expect(await secretFileWarnings(env)).toEqual([]);
  chmodSync(env, 0o644);
  expect(await secretFileWarnings(env, "darwin")).toEqual([expect.stringContaining("readable by other users (mode 644)")]);
  expect(await secretFileWarnings(env, "win32")).toEqual([]);
});

test("not git-ignored warns that git add . would commit it", async () => {
  const { env } = repoWithEnv();
  expect(await secretFileWarnings(env)).toEqual([expect.stringContaining("is not git-ignored")]);
});

test("staged but uncommitted warns to unstage", async () => {
  const { dir, env } = repoWithEnv();
  git(dir, "add", "-f", ".env.local");
  expect(await secretFileWarnings(env)).toEqual([expect.stringContaining("is staged in git")]);
});

test("committed warns that the key is in history; ignoring it later does not hide that", async () => {
  const { dir, env } = repoWithEnv();
  git(dir, "add", "-f", ".env.local");
  git(dir, "commit", "-q", "-m", "oops");
  writeFileSync(join(dir, ".gitignore"), "*.local\n");
  expect(await secretFileWarnings(env)).toEqual([expect.stringContaining("is committed to git")]);
});

test("untracked again after a past commit is judged by today's state", async () => {
  const { dir, env } = repoWithEnv();
  git(dir, "add", "-f", ".env.local");
  git(dir, "commit", "-q", "-m", "oops");
  git(dir, "rm", "-q", "--cached", ".env.local");
  writeFileSync(join(dir, ".gitignore"), "*.local\n");
  expect(await secretFileWarnings(env)).toEqual([]);
});

test("several problems are all reported", async () => {
  const { env } = repoWithEnv(0o644);
  const warnings = await secretFileWarnings(env, "linux");
  expect(warnings).toHaveLength(2);
  expect(warnings[0]).toContain("not git-ignored");
  expect(warnings[1]).toContain("chmod 600");
});
