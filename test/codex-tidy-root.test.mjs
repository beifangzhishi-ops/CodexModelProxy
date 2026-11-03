import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('Codex root cleanup only selects known stale files', (t) => {
  const result = spawnSync('python', ['codex-switch/test_tidy_root.py'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (['ENOENT', 'EPERM', 'EACCES', 'EAGAIN'].includes(result.error?.code)) {
    t.skip('Python subprocess unavailable within this test worker');
    return;
  }
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
