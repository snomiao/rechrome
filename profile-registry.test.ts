import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTokenRegistry, writeTokenRegistry } from "./rechrome.ts";

test("JSON registries migrate to private YAML, which takes precedence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rech-registry-"));
  const legacy = { qa: { extensionId: "id", token: "original", profileDir: "Default" } };
  try {
    expect(await readTokenRegistry(dir)).toEqual({});
    await writeFile(join(dir, "profiles.json"), JSON.stringify(legacy));
    expect(await readTokenRegistry(dir)).toEqual(legacy);
    // POSIX permission bits are not reported on Windows (always 0o666).
    if (process.platform !== "win32") expect((await stat(join(dir, "profiles.yaml"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(dir, "profiles.json"), "utf8"))).toEqual(legacy);
    const updated = { qa: { ...legacy.qa, token: "updated" } };
    await writeTokenRegistry(updated, dir);
    expect(await readTokenRegistry(dir)).toEqual(updated);
    await writeFile(join(dir, "profiles.yaml"), "qa: invalid\n");
    await expect(readTokenRegistry(dir)).rejects.toThrow("Invalid profile registry entry");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
