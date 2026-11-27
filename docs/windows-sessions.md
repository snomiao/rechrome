# Windows desktop sessions

Chrome's extension bridge must run in the same active Windows desktop session as
Chrome. A process manager started through SSH or a service can run `rech serve`
and its Playwright children in session 0, where extension connections time out.
Restarting Chrome does not fix the session boundary.

On Windows, serve checks its process session and discovers active Explorer
sessions belonging to the same user SID (including the WTS connection state,
so disconnected RDP sessions are excluded). If it is in session 0 or outside
those desktops, startup prints a warning and a complete PowerShell command.
`rech status` reports the serve PID/session and repeats the warning and command.
The daemon refreshes desktop discovery every 30 seconds. A probe failure is
reported as unknown, not as a healthy session. Custom shells without Explorer
may produce a warning even in an interactive session.

To repair, stop only the process manager's **rechrome** app, then run the printed
PowerShell command as the same user. Windows only lets an elevated shell register
a task with a logon trigger (a normal shell gets "Access is denied"), and the same
applies later to changing, disabling or deleting it. If the manager runs elevated,
stopping its app may require an elevated shell too. Leave the manager's other apps and Chrome
running. The command registers a clearly named, per-user task with
`LogonType Interactive`, starts it immediately, and wires it to future logons.
It reuses the task name, ignores concurrent starts, disables the default runtime
limit and battery shutdown, and retries failures. It reads the normal saved
machine configuration; temporary `RECHROME_URL` overrides and other credentials
are deliberately not copied into task arguments. Save the intended host
configuration with `rech setup` before using this command.

The command does not automatically stop an existing server. Do not leave the
old manager registration enabled: after verifying the task, remove only its
rechrome app and save the manager configuration (for pm2: `pm2 delete rechrome`
then `pm2 save --force`). Clients, including SSH/session-0 clients, can then use
the interactive server through the existing HTTP listener.

`rech status` reports the task as wired when it exists. The task intentionally
persists and can be inspected or stopped in Task Scheduler. To uninstall it,
stop and delete the `Rechrome Interactive Serve-<user SID>` task there; ordinary
`rech uninstall` only removes the process-manager app. Machines with multiple
active sessions for the same user should verify the reported serve session:
Task Scheduler chooses the interactive token rather than targeting a session ID.

## No console window, and the tray icon

Every background start avoids a console window. The interactive task runs
`wscript.exe` on `~\.rechrome\serve-interactive.vbs`, which starts bun with a hidden
window and waits on it (so the task still supervises serve). The pm2 logon entry
(`HKCU\...\Run\RechromePm2`) runs `wscript.exe` on `~\.rechrome\pm2-logon.vbs`, which
runs the `pm2-logon.ps1` resurrect script hidden. Entries from older versions started
PowerShell directly, which flashed a console; `rech setup` replaces them in place.
pm2 starts its apps hidden by default.

A supervised serve in the user's active desktop session starts the tray: a
PowerShell NotifyIcon (no build step) launched through `~\.rechrome\tray.vbs`. Its
tooltip reads "rechrome serve running" (or "not running", polled every 3 seconds
from the local port), and its menu has **Status** (`rech status` in a dialog),
**Restart** (`rech daemon restart`) and **Quit** (`rech daemon stop`, then the icon
closes). A named mutex keeps one icon across serve restarts. Windows 11 puts new
icons in the hidden overflow; the tray shows itself on the taskbar once unless you
have already hidden it there. Set `RECH_TRAY=0` in the daemon's environment to skip
the tray. `rech tray show|hide` starts or removes it by hand.

`rech daemon restart|stop` goes through the process manager when it registers
`rechrome`; otherwise it ends the interactive task and the serve it started (ending a
task does not stop that child by itself), then for a restart runs the task again.

References: [Interactive task principals](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal)
and [task settings](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset).
