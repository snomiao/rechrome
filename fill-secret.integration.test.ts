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
// A password the browser filled itself (autofill), never through fill-secret.
const AUTOFILL = "AUTOFILL-c4n4ry-9e1";
// A password whose "show password" toggle made it type=text; only its name marks it.
const REVEALED = "REVEALED-c4n4ry-5b2";

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
  // The login page embeds a cross-origin iframe ("localhost" is another host than "127.0.0.1").
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => new Response(new URL(req.url).pathname === "/frame"
    ? `<!doctype html><label>Evil <input id=evil></label>`
    : new URL(req.url).pathname === "/autofill"
    // Set by script, like autofill: not in the markup. A neutral label, so only the live scan
    // (not the label-based fallback) can catch it.
    ? `<!doctype html><title>autofill</title><label>Secret word <input id=apw type=password></label>` +
      `<label>Shown word <input id=shown name=user_password type=text></label>` +
      `<script>document.getElementById("apw").value = ${JSON.stringify(AUTOFILL)};` +
      `document.getElementById("shown").value = ${JSON.stringify(REVEALED)}</script>`
    : `<!doctype html><title>login</title><form onsubmit="event.preventDefault();document.title='submitted'">` +
      `<label>Password <input id=pw type=password></label><label>Code <input id=code></label><button>Log in</button></form>` +
      `<iframe src="http://localhost:${new URL(req.url).port}/frame"></iframe>`,
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

    // Guard, reject: an allowed page, but the ref points into a cross-origin iframe.
    const tree = (await rech(["snapshot"])).out;
    const evilRef = tree.match(/textbox "Evil" \[ref=(f\d+e\d+)\]/)?.[1];
    expect(evilRef).toBeDefined();
    const framed = await rech(["fill-secret", evilRef!, "--from-env", "PW", "--allow-domain", "127.0.0.1"], { PW: CANARY });
    expect(framed.status).not.toBe(0);
    expect(framed.out).toContain('host "localhost" is not allowed');

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

    // An autofilled password (never passed through fill-secret) is masked in snapshots too.
    const autofillNav = await rech(["goto", `http://127.0.0.1:${page.port}/autofill`]);
    expect(autofillNav.status).toBe(0);
    expect((await rech(fieldHash("#apw"))).out).toContain(`H${hash(AUTOFILL)}`); // really filled
    const autofillSnap = await rech(["snapshot"]);
    expect(autofillSnap.out).toMatch(/textbox "Secret word"[^\n]*: \*\*\*/);
    expect(autofillSnap.out).toMatch(/textbox "Shown word"[^\n]*: \*\*\*/);
    expect(autofillNav.out + autofillSnap.out).not.toContain(AUTOFILL);
    expect(autofillNav.out + autofillSnap.out).not.toContain(REVEALED);

    for (const out of [opened, refused, framed, filled, totp, snap].map(r => r.out)) {
      expect(out).not.toContain(CANARY);
      expect(out).not.toContain(SEED);
    }
    const log = await readFile(serveLog, "utf8") + await readFile(join(root, "serve.err"), "utf8");
    expect(log).toContain("run: rech fill-secret e3");
    expect(log).not.toContain(CANARY);
    expect(log).not.toContain(SEED);
    expect(log).not.toContain(AUTOFILL);
    expect(log).not.toContain(REVEALED);
    // Nothing on disk: daemon home (snapshots, downloads), the client's project dir, the browser profile.
    for (const dir of [home, work, udd]) expect(await grepTree(dir, CANARY)).toEqual([]);
    for (const dir of [home, work]) for (const v of [AUTOFILL, REVEALED]) expect(await grepTree(dir, v)).toEqual([]);
  } finally {
    await rech(["close"]).catch(() => {});
    serve.kill();
    await serve.exited;
    page.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

// No browser needed: a fake CLI prints a snapshot (inline and as a file) holding a value, and
// there is no live session to scan, so the daemon must withhold both rather than pass them on.
test("a snapshot that can't be checked for passwords is withheld, not passed through", async () => {
  const root = await mkdtemp(join(tmpdir(), "rech-withhold-"));
  const home = join(root, "home");
  await mkdir(join(home, ".rechrome"), { recursive: true });
  const LEAK = "UNCHECKED-c4n4ry-77";
  const fake = join(root, "fake-cli.ts");
  await writeFile(fake, `
    import { mkdirSync, writeFileSync } from "fs";
    mkdirSync(".playwright-cli", { recursive: true });
    writeFileSync(".playwright-cli/page-1.yml", '- textbox "Secret word" [ref=e1]: ${LEAK}\\n');
    console.log('### Page\\n- Page URL: https://example.com/\\n### Snapshot\\n\`\`\`yaml\\n- textbox "Secret word" [ref=e1]: ${LEAK}\\n\`\`\`\\n### Events\\n- [Snapshot](.playwright-cli/page-1.yml)');
  `);
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = reserve.port!;
  reserve.stop(true);
  const key = "k".repeat(24);
  const serveLog = join(root, "serve.log");
  const serve = Bun.spawn([process.execPath, join(import.meta.dir, "rechrome.ts"), "serve"], {
    cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, RECHROME_URL: `http://${key}@127.0.0.1:${port}`, PLAYWRIGHT_CLI: `${process.execPath} ${fake}` },
    stdin: "ignore", stdout: Bun.file(serveLog), stderr: Bun.file(join(root, "serve.err")),
  });
  try {
    for (let i = 0; i < 100 && !(await fetch(`http://127.0.0.1:${port}/`).then(r => r.ok).catch(() => false)); i++) await Bun.sleep(100);
    const res = await (await fetch(`http://127.0.0.1:${port}/run`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ args: ["snapshot"], identity: { key: "/withhold-test" } }),
    })).json() as { stdout: string; stderr: string; files: string[] };
    expect(res.stdout).toContain("snapshot withheld");
    expect(res.stdout).toContain("### Events"); // the rest of the output survives
    expect(JSON.stringify(res)).not.toContain(LEAK);
    expect(res.files).toEqual([]);
    expect((await fetch(`http://127.0.0.1:${port}/files/.playwright-cli/page-1.yml`, { headers: { Authorization: `Bearer ${key}` } })).status).toBe(404);
    expect(await readFile(serveLog, "utf8") + await readFile(join(root, "serve.err"), "utf8")).not.toContain(LEAK);
    expect(await grepTree(home, LEAK)).toEqual([]);
  } finally {
    serve.kill();
    await serve.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
