import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { playwrightCliIsUsable, resolvePlaywrightCli } from "./rechrome.ts";

let root: string;
const savedCli = process.env.PLAYWRIGHT_CLI;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rech-resolve-"));
  delete process.env.PLAYWRIGHT_CLI;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedCli === undefined) delete process.env.PLAYWRIGHT_CLI;
  else process.env.PLAYWRIGHT_CLI = savedCli;
});

// A wrapper .js, optionally with a playwright-core beside it that provides the deep subpath.
function fakeCli(dir: string, withCore: boolean): string {
  const entry = join(root, dir, "playwright-cli.js");
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(entry, "");
  if (withCore) {
    const core = join(root, dir, "node_modules/playwright-core");
    mkdirSync(join(core, "lib/tools/cli-client"), { recursive: true });
    writeFileSync(join(core, "package.json"), '{"name":"playwright-core"}');
    writeFileSync(join(core, "lib/tools/cli-client/program.js"), "");
  }
  return entry;
}

test("an entry whose playwright-core does not resolve is not usable", () => {
  expect(playwrightCliIsUsable(fakeCli("lib/playwright-cli", false))).toBe(false);
  expect(playwrightCliIsUsable(fakeCli("vendor/playwright-cli", true))).toBe(true);
});

test("a present-but-broken lib/ submodule falls through to vendor/", () => {
  fakeCli("lib/playwright-cli", false);
  const vendor = fakeCli("vendor/playwright-cli", true);
  expect(resolvePlaywrightCli(root)).toEndWith(vendor);
});

test("a working lib/ build still wins over vendor/", () => {
  const lib = fakeCli("lib/playwright-cli", true);
  fakeCli("vendor/playwright-cli", true);
  expect(resolvePlaywrightCli(root)).toEndWith(lib);
});

test("no usable candidate falls back to the bare PATH binary", () => {
  fakeCli("lib/playwright-cli", false);
  fakeCli("vendor/playwright-cli", false);
  expect(resolvePlaywrightCli(root)).toBe("playwright-cli-multi-tab");
});
