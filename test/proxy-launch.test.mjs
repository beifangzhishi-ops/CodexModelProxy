import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.dirname(fileURLToPath(import.meta.url));

test('headless CMP launcher starts a detached Node process without PowerShell COM', async (t) => {
  // Tests can run inside CCM's workspace-only sandbox, where system TEMP is
  // deliberately not writable.
  const dir = await mkdtemp(path.join(root, '..', '.cmp-launch-'));
  const marker = path.join(dir, 'child.pid');
  let childPid;
  try {
    await copyFile(path.join(root, '..', 'proxy-launch.mjs'), path.join(dir, 'proxy-launch.mjs'));
    await writeFile(path.join(dir, 'server.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(new URL('./child.pid', import.meta.url), String(process.pid));",
      'setInterval(() => {}, 1000);',
    ].join('\n'));

    let launcher;
    try {
      launcher = spawn(process.execPath, [path.join(dir, 'proxy-launch.mjs')], {
        cwd: dir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      if (error.code === 'EPERM') {
        t.skip('This test requires permission to spawn processes outside a restricted test sandbox');
        return;
      }
      throw error;
    }
    let stdout = '';
    let stderr = '';
    launcher.stdout.on('data', chunk => { stdout += chunk.toString(); });
    launcher.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const timer = setTimeout(() => launcher.kill(), 8000);
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        launcher.once('error', reject);
        launcher.once('close', (code, signal) => resolve({ code, signal }));
      });
    } catch (error) {
      if (error.code === 'EPERM') {
        t.skip('This test requires permission to spawn processes outside a restricted test sandbox');
        return;
      }
      throw error;
    }
    clearTimeout(timer);
    assert.equal(result.code, 0, `${stderr} (signal=${result.signal})`);
    assert.match(stdout, /Spawned CMP process \d+/);
    for (let i = 0; i < 35 && !existsSync(marker); i += 1) await delay(100);
    assert.ok(existsSync(marker), 'detached child should stay alive after launcher exits');
    childPid = Number(await readFile(marker, 'utf8'));
    assert.ok(Number.isInteger(childPid) && childPid > 0);
  } finally {
    if (!childPid && existsSync(marker)) {
      childPid = Number(await readFile(marker, 'utf8'));
    }
    if (childPid) {
      try { process.kill(childPid); } catch { /* Already exited. */ }
    }
    await delay(100);
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
