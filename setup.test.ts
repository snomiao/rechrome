import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const existingConfig of [false, true]) {
  test(`setup without a manager leaves configuration untouched (existing: ${existingConfig})`, async () => {
    const taskHome = mkdtempSync(join(tmpdir(), "rechrome-setup-test-"));
    const config = join(taskHome, ".env.local");
    const original = "UNRELATED_SETTING=keep\n";
    if (existingConfig) writeFileSync(config, original);
    try {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "rech.ts"), "setup", "--profile", "Default"], {
        cwd: taskHome,
        env: {
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
      const installer = join(taskHome, launcher);
      writeFileSync(installer, `#!${process.execPath}\nawait Bun.write(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(23);\n`, { mode: 0o755 });
      try {
        const proc = Bun.spawn([process.execPath, join(import.meta.dir, "rech.ts"), "setup", "--profile", "Default", ...(consent === "--yes" ? [consent] : [])], {
          cwd: taskHome,
          env: {
            HOME: taskHome, USERPROFILE: taskHome, PATH: taskHome,
            npm_config_user_agent: `${launcher}/1.0.0`,
            RECHROME_URL: "http://test@127.0.0.1:1", RECH_HOST: "0.0.0.0",
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
    const oxmgr = join(taskHome, "oxmgr");
    const managerScript = `#!${process.execPath}\nawait Bun.write(${JSON.stringify(marker)}, "called");\nprocess.exit(23);\n`;
    writeFileSync(join(taskHome, "npm"), `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\n${exposesBinary ? `writeFileSync(${JSON.stringify(oxmgr)}, ${JSON.stringify(managerScript)}, { mode: 0o755 });` : ""}\n`, { mode: 0o755 });
    try {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "rech.ts"), "setup", "--profile", "Default", "--yes"], {
        cwd: taskHome,
        env: {
          HOME: taskHome, USERPROFILE: taskHome, PATH: taskHome,
          npm_config_user_agent: "npm/11.0.0",
          RECHROME_URL: "http://test@127.0.0.1:1", RECH_HOST: "0.0.0.0",
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
