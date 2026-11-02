// End to end: a real `rech`, `serve`, the vendored playwright-cli and headless Chromium. An
// HttpOnly cookie must be readable by read-cookie (document.cookie can't see it) and reach
// nowhere else: not the daemon log, other output, or disk.
import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "fs";
import { mkdtemp, mkdir, readdir, readFile, rm } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join } from "path";

const CLI = join(import.meta.dir, "vendor/playwright-cli/playwright-cli.js");
const browsersDir = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
const hasBrowser = existsSync(CLI) && existsSync(browsersDir) && readdirSync(browsersDir).some(d => d.startsWith("chromium"));
const CANARY = "xoxd-c4n4ry-7f3a-HttpOnly";

async function grepTree(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await readFile(path).catch(() => Buffer.alloc(0))).includes(needle)) hits.push(path);
  }
  return hits;
}

test.skipIf(!hasBrowser)("read-cookie reads an HttpOnly cookie to a pipe and leaks it nowhere", async () => {
  const root = await mkdtemp(join(tmpdir(), "rech-read-cookie-"));
  const home = join(root, "home"), work = join(root, "work"), udd = join(root, "udd");
  await Promise.all([mkdir(join(home, ".rechrome"), { recursive: true }), mkdir(work), mkdir(udd)]);
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
    "<!doctype html><title>home</title>ok",
    { headers: { "content-type": "text/html", "set-cookie": `tc=${CANARY}; Path=/; HttpOnly; SameSite=Lax` } }) });
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = reserve.port!; reserve.stop(true);
  const key = "k".repeat(24);
  const url = `http://${key}@127.0.0.1:${port}/?user_data_dir=${encodeURIComponent(udd)}`;
  const env = { ...process.env, HOME: home, USERPROFILE: home, RECHROME_URL: url, PLAYWRIGHT_CLI: `node ${CLI}`, RECH_IDENTITY: "cwd" } as Record<string,string>;
  const serveLog = join(root, "serve.log");
  const serve = Bun.spawn([process.execPath, join(import.meta.dir, "rechrome.ts"), "serve"], {
    cwd: home, env, stdin: "ignore", stdout: Bun.file(serveLog), stderr: Bun.file(join(root, "serve.err")) });
  const rech = async (args: string[], pipe = false) => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "rechrome.ts"), ...args], {
      cwd: work, env, stdin: "ignore", stdout: pipe ? "pipe" : "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { status, stdout, stderr };
  };
  try {
    for (let i = 0; i < 100 && !(await fetch(`http://127.0.0.1:${port}/`).then(r => r.ok).catch(() => false)); i++) await Bun.sleep(100);
    expect((await rech(["open", `http://127.0.0.1:${page.port}/`])).status).toBe(0);
    // document.cookie cannot see an HttpOnly cookie.
    expect((await rech(["eval", "() => document.cookie"])).stdout).not.toContain(CANARY);
    // The cookie exists for 127.0.0.1, but --allow-domain names a different domain: refused.
    // (This is what --allow-domain guards; without the check the real cookie would be returned.)
    const bad = await rech(["read-cookie", "tc", "127.0.0.1", "--allow-domain", "example.com"]);
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toContain("read-cookie refused");
    // Right domain: the exact value on the piped stdout, and only there.
    const ok = await rech(["read-cookie", "tc", "127.0.0.1", "--allow-domain", "127.0.0.1"]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe(CANARY);
    expect(ok.stderr).not.toContain(CANARY);
    const log = await readFile(serveLog, "utf8") + await readFile(join(root, "serve.err"), "utf8");
    expect(log).toContain("read-cookie tc for 127.0.0.1");
    expect(log).not.toContain(CANARY);
    for (const dir of [home, work]) expect(await grepTree(dir, CANARY)).toEqual([]);
  } finally {
    await rech(["close"]).catch(() => {});
    serve.kill(); page.stop(true);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}, 180_000);
