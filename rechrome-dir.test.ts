import { expect, test } from "bun:test";
import { mkdtemp, readFile, symlink, writeFile, lstat, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ensureProjectDir, writeAtomic } from "./rechrome.ts";

test(".rechrome is created git-ignored, with a README", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "rech-dir-")), ".rechrome");
  await ensureProjectDir(dir);
  expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("*\n");
  expect(await readFile(join(dir, "README.md"), "utf8")).toContain(".env.local");
});

test("an existing README or .gitignore is left alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rech-dir-"));
  await writeFile(join(dir, "README.md"), "mine");
  await ensureProjectDir(dir);
  expect(await readFile(join(dir, "README.md"), "utf8")).toBe("mine");
});

test("writeAtomic keeps a symlink a symlink and leaves no temp file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rech-dir-"));
  await writeFile(join(dir, "real.env"), "old");
  await symlink(join(dir, "real.env"), join(dir, ".env.local"));
  await writeAtomic(join(dir, ".env.local"), "new", 0o600);
  expect((await lstat(join(dir, ".env.local"))).isSymbolicLink()).toBe(true);
  expect(await readFile(join(dir, "real.env"), "utf8")).toBe("new");
  expect((await readdir(dir)).filter(f => f.endsWith(".tmp"))).toEqual([]);
});
