import { expect, test } from "bun:test";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, symlink, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { serviceUrl } from "./listeners.ts";

test("share --all: one snapshot link, profiles picked on the host, never the management key", async () => {
  const root = await mkdtemp(join(tmpdir(), "rech-share-all-"));      // the host (HOME)
  const client = await mkdtemp(join(tmpdir(), "rech-client-"));        // another machine: no registry, no listeners
  const reserve = () => { const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const p = s.port!; s.stop(true); return p; };
  const mgmtPort = reserve(), onePort = reserve();
  await mkdir(join(root, ".rechrome"));
  for (const name of ["rechrome.ts", "serve.ts", "listeners.ts", "extension-token.ts", "daemon-manager.ts", "fill-secret.ts", "scoped-upload.ts", "shares.ts", "secret.ts", "e2e.ts", "webrtc.ts", "signal-relay.ts"])
    await copyFile(join(import.meta.dir, name), join(root, name));
  await symlink(join(import.meta.dir, "node_modules"), join(root, "node_modules"), "junction");
  // Stand-in playwright-cli: report the profile the host chose and the session it was given.
  await writeFile(join(root, "fake-cli.ts"), `
    const session = process.argv.find(a => a.startsWith('-s='))?.slice(3);
    console.log('Profile: ' + process.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY + ' Session: ' + session);
    if (process.argv.includes('tab-list')) console.log('- 0: (current) [Page](https://example.com/form)');
    if (process.argv.includes('upload')) console.log('Uploaded ' + require('path').basename(process.argv[process.argv.indexOf('upload') + 1]));
  `);
  const entry = (profileDir: string) => ({ profileDir, extensionId: "a".repeat(32), token: `token-${profileDir}` });
  const registryPath = join(root, ".rechrome", "profiles.json");
  const registry: Record<string, any> = { qa: entry("QA"), "qa-alias": entry("QA"), personal: entry("Personal"), "team-a@x.com": entry("TeamA"), "team-b@x.com": entry("TeamB") };
  await writeFile(registryPath, JSON.stringify(registry));
  const mgmt = { name: "local", host: "127.0.0.1", port: mgmtPort, key: "m".repeat(24), profiles: "*" };
  const one = { name: "one", host: "127.0.0.1", port: onePort, key: "o".repeat(24), profiles: ["qa"], prefix: "/" };
  const listenersPath = join(root, ".rechrome", "listeners.json");
  await writeFile(listenersPath, JSON.stringify({ version: 1, listeners: [mgmt, one] }));
  const hostEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PLAYWRIGHT_MCP_"))), HOME: root, USERPROFILE: root, RECHROME_URL: `http://127.0.0.1:${mgmtPort}/#key=${mgmt.key}`, PLAYWRIGHT_CLI: `${process.execPath} ${join(root, "fake-cli.ts")}` };
  const daemon = Bun.spawn([process.execPath, join(root, "rechrome.ts"), "serve"], { cwd: root, env: hostEnv, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  // Other test files load the developer's .env.local into process.env; keep its profile/URL out.
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PLAYWRIGHT_MCP_") && k !== "RECHROME_URL"));
  const rech = async (args: string[], env: Record<string, string | undefined>, cwd = root) => {
    const proc = Bun.spawn([process.execPath, join(root, "rechrome.ts"), ...args], { cwd, env: { ...baseEnv, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, stdout, stderr };
  };
  try {
    for (let i = 0; i < 70; i++) { if (await fetch(`http://127.0.0.1:${onePort}/ping`, { headers: { Authorization: `Bearer ${one.key}` } }).then(r => r.ok).catch(() => false)) break; await Bun.sleep(100); }

    // The management listener is never shared, even when named explicitly.
    const refused = await rech(["share", "qa", "--listener", "local"], hostEnv);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("never shared");
    expect((await rech(["share", "--all", "--listener", "local"], hostEnv)).stderr).toContain("never shared");

    // One profile that no listener allows: without a terminal, `share` gives it its own link
    // (loopback, own key) instead of stopping with instructions.
    const own = await rech(["share", "personal"], hostEnv);
    expect(own.code).toBe(0);
    expect(own.stdout.trim()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/rechrome\/personal\/\?profile=personal#key=[\w-]{20,}$/);
    let ownConfig = JSON.parse(await readFile(listenersPath, "utf8"));
    const ownListener = ownConfig.listeners.find((l: any) => l.name === "personal");
    expect(ownListener.host).toBe("127.0.0.1");
    expect(ownListener.key).not.toBe(one.key);
    const reshared = await rech(["share", "personal"], hostEnv);
    expect(reshared.stdout.trim()).toBe(own.stdout.trim());   // now shared: same link
    // ...but still loopback-only with no proxy: say so and how to expose it, not a bare 127.0.0.1 URL.
    expect(reshared.stderr).toContain("this link only works on this machine");
    expect(reshared.stderr).toContain(`rech listener set ${ownListener.name} --public-url`);
    expect((await rech(["share", "personal", "--local"], hostEnv)).stderr).not.toContain("only works on this machine");
    ownConfig.listeners = ownConfig.listeners.filter((l: any) => l !== ownListener && l.name !== ownListener.name);
    await writeFile(listenersPath, JSON.stringify(ownConfig));   // keep the rest of this test's setup unchanged

    // share --all: a snapshot of every registered profile (aliases collapse) on its own listener.
    const shared = await rech(["share", "--all"], hostEnv);
    expect(shared.code).toBe(0);
    const link = shared.stdout.trim();
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/rechrome-all\/#key=[\w-]{20,}$/);   // no fixed ?profile=
    let config = JSON.parse(await readFile(listenersPath, "utf8"));
    const all = config.listeners.find((l: any) => l.name === "share-all");
    expect([...all.profiles].sort()).toEqual(["personal", "qa", "team-a@x.com", "team-b@x.com"]);
    expect(all.key).not.toBe(one.key);                                   // old one-profile links gain nothing
    expect(config.listeners.find((l: any) => l.name === "one").profiles).toEqual(["qa"]);

    // A client with no registry picks profiles by name; the host resolves them.
    const clientEnv = { HOME: client, USERPROFILE: client, RECHROME_URL: link };
    const viaAlias = await rech(["--profile", "QA-ALIAS", "tab-list"], clientEnv, client);
    const viaKey = await rech(["--profile", "qa", "tab-list"], clientEnv, client);
    const viaPersonal = await rech(["--profile", "pers", "tab-list"], clientEnv, client);
    expect(viaAlias.stdout).toContain("Profile: QA");
    expect(viaAlias.stdout.match(/Session: (\S+)/)![1]).toBe(viaKey.stdout.match(/Session: (\S+)/)![1]);      // aliases share a session
    expect(viaPersonal.stdout).toContain("Profile: Personal");
    expect(viaPersonal.stdout.match(/Session: (\S+)/)![1]).not.toBe(viaKey.stdout.match(/Session: (\S+)/)![1]);
    const ambiguous = await rech(["--profile", "team", "tab-list"], clientEnv, client);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr + ambiguous.stdout).toContain("several shared profiles");
    const missing = await rech(["tab-list"], clientEnv, client);
    expect(missing.code).toBe(1);
    expect(missing.stderr + missing.stdout).toContain("Pick a profile: this link shares");
    // The one-profile link still reaches only its profile.
    const narrow = await rech(["--profile", "personal", "tab-list"], { ...clientEnv, RECHROME_URL: `http://127.0.0.1:${onePort}/?profile=qa#key=${one.key}` }, client);
    expect(narrow.code).toBe(1);
    expect(narrow.stderr + narrow.stdout).toContain("not shared by this link");

    // A forged env naming another profile is rejected, not obeyed.
    const allPort = all.port;
    const forged = await fetch(serviceUrl(`http://127.0.0.1:${allPort}/rechrome-all/`, "run"), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${all.key}` },
      body: JSON.stringify({ args: ["tab-list"], identity: { key: "/w", profile: "qa" }, env: { PLAYWRIGHT_MCP_PROFILE_DIRECTORY: "personal" } }),
    });
    expect(forged.status).toBe(403);

    // rech profile on the client lists the host's shared profiles; connect explains how to pick.
    const listed = await rech(["profile"], clientEnv, client);
    expect(listed.stdout).toContain("Profiles shared by");
    for (const p of ["qa", "personal", "team-a@x.com"]) expect(listed.stdout).toContain(`  ${p}`);
    const project = join(client, "project"); await mkdir(project);
    const connected = await rech(["connect", link], { HOME: client, USERPROFILE: client, RECHROME_URL: "" }, project);
    expect(connected.code).toBe(0);
    expect(connected.stdout).toContain("Pick one per command: rech --profile <name>");

    // A profile registered later is NOT shared until share --all runs again.
    registry.newbie = entry("Newbie");
    await rm(join(root, ".rechrome", "profiles.yaml"), { force: true });
    await writeFile(registryPath, JSON.stringify(registry));
    config = JSON.parse(await readFile(listenersPath, "utf8"));
    expect(config.listeners.find((l: any) => l.name === "share-all").profiles).not.toContain("newbie");
    const again = await rech(["share", "--all"], hostEnv);
    expect(again.stderr).toContain("added newbie");
    expect(again.stdout.trim()).toBe(link);                             // same listener, same key

    // A profile list: one link for exactly those, on its own listener; the same list reuses it.
    const pair = await rech(["share", "qa-alias", "personal"], hostEnv);
    expect(pair.code).toBe(0);
    config = JSON.parse(await readFile(listenersPath, "utf8"));
    const group = config.listeners.find((l: any) => l.name.startsWith("share-") && l.name !== "share-all");
    expect([...group.profiles].sort()).toEqual(["personal", "qa"]);   // the alias became the canonical key
    expect((await rech(["share", "personal", "qa"], hostEnv)).stdout.trim()).toBe(pair.stdout.trim());
    // --listener sets an existing listener to exactly the list, and says old links now reach them.
    const onto = await rech(["share", "qa", "personal", "--listener", "one"], hostEnv);
    expect(onto.stderr).toContain("added personal");
    expect(onto.stderr).toContain("now reach exactly these profiles");
    config = JSON.parse(await readFile(listenersPath, "utf8"));
    expect([...config.listeners.find((l: any) => l.name === "one").profiles].sort()).toEqual(["personal", "qa"]);
    // ...and only ever adds: a later list without qa keeps qa, so links already given out for it still work.
    const more = await rech(["share", "personal", "team-a@x.com", "--listener", "one"], hostEnv);
    expect(more.stderr).toContain("added team-a@x.com");
    expect(more.stderr).not.toContain("removed");
    config = JSON.parse(await readFile(listenersPath, "utf8"));
    expect([...config.listeners.find((l: any) => l.name === "one").profiles].sort()).toEqual(["personal", "qa", "team-a@x.com"]);

    // Uploads: off on a scoped listener until the host turns them on, and the refusal says how.
    // The client reads the file; the host stages its bytes under the original name.
    const shot = join(client, "shot.png");
    await writeFile(shot, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1sAAAAASUVORK5CYII=", "base64"));
    const off = await rech(["--profile", "qa", "upload", shot], clientEnv, client);
    expect(off.code).not.toBe(0);
    expect(off.stdout + off.stderr).toContain(`Uploads are off on listener "share-all". The host can turn them on: rech listener set share-all --uploads`);
    expect((await rech(["listener", "set", "share-all", "--uploads"], hostEnv)).stdout).toContain("share-all: uploads on");
    await Bun.sleep(1500); // the daemon reloads listeners.json about every second
    const on = await rech(["--profile", "qa", "upload", shot], clientEnv, client);
    expect(on.stdout).toContain("Uploaded shot.png");
    expect(on.stdout + on.stderr).not.toContain("rech-upload-");
    const bad = await rech(["--profile", "qa", "upload", join(client, "missing.png")], clientEnv, client);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("no such file");
    expect(bad.stderr).toContain("Usage: rech upload <file>");
    expect((await rech(["listener", "set", "share-all", "--no-uploads"], hostEnv)).stdout).toContain("uploads off");

    // A link saved with --save is remembered: removing its listener warns with the file and the fix,
    // and the next listener rech creates does not take the freed port (no other listener's answer).
    const saver = join(root, "saver"); await mkdir(saver);
    const saved = await rech(["share", "team-b@x.com", "--save"], hostEnv, saver);
    expect(saved.code).toBe(0);
    const savedPort = Number(new URL(saved.stdout.trim()).port);
    // team-b is already on share-all (share --all above), so the saved link is share-all's.
    const savedOn = JSON.parse(await readFile(listenersPath, "utf8")).listeners.find((l: any) => l.port === savedPort).name;
    expect(savedOn).toBe("share-all");
    const removed = await rech(["listener", "remove", savedOn], hostEnv);
    expect(removed.code).toBe(0);
    expect(removed.stderr).toContain("a saved link stops working");
    expect(removed.stderr).toContain(join(saver, ".rechrome", ".env.local"));
    expect(removed.stderr).toContain(`rech share "team-b@x.com"`);
    expect(JSON.parse(await readFile(listenersPath, "utf8")).retiredPorts).toContain(savedPort);
    const next = await rech(["share", "team-b@x.com"], hostEnv);
    expect(Number(new URL(next.stdout.trim()).port)).not.toBe(savedPort);
    // An already-stale saved link stays quiet on later, unrelated changes.
    const nextName = JSON.parse(await readFile(listenersPath, "utf8")).listeners.find((l: any) => l.port === Number(new URL(next.stdout.trim()).port)).name;
    expect((await rech(["listener", "remove", nextName], hostEnv)).stderr).not.toContain("a saved link stops working");
  } finally {
    daemon.kill();
    await daemon.exited;
    await rm(root, { recursive: true, force: true });
    await rm(client, { recursive: true, force: true });
  }
}, 60_000);
