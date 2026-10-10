// End to end: the real `rech` client, a real `serve`, the vendored playwright-cli and a real
// headless Chromium. A canary secret must reach the page and nowhere else: not the daemon log,
// the client's output, a snapshot taken right after, or anything left on disk.
import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "fs";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { totpCode } from "./fill-secret.ts";

const CLI = join(import.meta.dir, "vendor/playwright-cli/playwright-cli.js");
const browsersDir = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
const hasBrowser = existsSync(CLI) && existsSync(browsersDir) && readdirSync(browsersDir).some(d => d.startsWith("chromium"));

const CANARY = 'CANARY-7f3a"q-pw';
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

// Compare field contents by checksum: an eval naming the value would itself put it in the log.
const HASH_JS = "[...v].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)";
const hash = (v: string) => [...v].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
const fieldHash = (sel: string) => ["eval", `() => { const v = document.querySelector('${sel}').value; return 'H' + ${HASH_JS}; }`];

async function grepTree(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await readFile(path).catch(() => Buffer.alloc(0))).includes(needle)) hits.push(path);
  }
  return hits;
}

test.skipIf(!hasBrowser)("fill-secret fills the page and leaks the value nowhere", async () => {
  const root = await mkdtemp(join(tmpdir(), "rech-fill-secret-"));
  const home = join(root, "home"), work = join(root, "work"), udd = join(root, "udd");
  await Promise.all([mkdir(join(home, ".rechrome"), { recursive: true }), mkdir(work), mkdir(udd)]);
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
    `<!doctype html><title>login</title><form onsubmit="event.preventDefault();document.title='submitted'">` +
    `<label>Password <input id=pw type=password></label><label>Code <input id=code></label><button>Log in</button></form>`,
    { headers: { "content-type": "text/html" } }) });
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = reserve.port!;
  reserve.stop(true);
  const key = "k".repeat(24);
  const url = `http://${key}@127.0.0.1:${port}/?user_data_dir=${encodeURIComponent(udd)}`;
  const env = { ...process.env, HOME: home, USERPROFILE: home, RECHROME_URL: url, PLAYWRIGHT_CLI: `node ${CLI}`, RECH_IDENTITY: "cwd" };
  const serveLog = join(root, "serve.log");
  const serve = Bun.spawn([process.execPath, join(import.meta.dir, "rechrome.ts"), "serve"], {
    cwd: home, env, stdin: "ignore", stdout: Bun.file(serveLog), stderr: Bun.file(join(root, "serve.err")),
  });
  const rech = async (args: string[], extraEnv: Record<string, string> = {}) => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "rechrome.ts"), ...args], {
      cwd: work, env: { ...env, ...extraEnv }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { status, out: stdout + stderr };
  };
  try {
    for (let i = 0; i < 100 && !(await fetch(`http://127.0.0.1:${port}/`).then(r => r.ok).catch(() => false)); i++) await Bun.sleep(100);
    const opened = await rech(["open", `http://127.0.0.1:${page.port}/`]);
    expect(opened.status).toBe(0);
    // Refs on this fixed page: e3 = Password, e5 = Code.

    // Guard, reject: wrong host, nothing typed.
    const refused = await rech(["fill-secret", "e3", "--from-env", "PW", "--allow-domain", "*.salesforce.com"], { PW: CANARY });
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("fill-secret refused");
    expect((await rech(["eval", "() => document.querySelector('#pw').value.length"])).out).toContain("0");

    // Guard, accept: the value lands in the field.
    const filled = await rech(["fill-secret", "e3", "--from-env", "PW", "--allow-domain", "127.0.0.1"], { PW: CANARY });
    expect(filled.status).toBe(0);
    expect(filled.out).toContain("filled e3 on 127.0.0.1");
    expect((await rech(fieldHash("#pw"))).out).toContain(`H${hash(CANARY)}`);

    // TOTP from an env file: the code lands; the seed never leaves the client.
    const envFile = join(root, "secrets.env");
    await writeFile(envFile, `SEED=${SEED}\n`);
    const totp = await rech(["fill-secret", "e5", "--totp-from-env", "SEED", "--env-file", envFile, "--allow-domain", "127.0.0.1", "--submit"]);
    expect(totp.status).toBe(0);
    const typed = (await rech(fieldHash("#code"))).out;
    expect([Date.now(), Date.now() - 30_000].map(t => `H${hash(totpCode(SEED, t))}`).some(h => typed.includes(h))).toBe(true);
    expect((await rech(["eval", "() => document.title"])).out).toContain("submitted");

    // A snapshot taken right after shows the field, masked.
    const snap = await rech(["snapshot"]);
    expect(snap.out).toContain('textbox "Password"');
    expect(snap.out).toMatch(/textbox "Password"[^\n]*: \*\*\*/);

    for (const out of [opened, refused, filled, totp, snap].map(r => r.out)) {
      expect(out).not.toContain(CANARY);
      expect(out).not.toContain(SEED);
    }
    const log = await readFile(serveLog, "utf8") + await readFile(join(root, "serve.err"), "utf8");
    expect(log).toContain("run: rech fill-secret e3");
    expect(log).not.toContain(CANARY);
    expect(log).not.toContain(SEED);
    // Nothing on disk: daemon home (snapshots, downloads), the client's project dir, the browser profile.
    for (const dir of [home, work, udd]) expect(await grepTree(dir, CANARY)).toEqual([]);
  } finally {
    await rech(["close"]).catch(() => {});
    serve.kill();
    await serve.exited;
    page.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
