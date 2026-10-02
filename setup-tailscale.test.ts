import { test, expect } from "bun:test";
import { findTailscaleServeRoute, formatTailscaleHealth, planTailscaleServeRepairs, rebaseConnectionUrl, tailscaleHealthProblems } from "./rechrome.ts";

// Shape of `tailscale serve status --json`.
const serve = {
  TCP: { "443": { HTTPS: true } },
  Web: {
    "other.example.ts.net:443": { Handlers: { "/rechrome": { Proxy: "http://127.0.0.1:13776/rechrome" } } },
    "node.example.ts.net:443": { Handlers: {
      "/rechrome": { Proxy: "http://127.0.0.1:13776/rechrome" },
      "/webcode": { Proxy: "http://127.0.0.1:3001/webcode" },
    } },
  },
};

test("finds the Serve route for a prefixed loopback listener, preferring this node's name", () => {
  expect(findTailscaleServeRoute("node.example.ts.net", serve, 13776, "/rechrome/")).toBe("https://node.example.ts.net/rechrome/");
  expect(findTailscaleServeRoute(null, serve, 13776, "/rechrome/")).toBe("https://other.example.ts.net/rechrome/");
});

test("ignores routes to another port, another path, or that strip the prefix", () => {
  expect(findTailscaleServeRoute("node.example.ts.net", serve, 13775, "/rechrome/")).toBeNull();
  expect(findTailscaleServeRoute("node.example.ts.net", serve, 13776, "/other/")).toBeNull();
  const stripped = { Web: { "node.example.ts.net:443": { Handlers: { "/rechrome": { Proxy: "http://127.0.0.1:13776" } } } } };
  expect(findTailscaleServeRoute("node.example.ts.net", stripped, 13776, "/rechrome/")).toBeNull();
  expect(findTailscaleServeRoute("node.example.ts.net", null, 13776, "/rechrome/")).toBeNull();
});

test("keeps a non-default HTTPS port and accepts a bare host:port proxy", () => {
  const alt = { Web: { "node.example.ts.net:8443": { Handlers: { "/rechrome/": { Proxy: "localhost:13776/rechrome" } } } } };
  expect(findTailscaleServeRoute("node.example.ts.net", alt, 13776, "/rechrome/")).toBe("https://node.example.ts.net:8443/rechrome/");
});

test("remote URL carries the listener key in the fragment and only the profile query", () => {
  const url = new URL(rebaseConnectionUrl("https://node.example.ts.net/rechrome/", "http://KEY123@127.0.0.1:13776/rechrome/?profile=Profile+5&token=bridge"));
  expect(url.origin + url.pathname).toBe("https://node.example.ts.net/rechrome/");
  expect(url.searchParams.get("profile")).toBe("Profile 5");
  expect(url.searchParams.has("token")).toBe(false);
  expect(url.hash).toBe("#key=KEY123");
});

test("the Serve health check re-points a moved listener's route and flags a removed one's leftover", () => {
  const serve = { Web: { "node.example.ts.net:443": { Handlers: {
    "/rechrome": { Proxy: "http://127.0.0.1:13776/rechrome" },          // removed listener: stale
    "/rechrome/taku": { Proxy: "http://127.0.0.1:13790/rechrome/taku" }, // listener moved to 13777
    "/rechrome/ok": { Proxy: "http://127.0.0.1:13778/rechrome/ok" },     // healthy
    "/webcode": { Proxy: "http://127.0.0.1:3001/webcode/" },             // not ours
    "/": { Proxy: "http://127.0.0.1:9999" },                             // root: never touched
  } } } };
  const listeners = [{ port: 13775, prefix: "/" }, { port: 13777, prefix: "/rechrome/taku/" }, { port: 13778, prefix: "/rechrome/ok/" }];
  expect(planTailscaleServeRepairs(serve, listeners)).toEqual({
    repair: [{ hostPort: "node.example.ts.net:443", mount: "/rechrome/taku", from: 13790, to: 13777, proxy: "http://127.0.0.1:13777/rechrome/taku" }],
    stale: [{ hostPort: "node.example.ts.net:443", mount: "/rechrome", port: 13776 }],
  });
  expect(planTailscaleServeRepairs(serve, [])).toEqual({ repair: [], stale: [] });
});

test("rech status / share ls show each shared listener's route and every Serve problem with its fix", () => {
  const stale = { hostPort: "node.example.ts.net:443", mount: "/rechrome", port: 13776 };
  expect(formatTailscaleHealth({ state: "ok", routes: [
    { listener: "taku", port: 13777, url: "https://node.example.ts.net/rechrome/taku/" },
    { listener: "lan", port: 13780, url: null },
  ], repair: [], stale: [stale] })).toEqual([
    "tailscale: ✓ taku → https://node.example.ts.net/rechrome/taku/ (127.0.0.1:13777)",
    "           - lan: no Tailscale Serve route (fine if another proxy exposes it)",
    "           ⚠ node.example.ts.net:443/rechrome proxies to 127.0.0.1:13776, where no listener runs (clients get HTTP 502). Remove it: tailscale serve --https=443 --set-path=/rechrome off",
  ]);
  expect(formatTailscaleHealth({ state: "absent" })).toEqual([]);
});

test("an installed Tailscale whose CLI doesn't answer is reported, not mistaken for no Tailscale", () => {
  const health = { state: "unresponsive", error: "`tailscale serve status --json`: The Tailscale GUI failed to start" } as const;
  expect(tailscaleHealthProblems(health)).toEqual(["Tailscale is installed but its CLI doesn't answer, so Serve routes go unchecked: `tailscale serve status --json`: The Tailscale GUI failed to start"]);
  expect(formatTailscaleHealth(health)[0]).toStartWith("tailscale: ⚠ Tailscale is installed but its CLI doesn't answer");
});
