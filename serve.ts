import { file } from "bun";
import { createHash } from "crypto";
import { mkdirSync } from "fs";
import { join, resolve, relative, isAbsolute } from "path";
import {
  log,
  parseUrl,
  getOrCreateUrl,
  authCheck,
  describeImage,
  RECH_DIR,
  PASSTHROUGH_ENV_KEYS,
} from "./rech.ts";

export function isUnderDir(base: string, candidate: string): boolean {
  const absBase = resolve(base) + "/";
  const absCandidate = resolve(base, candidate);
  return absCandidate.startsWith(absBase);
}

export async function serve() {
  const url = await getOrCreateUrl();
  const { key, port } = parseUrl(url);

  const workDir = join(RECH_DIR, "output");
  mkdirSync(workDir, { recursive: true });

  const listenHost = process.env.RECH_HOST || "127.0.0.1";
  const server = Bun.serve({
    hostname: listenHost,
    port,
    async fetch(req) {
      const reqUrl = new URL(req.url);

      // Serve files from output dir
      if (reqUrl.pathname.startsWith("/files/")) {
        const denied = authCheck(req, key);
        if (denied) return denied;
        const name = decodeURIComponent(reqUrl.pathname.slice(7));
        if (!isUnderDir(workDir, name)) return new Response("Forbidden", { status: 403 });
        const resolved = resolve(workDir, name);
        const f = file(resolved);
        if (!(await f.exists())) return new Response("Not found", { status: 404 });
        return new Response(f);
      }

      if (reqUrl.pathname !== "/run") return new Response("rech server\n");
      const denied = authCheck(req, key);
      if (denied) return denied;

      const body = await req.json();
      let args: string[];
      let sessionId: string;
      let clientName = "";
      let clientEnv: Record<string, string> = {};
      if (Array.isArray(body)) {
        args = body;
        const clientAddr = `${req.headers.get("x-forwarded-for") || server.requestIP(req)?.address || "unknown"}`;
        sessionId = createHash("sha256").update(clientAddr).digest("hex").slice(0, 12);
        clientName = clientAddr;
        log(`session from client IP: ${clientAddr} -> ${sessionId}`);
      } else {
        args = body.args;
        const id = body.identity as
          | { gitUrl?: string; hostname?: string; cwd?: string }
          | undefined;
        const raw = id?.gitUrl || (id?.hostname && id?.cwd ? `${id.hostname}:${id.cwd}` : null);
        if (raw) {
          sessionId = createHash("sha256").update(raw).digest("hex").slice(0, 12);
          clientName = raw;
          log(`session from identity: ${raw} -> ${sessionId}`);
        } else {
          const clientAddr = `${req.headers.get("x-forwarded-for") || server.requestIP(req)?.address || "unknown"}`;
          sessionId = createHash("sha256").update(clientAddr).digest("hex").slice(0, 12);
          clientName = clientAddr;
          log(`session from client IP fallback: ${clientAddr} -> ${sessionId}`);
        }
        // Extract allowlisted env vars from client (client overrides server)
        if (body.env && typeof body.env === "object") {
          for (const key of PASSTHROUGH_ENV_KEYS) {
            if (typeof body.env[key] === "string") clientEnv[key] = body.env[key];
          }
        }
      }

      let clientSession = "";
      const filteredArgs = args.filter((a) => {
        const m = a.match(/^-s=(.+)$/);
        if (m) {
          clientSession = m[1];
          return false;
        }
        return true;
      });
      const namespacedSession = clientSession ? `${sessionId}-${clientSession}` : sessionId;

      const bin = process.env.PLAYWRIGHT_CLI || "playwright-cli";

      if (filteredArgs.length === 0) {
        filteredArgs.push("--help");
      }

      log(`run: rech ${filteredArgs.join(" ")} (session=${namespacedSession})`);

      // For open commands, check if this session already has tabs open
      const isOpenCmd = filteredArgs[0] === "open";
      if (isOpenCmd) {
        try {
          const listProc = Bun.spawn([bin, "tab-list", "--extension", `-s=${namespacedSession}`], {
            cwd: workDir,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: { PATH: process.env.PATH, HOME: process.env.HOME },
          });
          const [listStatus, listOut] = await Promise.all([
            listProc.exited,
            new Response(listProc.stdout).text(),
          ]);
          if (listStatus === 0 && listOut.trim()) {
            log(`session ${namespacedSession} already has tabs, returning tab-list hint`);
            return Response.json({
              status: 0,
              stdout: listOut,
              stderr: `[rech] session "${namespacedSession}" already has open tabs:\n`,
              files: [],
              existingSession: true,
            });
          }
        } catch (e) {
          log(`tab-list check failed: ${e}`);
        }
      }

      // Merge passthrough env: server .env.local defaults, then client overrides
      const passthroughEnv: Record<string, string | undefined> = {};
      for (const key of PASSTHROUGH_ENV_KEYS) {
        if (process.env[key]) passthroughEnv[key] = process.env[key];
      }
      Object.assign(passthroughEnv, clientEnv);

      const childEnv: Record<string, string | undefined> = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        DISPLAY: process.env.DISPLAY,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        ...(clientName ? { PLAYWRIGHT_MCP_CLIENT_NAME: clientName } : {}),
        ...passthroughEnv,
      };
      const proc = Bun.spawn([bin, ...filteredArgs, "--extension", `-s=${namespacedSession}`], {
        cwd: workDir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: childEnv,
      });

      const TIMEOUT = 60_000;
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => {
          proc.kill();
          reject(new Error("timeout"));
        }, TIMEOUT),
      );
      const [status, stdout, stderr] = await Promise.race([
        Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]),
        timeout.then(() => [1, "", ""] as [number, string, string]),
      ]).catch(
        () => [1, "", `Command timed out after ${TIMEOUT / 1000}s\n`] as [number, string, string],
      );

      log(`exit: ${status}${stdout.trim() ? ` | ${stdout.trim().slice(0, 200)}` : ""}`);

      // Detect files mentioned in output
      const filePattern = /[\w./-]+\.(?:png|jpe?g|pdf|json|yml)\b/gi;
      const mentionedFiles = [
        ...new Set(
          [...stdout.matchAll(filePattern), ...stderr.matchAll(filePattern)].map((m) => m[0]),
        ),
      ];
      const outputFiles: string[] = [];
      for (const f of mentionedFiles) {
        if (!isUnderDir(workDir, f)) continue;
        if (await file(join(workDir, f)).exists()) {
          outputFiles.push(f);
        } else {
          const basename = f.split("/").pop()!;
          for (const subdir of [".playwright-cli", ".rech-multi-tab"]) {
            const subpath = join(subdir, basename);
            if (await file(join(workDir, subpath)).exists()) {
              outputFiles.push(subpath);
              break;
            }
          }
        }
      }

      // Auto-describe screenshot files with Gemini vision
      const descriptions: Record<string, string> = {};
      for (const f of outputFiles) {
        if (/\.(?:png|jpe?g)$/i.test(f)) {
          const desc = await describeImage(join(workDir, f));
          if (desc) descriptions[f] = desc;
        }
      }

      const rebrand = (s: string) => s.replaceAll("npx playwright-cli", "rech");
      return Response.json({
        status,
        stdout: rebrand(stdout),
        stderr: rebrand(stderr),
        files: outputFiles,
        descriptions,
      });
    },
  });

  log(`serving on http://${server.hostname}:${server.port}`);
  log(`Connection URL set (use .env.local to view)`);
}
