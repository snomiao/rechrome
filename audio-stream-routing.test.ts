import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('direct, pw and separator audio never substitute a selected scoped listener', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rech-pcm-routing-'));
    await mkdir(join(home, '.rechrome'));
    const seen: {
        endpoint: string;
        args: string[];
    }[] = [];
    const endpoint = (name: string) => Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
            if (new URL(req.url).pathname === '/run') {
                const body = await req.json();
                seen.push({ endpoint: name, args: body.args });
                return Response.json({ status: 1, stdout: '', stderr: 'audio refused', files: [] });
            }
            return Response.json({ multiListener: true });
        } });
    const management = endpoint('management'), scoped = endpoint('scoped');
    const config = { version: 1, listeners: [{ name: 'local', host: '127.0.0.1', port: management.port, key: 'm'.repeat(24), profiles: '*' }, { name: 'scoped', host: '127.0.0.1', port: scoped.port, key: 's'.repeat(24), profiles: ['fixture'] }] };
    await writeFile(join(home, '.rechrome', 'listeners.json'), JSON.stringify(config));
    try {
        for (const args of [['audio', 'status'], ['pw', 'audio', 'status'], ['--', 'audio', 'status']]) {
            const before = seen.length;
            const child = Bun.spawn([process.execPath, join(import.meta.dir, 'rechrome.ts'), ...args], { cwd: home, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, RECHROME_URL: `http://${'s'.repeat(24)}@127.0.0.1:${scoped.port}/` }, stdout: 'pipe', stderr: 'pipe' });
            const [code] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
            expect(code).toBe(1);
            expect(seen.length - before).toBe(1);
            expect(seen.at(-1)).toEqual({ endpoint: 'scoped', args: ['audio', 'status'] });
        }
    }
    finally {
        management.stop(true);
        scoped.stop(true);
        await rm(home, { recursive: true, force: true });
    }
});
