import { test, expect } from "bun:test";
import { landingPage, LANDING_HEADERS } from "./serve.ts";

type El = { id?: string; children: El[]; hidden: boolean; textContent: string; className: string; click?: () => Promise<void>; append(...c: El[]): void; setAttribute(): void; addEventListener(t: string, f: () => Promise<void>): void };

/** Run the page's script against a minimal fake DOM; return the rows and what Copy puts on the clipboard. */
async function render(href: string, ping?: (url: string, init: { headers: Record<string, string> }) => unknown) {
  const script = landingPage().match(/<script>([\s\S]*)<\/script>/)![1];
  const make = (id?: string): El => ({
    id, children: [], hidden: true, textContent: "", className: "",
    append(...c) { this.children.push(...c); }, setAttribute() {}, addEventListener(_t, f) { this.click = f; },
  });
  const byId: Record<string, El> = {};
  const document = { getElementById: (id: string) => (byId[id] ??= make(id)), createElement: () => make(), body: make(), execCommand() {} };
  const copied: string[] = [];
  const navigator = { clipboard: { writeText: async (t: string) => { copied.push(t); } } };
  let pinged: Promise<unknown> = Promise.resolve();
  const fetch = ping && ((url: string, init: { headers: Record<string, string> }) => {
    const body = ping(url, init);
    return pinged = Promise.resolve({ ok: !!body, json: async () => body });
  });
  new Function("location", "document", "navigator", "setTimeout", "fetch", script)({ href, hash: new URL(href).hash }, document, navigator, () => {}, fetch);
  await pinged; await Bun.sleep(0);
  const rows = byId.cmds.children.map(row => ({ shown: row.children[0].children[0].textContent, button: row.children[0].children[1] }));
  for (const row of rows) await row.button.click!();
  const profiles = (byId.plist?.children ?? []).map(b => b as El & { textContent: string });
  return { rows, copied, noKeyWarning: byId.nokey?.hidden === false, profiles, profilesShown: byId.profiles?.hidden === false };
}

const shared = "https://host.example.ts.net/rechrome/?profile=you%40example.com#key=SECRETkey_0123456789";

test("a shared URL shows one two-line install-and-connect block for every shell, key masked, copied whole", async () => {
  const { rows, copied, noKeyWarning } = await render(shared);
  expect(rows.length).toBe(1);
  expect(copied).toEqual([`bun i -g rechrome\nrechrome connect "${shared.replace("%40", "@")}"`]);
  expect(rows[0].shown).not.toContain("SECRETkey");
  expect(rows[0].shown).toContain("#key=…");
  expect(noKeyWarning).toBe(false);
});

test("the copied URL survives sh (and PowerShell, if installed) even with shell metacharacters", async () => {
  const tricky = "https://h.example/rechrome/?profile=o'neil$HOME!`id`\\\"x@y#key=SECRETkey_0123456789";
  const { copied } = await render(tricky);
  const arg = copied[0].split("\n")[1].slice("rechrome connect ".length);
  const same = (got: string) => {
    const [want, have] = [new URL(tricky), new URL(got)];
    expect(have.searchParams.get("profile")).toBe(want.searchParams.get("profile"));
    expect(have.hash).toBe(want.hash);
  };
  same(Bun.spawnSync(["sh", "-c", `printf %s ${arg}`]).stdout.toString());
  if (Bun.which("pwsh")) same(Bun.spawnSync(["pwsh", "-NoProfile", "-Command", `[Console]::Write(${arg})`]).stdout.toString());
});

test("a link without its key warns instead of pretending to work", async () => {
  expect((await render("https://host.example.ts.net/rechrome/?profile=you%40example.com")).noKeyWarning).toBe(true);
});

test("the page is served no-store, no-referrer, scripts limited to its own inline code", () => {
  expect(LANDING_HEADERS["Cache-Control"]).toBe("no-store");
  expect(LANDING_HEADERS["Referrer-Policy"]).toBe("no-referrer");
  expect(LANDING_HEADERS["Content-Security-Policy"]).toContain("default-src 'none'");
  expect(landingPage()).not.toMatch(/<script src|https?:\/\/[^"<]*\.js/);
});

test("the page lists the link's profiles from its own /ping, and picking one rewrites ?profile=", async () => {
  const link = "https://host.example.ts.net/rechrome/team/?profile=a#key=SECRETkey_0123456789";
  const seen: string[] = [];
  const { profiles, profilesShown, rows, copied } = await render(link, (url, init) => {
    seen.push(`${url} ${init.headers.Authorization}`);
    return { profiles: ["a", "b@example.com"] };
  });
  expect(seen).toEqual(["https://host.example.ts.net/rechrome/team/ping Bearer SECRETkey_0123456789"]);
  expect(profilesShown).toBe(true);
  expect(profiles.map(p => p.textContent)).toEqual(["a", "b@example.com"]);
  copied.length = 0;
  await profiles[1].click!();
  await rows[0].button.click!();
  expect(copied[0]).toBe(`bun i -g rechrome\nrechrome connect "https://host.example.ts.net/rechrome/team/?profile=b@example.com#key=SECRETkey_0123456789"`);
});

test("a key the listener rejects shows no profile list", async () => {
  const { profilesShown } = await render(shared, () => null);
  expect(profilesShown).toBe(false);
});
