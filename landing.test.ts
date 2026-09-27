import { test, expect } from "bun:test";
import { landingPage, LANDING_HEADERS } from "./serve.ts";

type El = { id?: string; children: El[]; hidden: boolean; textContent: string; className: string; click?: () => Promise<void>; append(...c: El[]): void; setAttribute(): void; addEventListener(t: string, f: () => Promise<void>): void };

/** Run the page's script against a minimal fake DOM; return the rows and what Copy puts on the clipboard. */
async function render(href: string) {
  const script = landingPage().match(/<script>([\s\S]*)<\/script>/)![1];
  const make = (id?: string): El => ({
    id, children: [], hidden: true, textContent: "", className: "",
    append(...c) { this.children.push(...c); }, setAttribute() {}, addEventListener(_t, f) { this.click = f; },
  });
  const byId: Record<string, El> = {};
  const document = { getElementById: (id: string) => (byId[id] ??= make(id)), createElement: () => make(), body: make(), execCommand() {} };
  const copied: string[] = [];
  const navigator = { clipboard: { writeText: async (t: string) => { copied.push(t); } } };
  new Function("location", "document", "navigator", "setTimeout", script)({ href, hash: new URL(href).hash }, document, navigator, () => {});
  const rows = byId.cmds.children.map(row => ({ label: row.children[0].textContent, shown: row.children[1].children[0].textContent, button: row.children[1].children[1] }));
  for (const row of rows) await row.button.click!();
  return { rows, copied, noKeyWarning: byId.nokey?.hidden === false };
}

const shared = "https://host.example.ts.net/rechrome/?profile=you%40example.com#key=SECRETkey_0123456789";

test("a shared URL shows one install-and-connect command per shell, key masked, copied whole", async () => {
  const { rows, copied, noKeyWarning } = await render(shared);
  expect(rows.map(r => r.label)).toEqual(["macOS / Linux", "Windows PowerShell", "Windows cmd"]);
  expect(copied).toEqual([
    `bun i -g rechrome && rechrome connect '${shared}'`,
    `bun i -g rechrome; rechrome connect "${shared}"`,
    `bun i -g rechrome && rechrome connect "${shared}"`,
  ]);
  for (const row of rows) {
    expect(row.shown).not.toContain("SECRETkey");
    expect(row.shown).toContain("#key=…");
  }
  expect(noKeyWarning).toBe(false);
});

test("the macOS/Linux command survives a shell even with quotes and $ in the URL", async () => {
  const tricky = "https://h.example/rechrome/?profile=o'neil$HOME#key=k'$(id)";
  const { copied } = await render(tricky);
  const arg = copied[0].slice("bun i -g rechrome && rechrome connect ".length);
  const echoed = Bun.spawnSync(["sh", "-c", `printf %s ${arg}`]).stdout.toString();
  expect(echoed).toBe(tricky);
  expect(copied[1]).toContain("o'neil`$HOME");   // PowerShell: $ escaped with a backtick
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
