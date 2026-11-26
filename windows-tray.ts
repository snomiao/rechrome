// Windows: launch rechrome's background processes without a console window, and
// the system-tray icon that shows the serve daemon is running.
//
// A console program (bun, pm2, powershell) started directly from Task Scheduler or the
// HKCU Run key opens a console window; `powershell -WindowStyle Hidden` still flashes one
// before it hides itself. wscript.exe is a GUI program, and `WshShell.Run cmd, 0` creates
// the child's console already hidden, so nothing ever appears on the desktop.
//
// Pure string builders only (no fs/process), so the quoting is unit-testable.

/** A VBScript string literal. */
export const vbsString = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** One argv element as Windows' CommandLineToArgvW reads it (no shell metacharacters involved). */
export function windowsArg(value: string): string {
  if (value && !/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * A one-line VBScript that runs `argv` with a hidden window. `wait` keeps wscript alive
 * for the child's lifetime and returns its exit code (what Task Scheduler supervises);
 * otherwise wscript exits at once and the child is detached from the caller's process tree.
 */
export function hiddenLaunchVbs(opts: { argv: string[]; cwd?: string; env?: Record<string, string>; prependPath?: string; wait: boolean }): string {
  const parts = [`Set s=CreateObject("WScript.Shell")`, `Set e=s.Environment("Process")`];
  if (opts.prependPath) parts.push(`e("PATH")=${vbsString(opts.prependPath + ";")}&e("PATH")`);
  for (const [name, value] of Object.entries(opts.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid environment variable name: ${name}`);
    parts.push(`e(${vbsString(name)})=${vbsString(value)}`);
  }
  if (opts.cwd) parts.push(`s.CurrentDirectory=${vbsString(opts.cwd)}`);
  const run = `s.Run(${vbsString(opts.argv.map(windowsArg).join(" "))},0,${opts.wait ? "True" : "False"})`;
  parts.push(opts.wait ? `WScript.Quit ${run}` : `r=${run}`);
  return parts.join(":") + "\r\n";
}

/** How a scheduled task / Run key invokes a launcher script without any console. */
export function wscriptCommand(systemRoot: string, vbsPath: string): { exe: string; args: string } {
  return { exe: `${systemRoot}\\System32\\wscript.exe`, args: `//B //NoLogo ${windowsArg(vbsPath)}` };
}

export const WINDOWS_TRAY_MUTEX = "Local\\rechrome-tray";
export const TRAY_TOOLTIP_RUNNING = "rechrome serve running";
export const TRAY_TOOLTIP_DOWN = "rechrome serve not running";

const psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * The tray: a Windows PowerShell (5.1, always present) NotifyIcon. It is a singleton (named
 * mutex), polls the daemon's TCP port for the icon/tooltip, and drives the daemon through
 * `rech status` and `rech daemon restart|stop` started with CreateNoWindow. It never reads RECHROME_URL
 * or any key: health is a plain TCP connect to the local port.
 */
export function windowsTrayScript(opts: { port: number; bun: string; script: string; pidFile: string; home: string }): string {
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) throw new Error("Invalid tray port");
  return `$ErrorActionPreference='Stop'
$created=$false
$mutex=New-Object System.Threading.Mutex($true, ${psLiteral(WINDOWS_TRAY_MUTEX)}, [ref]$created)
if (-not $created) { exit 0 }
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$port=${opts.port}; $bun=${psLiteral(opts.bun)}; $script=${psLiteral(opts.script)}; $pidFile=${psLiteral(opts.pidFile)}; $home0=${psLiteral(opts.home)}
[IO.File]::WriteAllText($pidFile, "$PID")
function Quote-Arg([string]$a) { if ($a -notmatch '[\\s"]') { return $a }; '"' + ($a -replace '(\\\\*)"', '$1$1\\"' -replace '(\\\\+)$', '$1$1') + '"' }
function Invoke-Rech([string[]]$rechArgs, [bool]$capture) {
  $psi=New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName=$bun
  $psi.Arguments=((@($script) + $rechArgs) | ForEach-Object { Quote-Arg $_ }) -join ' '
  $psi.UseShellExecute=$false; $psi.CreateNoWindow=$true; $psi.WorkingDirectory=$home0
  if ($capture) { $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true; $psi.StandardOutputEncoding=[Text.Encoding]::UTF8; $psi.StandardErrorEncoding=[Text.Encoding]::UTF8 }
  $p=[System.Diagnostics.Process]::Start($psi)
  if (-not $capture) { return $p }
  $err=$p.StandardError.ReadToEndAsync(); $out=$p.StandardOutput.ReadToEnd(); $p.WaitForExit()
  (($out + $err.Result) -replace '\\x1b\\[[0-9;]*m', '').Trim()
}
function New-StateIcon([System.Drawing.Color]$color) {
  $bmp=New-Object System.Drawing.Bitmap 16,16
  $g=[System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint=[System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $color), 0, 0, 15, 15)
  $font=New-Object System.Drawing.Font('Segoe UI', 8, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt=New-Object System.Drawing.StringFormat; $fmt.Alignment='Center'; $fmt.LineAlignment='Center'
  $g.DrawString('R', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF(0, 0, 16, 16)), $fmt)
  $g.Dispose()
  [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$iconUp=New-StateIcon ([System.Drawing.Color]::FromArgb(46, 160, 67))
$iconDown=New-StateIcon ([System.Drawing.Color]::FromArgb(200, 60, 50))
function Test-Serve {
  $c=New-Object System.Net.Sockets.TcpClient
  try { $c.ConnectAsync('127.0.0.1', $port).Wait(1000) -and $c.Connected } catch { $false } finally { $c.Close() }
}
$notify=New-Object System.Windows.Forms.NotifyIcon
$menu=New-Object System.Windows.Forms.ContextMenuStrip
$status=$menu.Items.Add('Status')
$restart=$menu.Items.Add('Restart')
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$quit=$menu.Items.Add('Quit')
$notify.ContextMenuStrip=$menu
function Update-State {
  if (Test-Serve) { $notify.Icon=$iconUp; $notify.Text=${psLiteral(TRAY_TOOLTIP_RUNNING)} }
  else { $notify.Icon=$iconDown; $notify.Text=${psLiteral(TRAY_TOOLTIP_DOWN)} }
}
$showStatus={ [void][System.Windows.Forms.MessageBox]::Show((Invoke-Rech @('status') $true), 'rechrome serve') }
$status.add_Click($showStatus)
$notify.add_DoubleClick($showStatus)
$restart.add_Click({
  [void](Invoke-Rech @('daemon', 'restart') $false)
  $notify.ShowBalloonTip(3000, 'rechrome', 'Restarting rechrome serve...', [System.Windows.Forms.ToolTipIcon]::Info)
})
$quit.add_Click({
  $p=Invoke-Rech @('daemon', 'stop') $false
  [void]$p.WaitForExit(60000)
  [System.Windows.Forms.Application]::Exit()
})
# Windows 11 puts a new icon in the hidden overflow. Show it on the taskbar once, unless the
# user already chose (IsPromoted 0 = hidden by the user): the icon exists to be seen.
$script:promoteTries=5
function Promote-Icon {
  if ($script:promoteTries -le 0) { return }
  $script:promoteTries--
  try {
    Get-ChildItem 'HKCU:\\Control Panel\\NotifyIconSettings' -ErrorAction Stop | ForEach-Object {
      $p=Get-ItemProperty -LiteralPath $_.PSPath
      if ($p.ExecutablePath -like '*\\powershell.exe' -and $p.InitialTooltip -like 'rechrome serve*') {
        $script:promoteTries=0
        if ($null -eq $p.IsPromoted) { Set-ItemProperty -LiteralPath $_.PSPath -Name IsPromoted -Value 1 -Type DWord }
      }
    }
  } catch {}
}
$timer=New-Object System.Windows.Forms.Timer
$timer.Interval=3000
$timer.add_Tick({ Update-State; Promote-Icon })
Update-State
$notify.Visible=$true
$timer.Start()
try { [System.Windows.Forms.Application]::Run() }
finally {
  $timer.Stop(); $notify.Visible=$false; $notify.Dispose()
  try { if ((Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue) -eq "$PID") { Remove-Item -LiteralPath $pidFile -Force } } catch {}
  $mutex.ReleaseMutex()
}
`;
}

/** The launcher that starts the tray detached and hidden. -STA: WinForms needs a single-threaded apartment. */
export function windowsTrayLauncherVbs(opts: { systemRoot: string; trayScript: string; home: string }): string {
  return hiddenLaunchVbs({
    argv: [`${opts.systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, "-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", opts.trayScript],
    cwd: opts.home,
    wait: false,
  });
}

/** Only a supervised serve in this user's active desktop session shows the tray (never tests, SSH, session 0). */
export function shouldStartWindowsTray(opts: {
  platform: string;
  managed: boolean;
  session?: { sessionId: number; desktopSessionIds: number[] };
  env: Record<string, string | undefined>;
}): boolean {
  if (opts.platform !== "win32" || !opts.managed || opts.env.RECH_TRAY === "0") return false;
  const s = opts.session;
  return !!s && s.sessionId !== 0 && s.desktopSessionIds.includes(s.sessionId);
}
