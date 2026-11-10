import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, symlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { startSignalRelay } from "./signal-relay.ts";
import type { InviteResult } from "./invite-page.ts";
import { readShares } from "./shares.ts";

// End to end, with the real CLI and daemon: a host shares a profile, a second "machine" (its own
// HOME, no registry) redeems the invite and drives the browser over WebRTC and over a LAN
// listener, and the host's approve/revoke take effect. playwright-cli is a stand-in that reports
// the profile and session it was given; ICE stays on loopback.
const relay = startSignalRelay({ port: 0 });
const signal = `http://127.0.0.1:${relay.port}/`;
// A second signal server: one share offered on two WebRTC listeners.
const relay2 = startSignalRelay({ port: 0 });
const signal2 = `http://127.0.0.1:${relay2.port}/`;
const cleanups: Array<() => void | Promise<void>> = [() => relay.stop(true), () => relay2.stop(true)];
afterAll(async () => { for (const c of cleanups.reverse()) await c(); });

const MODULES = ["rechrome.ts", "serve.ts", "listeners.ts", "extension-token.ts", "daemon-manager.ts", "fill-secret.ts", "record.ts", "scoped-upload.ts", "shares.ts", "secret.ts", "token.ts", "rtc-channel.ts", "e2e.ts", "webrtc.ts", "signal-relay.ts", "redact.ts", "secret-rules/gitleaks.toml"];
const reserve = () => { const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const p = s.port!; s.stop(true); return p; };

test("share new → connect → drive → session ls → reuse refused → approve → revoke, over WebRTC and LAN", async () => {
  const root = await mkdtemp(join(tmpdir(), "rech-share-rtc-"));
  const client = await mkdtemp(join(tmpdir(), "rech-rtc-client-"));
  const client2 = await mkdtemp(join(tmpdir(), "rech-rtc-client2-"));
  const client3 = await mkdtemp(join(tmpdir(), "rech-rtc-client3-"));
  const client4 = await mkdtemp(join(tmpdir(), "rech-rtc-client4-"));
  const client5 = await mkdtemp(join(tmpdir(), "rech-rtc-client5-"));
  const client6 = await mkdtemp(join(tmpdir(), "rech-rtc-client6-"));
  const client7 = await mkdtemp(join(tmpdir(), "rech-rtc-client7-"));
  const mgmtPort = reserve(), lanPort = reserve();
  await mkdir(join(root, ".rechrome"));
  await mkdir(join(root, "secret-rules"));
  await mkdir(join(root, "socks", "cli"), { recursive: true });
  for (const name of MODULES) await copyFile(join(import.meta.dir, name), join(root, name));
  await symlink(join(import.meta.dir, "node_modules"), join(root, "node_modules"), "junction");
  await writeFile(join(root, "fake-cli.ts"), `
    const session = process.argv.find(a => a.startsWith('-s='))?.slice(3);
    // A live session, as the daemon sees one: a socket file named after it.
    require('fs').writeFileSync(require('path').join(process.env.PLAYWRIGHT_SOCKETS_DIR, 'cli', session + '.sock'), '');
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
  const hostEnv = { ...baseEnv, HOME: root, USERPROFILE: root, RECH_ICE_SERVERS: "[]", PLAYWRIGHT_SOCKETS_DIR: join(root, "socks"), RECHROME_URL: `http://127.0.0.1:${mgmtPort}/#key=${mgmt.key}`, PLAYWRIGHT_CLI: `${process.execPath} ${join(root, "fake-cli.ts")}` };
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
    for (const home of [client, client2, client3, client4, client5, client6, client7]) {
      const dir = join(home, ".rechrome", "bridges");
      for (const f of await readdir(dir).catch(() => [] as string[]))
        if (f.endsWith(".json")) { try { process.kill(JSON.parse(await readFile(join(dir, f), "utf8")).pid); } catch {} }
    }
  });
  for (let i = 0; i < 80; i++) { if (await fetch(`http://127.0.0.1:${mgmtPort}/ping`, { headers: { Authorization: `Bearer ${mgmt.key}` } }).then(r => r.ok).catch(() => false)) break; await Bun.sleep(100); }

  // --- WebRTC share ------------------------------------------------------------------------
  // No transport named, no terminal: nothing is made, and the error lists the choices.
  const unnamed = await rech(["share", "new", "qa", "--name", "nobody"], hostEnv);
  expect(unnamed.code).toBe(1);
  expect(unnamed.stderr).toContain("rech share has no default");
  expect((await rech(["share", "ls"], hostEnv)).stdout).not.toContain("nobody");

  // --signal alone is a WebRTC transport on that server: a listener for it is made.
  const made = await rech(["share", "new", "qa", "--name", "alice", "--signal", signal], hostEnv);
  expect(made.stderr).toBe("");
  expect(made.code).toBe(0);
  expect(made.stdout).toContain('Added WebRTC listener "webrtc-127-0-0-1"');
  const link = made.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/#rech1_\w{28}/)?.[0]!;
  expect(link).toBeTruthy();
  expect(made.stdout).toContain("Share expires:");             // webrtc shares default to 30 days

  // The daemon picks the share up and opens its room; then the client redeems the invite.
  await Bun.sleep(1500);
  // The invite page: what the link gives, over the same room, without redeeming it.
  // Its own process, as a browser would be: the secret goes by env, and native WebRTC stays out of this one.
  const pageView = async (token: string): Promise<InviteResult> => {
    const code = `import { fetchInviteInfo } from ${JSON.stringify(join(import.meta.dir, "invite-page.ts"))}; import { loadRTC } from ${JSON.stringify(join(import.meta.dir, "webrtc.ts"))};
      const { RTCPeerConnection } = await loadRTC();
      console.log(JSON.stringify(await fetchInviteInfo(process.env.PAGE_TOKEN, { signal: process.env.PAGE_SIGNAL, RTCPeerConnection, timeoutMs: 15000 })));
      process.exit(0);`;
    const proc = Bun.spawn([process.execPath, "--eval", code], { env: { ...baseEnv, PAGE_TOKEN: token, PAGE_SIGNAL: signal }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    return JSON.parse(await new Response(proc.stdout).text());
  };
  const inviteToken = link.split("#")[1]!;
  const viewed = await pageView(inviteToken);
  if (viewed.state !== "online") throw new Error(`invite page: ${JSON.stringify(viewed)}`);
  expect(viewed.info.share).toBe("alice");
  expect(viewed.info.invite).toMatchObject({ state: "open", used: 0, maxDevices: 1 });
  expect(viewed.info.profileInfo).toEqual([{ key: "qa", name: "", registered: true }]);
  expect(viewed.info.sessions).toEqual([]);
  expect((await rech(["share", "ls"], hostEnv)).stdout).toMatch(/alice\s+qa\s+webrtc-127-0-0-1\s+0\/1/); // not redeemed
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

  // The page on the used invite says so, and lists this share's live sessions.
  const usedView = await pageView(inviteToken);
  if (usedView.state !== "online") throw new Error(`invite page: ${JSON.stringify(usedView)}`);
  expect(usedView.info.invite).toMatchObject({ state: "used", used: 1 });
  expect(usedView.info.sessions!.map(x => x.name).sort()).toEqual(["default", "login"]);
  for (const x of usedView.info.sessions!) expect(Object.keys(x).sort()).toEqual(["device", "name"]);

  // Host view.
  const ls = await rech(["share", "ls"], hostEnv);
  expect(ls.stdout).toMatch(/alice\s+qa\s+webrtc-127-0-0-1\s+1\/1/);
  const devices = await rech(["share", "devices", "alice"], hostEnv);
  expect(devices.stdout).toContain("yes");

  // Revoke: the device stops working right away (the daemon reloads within a second).
  expect((await rech(["share", "revoke", "alice"], hostEnv)).code).toBe(0);
  await Bun.sleep(1500);
  const after = await rech(["tab-list"], clientEnv(client), client);
  expect(after.stdout).not.toContain("Profile:");
  expect(after.stderr).toMatch(/revoked|offline|WebRTC/);
  expect((await pageView(inviteToken)).state).toBe("offline");   // the room is gone: the page says so

  // --- A reusable invite: two machines redeem the same link, each gets its own credential ----
  const team = await rech(["share", "new", "qa", "--name", "team", "--signal", signal, "--reusable", "--ttl", "12h"], hostEnv);
  expect(team.code).toBe(0);
  expect(team.stdout).toContain("Reusable invite: up to 100 devices");
  const teamLink = team.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/#rech1_\w{28}/)?.[0]!;
  expect(teamLink).toBeTruthy();
  await Bun.sleep(1500);
  for (const home of [client6, client7]) {
    const c = await rech(["connect", "--project", teamLink], clientEnv(home), home);
    expect(c.stderr + c.stdout).toContain('Connected to share "team"');
    expect(c.code).toBe(0);
    expect((await rech(["tab-list"], clientEnv(home), home)).stdout).toContain("Profile: QA");
  }
  const own6 = await readFile(join(client6, ".rechrome", ".env.local"), "utf8");
  const own7 = await readFile(join(client7, ".rechrome", ".env.local"), "utf8");
  expect(own6).not.toBe(own7);
  expect(own6 + own7).not.toContain(teamLink.split("#")[1]);
  const teamLs = await rech(["share", "ls"], hostEnv);
  expect(teamLs.stdout).toMatch(/team\s+qa\s+webrtc-127-0-0-1\s+2\/100\s+\S+\s+reusable, 2 redeemed, until /);
  // One device dropped alone; the other keeps working.
  const teamDevs = (await readShares(join(root, ".rechrome", "shares.json"))).shares.find(s => s.label === "team")!.devices;
  expect(teamDevs.length).toBe(2);
  expect((await rech(["share", "devices", "team", "--rm", teamDevs[0]!.id], hostEnv)).code).toBe(0);
  await Bun.sleep(1500);
  const after6 = await rech(["tab-list"], clientEnv(client6), client6), after7 = await rech(["tab-list"], clientEnv(client7), client7);
  expect([after6.stdout.includes("Profile: QA"), after7.stdout.includes("Profile: QA")].sort()).toEqual([false, true]);
  // Rotate kills the (leaked) link: a third machine is refused; nobody already in is affected.
  expect((await rech(["share", "rotate", "team"], hostEnv)).code).toBe(0);
  await Bun.sleep(1500);
  const late = await rech(["connect", "--project", teamLink], clientEnv(client2), client2);
  expect(late.code).toBe(1);
  expect(late.stdout + late.stderr).not.toContain('Connected to share "team"');
  expect([(await rech(["tab-list"], clientEnv(client6), client6)).stdout.includes("Profile: QA"), (await rech(["tab-list"], clientEnv(client7), client7)).stdout.includes("Profile: QA")].sort()).toEqual([false, true]);
  expect((await rech(["share", "rm", "team"], hostEnv)).code).toBe(0);

  // --- One share on two WebRTC listeners (two signal servers) ------------------------------
  expect((await rech(["listener", "add", "second", "--webrtc", signal2], hostEnv)).code).toBe(0);
  // TURN credentials go in as one URL (here from the environment) and are never shown back.
  const turnAdded = await rech(["listener", "add", "relayed", "--webrtc", signal2, "--turn-env", "TEAM_TURN"], { ...hostEnv, TEAM_TURN: "turns://team:p%40ss-word@turn.example.com:5349?transport=tcp" });
  expect(turnAdded.code).toBe(0);
  expect(turnAdded.stdout + turnAdded.stderr).not.toContain("ss-word");
  const rtcLs = await rech(["listener", "ls"], hostEnv);
  expect(rtcLs.stdout).toMatch(/second\s+http:\/\/127\.0\.0\.1:\d+\/\s+public STUN/);
  expect(rtcLs.stdout).toContain("turns://team:…@turn.example.com:5349?transport=tcp");
  expect(rtcLs.stdout).not.toContain("ss-word");
  expect(rtcLs.stdout).toContain("webrtc-default");
  const stored = JSON.parse(await readFile(join(root, ".rechrome", "listeners.json"), "utf8"));
  expect(stored.rtcListeners.find((l: any) => l.name === "relayed").ice).toEqual([{ urls: "turns:turn.example.com:5349?transport=tcp", username: "team", credential: "p@ss-word" }]);
  expect((await rech(["listener", "remove", "relayed"], hostEnv)).code).toBe(0);
  const two = await rech(["share", "new", "qa", "--name", "dave", "--devices", "2", "--via", "webrtc-127-0-0-1,second"], hostEnv);
  expect(two.code).toBe(0);
  const links = [...two.stdout.matchAll(/http:\/\/127\.0\.0\.1:(\d+)\/#rech1_\w{28}/g)];
  expect(links.map(m => Number(m[1]))).toEqual([relay.port, relay2.port]);   // one invite link per signal server
  await Bun.sleep(1500);
  // The daemon is in the share's room on each signal server: a device can join through either.
  const viaSecond = await rech(["connect", "--project", links[1]![0]], clientEnv(client4), client4);
  expect(viaSecond.stderr + viaSecond.stdout).toContain('Connected to share "dave"');
  expect((await rech(["tab-list"], clientEnv(client4), client4)).stdout).toContain("Profile: QA");
  const viaFirst = await rech(["connect", "--project", links[0]![0]], clientEnv(client5), client5);
  expect(viaFirst.stderr + viaFirst.stdout).toContain('Connected to share "dave"');
  // A session that's already open on the share is listed right after connecting.
  expect(viaFirst.stdout).toContain("Open sessions on this share:");
  expect(viaFirst.stdout).toMatch(/^\s+default\s+\(device /m);
  // A listener a share still uses can't be removed.
  expect((await rech(["listener", "remove", "second"], hostEnv)).stderr).toContain("Shares still use");
  expect((await rech(["share", "revoke", "dave"], hostEnv)).code).toBe(0);

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
  // Another share's sessions aren't listed: bob has some on this listener, carol has none.
  const pingAs = async (bearer: string) => (await fetch(`http://127.0.0.1:${lanPort}/ping`, { headers: { Authorization: `Bearer ${bearer}` } })).json() as Promise<any>;
  expect((await pingAs(bobBearer)).sessions.map((x: any) => x.name)).toContain("default");
  const carolPing = await pingAs(carolBearer);
  expect(carolPing.sessions).toEqual([]);
  expect(carolPing.invite).toBeUndefined();                     // a device's link, so no invite state
  expect(carolPing.device.approved).toBe(true);
  expect(carolPing.profileInfo).toEqual([{ key: "personal", name: "", registered: true }]);
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
