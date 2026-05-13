#!/usr/bin/env bun

import { file } from "bun";
import { randomBytes } from "crypto";
import { mkdirSync, appendFileSync, existsSync, unlinkSync, realpathSync } from "fs";
import { hostname } from "os";
import { join, basename, dirname } from "path";

export const ENV_KEY = "RECHROME_URL";
export const DEFAULT_PORT = 13775;
export const RECH_DIR = join(import.meta.dir, ".rech");
export const LOG_DIR = join(RECH_DIR, "logs");

const envFile = join(import.meta.dir, ".env.local");

async function loadEnvFile(path: string): Promise<boolean> {
  const envRaw = await file(path).text().catch(() => "");
  if (!envRaw) return false;
  let hasKey = false;
  for (const line of envRaw.split("\n")) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      if (m[1] === ENV_KEY) hasKey = true;
    }
  }
  return hasKey;
}

async function loadEnv() {
  // Walk up from cwd first — project-local .env.local takes priority
  let dir = process.cwd();
  while (true) {
    if (await loadEnvFile(join(dir, ".env.local"))) break;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to script dir's .env.local
  if (!process.env[ENV_KEY]) await loadEnvFile(envFile);
}
// Shell-set passthrough vars survive .env.local loading
const _shellPassthrough: Record<string, string> = {};
for (const k of ["PLAYWRIGHT_MCP_EXTENSION_ID","PLAYWRIGHT_MCP_EXTENSION_TOKEN","PLAYWRIGHT_MCP_PROFILE_DIRECTORY","PLAYWRIGHT_MCP_USER_DATA_DIR"] as const) {
  if (process.env[k]) _shellPassthrough[k] = process.env[k]!;
}
await loadEnv();
Object.assign(process.env, _shellPassthrough);

import { watch } from "node:fs";
if (existsSync(envFile)) {
  watch(envFile, async () => {
    log(".env.local changed, reloading");
    await loadEnv();
  });
}


export const PASSTHROUGH_ENV_KEYS = [
  "PLAYWRIGHT_MCP_EXTENSION_ID",
  "PLAYWRIGHT_MCP_EXTENSION_TOKEN",
  "PLAYWRIGHT_MCP_PROFILE_DIRECTORY",
  "PLAYWRIGHT_MCP_USER_DATA_DIR",
] as const;

export function log(msg: string) {
  mkdirSync(LOG_DIR, { recursive: true });
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  console.error(line.trimEnd());
  const logFile = join(LOG_DIR, `${ts.slice(0, 10)}.log`);
  appendFileSync(logFile, line);
}

export function parseUrl(raw: string) {
  const u = new URL(raw);
  const scheme = u.protocol.replace(":", "");
  const protocol = scheme === "https" ? "https" : "http";
  const defaultPort = scheme === "https" ? 443 : scheme === "http" ? 80 : DEFAULT_PORT;
  return {
    key: u.username,
    host: u.hostname,
    port: parseInt(u.port) || defaultPort,
    protocol,
    extensionId: u.searchParams.get("extension_id") ?? undefined,
    extensionToken: u.searchParams.get("token") ?? undefined,
    profileDirectory: u.searchParams.get("profile") ?? undefined,
    userDataDir: u.searchParams.get("user_data_dir") ?? undefined,
  };
}

export async function getOrCreateUrl(): Promise<string> {
  if (process.env[ENV_KEY]) return process.env[ENV_KEY];
  const key = randomBytes(9).toString("base64url"); // 12 chars
  const url = `http://${key}@127.0.0.1:${DEFAULT_PORT}`;
  const newLine = `${ENV_KEY}=${url}`;
  const envRaw = await file(envFile).text().catch(() => "");
  const lines = envRaw.trimEnd().split("\n").filter(l => !l.startsWith(`${ENV_KEY}=`));
  const content = [...lines, newLine, ""].join("\n");
  Bun.write(envFile, content);
  process.env[ENV_KEY] = url;
  return url;
}

export function authCheck(req: Request, key: string): Response | null {
  const bearer = req.headers.get("authorization")?.replace("Bearer ", "");
  if (bearer !== key) return new Response("Unauthorized", { status: 401 });
  return null;
}

async function getClientIdentity(): Promise<{ gitUrl?: string; hostname?: string; cwd?: string }> {
  const cwd = process.cwd();
  try {
    const remoteProc = Bun.spawn(["git", "remote", "get-url", "origin"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const remoteUrl = (await new Response(remoteProc.stdout).text()).trim();
    await remoteProc.exited;

    const branchProc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const branch = (await new Response(branchProc.stdout).text()).trim();
    await branchProc.exited;

    if (remoteUrl) {
      let gitUrl: string;
      const sshMatch = remoteUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
      const httpsMatch = remoteUrl.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
      if (sshMatch) {
        gitUrl = `https://${sshMatch[1]}/${sshMatch[2]}`;
      } else if (httpsMatch) {
        gitUrl = `https://${httpsMatch[1]}/${httpsMatch[2]}`;
      } else {
        gitUrl = remoteUrl.replace(/\.git$/, "");
      }
      if (branch) gitUrl += `/tree/${branch}`;
      // Strip any embedded credentials from the URL
      try {
        const u = new URL(gitUrl);
        u.username = "";
        u.password = "";
        gitUrl = u.toString();
      } catch {}
      return { gitUrl };
    }
  } catch {}
  return { hostname: hostname(), cwd };
}

function getClientEnv(urlExtras?: { extensionId?: string; extensionToken?: string; profileDirectory?: string; userDataDir?: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (urlExtras?.extensionId)
    env["PLAYWRIGHT_MCP_EXTENSION_ID"] = urlExtras.extensionId;
  if (urlExtras?.extensionToken)
    env["PLAYWRIGHT_MCP_EXTENSION_TOKEN"] = urlExtras.extensionToken;
  if (urlExtras?.profileDirectory)
    env["PLAYWRIGHT_MCP_PROFILE_DIRECTORY"] = urlExtras.profileDirectory;
  if (urlExtras?.userDataDir)
    env["PLAYWRIGHT_MCP_USER_DATA_DIR"] = urlExtras.userDataDir;
  return env;
}

const CHROME_LOCAL_STATE_PATHS = () => {
  const home = process.env.HOME || "~";
  return [
    join(home, "Library/Application Support/Google/Chrome/Local State"),
    join(home, ".config/google-chrome/Local State"),
    join(home, "AppData/Local/Google/Chrome/User Data/Local State"),
  ];
};

async function readChromeProfileCache(): Promise<Record<string, { user_name?: string; name?: string }> | null> {
  for (const statePath of CHROME_LOCAL_STATE_PATHS()) {
    const f = file(statePath);
    if (!(await f.exists())) continue;
    try {
      const data = JSON.parse(await f.text());
      return data?.profile?.info_cache ?? null;
    } catch {}
  }
  return null;
}

async function findChromeUserDataDir(): Promise<string | null> {
  for (const statePath of CHROME_LOCAL_STATE_PATHS()) {
    if (!(await file(statePath).exists())) continue;
    return dirname(statePath);
  }
  return null;
}

export const EXTENSION_DIST_DIR = join(
  import.meta.dir,
  "lib/playwright-multi-tab/lib/playwright-mcp/packages/extension/dist",
);

// Walk all Chrome profiles' Secure Preferences and find an extension
// whose loaded `path` matches our dist directory. The extension ID Chrome
// generates for an unpacked extension is path-dependent, so we cannot rely
// on a hardcoded ID across machines.
async function findInstalledExtension(
  profileDir?: string,
): Promise<{ id: string; profile: string } | null> {
  const userDataDir = await findChromeUserDataDir();
  if (!userDataDir) return null;
  const cache = await readChromeProfileCache();
  const profiles = profileDir ? [profileDir] : (cache ? Object.keys(cache) : []);
  for (const prof of profiles) {
    const prefsPath = join(userDataDir, prof, "Secure Preferences");
    const f = file(prefsPath);
    if (!(await f.exists())) continue;
    try {
      const data = JSON.parse(await f.text());
      const settings = data?.extensions?.settings ?? {};
      for (const [extId, info] of Object.entries(settings as Record<string, any>)) {
        if (!info?.path || info.state === 0) continue; // state 0 = explicitly disabled
        let storedPath = info.path as string;
        try { storedPath = realpathSync(storedPath); } catch {}
        let distPath = EXTENSION_DIST_DIR;
        try { distPath = realpathSync(distPath); } catch {}
        if (storedPath === distPath) return { id: extId, profile: prof };
      }
    } catch {}
  }
  return null;
}

function printInstallInstructions(profileDisplay: string): void {
  console.error("");
  console.error("Multi-tab extension is not installed in this Chrome profile.");
  console.error("");
  console.error("To install:");
  console.error("  1. Open chrome://extensions/ in the selected profile");
  console.error(`     (profile: ${profileDisplay})`);
  console.error("  2. Enable \"Developer mode\" (top-right toggle)");
  console.error("  3. Click \"Load unpacked\"");
  console.error("  4. Select this directory:");
  console.error(`       ${EXTENSION_DIST_DIR}`);
  console.error("  5. Re-run `rech setup`");
  console.error("");
}

async function resolveProfileEmail(dir: string): Promise<string> {
  const cache = await readChromeProfileCache();
  if (cache?.[dir]?.user_name) return cache[dir].user_name;
  return dir;
}

async function listProfiles(): Promise<void> {
  const cache = await readChromeProfileCache();
  if (!cache) { console.error("Chrome Local State not found"); process.exit(1); }

  const current = process.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY;
  // Resolve email/name → dir for current marker
  let currentDir = current;
  if (current && !/^(Default|Profile \d+)$/i.test(current)) {
    for (const [dir, info] of Object.entries(cache)) {
      if (info.user_name === current || info.name === current) { currentDir = dir; break; }
    }
  }

  const rows = Object.entries(cache).map(([dir, info]) => [
    dir,
    info.user_name || "",
    info.name || "",
    dir === currentDir ? "← current" : "",
  ]);
  const widths = rows.reduce((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, c.length)), [] as number[]);
  for (const row of rows) {
    console.log(row.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd());
  }
}

async function callServe(
  url: string,
  args: string[],
  overrideEnv?: Record<string, string>,
): Promise<{ status: number; stdout: string; stderr: string; files?: string[]; existingSession?: boolean }> {
  const { key, host, port, protocol, extensionId, extensionToken, profileDirectory, userDataDir } = parseUrl(url);
  const identity = await getClientIdentity();
  const effectiveProfile = profileDirectory || process.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY;
  if (effectiveProfile) (identity as any).profile = effectiveProfile;
  const env = { ...getClientEnv({ extensionId, extensionToken, profileDirectory, userDataDir }), ...overrideEnv };
  const res = await fetch(`${protocol}://${host}:${port}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ args, identity, env }),
    signal: AbortSignal.timeout(70_000),
  }).catch((e) => { console.error(`[rech] ${e.message}`); process.exit(1); });
  if (res.status === 401) { console.error("Unauthorized: bad key"); process.exit(1); }
  return res.json();
}

async function run(url: string, args: string[]) {
  const { host, port, protocol } = parseUrl(url);
  const effectiveProfile = parseUrl(url).profileDirectory || process.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY;
  const displayProfile = effectiveProfile ? await resolveProfileEmail(effectiveProfile) : undefined;
  const identity = await getClientIdentity();
  const profileSuffix = displayProfile ? ` profile:${displayProfile}` : "";
  console.error(
    `[rech] connecting to ${host}:${port} (identity: ${identity.gitUrl || `${identity.hostname}:${identity.cwd}`}${profileSuffix})`,
  );

  const { status, stdout, stderr, files, existingSession } = await callServe(url, args);

  if (existingSession)
    console.error(`[rech] session already has open tabs — listing existing tabs instead of opening a new window`);
  if (stderr) process.stderr.write(stderr);
  if (stdout) process.stdout.write(stdout);

  if (files?.length) {
    const dlDir = join(process.cwd(), ".playwright-cli-multi-tab");
    mkdirSync(dlDir, { recursive: true });
    const gitignorePath = join(dlDir, ".gitignore");
    if (!existsSync(gitignorePath)) await Bun.write(gitignorePath, "*\n");
    for (const name of files) {
      const fileRes = await fetch(`${protocol}://${host}:${port}/files/${name}`, {
        headers: { Authorization: `Bearer ${parseUrl(url).key}` },
      });
      if (!fileRes.ok) continue;
      const dest = join(dlDir, basename(name));
      await Bun.write(dest, fileRes);
      console.error(`[rech] downloaded: ${dest}`);
    }
  }

  process.exit(status);
}

function buildSetupHtml(extDistDir: string, profileDisplay: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>rechrome — Extension Setup</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #222; }
  h1 { color: #1a73e8; }
  .step { background: #f8f9fa; border-left: 4px solid #1a73e8; padding: 12px 16px; margin: 16px 0; border-radius: 0 8px 8px 0; }
  .step h3 { margin: 0 0 8px; }
  code { background: #e8eaed; padding: 2px 6px; border-radius: 4px; font-size: 0.95em; word-break: break-all; }
  .path { display: flex; align-items: center; gap: 8px; }
  button { background: #1a73e8; color: white; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 0.9em; }
  button:active { background: #1558b0; }
  .note { color: #666; font-size: 0.9em; }
</style>
</head>
<body>
<h1>rechrome — Extension Setup</h1>
<p>Install the multi-tab extension in Chrome profile: <strong>${profileDisplay}</strong></p>

<div class="step">
  <h3>Step 1 — Open Chrome Extensions</h3>
  <p>In the Chrome profile <strong>${profileDisplay}</strong>, navigate to:</p>
  <code>chrome://extensions/</code>
  <p class="note">Make sure you are in the correct profile (check the avatar in the top-right corner).</p>
</div>

<div class="step">
  <h3>Step 2 — Enable Developer Mode</h3>
  <p>Toggle <strong>Developer mode</strong> on (top-right of the extensions page).</p>
</div>

<div class="step">
  <h3>Step 3 — Load the extension</h3>
  <p>Click <strong>Load unpacked</strong> and select this directory:</p>
  <div class="path">
    <code id="extPath">${extDistDir}</code>
    <button onclick="navigator.clipboard.writeText(document.getElementById('extPath').textContent).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy path',1500)})">Copy path</button>
  </div>
</div>

<div class="step">
  <h3>Step 4 — Return to terminal</h3>
  <p>Press <strong>Enter</strong> in the terminal to continue setup.</p>
</div>

<div class="step">
  <h3>Step 5 — Copy auth token</h3>
  <p>Click the extension icon in the Chrome toolbar (or open the URL below):</p>
  <code id="statusUrl">chrome-extension://(detected after install)/status.html</code>
  <p>The page shows <strong>PLAYWRIGHT_MCP_EXTENSION_TOKEN=...</strong> — paste that into the terminal when prompted.</p>
</div>
</body>
</html>`;
}

const LAUNCHD_LABEL = "com.rechrome.serve";
const LAUNCHD_PLIST = join(process.env.HOME!, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`);

async function daemonInstall(serveUrl: string): Promise<boolean> {
  const home = process.env.HOME!;
  const logDir = join(home, ".rech", "logs");
  mkdirSync(logDir, { recursive: true });
  // Use absolute bun + script paths — launchd has no user PATH
  const bunBin = Bun.which("bun") ?? process.execPath;
  const rechScript = import.meta.filename;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunBin}</string>
    <string>${rechScript}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${home}</string>
    <key>PATH</key><string>${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}</string>
    <key>${ENV_KEY}</key><string>${serveUrl}</string>${process.env.PLAYWRIGHT_CLI ? `
    <key>PLAYWRIGHT_CLI</key><string>${process.env.PLAYWRIGHT_CLI}</string>` : ""}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(logDir, "serve.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(logDir, "serve.err.log")}</string>
  <key>WorkingDirectory</key><string>${home}</string>
</dict>
</plist>`;
  await Bun.write(LAUNCHD_PLIST, plist);
  await Bun.spawn(["launchctl", "unload", LAUNCHD_PLIST], { stdout: "ignore", stderr: "ignore" }).exited;
  const proc = Bun.spawn(["launchctl", "load", "-w", LAUNCHD_PLIST], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  return proc.exitCode === 0;
}

async function daemonUninstall(): Promise<void> {
  const proc = Bun.spawn(["launchctl", "unload", "-w", LAUNCHD_PLIST], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  try { unlinkSync(LAUNCHD_PLIST); } catch {}
  console.log(`Removed launchd agent: ${LAUNCHD_LABEL}`);
}

async function setup(): Promise<void> {
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>(r => rl.question(q, r));

  // [1/4] Daemon
  console.log("\n[1/4] Setting up serve daemon...");
  const rechBin = Bun.which("rech") ?? process.execPath;
  // Clear stale hostname-based URL so we always use 127.0.0.1 locally
  if (process.env[ENV_KEY]) {
    try {
      const u = new URL(process.env[ENV_KEY]);
      if (!["127.0.0.1", "localhost"].includes(u.hostname)) delete process.env[ENV_KEY];
    } catch {}
  }
  const url = await getOrCreateUrl();
  const { host, port, protocol } = parseUrl(url);

  let ping = await fetch(`${protocol}://${host}:${port}/`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
  if (ping) {
    console.log(`      Already running at ${protocol}://${host}:${port}`);
    if (process.platform === "darwin" && !existsSync(LAUNCHD_PLIST)) {
      await daemonInstall(url);
      console.log(`      Registered as login daemon: ${LAUNCHD_LABEL}`);
    }
  } else {
    if (process.platform === "darwin") {
      await daemonInstall(url);
      console.log(`      Registered as login daemon: ${LAUNCHD_LABEL}`);
      process.stdout.write("      Starting");
      for (let i = 0; i < 15; i++) {
        await Bun.sleep(1000);
        ping = await fetch(`${protocol}://${host}:${port}/`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
        if (ping) break;
        process.stdout.write(".");
      }
      process.stdout.write("\n");
    }
    if (!ping) {
      Bun.spawn([rechBin, "serve"], { stdout: "ignore", stderr: "ignore", detached: true });
      process.stdout.write("      Starting");
      for (let i = 0; i < 10; i++) {
        await Bun.sleep(1000);
        ping = await fetch(`${protocol}://${host}:${port}/`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
        if (ping) break;
        process.stdout.write(".");
      }
      process.stdout.write("\n");
    }
    if (!ping) {
      console.error(`      Failed to start serve at ${host}:${port}`);
      rl.close();
      process.exit(1);
    }
    console.log(`      Serve running at ${protocol}://${host}:${port}`);
  }

  // [2/4] Profile selection
  console.log("\n[2/4] Select Chrome profile:");
  const cache = await readChromeProfileCache();
  if (!cache) { console.error("      Chrome profiles not found"); rl.close(); process.exit(1); }
  const profiles = Object.entries(cache);
  profiles.forEach(([dir, info], i) =>
    console.log(`        ${String(i + 1).padStart(2)}.  ${(info.user_name || "(no email)").padEnd(32)}  ${(info.name || "").padEnd(20)}  [${dir}]`)
  );
  const answer = await ask("\n      Profile number: ");
  rl.pause();
  const idx = parseInt(answer.trim()) - 1;
  if (isNaN(idx) || idx < 0 || idx >= profiles.length) { console.error("      Invalid selection"); rl.close(); process.exit(1); }
  const [profileDir, profileInfoSel] = profiles[idx];
  const profileEnv = { PLAYWRIGHT_MCP_PROFILE_DIRECTORY: profileDir };
  const profileDisplay = profileInfoSel.user_name || profileInfoSel.name || profileDir;

  // [3/4] Extension
  console.log("\n[3/4] Checking extension...");
  let extId: string | undefined;
  while (true) {
    const found = await findInstalledExtension(profileDir);
    if (found) { extId = found.id; break; }

    // Generate and open setup guide in system browser
    const setupHtmlPath = join(process.env.HOME!, ".rech", "setup.html");
    mkdirSync(join(process.env.HOME!, ".rech"), { recursive: true });
    await Bun.write(setupHtmlPath, buildSetupHtml(EXTENSION_DIST_DIR, profileDisplay));
    console.log(`\n      Extension not found in profile: ${profileDisplay}`);
    console.log(`      Extension dist: ${EXTENSION_DIST_DIR}`);
    console.log(`\n      Opening install guide in your browser...`);
    Bun.spawn(["open", setupHtmlPath], { stdout: "ignore", stderr: "ignore" });
    rl.resume();
    await ask("\n      Press Enter after loading the extension to retry...");
    rl.pause();
  }
  console.log(`      Extension found: ${extId}`);

  // [4/4] Token — user copies it from the extension status page
  const statusUrl = `chrome-extension://${extId}/status.html`;
  console.log(`\n[4/4] Get auth token from the extension:`);
  console.log(`\n      Open this URL in Chrome (profile: ${profileDisplay}):`);
  console.log(`        ${statusUrl}`);
  console.log(`\n      Or click the extension icon in the Chrome toolbar.`);
  console.log(`      Copy the token shown on the page (PLAYWRIGHT_MCP_EXTENSION_TOKEN=...).\n`);
  Bun.spawn(["open", statusUrl], { stdout: "ignore", stderr: "ignore" });
  rl.resume();
  const tokenInput = (await ask("      Paste token: ")).trim();
  rl.pause();
  // Accept bare token or KEY=value format
  const token = tokenInput.replace(/^.*?=/, "").trim();
  if (!token || token.length < 20) {
    console.error("      Invalid token (too short)");
    rl.close();
    process.exit(1);
  }
  console.log("      Token accepted");
  rl.close();

  // Save config
  const home = process.env.HOME!;
  const globalEnvPath = join(home, ".env.local");
  const existing = await file(globalEnvPath).text().catch(() => "");
  const rechUrl = new URL(url);
  rechUrl.searchParams.set("extension_id", extId);
  rechUrl.searchParams.set("token", token);
  rechUrl.searchParams.set("profile", profileInfoSel.user_name || profileDir);
  const userDataDir = await findChromeUserDataDir();
  if (userDataDir) rechUrl.searchParams.set("user_data_dir", userDataDir);
  const newLine = `RECHROME_URL=${rechUrl.toString()}`;
  const keysToRemove = ["PLAYWRIGHT_MCP_USER_DATA_DIR", "PLAYWRIGHT_MCP_EXTENSION_ID", "PLAYWRIGHT_MCP_EXTENSION_TOKEN", "PLAYWRIGHT_MCP_PROFILE_DIRECTORY"];
  let lines = existing.trimEnd().split("\n").filter(l => !keysToRemove.some(k => l.startsWith(`${k}=`)));
  const rechIdx = lines.findIndex(l => l.startsWith("RECHROME_URL="));
  if (rechIdx >= 0) lines[rechIdx] = newLine;
  else lines.push(newLine);
  await Bun.write(globalEnvPath, lines.join("\n").trim() + "\n");
  console.log(`\nSaved to ${globalEnvPath}:\n  ${newLine}`);
  console.log('\nDone! Test with: rech eval "() => document.title"');
}

function printHelp(): void {
  console.log(`rechrome (rech) — drive Chrome via Playwright over HTTP

Usage:
  rech setup                   First-time setup: daemon + Chrome extension + config
  rech uninstall               Remove the serve daemon and clear config
  rech serve                   Start the serve server manually (foreground)
  rech profiles                List Chrome profiles
  rech <playwright-args...>    Run Playwright CLI command (requires ${ENV_KEY})

Environment:
  ${ENV_KEY}   Server URL set by \`rech setup\`

Examples:
  rech setup
  rech eval "() => document.title"
  rech open https://example.com
  rech screenshot`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const cmd = args[0]?.toLowerCase();

  if (cmd === "serve") {
    const { serve } = await import("./serve.ts");
    serve();
  } else if (cmd === "profiles") {
    await listProfiles();
  } else if (cmd === "setup") {
    await setup();
  } else if (cmd === "uninstall") {
    await daemonUninstall();
  } else if (cmd === "help" || cmd === "--help" || cmd === "-h" || args.length === 0) {
    printHelp();
  } else {
    const url = process.env[ENV_KEY];
    if (!url) {
      console.error(`${ENV_KEY} is not set. Run \`rech setup\` to configure.\n`);
      printHelp();
      process.exit(1);
    }
    run(url, args);
  }
}
