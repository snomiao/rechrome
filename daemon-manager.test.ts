import { describe, expect, test } from "bun:test";
import { compareVersion, oxmgrHasWinfix, pickDaemonManager } from "./daemon-manager.ts";

describe("oxmgrHasWinfix", () => {
  test("accepts the winfix build tag", () => {
    expect(oxmgrHasWinfix("0.4.0+winfix")).toBe(true);
  });
  test("rejects stock 0.4.0 (would regress to the Windows daemon wedge)", () => {
    expect(oxmgrHasWinfix("0.4.0")).toBe(false);
  });
  test("accepts a newer base version even without the tag (fix assumed upstreamed)", () => {
    expect(oxmgrHasWinfix("0.4.1")).toBe(true);
    expect(oxmgrHasWinfix("0.5.0")).toBe(true);
    expect(oxmgrHasWinfix("1.0.0")).toBe(true);
  });
  test("rejects older / unknown / empty versions", () => {
    expect(oxmgrHasWinfix("0.3.9")).toBe(false);
    expect(oxmgrHasWinfix(null)).toBe(false);
    expect(oxmgrHasWinfix(undefined)).toBe(false);
    expect(oxmgrHasWinfix("")).toBe(false);
  });
});

describe("pickDaemonManager", () => {
  const OX = "/usr/bin/oxmgr";
  const PM = "/usr/bin/pm2";

  test("POSIX prefers oxmgr", () => {
    expect(pickDaemonManager({ oxmgrBin: OX, pm2Bin: PM, oxmgrVersion: "0.4.0", isWindows: false }).id).toBe("oxmgr");
  });
  test("POSIX falls back to pm2 when oxmgr is absent", () => {
    expect(pickDaemonManager({ oxmgrBin: null, pm2Bin: PM, oxmgrVersion: null, isWindows: false }).id).toBe("pm2");
  });

  test("Windows prefers oxmgr ONLY with the winfix build", () => {
    expect(pickDaemonManager({ oxmgrBin: OX, pm2Bin: PM, oxmgrVersion: "0.4.0+winfix", isWindows: true }).id).toBe("oxmgr");
  });
  test("Windows stock oxmgr 0.4.0 falls back to pm2 (avoids the wedge)", () => {
    expect(pickDaemonManager({ oxmgrBin: OX, pm2Bin: PM, oxmgrVersion: "0.4.0", isWindows: true }).id).toBe("pm2");
  });
  test("Windows uses oxmgr when pm2 is unavailable, even without winfix", () => {
    expect(pickDaemonManager({ oxmgrBin: OX, pm2Bin: null, oxmgrVersion: "0.4.0", isWindows: true }).id).toBe("oxmgr");
  });

  test("override forces the manager, bypassing the winfix guard", () => {
    expect(pickDaemonManager({ oxmgrBin: OX, pm2Bin: PM, oxmgrVersion: "0.4.0", isWindows: true, override: "oxmgr" }).id).toBe("oxmgr");
    expect(pickDaemonManager({ oxmgrBin: OX, pm2Bin: PM, oxmgrVersion: "0.4.0+winfix", isWindows: false, override: "pm2" }).id).toBe("pm2");
    expect(pickDaemonManager({ oxmgrBin: OX, pm2Bin: PM, oxmgrVersion: "0.4.0", isWindows: true, override: "OXMGR" }).id).toBe("oxmgr");
  });

  test("returns the resolved bin, or the bare name as a fallback", () => {
    expect(pickDaemonManager({ oxmgrBin: OX, pm2Bin: PM, oxmgrVersion: "0.4.0+winfix", isWindows: true }).bin).toBe(OX);
    expect(pickDaemonManager({ oxmgrBin: null, pm2Bin: null, oxmgrVersion: null, isWindows: false }).bin).toBe("oxmgr");
  });
});

describe("compareVersion", () => {
  test("orders major.minor.patch correctly", () => {
    expect(compareVersion("0.4.0", "0.4.0")).toBe(0);
    expect(compareVersion("0.4.1", "0.4.0")).toBeGreaterThan(0);
    expect(compareVersion("0.3.9", "0.4.0")).toBeLessThan(0);
    expect(compareVersion("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });
});
