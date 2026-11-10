// Bundle invite-page.ts to public/invite.js, stamped with a hash of its sources so a test can tell
// when the committed bundle is stale without depending on the bundler's exact output.
import { createHash } from "crypto";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
export const SOURCES = ["invite-page.ts", "rtc-channel.ts", "e2e.ts", "token.ts"];
export const BUNDLE = join(ROOT, "public", "invite.js");

export async function sourceHash(): Promise<string> {
  const hash = createHash("sha256");
  for (const name of SOURCES) hash.update(await Bun.file(join(ROOT, name)).text());
  return hash.digest("hex");
}

if (import.meta.main) {
  const built = await Bun.build({ entrypoints: [join(ROOT, "invite-page.ts")], target: "browser", format: "iife", minify: true });
  if (!built.success) throw new AggregateError(built.logs, "invite page build failed");
  const code = await built.outputs[0]!.text();
  await Bun.write(BUNDLE, `// Built from invite-page.ts by \`bun run build-invite-page\`; don't edit. source-sha256: ${await sourceHash()}\n${code}`);
  console.log(`public/invite.js: ${code.length} bytes`);
}
