// Process-manager selection policy for the `rech serve` daemon.
//
// oxmgr is the cross-platform default. On Windows, stock oxmgr 0.4.0 wedges after
// a daemon crash: it leaves the daemon's control socket bound to a dead PID, so
// every subsequent oxmgr command fails with "daemon did not become ready in
// time". The snomiao/OxMgr fork fixes it and stamps the build `0.4.0+winfix`.
// We therefore only PREFER oxmgr on Windows when the winfix build is present;
// stock 0.4.0 falls back to pm2's named-pipe daemon, which has no such failure
// mode. POSIX oxmgr is unaffected and stays the default there.
//
// This module is deliberately pure (no Bun/process/fs) so the selection policy is
// unit-testable; the impure probing (Bun.which, `oxmgr --version`) lives in
// rechrome.ts and feeds its results into pickDaemonManager.

import { hiddenLaunchVbs, wscriptCommand } from "./windows-tray.ts";

export type DaemonManager = { id: "oxmgr" | "pm2"; bin: string };

// Base version that first shipped the winfix build tag. A strictly newer base
// version is assumed to carry the fix upstream even without the explicit
// `+winfix` tag, so a future release doesn't get pinned out.
export const OXMGR_WINFIX_BASE = "0.4.0";

// Compare dotted numeric versions (major.minor.patch); any build/prerelease
// suffix must be stripped by the caller. Returns <0, 0, or >0.
export function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// True when an `oxmgr --version` string reports a build carrying the Windows
// daemon-wedge fix: the `+winfix` build tag, OR a base version newer than the
// 0.4.0 that first shipped it. Anything older/unknown/empty is treated as
// unfixed so a Windows install falls back to pm2 rather than the wedge.
export function oxmgrHasWinfix(version: string | null | undefined): boolean {
  if (!version) return false;
  const plus = version.indexOf("+");
  const base = plus === -1 ? version : version.slice(0, plus);
  const build = plus === -1 ? "" : version.slice(plus + 1);
  if (build.includes("winfix")) return true;
  return compareVersion(base.trim(), OXMGR_WINFIX_BASE) > 0;
}

// Decide which manager daemonizes `rech serve`, given what's discoverable at
// runtime. `override` is RECH_DAEMON_MANAGER (case-insensitive) and, when set to
// a known manager, wins outright — bypassing the winfix guard as an explicit
// opt-in. The `*Bin` inputs are resolved executable paths (null when not on
// PATH). Missing dependencies fail here, before callers mutate configuration.
export function pickDaemonManager(opts: {
  oxmgrBin: string | null;
  pm2Bin: string | null;
  oxmgrVersion: string | null;
  isWindows: boolean;
  override?: string | null;
}): DaemonManager {
  const override = opts.override?.toLowerCase();
  if (override === "oxmgr" && !opts.oxmgrBin) {
    throw new Error("RECH_DAEMON_MANAGER=oxmgr, but oxmgr is not on PATH. Install it with `bun i -g oxmgr` and ensure the global bin directory is on PATH.");
  }
  if (override === "pm2" && !opts.pm2Bin) {
    throw new Error("RECH_DAEMON_MANAGER=pm2, but pm2 is not on PATH. Install it with `bun add -g pm2` and ensure the global bin directory is on PATH.");
  }
  if (!opts.oxmgrBin && !opts.pm2Bin) {
    // oxmgr is the recommended manager. On Windows stock oxmgr is only used when pm2 is
    // absent (see below), so pm2 stays a documented alternative there.
    const install = opts.isWindows
      ? "Install oxmgr with `bun i -g oxmgr` (on Windows, pm2 via `bun add -g pm2` is preferred unless oxmgr is the +winfix build)"
      : "Install oxmgr with `bun i -g oxmgr`";
    throw new Error(`No daemon process manager found on PATH (oxmgr or pm2). ${install}, ensure the global bin directory is on PATH, then rerun \`bunx rechrome setup\`.`);
  }
  const oxmgr: DaemonManager = { id: "oxmgr", bin: opts.oxmgrBin ?? "oxmgr" };
  const pm2: DaemonManager = { id: "pm2", bin: opts.pm2Bin ?? "pm2" };

  if (override === "pm2") return pm2;
  if (override === "oxmgr") return oxmgr;

  if (opts.isWindows) {
    // Prefer oxmgr only when it carries the winfix; otherwise pm2. If pm2 is
    // missing, fall back to oxmgr regardless — a possibly-wedging manager still
    // beats none, and the operator can install pm2 or the winfix build.
    if (opts.oxmgrBin && oxmgrHasWinfix(opts.oxmgrVersion)) return oxmgr;
    if (opts.pm2Bin) return pm2;
    return oxmgr;
  }

  // POSIX: oxmgr preferred, pm2 fallback.
  if (opts.oxmgrBin) return oxmgr;
  if (opts.pm2Bin) return pm2;
  return oxmgr;
}

// npm/npx sets npm_config_user_agent even when the CLI's shebang runs Bun.
// Prefer launcher metadata over the runtime, which is Bun for both launchers.
export function oxmgrInstallCommand(env: { npm_config_user_agent?: string; npm_execpath?: string; [name: string]: string | undefined }):["bun" | "npm", "i", "-g", "oxmgr"] {
  const agent = env.npm_config_user_agent?.toLowerCase() ?? "";
  if (agent.startsWith("npm/")) return ["npm", "i", "-g", "oxmgr"];
  if (agent.startsWith("bun/")) return ["bun", "i", "-g", "oxmgr"];
  const execPath = env.npm_execpath?.replace(/\\/g, "/") ?? "";
  if (/(^|\/)(npm|npx)(-cli\.js|\.cmd|\.exe)?$/i.test(execPath)) return ["npm", "i", "-g", "oxmgr"];
  return ["bun", "i", "-g", "oxmgr"];
}

export const PM2_DEPRECATION =
  "pm2 is deprecated as the rech daemon manager; install oxmgr (`bun i -g oxmgr`) and rerun `rech setup` to migrate.";

// Whether `mgr` is pm2 only as a stopgap because oxmgr is missing: the case where the user
// should be nudged to oxmgr. Never on Windows, where pm2 is the deliberate choice over stock
// (non-winfix) oxmgr and installing oxmgr would not change the pick, and never for an explicit
// RECH_DAEMON_MANAGER=pm2.
export function isDeprecatedPm2Fallback(mgr: DaemonManager, opts: { isWindows: boolean; override?: string | null }): boolean {
  return mgr.id === "pm2" && !opts.isWindows && !opts.override;
}

// Whether a manager's process list (pm2 `jlist` JSON / oxmgr `list` table) registers exactly
// `name`. A substring test false-positives on other processes whose names, paths or args
// mention it (a pm2 app running from a `.../rechrome/...` checkout, or legacy `rechrome-serve`).
export function listsProcess(id: DaemonManager["id"], output: string, name: string): boolean {
  if (id === "pm2") {
    try {
      const list = JSON.parse(output);
      return Array.isArray(list) && list.some((p: { name?: unknown } | null) => p?.name === name);
    } catch {
      return false;
    }
  }
  return output.split(/[\s│|┃]+/).includes(name);
}

export type WindowsDesktopSession = {
  pid: number;
  sessionId: number;
  userSid: string;
  desktopSessionIds: number[];
};

export function windowsSessionWarning(info: WindowsDesktopSession): string | undefined {
  if (info.sessionId !== 0 && info.desktopSessionIds.includes(info.sessionId)) return;
  const desktop = info.desktopSessionIds.length ? ` Same-user active desktop session(s): ${info.desktopSessionIds.join(", ")}.` : " No active desktop session for this user was found; sign in to Windows first.";
  return `WARNING: serve PID ${info.pid} runs in Windows session ${info.sessionId}, outside this user's active desktop. Chrome's extension may never connect (Extension connection timeout).${desktop}`;
}

const psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

export const windowsInteractiveTaskName = (userSid: string) => `Rechrome Interactive Serve-${userSid}`;

// No URLs, tokens, or inherited credential environment in task arguments. The
// new serve reads the normal machine-wide configuration in ~/.rechrome.
// The task runs wscript.exe on a one-line VBScript launcher (written next to the
// other state in ~/.rechrome) that starts bun with a hidden window and waits on it:
// no console window ever appears, not even the flash of powershell -WindowStyle Hidden.
export function windowsInteractiveServeCommand(opts: { bun: string; script: string; nodeDirectory: string; home: string; userSid: string; systemRoot?: string }): string {
  const name = psLiteral(windowsInteractiveTaskName(opts.userSid));
  const rechDir = `${opts.home}\\.rechrome`;
  const launcher = `${rechDir}\\serve-interactive.vbs`;
  const vbs = hiddenLaunchVbs({ argv: [opts.bun, opts.script, "serve"], cwd: opts.home, prependPath: opts.nodeDirectory, env: { RECH_SERVE_MANAGED: "1" }, wait: true });
  const wscript = wscriptCommand(opts.systemRoot ?? "$env:SystemRoot", launcher);
  return [
    `New-Item -ItemType Directory -Force -Path ${psLiteral(rechDir)} | Out-Null`,
    `[IO.File]::WriteAllText(${psLiteral(launcher)}, ${psLiteral(vbs.trimEnd())}, [Text.Encoding]::Unicode)`,
    `$action=New-ScheduledTaskAction -Execute "${wscript.exe}" -WorkingDirectory ${psLiteral(opts.home)} -Argument ${psLiteral(wscript.args)}`,
    `$principal=New-ScheduledTaskPrincipal -UserId ${psLiteral(opts.userSid)} -LogonType Interactive`,
    `$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)`,
    `$trigger=New-ScheduledTaskTrigger -AtLogOn -User ${psLiteral(opts.userSid)}`,
    `Register-ScheduledTask -TaskName ${name} -Action $action -Principal $principal -Settings $settings -Trigger $trigger -Force | Out-Null`,
    `Start-ScheduledTask -TaskName ${name}`,
  ].join("; ");
}

// WTS state 0 = Active. Explorer alone is insufficient: it also survives in
// disconnected RDP sessions. Compare owner SIDs, never just a username/session ID.
export function windowsSessionProbeScript(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid process ID");
  return `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RechromeSessionState {
  [DllImport("wtsapi32.dll")] static extern bool WTSQuerySessionInformation(IntPtr server, int session, int info, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr buffer);
  public static bool Active(int session) {
    IntPtr buffer; int bytes;
    if (!WTSQuerySessionInformation(IntPtr.Zero, session, 8, out buffer, out bytes)) return false;
    try { return bytes >= 4 && Marshal.ReadInt32(buffer) == 0; }
    finally { WTSFreeMemory(buffer); }
  }
}
'@
$target=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'
if (!$target) { throw 'Serve process exited' }
$owner=Invoke-CimMethod -InputObject $target -MethodName GetOwnerSid
if ($owner.ReturnValue -ne 0) { throw 'Cannot read serve owner' }
$desktops=@(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Where-Object {
  $_.SessionId -gt 0 -and [RechromeSessionState]::Active($_.SessionId) -and
  (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $owner.Sid
} | Select-Object -ExpandProperty SessionId -Unique)
@{pid=${pid};sessionId=[int]$target.SessionId;userSid=$owner.Sid;desktopSessionIds=@($desktops)} | ConvertTo-Json -Compress`;
}
