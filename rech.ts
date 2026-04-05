#!/usr/bin/env bun

import { file } from "bun";
import { randomBytes } from "crypto";
import { mkdirSync, appendFileSync, existsSync } from "fs";
import { hostname } from "os";
import { join, basename } from "path";

export const ENV_KEY = "REMOTE_CHROME_URL";
export const DEFAULT_PORT = 13775;
export const RECH_DIR = join(import.meta.dir, ".rech");
export const LOG_DIR = join(RECH_DIR, "logs");

// Load .env.local from script's directory (works even when invoked from elsewhere)
const envFile = join(import.meta.dir, ".env.local");

/** Load .env.local into process.env. */
async function loadEnv() {
  const envRaw = await file(envFile)
    .text()
    .catch(() => "");
  for (const line of envRaw.split("\n")) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
await loadEnv();

// Watch .env.local for changes and hot-reload
import { watch } from "node:fs";
if (existsSync(envFile)) {
  watch(envFile, async () => {
    log(".env.local changed, reloading");
    await loadEnv();
  });
}

/** Describe an image using Gemini vision API. Returns description or null on failure. */
export async function describeImage(imagePath: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  try {
    const imageData = await file(imagePath).arrayBuffer();
    const base64 = Buffer.from(imageData).toString("base64");
    const mimeType = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: "Describe this browser screenshot concisely in 2-3 sentences. Focus on what's visible: page layout, content, any errors or issues.",
                },
                { inline_data: { mime_type: mimeType, data: base64 } },
              ],
            },
          ],
        }),
      },
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
  } catch {
    return null;
  }
}

export const PASSTHROUGH_ENV_KEYS = [
  "PLAYWRIGHT_MCP_EXTENSION_ID",
  "PLAYWRIGHT_MCP_EXTENSION_TOKEN",
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
  return { key: u.username, host: u.hostname, port: parseInt(u.port) || DEFAULT_PORT };
}

export async function getOrCreateUrl(): Promise<string> {
  if (process.env[ENV_KEY]) return process.env[ENV_KEY];
  const key = randomBytes(9).toString("base64url"); // 12 chars
  const url = `remote-chrome://${key}@${hostname()}:${DEFAULT_PORT}`;
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

function getClientEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function run(url: string, args: string[]) {
  const { key, host, port } = parseUrl(url);
  const identity = await getClientIdentity();
  console.error(
    `[rech] connecting to ${host}:${port} (identity: ${identity.gitUrl || `${identity.hostname}:${identity.cwd}`})`,
  );
  const res = await fetch(`http://${host}:${port}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ args, identity, env: getClientEnv() }),
    signal: AbortSignal.timeout(70_000),
  }).catch((e) => {
    console.error(`[rech] ${e.message}`);
    process.exit(1);
  });

  if (res.status === 401) {
    console.error("Unauthorized: bad key");
    process.exit(1);
  }

  const { status, stdout, stderr, files, descriptions, existingSession } = (await res.json()) as {
    status: number;
    stdout: string;
    stderr: string;
    files?: string[];
    descriptions?: Record<string, string>;
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
      const fileRes = await fetch(`http://${host}:${port}/files/${name}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!fileRes.ok) continue;
      const dest = join(dlDir, basename(name));
      await Bun.write(dest, fileRes);
      console.error(`[rech] downloaded: ${dest}`);
      if (descriptions?.[name]) {
        console.error(`[rech] vision: ${descriptions[name]}`);
      }
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
        `Usage:\n  rech serve\n  ${ENV_KEY}=remote-chrome://key@host:${DEFAULT_PORT} rech <playwright-args...>`,
      );
      process.exit(1);
    }
    run(url, args);
  }
}
