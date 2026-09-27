import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { envAssignment, bunAutoloadedKeys } from "./rechrome.ts";

test("env lines quote values with # or spaces, so Bun's .env loader keeps the #key", () => {
  expect(envAssignment("RECHROME_URL", "http://h:1/?profile=a#key=abc")).toBe('RECHROME_URL="http://h:1/?profile=a#key=abc"');
  expect(envAssignment("RECH_HOST", "127.0.0.1")).toBe("RECH_HOST=127.0.0.1");
  expect(envAssignment("X", "a b")).toBe('X="a b"');
});

test("values Bun loaded from the folder's .env files are recognised; real shell exports are not", () => {
  const files = ["RECHROME_URL=http://h/?p=1#key=abc\nQUOTED=\"http://h/#key=q\"\nexport EXP=plain\n"];
  const loaded = bunAutoloadedKeys({ RECHROME_URL: "http://h/?p=1", QUOTED: "http://h/#key=q", EXP: "plain", PATH: "/bin" }, files);
  expect([...loaded].sort()).toEqual(["EXP", "QUOTED", "RECHROME_URL"]);
  expect(bunAutoloadedKeys({ RECHROME_URL: "http://shell/#key=x" }, files).has("RECHROME_URL")).toBe(false);   // exported differently
});

async function statusIn(dir: string, home: string) {
  // No NODE_ENV: `bun test` sets it to "test", and Bun then skips .env.local (the case under test).
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PLAYWRIGHT_MCP_") && k !== "RECHROME_URL" && k !== "NODE_ENV"));
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "rechrome.ts"), "status"], { cwd: dir, env: { ...env, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return stdout + stderr;
}

test("an unquoted #key in the folder's .env.local still reaches the daemon, and .rechrome/.env.local wins", async () => {
  const key = "right-key-0123456789";
  const daemon = (name: string) => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req =>
    new URL(req.url).pathname === "/ping"
      ? (req.headers.get("authorization") === `Bearer ${key}` ? Response.json({ ok: true, listener: name, bind: "127.0.0.1" }) : new Response("no", { status: 401 }))
      : new Response("rech server\n") });
  const fromEnvLocal = daemon("from-env-local"), fromRechrome = daemon("from-rechrome");
  const project = await mkdtemp(join(tmpdir(), "rech-env-")), home = await mkdtemp(join(tmpdir(), "rech-env-home-"));
  try {
    // Written the old way (unquoted): Bun alone would cut it at "#" and lose the key.
    await writeFile(join(project, ".env.local"), `RECHROME_URL=http://127.0.0.1:${fromEnvLocal.port}/?profile=p#key=${key}\n`);
    expect(await statusIn(project, home)).toContain("listener from-env-local");
    // The documented order: .rechrome/.env.local before .env.local in the same folder.
    await mkdir(join(project, ".rechrome"));
    await writeFile(join(project, ".rechrome", ".env.local"), `RECHROME_URL="http://127.0.0.1:${fromRechrome.port}/?profile=p#key=${key}"\n`);
    expect(await statusIn(project, home)).toContain("listener from-rechrome");
  } finally {
    fromEnvLocal.stop(true); fromRechrome.stop(true);
    await rm(project, { recursive: true, force: true }); await rm(home, { recursive: true, force: true });
  }
});
