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
// PATH); the returned `bin` falls back to the bare command name so a downstream
// "install a manager" error can still surface with a meaningful name.
export function pickDaemonManager(opts: {
  oxmgrBin: string | null;
  pm2Bin: string | null;
  oxmgrVersion: string | null;
  isWindows: boolean;
  override?: string | null;
}): DaemonManager {
  const oxmgr: DaemonManager = { id: "oxmgr", bin: opts.oxmgrBin ?? "oxmgr" };
  const pm2: DaemonManager = { id: "pm2", bin: opts.pm2Bin ?? "pm2" };

  const override = opts.override?.toLowerCase();
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
