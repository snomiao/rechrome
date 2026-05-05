#!/usr/bin/env bun

import { file } from "bun";
import { randomBytes } from "crypto";
import { mkdirSync, appendFileSync, existsSync } from "fs";
import { hostname } from "os";
import { join, basename } from "path";

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
for (const k of ["PLAYWRIGHT_MCP_EXTENSION_ID","PLAYWRIGHT_MCP_EXTENSION_TOKEN","PLAYWRIGHT_MCP_USER_DATA_DIR","PLAYWRIGHT_MCP_PROFILE_DIRECTORY"] as const) {
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
  "PLAYWRIGHT_MCP_USER_DATA_DIR",
  "PLAYWRIGHT_MCP_PROFILE_DIRECTORY",
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
  };
}

export async function getOrCreateUrl(): Promise<string> {
  if (process.env[ENV_KEY]) return process.env[ENV_KEY];
  const key = randomBytes(9).toString("base64url"); // 12 chars
  const url = `http://${key}@${hostname()}:${DEFAULT_PORT}`;
  const newLine = `${ENV_KEY}=${url}`;
  const envRaw = await file(envFile)
    .text()
    .catch(() => "");
  const content = envRaw.trimEnd() ? envRaw.trimEnd() + "\n" + newLine + "\n" : newLine + "\n";
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

function getClientEnv(urlExtras?: { extensionId?: string; extensionToken?: string; profileDirectory?: string }): Record<string, string> {
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
  return env;
}

async function run(url: string, args: string[]) {
  const { key, host, port, protocol, extensionId, extensionToken, profileDirectory } = parseUrl(url);

  // Effective profile: URL param takes priority over env var
  const effectiveProfile = profileDirectory || process.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY;

  const identity = await getClientIdentity();
  if (effectiveProfile) (identity as any).profile = effectiveProfile;

  const profileSuffix = effectiveProfile ? ` profile:${effectiveProfile}` : "";
  console.error(
    `[rech] connecting to ${host}:${port} (identity: ${identity.gitUrl || `${identity.hostname}:${identity.cwd}`}${profileSuffix})`,
  );
  const res = await fetch(`${protocol}://${host}:${port}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ args, identity, env: getClientEnv({ extensionId, extensionToken, profileDirectory }) }),
    signal: AbortSignal.timeout(70_000),
  }).catch((e) => {
    console.error(`[rech] ${e.message}`);
    process.exit(1);
  });

  if (res.status === 401) {
    console.error("Unauthorized: bad key");
    process.exit(1);
  }

  const { status, stdout, stderr, files, existingSession } = (await res.json()) as {
    status: number;
    stdout: string;
    stderr: string;
    files?: string[];
    existingSession?: boolean;
  };

  if (existingSession) {
    console.error(
      `[rech] session already has open tabs — listing existing tabs instead of opening a new window`,
    );
  }
  if (stderr) process.stderr.write(stderr);
  if (stdout) process.stdout.write(stdout);

  if (files?.length) {
    const dlDir = join(process.cwd(), ".playwright-cli-multi-tab");
    mkdirSync(dlDir, { recursive: true });
    const gitignorePath = join(dlDir, ".gitignore");
    if (!existsSync(gitignorePath)) await Bun.write(gitignorePath, "*\n");
    for (const name of files) {
      const fileRes = await fetch(`${protocol}://${host}:${port}/files/${name}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!fileRes.ok) continue;
      const dest = join(dlDir, basename(name));
      await Bun.write(dest, fileRes);
      console.error(`[rech] downloaded: ${dest}`);
    }
  }

  process.exit(status);
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "serve") {
    const { serve } = await import("./serve.ts");
    serve();
  } else {
    const url = process.env[ENV_KEY];
    if (!url) {
      console.error(
        `Usage:\n  rech serve\n  ${ENV_KEY}=http://key@host:${DEFAULT_PORT}?extension_id=ID&token=TOKEN rech <playwright-args...>\n  ${ENV_KEY}=https://key@host/path?extension_id=ID&token=TOKEN rech <playwright-args...>`,
      );
      process.exit(1);
    }
    run(url, args);
  }
}
