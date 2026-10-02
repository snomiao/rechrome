import { expect, test } from 'bun:test';
import { mkdtempSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { provisionExtensionToken } from './rechrome.ts';
import { playwrightCliEnv } from './serve.ts';

// Opt in: launches its own Chrome for Testing, never a registered/user profile.
// RECH_TEST_MANAGED_PROFILE=1 bun test ./managed-profile.integration.test.ts
// Build lib/playwright first. Override RECH_TEST_MANAGED_CLI for a negative control.
test.skipIf(process.platform !== 'darwin' || process.env.RECH_TEST_MANAGED_PROFILE !== '1')(
  'a provisioned profile cold-launches through the extension and supports navigation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rech-managed-integration-'));
    const token = randomBytes(32).toString('base64url');
    const dist = join(import.meta.dir, 'extension');
    const cli = process.env.RECH_TEST_MANAGED_CLI || join(import.meta.dir, 'lib/playwright/packages/playwright-core/lib/tools/cli-client/cli.js');
    const session = `managed-${randomBytes(6).toString('hex')}`;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<title>Managed launch works</title><h1>Managed launch works</h1>', { headers: { 'Content-Type': 'text/html' } }) });
    const env = playwrightCliEnv({ PLAYWRIGHT_MCP_EXTENSION: '1', PLAYWRIGHT_MCP_EXTENSION_ID: 'mmlmfjhmonkocbjadbfplnigmagldckm', PLAYWRIGHT_MCP_EXTENSION_TOKEN: token, PLAYWRIGHT_MCP_USER_DATA_DIR: root, PLAYWRIGHT_MCP_PROFILE_DIRECTORY: 'qa', PLAYWRIGHT_MCP_LOAD_EXTENSION: dist, PWMCP_TEST_CONNECTION_TIMEOUT: '30000' });
    const run = async (args: string[]) => {
      const proc = Bun.spawn(['node', cli, ...args, `-s=${session}`], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      // Error assertions must not expose the token embedded in a connect URL.
      return { out: out.replaceAll(token, '[redacted]'), err: err.replaceAll(token, '[redacted]'), code };
    };
    try {
      await provisionExtensionToken({ userDataDir: root, profileDir: 'qa', dist, token });
      const opened = await run(['open', `http://127.0.0.1:${server.port}`]);
      expect(opened.err).not.toContain('Extension connection timeout');
      if (opened.code !== 0) throw new Error(opened.err + '\n' + opened.out);
      expect(opened.code).toBe(0);
      expect(opened.out).toContain('Managed launch works');
      const snapshot = await run(['snapshot']);
      expect(snapshot.code).toBe(0);
      expect(snapshot.out).toContain('Managed launch works');
      const navigated = await run(['goto', `http://127.0.0.1:${server.port}/next`]);
      expect(navigated.code).toBe(0);
      expect(navigated.out).toContain('Managed launch works');
    } finally {
      await run(['close']).catch(() => {});
      // Chrome owns this newly-created directory's SingletonLock and process group.
      // Extension session close leaves Chrome running, so reap only this fixture.
      try {
        const pid = Number(readlinkSync(join(root, 'SingletonLock')).match(/-(\d+)$/)?.[1]);
        if (pid > 0) {
          try { process.kill(-pid, 'SIGTERM'); } catch {}
          await Bun.sleep(1_000);
          try { process.kill(-pid, 'SIGKILL'); } catch {}
        }
      } catch {}
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000,
);
