import { test, expect } from "bun:test";
import { buildSetupHtml, createSetupGuide } from "./rechrome.ts";

test("guide remains reachable after non-TTY stdin closes", async () => {
  const modulePath = new URL("./rechrome.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "--eval", `
    import { createSetupGuide } from ${JSON.stringify(modulePath)};
    await Bun.stdin.text();
    const guide = createSetupGuide('/tmp/ext', 'Non-TTY test');
    console.log(guide.url);
  `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.end();
  const reader = child.stdout.getReader();
  const timeout = setTimeout(() => child.kill(), 5000);
  try {
    const first = await reader.read();
    const url = new TextDecoder().decode(first.value).trim();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/setup\//);
    for (let i = 0; i < 2; i++) {
      expect((await (await fetch(`${url}/status`)).json()).phase).toBe("extension");
      expect(child.exitCode).toBeNull();
      await Bun.sleep(100);
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
    child.kill();
    await child.exited;
  }
});

test("live guide reports phases without exposing pasted credentials", async () => {
  const guide = createSetupGuide("/tmp/extension", "Test profile");
  try {
    const endpoint = `${guide.url}/status`;
    guide.update("token", "Waiting for token");
    expect(await (await fetch(endpoint)).json()).toMatchObject({ phase: "token", message: "Waiting for token", checks: { extension: true, token: false, bridge: false, registration: false } });
    guide.setExtensionId("b".repeat(32));
    expect((await (await fetch(endpoint)).json()).statusUrl).toBe(`chrome-extension://${"b".repeat(32)}/status.html`);
    expect(() => guide.setExtensionId('invalid')).toThrow();
    const token = "a".repeat(43);
    const response = await fetch(endpoint, {
      method: "POST", headers: { Origin: new URL(endpoint).origin, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(token);
    expect(guide.takeToken()).toBe(token);
    expect(guide.takeToken()).toBeUndefined();
    expect(guide.takeRetry()).toBe(true);
    expect(guide.takeRetry()).toBe(false);
    guide.update("bridge", "Checking connection");
    guide.update("error", "Connection failed");
    expect((await (await fetch(endpoint)).json()).checks).toEqual({ extension: true, token: true, bridge: false, registration: false });
    guide.update("save", "Connection verified");
    expect((await (await fetch(endpoint)).json()).checks).toEqual({ extension: true, token: true, bridge: true, registration: false });
    guide.update("ready", "Connected");
    expect(await (await fetch(endpoint)).json()).toMatchObject({ phase: "ready", checks: { extension: true, token: true, bridge: true, registration: true } });
  } finally { guide.close(); }
});

test("guide rejects cross-origin writes, invalid tokens and unknown routes", async () => {
  const guide = createSetupGuide("/tmp/ext", "Test");
  try {
    const endpoint = `${guide.url}/status`;
    expect((await fetch(endpoint, { method: "POST", headers: { Origin: "https://example.com" }, body: '{}' })).status).toBe(403);
    expect((await fetch(endpoint, { method: "POST", headers: { Origin: new URL(endpoint).origin }, body: JSON.stringify({ token: "short" }) })).status).toBe(400);
    expect(guide.takeToken()).toBeUndefined();
    expect((await fetch(new URL('/status', endpoint))).status).toBe(404);
  } finally { guide.close(); }
});

test("guide renders the three-stage flow and safely escapes profile and path", () => {
  const html = buildSetupHtml('/tmp/<extension>', '<script>profile</script>', '/setup/example/status');
  expect(html).toContain('Step 1 — Install the extension');
  expect(html).toContain('Step 2 — Verify the connection');
  expect(html).toContain('Step 3 — Finish setup');
  expect(html).toContain('type="password"');
  expect(html).toContain('chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/status.html');
  expect(html).toContain('Copy status URL');
  expect(html).toContain('This page works while rech setup is running, including with piped input.');
  expect(html).not.toContain('Click the extension icon');
  expect(html).toContain('&lt;script&gt;profile&lt;/script&gt;');
  expect(html).not.toContain('<script>profile</script>');
});
