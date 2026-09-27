import { test, expect } from "bun:test";
import { findTailscaleServeRoute, tailscaleConnectionUrl } from "./rechrome.ts";

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
  const url = new URL(tailscaleConnectionUrl("https://node.example.ts.net/rechrome/", "http://KEY123@127.0.0.1:13776/rechrome/?profile=Profile+5&token=bridge"));
  expect(url.origin + url.pathname).toBe("https://node.example.ts.net/rechrome/");
  expect(url.searchParams.get("profile")).toBe("Profile 5");
  expect(url.searchParams.has("token")).toBe(false);
  expect(url.hash).toBe("#key=KEY123");
});
