#!/usr/bin/env bun
// Local static server for the rechrome lab notes: bun lab/serve.ts [port]
import { file } from "bun";
import { join, normalize } from "path";

const root = import.meta.dir;
const port = Number(process.argv[2] ?? process.env.PORT ?? 7790);

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    let path = normalize(decodeURIComponent(new URL(req.url).pathname)).replace(/^(\.\.[/\\])+/, "");
    if (path.endsWith("/")) path += "index.html";
    const f = file(join(root, path));
    if (await f.exists()) return new Response(f, { headers: { "Cache-Control": "no-cache" } });
    const html = file(join(root, `${path}.html`));
    if (await html.exists()) return new Response(html, { headers: { "Cache-Control": "no-cache" } });
    return new Response("Not found\n", { status: 404 });
  },
});
console.log(`rechrome lab: http://127.0.0.1:${port}/`);
