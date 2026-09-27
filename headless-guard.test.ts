import { expect, test } from "bun:test";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, symlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { serviceUrl } from "./listeners.ts";

// `open` without a registered profile used to launch a separate headless browser with a
// throwaway profile: the command "succeeded" and nothing showed up in the user's Chrome.
test("open without a profile is refused instead of silently launching a headless browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "rech-headless-"));
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const port = reserve.port!;
  reserve.stop(true);
  await mkdir(join(root, ".rechrome"));
  for (const name of ["rechrome.ts", "serve.ts", "listeners.ts", "extension-token.ts", "daemon-manager.ts"])
    await copyFile(join(import.meta.dir, name), join(root, name));
  // The copied sources import packages (e.g. yargs); resolve them from the repo's node_modules.
  await symlink(join(import.meta.dir, "node_modules"), join(root, "node_modules"), "junction");
  const calls = join(root, "calls.log");
  await writeFile(join(root, "fake-cli.ts"), `
    import { appendFileSync } from 'fs';
    appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2)[0] + '\\n');
    console.log('ok');
  `);
  await writeFile(join(root, ".rechrome", "profiles.json"), JSON.stringify({
    qa: { profileDir: "QA", extensionId: "a".repeat(32), token: "test-token" },
  }));
  const key = "k".repeat(24);
  const child = Bun.spawn([process.execPath, join(root, "rechrome.ts"), "serve"], {
    // The developer's .env.local (loaded into this test process by other test files) must not leak in.
    cwd: root, env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PLAYWRIGHT_MCP_") && !k.startsWith("RECH") )), HOME: root, USERPROFILE: root, RECHROME_URL: `http://${key}@127.0.0.1:${port}`, PLAYWRIGHT_CLI: `${process.execPath} ${join(root, "fake-cli.ts")}` },
    stdin: "ignore", stdout: "ignore", stderr: "pipe",
  });
  const base = `http://127.0.0.1:${port}/`;
  const run = (args: string[], env: Record<string, string> = {}) => fetch(serviceUrl(base, "run"), {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ identity: { key: "/test-worktree" }, args, env }),
  }).then(r => r.json() as Promise<{ status: number; stderr: string }>);
  try {
    for (let i = 0; i < 70; i++) {
      if (await fetch(serviceUrl(base, "ping"), { headers: { Authorization: `Bearer ${key}` } }).then(r => r.ok, () => false)) break;
      await Bun.sleep(100);
    }
    const refused = await run(["open", "https://example.com"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("no Chrome profile selected");
    expect(refused.stderr).toContain("Registered here: qa");
    // The fake CLI reports an existing session: a bare open would be answered with its tab list.
    const bare = await run(["open"]);
    expect(bare.status).toBe(1);
    expect(bare.stderr).toContain("no Chrome profile selected");
    const unregistered = await run(["open", "https://example.com"], { PLAYWRIGHT_MCP_PROFILE_DIRECTORY: "Nope" });
    expect(unregistered.status).toBe(1);
    expect(unregistered.stderr).toContain(`profile "Nope" has no extension token`);
    const calledBefore = await readFile(calls, "utf8").catch(() => "");
    // Only the daemon's tab-list pre-check ran; nothing navigated (open, or open rewritten to goto).
    expect(calledBefore).not.toMatch(/^(open|goto)$/m);
    // With extension credentials (a registered profile) open goes through to the CLI.
    const allowed = await run(["open", "https://example.com"], { PLAYWRIGHT_MCP_EXTENSION_ID: "a".repeat(32), PLAYWRIGHT_MCP_EXTENSION_TOKEN: "test-token" });
    expect(allowed.status).toBe(0);
    expect(await readFile(calls, "utf8")).toMatch(/^(open|goto)$/m);
  } finally {
    child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
