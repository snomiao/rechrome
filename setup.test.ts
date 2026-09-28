import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IS_WINDOWS = process.platform === "win32";
// Windows can't exec shebang scripts, and resolving/spawning a .cmd shim needs these vars.
const WINDOWS_ENV = IS_WINDOWS
  ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT }
  : {};

// Source that writes an executable stub `name` into `dir` running `body` under bun: a shebang
// script on POSIX, a .mjs script plus a .cmd shim on Windows. Returned as code so a stub
// installer can create a stub binary itself.
function stubWriterSource(dir: string, name: string, body: string): string {
  const file = (n: string) => JSON.stringify(join(dir, n));
  return IS_WINDOWS
    ? `writeFileSync(${file(`${name}.mjs`)}, ${JSON.stringify(body)});\n`
      + `writeFileSync(${file(`${name}.cmd`)}, ${JSON.stringify(`@"${process.execPath}" "%~dp0${name}.mjs" %*\r\n`)});\n`
    : `writeFileSync(${file(name)}, ${JSON.stringify(`#!${process.execPath}\n${body}`)}, { mode: 0o755 });\n`;
}

function writeStub(dir: string, name: string, body: string): void {
  new Function("writeFileSync", stubWriterSource(dir, name, body))(writeFileSync);
}

for (const existingConfig of [false, true]) {
  test(`setup without a manager leaves configuration untouched (existing: ${existingConfig})`, async () => {
    const taskHome = mkdtempSync(join(tmpdir(), "rechrome-setup-test-"));
    const config = join(taskHome, ".env.local");
    const original = "UNRELATED_SETTING=keep\n";
    if (existingConfig) writeFileSync(config, original);
    try {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "rechrome.ts"), "setup", "--profile", "Default"], {
        cwd: taskHome,
        env: {
          ...WINDOWS_ENV,
          HOME: taskHome,
          USERPROFILE: taskHome,
          PATH: "",
          RECHROME_URL: "invalid",
          RECH_HOST: "0.0.0.0",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain("Setup cancelled");
      expect(stdout).toContain("bun i -g oxmgr`? [y/N]:");
      expect(stderr).not.toContain("Bun.spawn");
      expect(stdout).not.toContain("[2/5]");
      if (existingConfig) expect(readFileSync(config, "utf8")).toBe(original);
      else expect(existsSync(config)).toBe(false);
    } finally {
      rmSync(taskHome, { recursive: true, force: true });
    }
  });
}

for (const launcher of ["bun", "npm"] as const) {
  for (const consent of ["n", "y", "--yes"] as const) {
    test(`${launcher}: ${consent} controls global installation`, async () => {
      const taskHome = mkdtempSync(join(tmpdir(), "rechrome-install-test-"));
      const marker = join(taskHome, "installer-args.json");
      writeStub(taskHome, launcher, `await Bun.write(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(23);\n`);
      try {
        const proc = Bun.spawn([process.execPath, join(import.meta.dir, "rechrome.ts"), "setup", "--profile", "Default", ...(consent === "--yes" ? [consent] : [])], {
          cwd: taskHome,
          env: {
            ...WINDOWS_ENV,
            HOME: taskHome, USERPROFILE: taskHome, PATH: taskHome,
            npm_config_user_agent: `${launcher}/1.0.0`,
            RECHROME_URL: "http://test-key-0123456789@127.0.0.1:1", RECH_HOST: "0.0.0.0",
          },
          stdin: new Blob([consent === "--yes" ? "" : `${consent}\n`]),
          stdout: "pipe", stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        expect(code).toBe(1);
        if (consent === "n") {
          expect(existsSync(marker)).toBe(false);
          expect(stderr).toContain("Setup cancelled");
        } else {
          expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual(["i", "-g", "oxmgr"]);
          expect(stderr).toContain("failed (exit code 23)");
        }
        expect(stdout.includes("[y/N]")).toBe(consent !== "--yes");
        expect(existsSync(join(taskHome, ".env.local"))).toBe(false);
      } finally {
        rmSync(taskHome, { recursive: true, force: true });
      }
    });
  }
}

for (const exposesBinary of [false, true]) {
  test(`successful installer checks oxmgr availability and resumes setup (binary: ${exposesBinary})`, async () => {
    const taskHome = mkdtempSync(join(tmpdir(), "rechrome-installed-test-"));
    const marker = join(taskHome, "manager-called");
    // A working oxmgr (answers --version, which rech probes) whose real commands fail deliberately.
    const managerScript = `if (process.argv.includes("--version")) { console.log("oxmgr 0.5.0"); process.exit(0); }\nawait Bun.write(${JSON.stringify(marker)}, "called");\nprocess.exit(23);\n`;
    writeStub(taskHome, "npm", `import { writeFileSync } from "node:fs";\n${exposesBinary ? stubWriterSource(taskHome, "oxmgr", managerScript) : ""}`);
    try {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "rechrome.ts"), "setup", "--profile", "Default", "--yes"], {
        cwd: taskHome,
        env: {
          ...WINDOWS_ENV,
          HOME: taskHome, USERPROFILE: taskHome, PATH: taskHome,
          npm_config_user_agent: "npm/11.0.0",
          RECHROME_URL: "http://test-key-0123456789@127.0.0.1:1", RECH_HOST: "0.0.0.0",
        },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [code, , stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect(code).toBe(1);
      if (exposesBinary) {
        // The stub manager fails deliberately; reaching it proves setup resumed.
        expect(existsSync(marker)).toBe(true);
        expect(existsSync(join(taskHome, ".env.local"))).toBe(true);
      } else {
        expect(stderr).toContain("oxmgr was installed but is not on PATH");
        expect(existsSync(join(taskHome, ".env.local"))).toBe(false);
      }
    } finally {
      rmSync(taskHome, { recursive: true, force: true });
    }
  });
}
