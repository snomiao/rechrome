import { expect, test } from "bun:test";
import { windowsInteractiveServeCommand, windowsSessionProbeScript, windowsSessionWarning } from "./daemon-manager.ts";

const session = { pid: 123, sessionId: 0, userSid: "S-1-5-21-123", desktopSessionIds: [1] };

test("session zero explains the timeout and identifies the same-user desktop", () => {
  expect(windowsSessionWarning(session)).toContain("Windows session 0");
  expect(windowsSessionWarning(session)).toContain("Extension connection timeout");
  expect(windowsSessionWarning(session)).toContain("desktop session(s): 1");
});
test("active desktop is healthy; a disconnected/noninteractive session warns", () => {
  expect(windowsSessionWarning({ ...session, sessionId: 1 })).toBeUndefined();
  expect(windowsSessionWarning({ ...session, sessionId: 2 })).toContain("Windows session 2");
  expect(windowsSessionWarning({ ...session, desktopSessionIds: [] })).toContain("sign in to Windows first");
  expect(windowsSessionWarning({ ...session, sessionId: 2, desktopSessionIds: [1, 2] })).toBeUndefined();
});
test("probe scopes desktop discovery by owner SID and active WTS state", () => {
  const script = windowsSessionProbeScript(123);
  expect(script).toContain("ProcessId=123");
  expect(script).toContain("GetOwnerSid");
  expect(script).toContain(".Sid -eq $owner.Sid");
  expect(script).toContain("[RechromeSessionState]::Active($_.SessionId)");
  expect(script).toContain("WTSFreeMemory(buffer)");
  for (const pid of [0, -1, NaN, 1.5]) expect(() => windowsSessionProbeScript(pid)).toThrow();
});
test.skipIf(process.platform !== "win32")("the Windows probe returns the requested process and numeric sessions", () => {
  const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", windowsSessionProbeScript(process.pid)], { windowsHide: true, timeout: 15000 });
  expect(result.exitCode).toBe(0);
  const info = JSON.parse(result.stdout.toString());
  expect(info.pid).toBe(process.pid);
  expect(Number.isInteger(info.sessionId)).toBe(true);
  expect(info.userSid).toMatch(/^S-1-/);
  expect(Array.isArray(info.desktopSessionIds)).toBe(true);
  expect(info.desktopSessionIds.every((id: number) => Number.isInteger(id) && id > 0)).toBe(true);
});
const options = { bun: String.raw`C:\Program Files\Bun\bun.exe`, script: String.raw`C:\User's files\rechrome.ts`, nodeDirectory: String.raw`C:\Program Files\node`, home: String.raw`C:\User's files`, userSid: session.userSid };
test("hint uses an idempotent same-user interactive task without credentials or manager mutation", () => {
  const command = windowsInteractiveServeCommand(options);
  expect(command).toContain("-LogonType Interactive");
  expect(command).toContain("-MultipleInstances IgnoreNew");
  expect(command).toContain("-ExecutionTimeLimit ([TimeSpan]::Zero)");
  expect(command).toContain("-WindowStyle Hidden");
  expect(command).toContain("-AtLogOn");
  expect(command).toContain("-WorkingDirectory 'C:\\User''s files'");
  expect(command).toContain("Start-ScheduledTask -TaskName 'Rechrome Interactive Serve-S-1-5-21-123'");
  expect(command).toContain("User''''s files");
  expect(command).not.toMatch(/RECHROME_URL|token=|#key=|Stop-Process|pm2|Password/);
  expect(windowsInteractiveServeCommand(options)).toBe(command);
});

test.skipIf(process.platform !== "win32")("PowerShell parses the exact hint and preserves action quoting", () => {
  // Replace scheduler cmdlets with stubs, so this checks real PowerShell parsing
  // and nested command quoting without registering or starting anything.
  const script = `
function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory) @{Execute=$Execute;Argument=$Argument} }
function New-ScheduledTaskPrincipal { param($UserId,$LogonType) }
function New-ScheduledTaskSettingsSet { param($MultipleInstances,$ExecutionTimeLimit,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,$RestartCount,$RestartInterval) }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn,$User) }
function Register-ScheduledTask { param($TaskName,$Action,$Principal,$Settings,$Trigger,[switch]$Force) $Action.Argument | ConvertTo-Json -Compress | Write-Host }
function Start-ScheduledTask { param($TaskName) }
${windowsInteractiveServeCommand(options)}`;
  const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15000 });
  expect(result.exitCode).toBe(0);
  const action = JSON.parse(result.stdout.toString().trim());
  expect(action).toContain("& 'C:\\Program Files\\Bun\\bun.exe' 'C:\\User''s files\\rechrome.ts' serve");
});
