import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hiddenLaunchVbs, shouldStartWindowsTray, TRAY_TOOLTIP_RUNNING, vbsString, windowsArg, windowsTrayLauncherVbs, windowsTrayScript, wscriptCommand } from "./windows-tray.ts";

const isWindows = process.platform === "win32";
const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

test("argv quoting follows CommandLineToArgvW", () => {
  expect(windowsArg("C:\\bun.exe")).toBe("C:\\bun.exe");
  expect(windowsArg("C:\\Program Files\\x.exe")).toBe('"C:\\Program Files\\x.exe"');
  expect(windowsArg('say "hi"')).toBe('"say \\"hi\\""');
  expect(windowsArg("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
  expect(windowsArg("")).toBe('""');
  expect(vbsString('a"b')).toBe('"a""b"');
});

test("launcher hides the window, waits only when supervised, and rejects bad env names", () => {
  const vbs = hiddenLaunchVbs({ argv: ["C:\\Program Files\\bun.exe", "C:\\x\\rechrome.ts", "serve"], cwd: "C:\\Users\\me", prependPath: "C:\\node", env: { RECH_SERVE_MANAGED: "1" }, wait: true });
  expect(vbs).toContain('s.Run("""C:\\Program Files\\bun.exe"" C:\\x\\rechrome.ts serve",0,True)');
  expect(vbs).toContain("WScript.Quit");
  expect(vbs).toContain('e("PATH")="C:\\node;"&e("PATH")');
  expect(vbs).toContain('e("RECH_SERVE_MANAGED")="1"');
  expect(vbs.trimEnd().split("\n")).toHaveLength(1);
  expect(hiddenLaunchVbs({ argv: ["a"], wait: false })).toContain(",0,False)");
  expect(() => hiddenLaunchVbs({ argv: ["a"], env: { "A=B": "1" }, wait: false })).toThrow();
  expect(wscriptCommand("C:\\Windows", "C:\\Users\\me\\.rechrome\\x.vbs")).toEqual({ exe: "C:\\Windows\\System32\\wscript.exe", args: "//B //NoLogo C:\\Users\\me\\.rechrome\\x.vbs" });
});

test("tray offers Status / Restart / Quit and never handles the URL or key", () => {
  const script = windowsTrayScript({ port: 13775, bun: "C:\\bun.exe", script: "C:\\r\\rechrome.ts", pidFile: "C:\\h\\.rechrome\\tray.pid", home: "C:\\h" });
  for (const item of ["'Status'", "'Restart'", "'Quit'", TRAY_TOOLTIP_RUNNING, "Local\\rechrome-tray", "CreateNoWindow=$true", "@('daemon', 'restart')", "@('daemon', 'stop')", "@('status')"])
    expect(script).toContain(item);
  expect(script).not.toMatch(/RECHROME_URL|token|#key|Bearer/);
  expect(TRAY_TOOLTIP_RUNNING.length).toBeLessThan(64); // NotifyIcon.Text limit
  for (const port of [0, -1, 70000, 1.5]) expect(() => windowsTrayScript({ port, bun: "b", script: "s", pidFile: "p", home: "h" })).toThrow();
  expect(windowsTrayLauncherVbs({ systemRoot: "C:\\Windows", trayScript: "C:\\h\\tray.ps1", home: "C:\\h" })).toContain("-STA -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\\h\\tray.ps1\",0,False)");
});

test("only a supervised serve in the active desktop session starts the tray", () => {
  const base = { platform: "win32", managed: true, session: { sessionId: 1, desktopSessionIds: [1] }, env: {} };
  expect(shouldStartWindowsTray(base)).toBe(true);
  expect(shouldStartWindowsTray({ ...base, platform: "darwin" })).toBe(false);
  expect(shouldStartWindowsTray({ ...base, managed: false })).toBe(false);
  expect(shouldStartWindowsTray({ ...base, env: { RECH_TRAY: "0" } })).toBe(false);
  expect(shouldStartWindowsTray({ ...base, session: undefined })).toBe(false);
  expect(shouldStartWindowsTray({ ...base, session: { sessionId: 0, desktopSessionIds: [0, 1] } })).toBe(false);
  expect(shouldStartWindowsTray({ ...base, session: { sessionId: 2, desktopSessionIds: [1] } })).toBe(false);
});

test.skipIf(!isWindows)("PowerShell parses the tray script without errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "rechrome tray '"));
  try {
    const file = join(dir, "tray.ps1");
    writeFileSync(file, "\ufeff" + windowsTrayScript({ port: 13775, bun: "C:\\Program Files\\b'un.exe", script: "C:\\r\\rechrome.ts", pidFile: join(dir, "tray.pid"), home: dir }), "utf8");
    const check = `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replaceAll("'", "''")}', [ref]$null, [ref]$e); $e.Count`;
    const result = Bun.spawnSync([powershell, "-NoProfile", "-NonInteractive", "-Command", check], { windowsHide: true, timeout: 20000 });
    expect(result.stdout.toString().trim()).toBe("0");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(!isWindows)("wscript runs the launcher hidden with the exact argv, env, cwd and exit code", () => {
  const dir = mkdtempSync(join(tmpdir(), "rechrome vbs "));
  try {
    const out = join(dir, "out.json");
    const probe = join(dir, "probe script.ts");
    writeFileSync(probe, `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), managed: process.env.RECH_SERVE_MANAGED, path: process.env.PATH.split(";")[0], cwd: process.cwd() })); process.exit(7);`);
    const vbs = join(dir, "launch.vbs");
    writeFileSync(vbs, Buffer.from("\ufeff" + hiddenLaunchVbs({ argv: [process.execPath, probe, "serve", 'quote " arg'], cwd: dir, prependPath: "C:\\node dir", env: { RECH_SERVE_MANAGED: "1" }, wait: true }), "utf16le"));
    const { exe, args } = wscriptCommand(process.env.SystemRoot || "C:\\Windows", vbs);
    const result = Bun.spawnSync([exe, ...args.split(" ").slice(0, 2), vbs], { windowsHide: true, timeout: 30000 });
    expect(result.exitCode).toBe(7);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ argv: ["serve", 'quote " arg'], managed: "1", path: "C:\\node dir", cwd: dir });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
