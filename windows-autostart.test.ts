import { expect, test } from "bun:test";
import { isPm2Resurrect, pm2LogonCommand, pm2LogonScript, pm2WindowsAutostart, setupBridgeCanRetry } from "./rechrome.ts";

const bin = String.raw`C:\Program Files\pm2\pm2.cmd`;
test("matches equivalent direct commands, not substrings or other installations", () => {
  expect(isPm2Resurrect(`"${bin}" resurrect`, bin)).toBe(true);
  expect(isPm2Resurrect("pm2.exe resurrect", bin)).toBe(true);
  expect(isPm2Resurrect("echo pm2 resurrect", bin)).toBe(false);
  expect(isPm2Resurrect('"C:\\other\\pm2.exe" resurrect', bin)).toBe(false);
  expect(isPm2Resurrect("pm2 resurrect && other", bin)).toBe(false);
});
test("logon command preserves custom home and quoted shim paths", () => {
  const script = pm2LogonScript(bin, { PM2_HOME: "C:\\custom home's\\pm2", PATH: "C:\\Program Files\\node", SystemRoot: "C:\\Windows" });
  expect(pm2LogonCommand().length).toBeLessThanOrEqual(260);
  expect(script).toContain("home''s");
  expect(script).toContain(`& '${bin}' resurrect`);
  expect(script).toContain("$env:PATH='C:\\Program Files\\node'");
});
test("installs once, verifies and reuses existing wiring", () => {
  let command = "";
  let writes = 0;
  let scriptExists = false;
  const scriptIO = { exists: () => scriptExists, write: (_script: string) => { scriptExists = true; } };
  const run = (args: string[]) => {
    if (args[0] === "add") { writes++; command = args[args.indexOf("/d") + 1]!; }
    return { exitCode: 0, stdout: command ? `    ExistingName    REG_SZ    ${command}\r\n` : "" };
  };
  expect(pm2WindowsAutostart(bin, false, run, scriptIO)).toBe(false);
  expect(pm2WindowsAutostart(bin, true, run, scriptIO)).toBe(true);
  expect(pm2WindowsAutostart(bin, true, run, scriptIO)).toBe(true);
  expect(writes).toBe(1);
});
test("does not duplicate an existing direct resurrect entry", () => {
  if (process.env.PM2_HOME) return;
  expect(pm2WindowsAutostart(bin, true, args => {
    expect(args[0]).toBe("query");
    return { exitCode: 0, stdout: '    ExistingName    REG_SZ    pm2.exe resurrect\r\n' };
  })).toBe(true);
});
test("registry failures are reported", () => {
  expect(() => pm2WindowsAutostart(bin, true, () => ({ exitCode: 1, stdout: "" }))).toThrow("Cannot inspect");
  expect(() => pm2WindowsAutostart(bin, true, args => ({ exitCode: args[0] === "add" ? 1 : 0, stdout: "" }), { exists: () => false, write: () => {} })).toThrow("Cannot register");
});
test("only interactive setup with a guide waits for manual retries", () => {
  expect(setupBridgeCanRetry(true, true, false)).toBe(true);
  expect(setupBridgeCanRetry(false, true, false)).toBe(false);
  expect(setupBridgeCanRetry(true, true, true)).toBe(false);
  expect(setupBridgeCanRetry(true, false, false)).toBe(false);
});


test("creates a missing Run key and repairs a missing wrapper", () => {
  let keyExists = false;
  let scriptExists = false;
  let value = "";
  const run = (args: string[]) => {
    if (args[0] === "add") {
      keyExists = true;
      if (args.includes("/d")) value = args[args.indexOf("/d") + 1]!;
    }
    return { exitCode: keyExists ? 0 : 1, stdout: value ? `    RechromePm2    REG_SZ    ${value}\r\n` : "" };
  };
  const io = { exists: () => scriptExists, write: () => { scriptExists = true; } };
  expect(pm2WindowsAutostart(bin, true, run, io)).toBe(true);
  scriptExists = false;
  expect(pm2WindowsAutostart(bin, false, run, io)).toBe(false);
  expect(pm2WindowsAutostart(bin, true, run, io)).toBe(true);
});

test.skipIf(process.platform !== "win32")("Windows executes the logon wrapper with preserved environment and resurrect argument", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "rechrome logon "));
  try {
    const stub = join(dir, "pm2 test.ps1");
    writeFileSync(stub, '[Console]::WriteLine(($env:PM2_HOME + "|" + $env:PATH + "|" + $args[0])); exit 0');
    const script = join(dir, "logon.ps1");
    writeFileSync(script, "\ufeff" + pm2LogonScript(stub, { PM2_HOME: "C:\\custom home's\\pm2", PATH: "C:\\node path" }));
    const result = Bun.spawnSync([join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { windowsHide: true, timeout: 10000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("C:\\custom home's\\pm2|C:\\node path|resurrect");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
