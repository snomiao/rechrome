import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, symlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { startSignalRelay } from "./signal-relay.ts";

// End to end, with the real CLI and daemon: a host shares a profile, a second "machine" (its own
// HOME, no registry) redeems the invite and drives the browser over WebRTC and over a LAN
// listener, and the host's approve/revoke take effect. playwright-cli is a stand-in that reports
// the profile and session it was given; ICE stays on loopback.
const relay = startSignalRelay({ port: 0 });
const signal = `http://127.0.0.1:${relay.port}/`;
const cleanups: Array<() => void | Promise<void>> = [() => relay.stop(true)];
afterAll(async () => { for (const c of cleanups.reverse()) await c(); });

const MODULES = ["rechrome.ts", "serve.ts", "listeners.ts", "extension-token.ts", "daemon-manager.ts", "scoped-upload.ts", "shares.ts", "secret.ts", "e2e.ts", "webrtc.ts", "signal-relay.ts"];
const reserve = () => { const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const p = s.port!; s.stop(true); return p; };

test("share new → connect → drive → session ls → reuse refused → approve → revoke, over WebRTC and LAN", async () => {
  const root = await mkdtemp(join(tmpdir(), "rech-share-rtc-"));
  const client = await mkdtemp(join(tmpdir(), "rech-rtc-client-"));
  const client2 = await mkdtemp(join(tmpdir(), "rech-rtc-client2-"));
  const client3 = await mkdtemp(join(tmpdir(), "rech-rtc-client3-"));
  const mgmtPort = reserve(), lanPort = reserve();
  await mkdir(join(root, ".rechrome"));
  for (const name of MODULES) await copyFile(join(import.meta.dir, name), join(root, name));
  await symlink(join(import.meta.dir, "node_modules"), join(root, "node_modules"), "junction");
  await writeFile(join(root, "fake-cli.ts"), `
    const session = process.argv.find(a => a.startsWith('-s='))?.slice(3);
    if (process.argv.includes('screenshot')) {
      require('fs').mkdirSync('.playwright-cli', { recursive: true });
      const name = '.playwright-cli/shot-' + Date.now() + '.png';
      require('fs').writeFileSync(name, 'png-of-' + session);
      console.log('Screenshot saved: ' + name);
    }
    console.log('Profile: ' + process.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY + ' Session: ' + session + ' Group: ' + process.env.PLAYWRIGHT_MCP_CLIENT_NAME);
  `);
  const entry = (profileDir: string) => ({ profileDir, extensionId: "a".repeat(32), token: `token-${profileDir}` });
  await writeFile(join(root, ".rechrome", "profiles.json"), JSON.stringify({ qa: entry("QA"), personal: entry("Personal") }));
  const mgmt = { name: "local", host: "127.0.0.1", port: mgmtPort, key: "m".repeat(24), profiles: "*" };
  const lan = { name: "lan1", host: "127.0.0.1", port: lanPort, key: "l".repeat(24), profiles: ["personal"], prefix: "/" };
  await writeFile(join(root, ".rechrome", "listeners.json"), JSON.stringify({ version: 1, listeners: [mgmt, lan] }));

  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PLAYWRIGHT_MCP_") && k !== "RECHROME_URL"));
  const hostEnv = { ...baseEnv, HOME: root, USERPROFILE: root, RECH_ICE_SERVERS: "[]", RECHROME_URL: `http://127.0.0.1:${mgmtPort}/#key=${mgmt.key}`, PLAYWRIGHT_CLI: `${process.execPath} ${join(root, "fake-cli.ts")}` };
  const daemon = Bun.spawn([process.execPath, join(root, "rechrome.ts"), "serve"], { cwd: root, env: hostEnv, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  cleanups.push(() => { daemon.kill(); });
  const rech = async (args: string[], env: Record<string, string | undefined>, cwd = root) => {
    const proc = Bun.spawn([process.execPath, join(root, "rechrome.ts"), ...args], { cwd, env: { ...baseEnv, RECH_ICE_SERVERS: "[]", ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, stdout, stderr };
  };
  const clientEnv = (home: string) => ({ HOME: home, USERPROFILE: home, RECHROME_URL: undefined });
  cleanups.push(async () => {
    // Bridges are detached processes of the client machines: stop them.
    for (const home of [client, client2, client3]) {
      const dir = join(home, ".rechrome", "bridges");
      for (const f of await readdir(dir).catch(() => [] as string[]))
        if (f.endsWith(".json")) { try { process.kill(JSON.parse(await readFile(join(dir, f), "utf8")).pid); } catch {} }
    }
  });
  for (let i = 0; i < 80; i++) { if (await fetch(`http://127.0.0.1:${mgmtPort}/ping`, { headers: { Authorization: `Bearer ${mgmt.key}` } }).then(r => r.ok).catch(() => false)) break; await Bun.sleep(100); }

  // --- WebRTC share ------------------------------------------------------------------------
  const made = await rech(["share", "new", "qa", "--name", "alice", "--signal", signal], hostEnv);
  expect(made.stderr).toBe("");
  expect(made.code).toBe(0);
  const link = made.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/#rech1_\w{28}/)?.[0]!;
  expect(link).toBeTruthy();
  expect(made.stdout).toContain("Share expires:");             // webrtc shares default to 30 days

  // The daemon picks the share up and opens its room; then the client redeems the invite.
  await Bun.sleep(1500);
  const connected = await rech(["connect", "--project", link], clientEnv(client), client);
  expect(connected.stderr + connected.stdout).toContain('Connected to share "alice"');
  expect(connected.code).toBe(0);
  const saved = await readFile(join(client, ".rechrome", ".env.local"), "utf8");
  expect(saved).toContain("&via=webrtc");
  expect(saved).toContain("?profile=qa");
  expect(saved).not.toContain(link.split("#")[1]);              // the device has its own credential

  // Browser commands go through the local bridge, as this device, in its own session namespace.
  const tabs = await rech(["tab-list"], clientEnv(client), client);
  expect(tabs.stdout).toContain("Profile: QA");
  expect(tabs.stdout).toContain("Group: alice");
  const login = await rech(["-s=login", "tab-list"], clientEnv(client), client);
  expect(login.stdout).toMatch(/Session: \w+-login/);
  const sessions = await rech(["session", "ls"], clientEnv(client), client);
  expect(sessions.stdout).toContain("login");
  expect(sessions.stdout).toContain("default");
  const status = await rech(["status"], clientEnv(client), client);
  expect(status.stdout).toContain("via:      WebRTC through");
  expect(status.stdout).toMatch(/share:    alice, device \S+ \(\w+\), expires \d{4}-/);
  const profiles = await rech(["profile"], clientEnv(client), client);
  expect(profiles.stdout).toContain('share "alice" gives you');
  expect(profiles.stdout).toMatch(/^\s+qa/m);
  expect(profiles.stdout).not.toContain("personal");
  // The share only offers qa: the other registered profile can't be picked.
  expect((await rech(["--profile", "personal", "tab-list"], clientEnv(client), client)).stderr).toContain("is not shared by this link");
  // Commands the share doesn't allow are still refused (eval = arbitrary code).
  expect((await rech(["eval", "() => 1"], clientEnv(client), client)).stdout + "").not.toContain("Profile:");

  // The invite is used up: a second machine with the same link is turned away.
  const reused = await rech(["connect", "--project", link], clientEnv(client2), client2);
  expect(reused.code).toBe(1);
  expect(reused.stderr).toContain("already used");

  // Host view.
  const ls = await rech(["share", "ls"], hostEnv);
  expect(ls.stdout).toMatch(/alice\s+qa\s+webrtc\s+1\/1/);
  const devices = await rech(["share", "devices", "alice"], hostEnv);
  expect(devices.stdout).toContain("yes");

  // Revoke: the device stops working right away (the daemon reloads within a second).
  expect((await rech(["share", "revoke", "alice"], hostEnv)).code).toBe(0);
  await Bun.sleep(1500);
  const after = await rech(["tab-list"], clientEnv(client), client);
  expect(after.stdout).not.toContain("Profile:");
  expect(after.stderr).toMatch(/revoked|offline|WebRTC/);

  // --- LAN share with approval --------------------------------------------------------------
  const lanMade = await rech(["share", "new", "personal", "--name", "bob", "--via", "lan1", "--approve"], hostEnv);
  expect(lanMade.code).toBe(0);
  const lanLink = lanMade.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/#rech1_\w{28}/)?.[0]!;
  expect(lanLink).toContain(`:${lanPort}/`);
  await Bun.sleep(1200);
  const lanConnected = await rech(["connect", "--project", lanLink], clientEnv(client2), client2);
  expect(lanConnected.stdout).toContain("must approve this device");
  const waiting = await rech(["tab-list"], clientEnv(client2), client2);
  expect(waiting.stderr).toContain("Waiting for the host to approve");
  expect((await rech(["share", "approve", "bob"], hostEnv)).stdout).toContain("Approved:");
  await Bun.sleep(1200);
  const approved = await rech(["tab-list"], clientEnv(client2), client2);
  expect(approved.stdout).toContain("Profile: Personal");
  // Files a device produces are its own: they download for it, but another device of another
  // share on the same profile can't fetch them by path.
  const shot = await rech(["screenshot"], clientEnv(client2), client2);
  const downloaded = shot.stderr.match(/downloaded: (\S+)/)?.[1];
  expect(downloaded).toBeTruthy();
  expect(await readFile(downloaded!, "utf8")).toStartWith("png-of-");
  const carol = await rech(["share", "new", "personal", "--name", "carol", "--via", "lan1"], hostEnv);
  const carolLink = carol.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/#rech1_\w{28}/)?.[0]!;
  await Bun.sleep(1200);
  expect((await rech(["connect", "--project", carolLink], clientEnv(client3), client3)).code).toBe(0);
  const carolUrl = (await readFile(join(client3, ".rechrome", ".env.local"), "utf8")).match(/RECHROME_URL="([^"]+)"/)![1];
  const { bearerOf } = await import("./secret.ts");
  const carolBearer = bearerOf(new URL(carolUrl).hash.slice(1).split("&")[0]);
  const bobUrl = (await readFile(join(client2, ".rechrome", ".env.local"), "utf8")).match(/RECHROME_URL="([^"]+)"/)![1];
  const bobBearer = bearerOf(new URL(bobUrl).hash.slice(1).split("&")[0]);
  const shotPath = shot.stdout.match(/\.playwright-cli\/shot-\d+\.png/)?.[0];
  const listed = await (await fetch(`http://127.0.0.1:${lanPort}/run`, { method: "POST", headers: { Authorization: `Bearer ${bobBearer}`, "Content-Type": "application/json" }, body: JSON.stringify({ args: ["screenshot"], identity: { key: "probe", label: "probe", profile: "personal" }, env: {} }) })).json();
  const bobFile = listed.files[0] as string;
  expect(bobFile).toMatch(/^profiles\/[0-9a-f]+\/d-\w+\/\.playwright-cli\/shot-\d+\.png$/);
  expect(shotPath).toBeTruthy();
  expect((await fetch(`http://127.0.0.1:${lanPort}/files/${bobFile}`, { headers: { Authorization: `Bearer ${bobBearer}` } })).status).toBe(200);
  expect((await fetch(`http://127.0.0.1:${lanPort}/files/${bobFile}`, { headers: { Authorization: `Bearer ${carolBearer}` } })).status).toBe(403);

  // The listener's own legacy key still works as before.
  const legacy = await fetch(`http://127.0.0.1:${lanPort}/ping`, { headers: { Authorization: `Bearer ${lan.key}` } });
  expect((await legacy.json()).profiles).toEqual(["personal"]);
}, 120_000);
