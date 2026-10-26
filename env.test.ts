import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("explicit environment wins and file defaults retain nearest-first precedence on reload", () => {
  const root = mkdtempSync(join(tmpdir(), "rechrome-env-"));
  try {
    const cwd = join(root, "project");
    mkdirSync(join(cwd, ".rechrome"), { recursive: true });
    writeFileSync(join(root, ".env.local"), "RECH_TEST_DEFAULT=parent\n");
    writeFileSync(join(cwd, ".env.local"), "RECHROME_URL=http://stale.invalid\nRECH_TEST_DEFAULT=project\nRECH_TEST_EMPTY=file\n");
    const nearest = join(cwd, ".rechrome", ".env.local");
    writeFileSync(nearest, "RECH_TEST_DEFAULT=nearest\n");
    const source = new URL("./rechrome.ts", import.meta.url).href;
    const script = `
      const { loadNearestEnv } = await import(${JSON.stringify(source)});
      const first = [process.env.RECHROME_URL, process.env.RECH_TEST_DEFAULT, process.env.RECH_TEST_EMPTY];
      await Bun.write(${JSON.stringify(nearest)}, 'RECH_TEST_DEFAULT=updated\\nRECHROME_URL=http://other.invalid\\n');
      await loadNearestEnv();
      console.log(JSON.stringify({ first, second: [process.env.RECHROME_URL, process.env.RECH_TEST_DEFAULT] }));
      process.exit(0);
    `;
    const result = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], {
      cwd,
      env: { PATH: process.env.PATH, HOME: root, RECHROME_URL: "http://explicit.invalid", RECH_TEST_EMPTY: "" },
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      first: ["http://explicit.invalid", "nearest", ""],
      second: ["http://explicit.invalid", "updated"],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the machine-wide link (rech connect --global) applies outside $HOME, and a project's own link wins", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rechrome-global-")));
  try {
    const home = join(root, "home"), scratch = join(root, "scratch"), project = join(root, "project");
    mkdirSync(join(home, ".rechrome"), { recursive: true });
    mkdirSync(scratch); mkdirSync(join(project, ".rechrome"), { recursive: true });
    writeFileSync(join(home, ".rechrome", ".env.local"), 'RECHROME_URL="https://global.invalid/rechrome/#key=g"\n');
    writeFileSync(join(project, ".rechrome", ".env.local"), 'RECHROME_URL="https://project.invalid/#key=p"\n');
    const source = new URL("./rechrome.ts", import.meta.url).href;
    const script = `
      const m = await import(${JSON.stringify(source)});
      console.log(JSON.stringify({ url: process.env.RECHROME_URL, from: m.rechromeUrlSource, shadow: m.nearerUrlSource(process.cwd(), false) }));
      process.exit(0);
    `;
    const at = (cwd: string) => JSON.parse(Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], { cwd, env: { PATH: process.env.PATH, HOME: home } }).stdout.toString());
    // scratch is not under HOME, so the walk never passes ~/.rechrome: the fallback still finds it.
    expect(at(scratch)).toEqual({ url: "https://global.invalid/rechrome/#key=g", from: join(home, ".rechrome", ".env.local"), shadow: null });
    expect(at(project)).toEqual({ url: "https://project.invalid/#key=p", from: join(project, ".rechrome", ".env.local"), shadow: join(project, ".rechrome", ".env.local") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
