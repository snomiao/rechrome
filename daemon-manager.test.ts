import { describe, expect, test } from "bun:test";
import { compareVersion, oxmgrHasWinfix, oxmgrInstallCommand, pickDaemonManager } from "./daemon-manager.ts";

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

  test("returns the resolved bin", () => {
    expect(pickDaemonManager({ oxmgrBin: OX, pm2Bin: PM, oxmgrVersion: "0.4.0+winfix", isWindows: true }).bin).toBe(OX);

  });
  for (const isWindows of [false, true]) {
    test(`missing managers give installation instructions (Windows: ${isWindows})`, () => {
      expect(() => pickDaemonManager({ oxmgrBin: null, pm2Bin: null, oxmgrVersion: null, isWindows }))
        .toThrow("bun add -g pm2");
    });
  }
  test("an unavailable explicit manager does not silently fall back", () => {
    expect(() => pickDaemonManager({ oxmgrBin: null, pm2Bin: PM, oxmgrVersion: null, isWindows: false, override: "OXMGR" }))
      .toThrow("RECH_DAEMON_MANAGER=oxmgr");
    expect(() => pickDaemonManager({ oxmgrBin: OX, pm2Bin: null, oxmgrVersion: null, isWindows: false, override: "pm2" }))
      .toThrow("RECH_DAEMON_MANAGER=pm2");
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

describe("oxmgrInstallCommand", () => {
  test("uses npm for npx even though rechrome runs under Bun", () => {
    expect(oxmgrInstallCommand({ npm_config_user_agent: "npm/11.0.0 node/v22.0.0" })).toEqual(["npm", "i", "-g", "oxmgr"]);
    expect(oxmgrInstallCommand({ npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js" })[0]).toBe("npm");
    expect(oxmgrInstallCommand({ npm_execpath: "C:\\npm\\bin\\npx-cli.js" })[0]).toBe("npm");
  });
  test("uses bun for bunx or direct invocation", () => {
    expect(oxmgrInstallCommand({ npm_config_user_agent: "bun/1.4.2", npm_execpath: "/bin/npm" })).toEqual(["bun", "i", "-g", "oxmgr"]);
    expect(oxmgrInstallCommand({})).toEqual(["bun", "i", "-g", "oxmgr"]);
  });
});
