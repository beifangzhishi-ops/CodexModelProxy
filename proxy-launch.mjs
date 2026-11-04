// Spawn CMP without COM or PowerShell, so headless CCM maintenance can restart
// the local server even when PowerShell is running in ConstrainedLanguage mode.
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = openSync(path.join(root, 'proxy.log'), 'a');
const err = openSync(path.join(root, 'proxy.err.log'), 'a');

try {
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
  });
  child.once('error', (error) => {
    console.error(`[codex-proxy] Unable to spawn CMP: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('spawn', () => {
    console.log(`[codex-proxy] Spawned CMP process ${child.pid}`);
    child.unref();
  });
} finally {
  closeSync(out);
  closeSync(err);
}
