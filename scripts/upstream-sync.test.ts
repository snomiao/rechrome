import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function runSync(options: { ahead?: number; existing?: boolean; dry?: boolean; pushFails?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rech-upstream-test-'));
  try {
    const log = join(dir, 'calls');
    writeFileSync(log, '');
    writeFileSync(join(dir, 'gh'), `#!/bin/bash
echo "gh $*" >> "$CALL_LOG"
case "$*" in
  'api repos/snomiao/playwright --jq .default_branch'|'api repos/microsoft/playwright --jq .default_branch') echo main ;;
  'api repos/microsoft/playwright/commits/main --jq .sha') echo abc123 ;;
  'api repos/snomiao/playwright/compare/main...abc123 --jq .ahead_by') echo "$AHEAD" ;;
  'pr list '*) if [ "$EXISTING" = 1 ]; then echo 42; fi ;;
  'auth setup-git --hostname github.com'|'pr create '*) ;;
  *) exit 90 ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(dir, 'git'), `#!/bin/bash
echo "git $*" >> "$CALL_LOG"
if [[ "$*" == *' push '* && "$PUSH_FAILS" == 1 ]]; then exit 1; fi
`, { mode: 0o755 });
    const result = Bun.spawnSync(['bash', resolve(import.meta.dir, 'upstream-sync.sh'), 'playwright', ...(options.dry ? ['--dry-run'] : [])], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: 'test-only', CALL_LOG: log,
        AHEAD: String(options.ahead ?? 2), EXISTING: options.existing ? '1' : '0', PUSH_FAILS: options.pushFails ? '1' : '0' },
    });
    return { code: result.exitCode, calls: readFileSync(log, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('no upstream changes cause no writes', () => {
  const result = runSync({ ahead: 0 });
  expect(result.code).toBe(0);
  expect(result.calls).not.toContain('git ');
  expect(result.calls).not.toContain('pr create');
});
test('dry run only reads GitHub', () => {
  const result = runSync({ dry: true });
  expect(result.code).toBe(0);
  expect(result.calls).not.toContain('git ');
  expect(result.calls).not.toContain('pr create');
});
test('new upstream changes open a merge PR without touching main', () => {
  const result = runSync();
  expect(result.code).toBe(0);
  expect(result.calls).toContain('FETCH_HEAD:refs/heads/automation/official-upstream');
  expect(result.calls).toContain('pr create --repo snomiao/playwright --base main');
  expect(result.calls).not.toContain('--force');
  expect(result.calls).not.toContain('takusym');
});
test('existing PR is updated without a duplicate', () => {
  const result = runSync({ existing: true });
  expect(result.code).toBe(0);
  expect(result.calls).toContain(' push ');
  expect(result.calls).not.toContain('pr create');
});
test('rejected branch update stops without creating a PR', () => {
  const result = runSync({ pushFails: true });
  expect(result.code).not.toBe(0);
  expect(result.calls).not.toContain('pr create');
});
