import { expect, test } from "bun:test";
import { mkdtemp, mkdir, copyFile, writeFile, rm, symlink, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { profileOutputPrefix, serviceUrl } from "./listeners.ts";

test("multiple sockets enforce profile/file policies and reload without browser restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "rech-listeners-"));
  const reserve = () => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const a = reserve(), b = reserve();
  const portA = a.port!, portB = b.port!;
  a.stop(true); b.stop(true);
  await mkdir(join(root, ".rechrome"));
  for (const name of ["rechrome.ts", "serve.ts", "listeners.ts", "extension-token.ts", "daemon-manager.ts"])
    await copyFile(join(import.meta.dir, name), join(root, name));
  // The copied sources import packages (e.g. yargs); resolve them from the repo's node_modules.
  await symlink(join(import.meta.dir, "node_modules"), join(root, "node_modules"), "junction");
  await writeFile(join(root, "fake-cli.ts"), `
    import { mkdirSync, writeFileSync } from 'fs';
    if (process.argv.includes('screenshot')) {
      mkdirSync('.playwright-cli', {recursive:true});
      writeFileSync('.playwright-cli/probe.png', 'fixture');
      console.log('.playwright-cli/probe.png');
    } else console.log('Profile: ' + process.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY);
  `);
  await writeFile(join(root, ".rechrome", "profiles.json"), JSON.stringify({
    qa: { profileDir: "QA", extensionId: "a".repeat(32), token: "test-token" },
    personal: { profileDir: "Personal", extensionId: "a".repeat(32), token: "other-token" },
  }));
  const qa = { name: "qa", host: "127.0.0.1", port: portA, key: "a".repeat(24), profiles: ["qa"], prefix: "/rechrome/" };
  const personal = { name: "personal", host: "127.0.0.1", port: portB, key: "b".repeat(24), profiles: ["personal"], prefix: "/" };
  const configPath = join(root, ".rechrome", "listeners.json");
  const save = (listeners: any[]) => writeFile(configPath, JSON.stringify({ version: 1, listeners }));
  await save([qa, personal]);
  const child = Bun.spawn([process.execPath, join(root, "rechrome.ts"), "serve"], {
    cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, RECHROME_URL: `http://${qa.key}@127.0.0.1:${portA}`, PLAYWRIGHT_CLI: `${process.execPath} ${join(root, "fake-cli.ts")}` },
    stdin: "ignore", stdout: "ignore", stderr: "pipe",
  });
  const get = (l: typeof qa, path = "/ping") => fetch(serviceUrl(`http://127.0.0.1:${l.port}${l.prefix}`, path), { headers: { Authorization: `Bearer ${l.key}` } });
  const run = (l: typeof qa, profile: string, args: string[], env = {}) => fetch(serviceUrl(`http://127.0.0.1:${l.port}${l.prefix}`, "run"), {
    method: "POST", headers: { Authorization: `Bearer ${l.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ identity: { key: "/test-worktree", profile }, args, env }),
  });
  const waitFor = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 70; i++) { if (await check().catch(() => false)) return; await Bun.sleep(100); }
    throw new Error("Listener did not reach expected state");
  };
  try {
    await waitFor(async () => (await get(qa)).ok && (await get(personal)).ok);
    for (const path of ["/ping", "/run", "/rechrome-other/ping"])
      expect((await fetch(`http://127.0.0.1:${portA}${path}`, { headers: { Authorization: `Bearer ${qa.key}` } })).status).toBe(404);
    expect((await get({ ...qa, key: personal.key })).status).toBe(401);
    expect((await run(qa, "personal", ["tab-list"])).status).toBe(403);
    expect((await run(qa, "qa", ["run-code", "async page => {}"])).status).toBe(403);
    const result = await (await run(qa, "qa", ["tab-list"], { PLAYWRIGHT_MCP_USER_DATA_DIR: "/personal", PLAYWRIGHT_MCP_EXTENSION_TOKEN: "attacker" })).json();
    expect(result.stdout).toContain("Profile: QA");
    const shot = await (await run(qa, "qa", ["screenshot"])).json();
    expect(shot.files).toHaveLength(1);
    expect(await (await get(qa, `/files/${shot.files[0]}`)).text()).toBe("fixture");
    expect((await get(personal, `/files/${shot.files[0]}`)).status).toBe(403);
    // Model a path-mount proxy that strips the mount and restores the target path.
    const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      const pathname = new URL(req.url).pathname;
      if (!pathname.startsWith("/rechrome/")) return new Response("Not found", { status: 404 });
      return fetch(serviceUrl(`http://127.0.0.1:${portA}/rechrome/`, pathname.slice("/rechrome/".length)), {
        method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
      });
    } });
    try {
      const publicListener = { ...qa, port: proxy.port! };
      expect((await get(publicListener)).ok).toBe(true);
      const publicShot = await (await run(publicListener, "qa", ["screenshot"])).json();
      expect(await (await get(publicListener, `/files/${publicShot.files[0]}`)).text()).toBe("fixture");
      // Exercise the real client, including the download path, against the proxy.
      const client = Bun.spawn([process.execPath, join(root, "rechrome.ts"), "--profile", "qa", "screenshot"], {
        cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, RECHROME_URL: `http://127.0.0.1:${proxy.port}/rechrome/#?key=${qa.key}&profile=qa` },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      expect(await client.exited).toBe(0);
      expect(await Bun.file(join(root, ".playwright-cli-multi-tab", "probe.png")).text()).toBe("fixture");
    } finally { proxy.stop(true); }
    await writeFile(join(root, ".rech", "output", "secret.png"), "private");
    const link = profileOutputPrefix("qa") + "link.png";
    await symlink(join(root, ".rech", "output", "secret.png"), join(root, ".rech", "output", link));
    expect((await get(qa, `/files/${link}`)).status).toBe(403);
    const rotated = { ...qa, key: "c".repeat(24), profiles: ["personal"] };
    await save([rotated, personal]);
    await waitFor(async () => (await get(rotated)).ok);
    expect((await get(qa)).status).toBe(401);
    expect((await run(rotated, "qa", ["tab-list"])).status).toBe(403);
    expect((await run(rotated, "personal", ["tab-list"])).status).toBe(200);
    // A failed extra bind must not remove the currently working listeners.
    const occupied = reserve();
    try {
      await save([rotated, personal, { ...qa, name: "blocked", port: occupied.port, key: "d".repeat(24) }]);
      await Bun.sleep(1300);
      expect((await get(rotated)).ok).toBe(true);
      expect((await get(personal)).ok).toBe(true);
    } finally { occupied.stop(true); }
    await save([rotated]);
    await waitFor(async () => {
      const response = await get(personal).catch(() => null);
      return !response || response.status === 403;
    });
    expect((await get(rotated)).ok).toBe(true);
    await unlink(configPath);
    await Bun.sleep(1200);
    expect((await get(rotated)).ok).toBe(true);
    expect((await get(qa)).status).toBe(401); // No fallback to the legacy broad key.
    expect(child.exitCode).toBeNull();
  } finally {
    child.kill(); await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
