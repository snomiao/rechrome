import { expect, test } from "bun:test";
import { mkdtempSync, lstatSync, readFileSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { playwrightCliEnv, tmpSocketRoot } from "./serve.ts";

const uid = process.getuid?.();
const darwin = (env: NodeJS.ProcessEnv = {}, owner = uid) => ({ env, platform: "darwin" as const, uid: owner });

test.skipIf(uid === undefined)("macOS isolated session socket fits sun_path despite a long TMPDIR", () => {
  const env = playwrightCliEnv({}, darwin({ TMPDIR: "/var/folders/vr/_q_jqlgs7t98p5lmylv4cbj00000gn/T/" }));
  const socket = join(tmpSocketRoot(env), `${"a".repeat(16)}-${"b".repeat(8)}-iso-${"c".repeat(16)}.sock`);
  expect(env.PLAYWRIGHT_SOCKETS_DIR).toBe(`/tmp/pw-${uid}`);
  expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
  expect(lstatSync(env.PLAYWRIGHT_SOCKETS_DIR!).mode & 0o777).toBe(0o700);
});

test.skipIf(uid === undefined)("explicit socket directory is honored, but foreign owners and symlinks are refused", () => {
  const root = mkdtempSync(join(tmpdir(), "rech-sockets-"));
  try {
    const source = { PLAYWRIGHT_SOCKETS_DIR: join(root, "explicit") };
    const env = playwrightCliEnv({}, darwin(source));
    expect(env.PLAYWRIGHT_SOCKETS_DIR).toBe(source.PLAYWRIGHT_SOCKETS_DIR);
    expect(tmpSocketRoot(env)).toBe(join(source.PLAYWRIGHT_SOCKETS_DIR, "cli"));
    expect(() => playwrightCliEnv({}, darwin(source, uid! + 1))).toThrow("Refusing unsafe");
    symlinkSync(source.PLAYWRIGHT_SOCKETS_DIR, join(root, "link"));
    expect(() => playwrightCliEnv({}, darwin({ PLAYWRIGHT_SOCKETS_DIR: join(root, "link") }))).toThrow("Refusing unsafe");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("non-darwin preserves default socket selection and command environment", () => {
  for (const platform of ["linux", "win32"] as const) {
    const env = playwrightCliEnv({ PLAYWRIGHT_MCP_EXTENSION: "1" }, {
      platform, uid, env: { PATH: "/bin", HOME: "/home/test", TMPDIR: "/tmp/test", DEBUG: "pw:*" },
    });
    expect(env.PLAYWRIGHT_SOCKETS_DIR).toBeUndefined();
    expect(env.PATH).toBe("/bin");
    expect(env.DEBUG).toBe("pw:*");
    expect(env.PLAYWRIGHT_MCP_EXTENSION).toBe("1");
    expect(tmpSocketRoot(env)).toBe("/tmp/test/pw-7505d64a/cli");
    expect(playwrightCliEnv({}, { platform, uid, env: { PLAYWRIGHT_SOCKETS_DIR: "/custom" } }).PLAYWRIGHT_SOCKETS_DIR).toBe("/custom");
  }
});

// Match every spawn whose argument array includes a namespaced CLI session.
// This deliberately checks each call site, not just the number of helper mentions.
function cliSpawns(source: string): string[] {
  return [...source.matchAll(/Bun\.spawn\(\[[^\n]*\],\s*\{[\s\S]*?\n\s*\}\);/g)]
    .map(m => m[0]).filter(s => s.split("\n")[0].includes("-s="));
}
function allUseHelper(source: string): boolean {
  const calls = cliSpawns(source);
  return calls.length >= 5 && calls.every(call => /env:\s*playwrightCliEnv\(/.test(call));
}

test("every CLI spawn uses the shared environment; bypassing any site fails", () => {
  const source = readFileSync(join(import.meta.dir, "serve.ts"), "utf8");
  expect(allUseHelper(source)).toBe(true);
  for (const call of cliSpawns(source)) {
    const mutant = source.replace(call, call.replace(/env:\s*playwrightCliEnv\([^)]*\)/, "env: process.env"));
    expect(allUseHelper(mutant)).toBe(false);
  }
});
