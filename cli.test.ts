import { test, expect } from "bun:test";
import { rechCli, listenerNextSteps, type RechHandlers } from "./rechrome.ts";

async function run(argv: string[]) {
  const calls: [string, ...unknown[]][] = [];
  const record = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); };
  const handlers = Object.fromEntries(["serve", "status", "listListeners", "addListener", "removeListener", "listProfiles",
    "printProfileUri", "setup", "tray", "provisionProfile", "uninstall",
    "urlList", "connect", "listenerPort", "allowListener", "denyListener", "rotateKey", "setListener"].map(n => [n, record(n)])) as unknown as RechHandlers;
  await rechCli(argv, handlers).exitProcess(false).parseAsync();
  return calls;
}

test("setup parses options in both --opt value and --opt=value forms, keeping numeric profiles as strings", async () => {
  expect(await run(["setup", "--profile", "18", "--listen=tailscale", "--prefix", "rechrome", "--port=13776", "--token", "t"]))
    .toEqual([["setup", { profile: "18", token: "t", listen: "tailscale", prefix: "rechrome", port: 13776, yes: false }]]);
  expect((await run(["setup", "--yes"]))[0][1]).toMatchObject({ yes: true });
  expect((await run(["setup", "-y"]))[0][1]).toMatchObject({ yes: true });
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
  expect(await run(["profile", "qa", "--print-uri", "--listener", "local"])).toEqual([["printProfileUri", "qa", "local"]]); // alias of url
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

test("url prints, saves, or lists connection URLs; connect takes a shared URL", async () => {
  expect(await run(["url", "qa"])).toEqual([["printProfileUri", "qa", undefined, { local: undefined, save: undefined }]]);
  expect(await run(["url", "qa", "--listener", "share", "--local", "--save"])).toEqual([["printProfileUri", "qa", "share", { local: true, save: true }]]);
  expect(await run(["url"])).toEqual([["printProfileUri", undefined, undefined, { local: undefined, save: undefined }]]);
  expect(await run(["url", "ls"])).toEqual([["urlList"]]);
  expect(await run(["urls", "list"])).toEqual([["urlList"]]);
  expect(await run(["connect", "https://h.ts.net/rechrome/?profile=qa#key=k"])).toEqual([["connect", "https://h.ts.net/rechrome/?profile=qa#key=k"]]);
  await expect(run(["connect"])).rejects.toThrow();
});

test("listener port, allow, deny, rotate-key and set", async () => {
  expect(await run(["listener", "port"])).toEqual([["listenerPort", undefined]]);
  expect(await run(["listener", "port", "share"])).toEqual([["listenerPort", "share"]]);
  expect(await run(["listener", "allow", "share", "a@x.com", "Profile 5"])).toEqual([["allowListener", "share", ["a@x.com", "Profile 5"]]]);
  expect(await run(["listener", "deny", "share", "a@x.com"])).toEqual([["denyListener", "share", ["a@x.com"]]]);
  await expect(run(["listener", "allow", "share"])).rejects.toThrow();
  expect(await run(["listener", "rotate-key", "share"])).toEqual([["rotateKey", "share"]]);
  expect(await run(["listener", "set", "share", "--public-url", "https://h.ts.net/rechrome/"])).toEqual([["setListener", "share", { publicUrl: "https://h.ts.net/rechrome/", clearPublicUrl: undefined }]]);
  expect(await run(["listener", "set", "share", "--clear-public-url"])).toEqual([["setListener", "share", { publicUrl: undefined, clearPublicUrl: true }]]);
  await expect(run(["listener", "set", "share"])).rejects.toThrow(/public-url/);
});

test("next steps are plain text with the port filled in, so any shell (cmd too) can paste them", () => {
  const steps = listenerNextSteps({ name: "share", host: "127.0.0.1", port: 13776, key: "k".repeat(24), profiles: ["qa"], prefix: "/rechrome/" }, "qa");
  expect(steps).toContain("  tailscale serve --bg --set-path=/rechrome 13776");
  expect(steps).toContain("  rech listener set share --public-url https://<your-host>/rechrome/");
  expect(steps.join("\n")).not.toContain("$(");
  expect(listenerNextSteps({ name: "root", host: "127.0.0.1", port: 13777, key: "k".repeat(24), profiles: ["qa"], prefix: "/" })).toContain("  tailscale serve --bg 13777");
});
