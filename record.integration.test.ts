import { expect, test } from "bun:test";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, symlink } from "fs/promises";
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { createServer, type Server } from "net";
import { serviceUrl } from "./listeners.ts";
import { resolveFfmpeg } from "./record.ts";

const ffmpeg = resolveFfmpeg();

// serve's record route end to end: a real daemon and real ffmpeg, with a stand-in for the
// session's browser (its cliDaemon socket answers run-code with JPEG frames).
test.skipIf(!ffmpeg)("record: a timed recording holds the request past 10 s, start/stop, a gone tab, and --filename never overwrites", async () => {
  // Short root: a unix socket path must fit in ~104 bytes.
  const root = await mkdtemp("/tmp/rech-rec-");
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const port = reserve.port!;
  reserve.stop(true);
  await mkdir(join(root, ".rechrome"));
  await mkdir(join(root, "secret-rules"));
  for (const name of ["rechrome.ts", "serve.ts", "listeners.ts", "extension-token.ts", "daemon-manager.ts", "fill-secret.ts", "record.ts", "scoped-upload.ts", "shares.ts", "secret.ts", "token.ts", "rtc-channel.ts", "e2e.ts", "webrtc.ts", "signal-relay.ts", "redact.ts", "secret-rules/gitleaks.toml"])
    await copyFile(join(import.meta.dir, name), join(root, name));
  await symlink(join(import.meta.dir, "node_modules"), join(root, "node_modules"), "junction");
  const argvLog = join(root, "argv.log");
  await writeFile(join(root, "fake-cli.ts"), `
    import { appendFileSync } from 'fs';
    appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
    console.log('ok');
  `);
  await writeFile(join(root, ".rechrome", "profiles.json"), JSON.stringify({ qa: { profileDir: "QA", extensionId: "a".repeat(32), token: "test-token" } }));
  const key = "r".repeat(24);
  const socketsDir = join(root, "s");
  await mkdir(socketsDir, { mode: 0o700 });
  const child = Bun.spawn([process.execPath, join(root, "rechrome.ts"), "serve"], {
    // The developer's .env.local (loaded into this test process by other test files) must not leak in.
    cwd: root, env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PLAYWRIGHT_MCP_") && !k.startsWith("RECH"))), HOME: root, USERPROFILE: root, PLAYWRIGHT_SOCKETS_DIR: socketsDir, FFMPEG_BIN: ffmpeg!, RECHROME_URL: `http://${key}@127.0.0.1:${port}`, PLAYWRIGHT_CLI: `${process.execPath} ${join(root, "fake-cli.ts")}` },
    stdin: "ignore", stdout: "ignore", stderr: "pipe",
  });
  const run = (args: string[]) => fetch(serviceUrl(`http://127.0.0.1:${port}/`, "run"), {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ identity: { key: "/test-worktree", profile: "qa" }, args, env: {} }),
  }).then(r => r.json() as Promise<{ status: number; stdout: string; stderr: string; files: string[] }>);

  // Real JPEG frames for the stand-in browser to return.
  const all = Bun.spawnSync([ffmpeg!, "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=8", "-frames:v", "8", "-f", "image2pipe", "-c:v", "mjpeg", "-"]).stdout;
  const jpegs: string[] = [];
  for (let i = 0, start = -1; i < all.length - 1; i++) {
    if (all[i] === 0xff && all[i + 1] === 0xd8 && start < 0) start = i;
    if (all[i] === 0xff && all[i + 1] === 0xd9 && start >= 0) { jpegs.push(Buffer.from(all.subarray(start, i + 2)).toString("base64")); start = -1; }
  }
  let browser: Server | undefined;
  try {
    for (let i = 0; i < 70 && !(await fetch(serviceUrl(`http://127.0.0.1:${port}/`, "ping"), { headers: { Authorization: `Bearer ${key}` } }).then(r => r.ok).catch(() => false)); i++) await Bun.sleep(100);
    // Any command reveals the session name serve gives the browser (the CLI's -s=).
    expect((await run(["-s=rec", "tab-list"])).status).toBe(0);
    const session = JSON.parse((await readFile(argvLog, "utf8")).trim().split("\n").at(-1)!).find((a: string) => a.startsWith("-s="))!.slice(3);
    const sockets = join(socketsDir, "cli"); // tmpSocketRoot
    await mkdir(sockets, { recursive: true });
    let reachable = true;
    browser = createServer(sock => {
      sock.once("data", async () => {
        if (!reachable) return sock.destroy(); // the tab is gone
        // One capture chunk: half a second of screenshots, then the run-code reply.
        const t0 = Date.now();
        await Bun.sleep(500);
        const chunk = JSON.stringify({ frames: jpegs.slice(0, 4), times: [0, 125, 250, 375].map(d => t0 + d) });
        sock.end(JSON.stringify({ id: 1, result: { isError: false, text: JSON.stringify({ result: chunk }) } }) + "\n");
      });
    }).listen(join(sockets, `${session}.sock`));
    const files = () => readdirSync(root, { recursive: true }).map(String).filter(n => /clip.*\.mp4$/.test(n));

    // One call that holds the request for 12 s (past Bun's default 10 s idle limit).
    const t = Date.now();
    const timed = await run(["-s=rec", "record", "--seconds", "12", "--filename", "clip.mp4"]);
    expect(timed.stderr).toBe("");
    expect(timed.stdout).toContain("record: saved clip.mp4");
    expect(Date.now() - t).toBeGreaterThan(12_000);

    // Same name again: kept beside it, not over it.
    const again = await run(["-s=rec", "record", "--seconds", "1", "--filename", "clip.mp4"]);
    expect(again.stdout).toContain("record: saved clip-2.mp4");

    // Open-ended: start answers at once, stop saves.
    expect((await run(["-s=rec", "record", "start"])).stdout).toContain("recording at 8 fps to mp4");
    expect((await run(["-s=rec", "record", "start"])).stderr).toContain("already recording");
    await Bun.sleep(1500);
    const stopped = await run(["-s=rec", "record", "stop", "--filename", "clip.mp4"]);
    expect(stopped.stdout).toContain("record: saved clip-3.mp4");
    expect((await run(["-s=rec", "record", "stop"])).stderr).toContain("no recording in progress");

    // The tab goes away: a timed recording answers at once with why, not ffmpeg's "no stream".
    reachable = false;
    const t2 = Date.now();
    const gone = await run(["-s=rec", "record", "--seconds", "30"]);
    expect(gone.stderr).toContain("record: nothing was captured");
    expect(gone.stderr).not.toContain("ffmpeg");
    expect(Date.now() - t2).toBeLessThan(5_000);

    const saved = files().sort();
    expect(saved.map(f => f.split("/").at(-1))).toEqual(["clip-2.mp4", "clip-3.mp4", "clip.mp4"]);
    const long = saved.find(f => f.endsWith("/clip.mp4") || f === "clip.mp4")!;
    expect(statSync(join(root, long)).size).toBeGreaterThan(0);
    const probe = Bun.spawnSync([ffmpeg!, "-hide_banner", "-i", join(root, long), "-map", "0:v:0", "-f", "null", "-"]).stderr.toString();
    // 12 s at 8 fps, give or take the first and last chunk.
    expect(Number([...probe.matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1])).toBeGreaterThanOrEqual(80);
  } finally {
    browser?.close();
    child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
