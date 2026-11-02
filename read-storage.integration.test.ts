// End to end with a real headless Chromium: read a localStorage value (and a JSON path into it)
// to a pipe; it must reach nowhere else (daemon log, other output, disk).
import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "fs";
import { mkdtemp, mkdir, readdir, readFile, rm } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join } from "path";

const CLI = join(import.meta.dir, "vendor/playwright-cli/playwright-cli.js");
const browsersDir = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
const hasBrowser = existsSync(CLI) && existsSync(browsersDir) && readdirSync(browsersDir).some(d => d.startsWith("chromium"));
const TOKEN = "xoxc-live-c4n4ry-7f3a";

async function grepTree(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath, e.name);
    if ((await readFile(p).catch(() => Buffer.alloc(0))).includes(needle)) hits.push(p);
  }
  return hits;
}

test.skipIf(!hasBrowser)("read-storage reads a localStorage json-path to a pipe and leaks nowhere", async () => {
  const root = await mkdtemp(join(tmpdir(), "rech-read-storage-"));
  const home = join(root, "home"), work = join(root, "work"), udd = join(root, "udd");
  await Promise.all([mkdir(join(home, ".rechrome"), { recursive: true }), mkdir(work), mkdir(udd)]);
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
    `<!doctype html><title>t</title><script>localStorage.setItem("localConfig_v2", JSON.stringify({teams:{T011:{token:${JSON.stringify(TOKEN)}}}}))</script>ok`,
    { headers: { "content-type": "text/html" } }) });
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = reserve.port!; reserve.stop(true);
  const key = "k".repeat(24);
  const url = `http://${key}@127.0.0.1:${port}/?user_data_dir=${encodeURIComponent(udd)}`;
  const env = { ...process.env, HOME: home, USERPROFILE: home, RECHROME_URL: url, PLAYWRIGHT_CLI: `node ${CLI}`, RECH_IDENTITY: "cwd" } as Record<string,string>;
  const serveLog = join(root, "serve.log");
  const serve = Bun.spawn([process.execPath, join(import.meta.dir, "rechrome.ts"), "serve"], {
    cwd: home, env, stdin: "ignore", stdout: Bun.file(serveLog), stderr: Bun.file(join(root, "serve.err")) });
  const rech = async (args: string[]) => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "rechrome.ts"), ...args], { cwd: work, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { status, stdout, stderr };
  };
  try {
    for (let i = 0; i < 100 && !(await fetch(`http://127.0.0.1:${port}/`).then(r => r.ok).catch(() => false)); i++) await Bun.sleep(100);
    expect((await rech(["open", `http://127.0.0.1:${page.port}/`])).status).toBe(0);
    const bad = await rech(["read-storage", "local", "localConfig_v2", "teams.T011.token", "--allow-domain", "example.com"]);
    expect(bad.status).not.toBe(0); expect(bad.stdout).toBe("");
    const ok = await rech(["read-storage", "local", "localConfig_v2", "teams.T011.token", "--allow-domain", "127.0.0.1"]);
    expect(ok.status).toBe(0); expect(ok.stdout).toBe(TOKEN); expect(ok.stderr).not.toContain(TOKEN);
    const whole = await rech(["read-storage", "local", "localConfig_v2", "--allow-domain", "127.0.0.1"]);
    expect(whole.stdout).toContain(TOKEN); // no path = raw value
    const log = await readFile(serveLog, "utf8") + await readFile(join(root, "serve.err"), "utf8");
    expect(log).toContain("read-storage local localConfig_v2"); expect(log).not.toContain(TOKEN);
    for (const dir of [home, work]) expect(await grepTree(dir, TOKEN)).toEqual([]);
  } finally {
    await rech(["close"]).catch(() => {});
    serve.kill(); page.stop(true);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}, 180_000);
