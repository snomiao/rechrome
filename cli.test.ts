import { test, expect } from "bun:test";
import { rechCli, type RechHandlers } from "./rechrome.ts";

async function run(argv: string[]) {
  const calls: [string, ...unknown[]][] = [];
  const record = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); };
  const handlers = Object.fromEntries(["serve", "status", "listListeners", "addListener", "removeListener", "listProfiles",
    "printProfileUri", "setup", "tray", "provisionProfile", "uninstall"].map(n => [n, record(n)])) as unknown as RechHandlers;
  await rechCli(argv, handlers).exitProcess(false).parseAsync();
  return calls;
}

test("setup parses options in both --opt value and --opt=value forms, keeping numeric profiles as strings", async () => {
  expect(await run(["setup", "--profile", "18", "--listen=tailscale", "--prefix", "rechrome", "--port=13776", "--token", "t"]))
    .toEqual([["setup", { profile: "18", token: "t", listen: "tailscale", prefix: "rechrome", port: 13776 }]]);
});

test("setup falls back to RECH_TOKEN and rejects a flag without a value or an unknown flag", async () => {
  process.env.RECH_TOKEN = "env-token";
  try {
    expect((await run(["setup"]))[0][1]).toMatchObject({ token: "env-token" });
  } finally { delete process.env.RECH_TOKEN; }
  await expect(run(["setup", "--listen"])).rejects.toThrow();
  await expect(run(["setup", "--bogus"])).rejects.toThrow(/Unknown argument/);
});

test("profile lists by default and prints a URI with an optional listener", async () => {
  expect(await run(["profile"])).toEqual([["listProfiles"]]);
  expect(await run(["profiles", "ls"])).toEqual([["listProfiles"]]);
  expect(await run(["profile", "qa", "--print-uri", "--listener", "local"])).toEqual([["printProfileUri", "qa", "local"]]);
  expect(await run(["profile", "--print-uri"])).toEqual([["printProfileUri", undefined, undefined]]);
  await expect(run(["profile", "qa"])).rejects.toThrow(/not implemented/);
});

test("listener subcommands, with repeatable --profile", async () => {
  expect(await run(["listener"])).toEqual([["listListeners"]]);
  expect(await run(["listeners", "ls"])).toEqual([["listListeners"]]);
  expect(await run(["listener", "remove", "qa"])).toEqual([["removeListener", "qa"]]);
  expect(await run(["listener", "add", "qa", "--listen", "tailscale", "--profile", "a", "--profile", "b", "--port", "13776"]))
    .toEqual([["addListener", "qa", { listen: "tailscale", profile: ["a", "b"], port: 13776, prefix: undefined }]]);
  await expect(run(["listener", "add", "qa", "--listen", "lan"])).rejects.toThrow(/profile/);
});

test("tray and provision-profile", async () => {
  expect(await run(["tray"])).toEqual([["tray", undefined]]);
  expect(await run(["tray", "hide"])).toEqual([["tray", "hide"]]);
  await expect(run(["tray", "explode"])).rejects.toThrow();
  expect(await run(["provision-profile", "qa", "--experimental"])).toEqual([["provisionProfile", "qa", { headed: false, experimental: true }]]);
  await expect(run(["provision-profile"])).rejects.toThrow();
});
