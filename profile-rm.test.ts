import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

test("profile rm: plan first, consent for a running window, then unregister everywhere and trash managed data", async () => {
  const home = await mkdtemp(join(tmpdir(), "rech-profile-rm-"));
  const dataDir = join(home, ".rechrome", "profiles", "qa");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "Preferences"), "{}");
  const entry = (profileDir: string, extra = {}) => ({ profileDir, extensionId: "a".repeat(32), token: `token-${profileDir}`, ...extra });
  await writeFile(join(home, ".rechrome", "profiles.json"), JSON.stringify({
    qa: entry("qa", { userDataDir: dataDir, loadExtension: "/ext" }),
    "qa-alias": entry("qa", { userDataDir: dataDir, loadExtension: "/ext" }),
    "me@x.com": entry("Profile 2"),
  }));
  const listenersPath = join(home, ".rechrome", "listeners.json");
  await writeFile(listenersPath, JSON.stringify({ version: 1, listeners: [
    { name: "local", host: "127.0.0.1", port: 13775, key: "m".repeat(24), profiles: "*" },
    { name: "solo", host: "127.0.0.1", port: 13790, key: "s".repeat(24), profiles: ["qa-alias"] },
    { name: "team", host: "127.0.0.1", port: 13791, key: "t".repeat(24), profiles: ["qa", "me@x.com"] },
  ] }));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PLAYWRIGHT_MCP_") && k !== "RECHROME_URL")), HOME: home, USERPROFILE: home,
    // Windows has no per-HOME Trash: keep test runs out of the real Recycle Bin.
    ...(process.platform === "win32" ? { RECH_TRASH_DIR: join(home, "Trash") } : {}) };
  const rech = async (...args: string[]) => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "rechrome.ts"), ...args], { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, out: stdout + stderr };
  };
  // A stand-in for the managed profile's browser: a process whose command line names the folder.
  const browser = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)", `--user-data-dir=${dataDir}`], { stdout: "ignore", stderr: "ignore" });
  // A browser on a sibling folder whose name only starts with the same path must never be closed.
  // (On macOS, flattened `ps` output makes such a sibling "ambiguous", so rm refuses instead;
  // the unit test covers that. Windows and Linux read exact arguments.)
  const sibling = Bun.spawn(process.platform === "darwin" ? [process.execPath, "-e", "0"]
    : [process.execPath, "-e", "setTimeout(() => {}, 60000)", `--user-data-dir=${dataDir} backup`], { stdout: "ignore", stderr: "ignore" });
  try {
    const noConsent = await rech("profile", "rm", "qa");
    expect(noConsent.code).toBe(1);
    expect(noConsent.out).toContain(`Remove profile "qa" (registered as qa, qa-alias)`);
    expect(noConsent.out).toContain(`remove listener "solo"`);
    expect(noConsent.out).toContain(`stop sharing it on listener "team"`);
    expect(noConsent.out).toContain("close its browser window");
    expect(noConsent.out).toContain("--yes");
    const stillRunning = await rech("profile", "rm", "qa", "--yes");
    expect(stillRunning.code).toBe(1);
    expect(stillRunning.out).toContain("--close");
    expect(existsSync(dataDir)).toBe(true);
    expect(JSON.parse(await readFile(listenersPath, "utf8")).listeners).toHaveLength(3);   // nothing changed yet

    const removed = await rech("profile", "rm", "qa", "--yes", "--close");
    expect(removed.code).toBe(0);
    expect(await browser.exited).not.toBe(0);                                                 // closed by SIGTERM
    if (process.platform !== "darwin") expect(sibling.exitCode).toBeNull();                    // "qa backup" untouched
    const listeners = JSON.parse(await readFile(listenersPath, "utf8")).listeners;
    expect(listeners.map((l: any) => l.name)).toEqual(["local", "team"]);
    expect(listeners.find((l: any) => l.name === "team").profiles).toEqual(["me@x.com"]);
    const registry = await readFile(join(home, ".rechrome", "profiles.yaml"), "utf8");
    expect(registry).not.toContain("qa");
    expect(registry).toContain("me@x.com");
    expect(JSON.parse(await readFile(join(home, ".rechrome", "profiles.json"), "utf8"))).not.toHaveProperty("qa-alias");
    expect(existsSync(dataDir)).toBe(false);
    if (process.platform === "darwin") expect(readdirSync(join(home, ".Trash"))).toContain("qa");
    if (process.platform === "win32") expect(readdirSync(join(home, "Trash"))).toContain("qa");

    // A real Chrome profile is only unregistered; its data is not rech's to delete.
    const real = await rech("profile", "rm", "me@x.com", "--yes");
    expect(real.code).toBe(0);
    expect(real.out).toContain("its Chrome data is left alone");
  } finally {
    browser.kill();
    sibling.kill();
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);

test("--user-data-dir is read as a whole argument: a sibling folder never matches", async () => {
  const { splitWindowsCommandLine, userDataDirArg, sameDataDir, flatUserDataDirMatch } = await import("./rechrome.ts");
  const qa = String.raw`C:\Users\A\.rechrome\profiles\qa`;
  const backup = String.raw`C:\Users\A\.rechrome\profiles\qa backup`;
  const dirOf = (commandLine: string) => userDataDirArg(splitWindowsCommandLine(commandLine));
  // Windows: C runtime argument rules, including quotes in the middle of an argument.
  expect(dirOf(`chrome.exe --user-data-dir="${backup}" --no-first-run`)).toBe(backup);
  expect(dirOf(`bun.exe -e x "--user-data-dir=${backup}"`)).toBe(backup);
  expect(dirOf(`chrome.exe --user-data-dir="${qa}"backup --x`)).toBe(`${qa}backup`);          // mixed quoting (Codex)
  expect(dirOf(`chrome.exe --user-data-dir=${qa} --flag`)).toBe(qa);
  expect(dirOf("chrome.exe --no-first-run")).toBeNull();
  expect(splitWindowsCommandLine(String.raw`a "b c" d\\"e f" g\"h "i""j"`)).toEqual(["a", "b c", String.raw`d\e f`, 'g"h', 'i"j']);
  expect(sameDataDir(backup, qa, true)).toBe(false);
  expect(sameDataDir(`${qa}backup`, qa, true)).toBe(false);
  expect(sameDataDir(qa.toLowerCase() + "\\", qa, true)).toBe(true);           // case and a trailing separator don't matter
  expect(sameDataDir(`${qa}2`, qa, true)).toBe(false);
  // POSIX ps output is flattened: exact only when the path ends the line; anything after it is
  // ambiguous (a flag, or a sibling like "qa -backup"), which is never killed.
  const posix = "/h/.rechrome/profiles/qa";
  expect(flatUserDataDirMatch(`/opt/chrome --user-data-dir=${posix}`, posix)).toBe("exact");
  expect(flatUserDataDirMatch(`/opt/chrome --user-data-dir=${posix} -backup`, posix)).toBe("ambiguous");   // Codex
  expect(flatUserDataDirMatch(`/opt/chrome --user-data-dir=${posix} --no-first-run`, posix)).toBe("ambiguous");
  expect(flatUserDataDirMatch(`/opt/chrome --user-data-dir=${posix}2`, posix)).toBe("none");
  expect(flatUserDataDirMatch(`/opt/chrome --user-data-dir=${posix}-x --y`, posix)).toBe("none");
  expect(flatUserDataDirMatch(`/opt/chrome --x`, posix)).toBe("none");
});
