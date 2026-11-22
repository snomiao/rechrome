import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('approval companion prepares management then opens its own isolated operator session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rech-panel-cli-'));
    await mkdir(join(home, '.rechrome'));
    const seen: {
        endpoint: string;
        args: string[];
    }[] = [];
    const endpoint = (name: string) => Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) { if (new URL(req.url).pathname === '/run') {
            const body = await req.json();
            seen.push({ endpoint: name, args: body.args });
            return Response.json({ status: name === 'management' ? 0 : 1, stdout: '', stderr: '', files: [] });
        } return Response.json({ multiListener: true }); } });
    const management = endpoint('management'), scoped = endpoint('scoped');
    await writeFile(join(home, '.rechrome', 'listeners.json'), JSON.stringify({ version: 1, listeners: [{ name: 'local', host: '127.0.0.1', port: management.port, key: 'm'.repeat(24), profiles: '*' }, { name: 'scoped', host: '127.0.0.1', port: scoped.port, key: 's'.repeat(24), profiles: ['qa'] }] }));
    const run = async (key: string, port: number) => {
        const child = Bun.spawn([process.execPath, join(import.meta.dir, 'rechrome.ts'), 'audio', 'approvals'], { cwd: home, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, RECHROME_URL: `http://${key}@127.0.0.1:${port}/` }, stdout: 'pipe', stderr: 'pipe' });
        const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        return { code, out };
    };
    try {
        expect(await run('s'.repeat(24), scoped.port!)).toEqual({ code: 1, out: '' });
        expect(seen).toEqual([{ endpoint: 'scoped', args: ['audio', 'approvals', 'prepare'] }]);
        seen.length = 0;
        expect(await run('m'.repeat(24), management.port!)).toEqual({ code: 0, out: '' });
        expect(seen).toEqual([{ endpoint: 'management', args: ['audio', 'approvals', 'prepare'] }, { endpoint: 'management', args: ['open', 'about:blank', '-s=iso_rech_audio_approvals'] }, { endpoint: 'management', args: ['-s=iso_rech_audio_approvals', 'audio', 'approvals'] }]);
    }
    finally {
        management.stop(true);
        scoped.stop(true);
        await rm(home, { recursive: true, force: true });
    }
});
