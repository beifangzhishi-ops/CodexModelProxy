import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncModelSelection } from '../model-selection.mjs';
import { sendModelList } from '../model-catalog.mjs';
import { createProviderRegistry } from '../provider-registry.mjs';
import { resolveModelSelection } from '../model-resolver.mjs';

const logger = { info() {}, warn() {}, error() {} };

async function withSelectionFile(fn) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '.selection-check-');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  try { return await fn(path.join(dir, 'models.txt')); }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmdirSync(root);
  }
}

function ids(...names) { return names.map((id) => ({ id })); }

test('new file lists discovered IDs and selects one ordinary DS and one Kimi Coding model', async () => {
  await withSelectionFile((file) => {
    const discovered = ids(
      'ds/deepseek-flash', 'ds/deepseek-v4-pro',
      'kimi/kimi-k2.7-code-highspeed', 'kimi/kimi-k2.7-code', 'oc/other',
    );
    const selected = syncModelSelection(file, discovered, logger);
    assert.deepEqual([...selected], ['ds/deepseek-flash', 'kimi/kimi-k2.7-code']);
    const content = fs.readFileSync(file, 'utf8');
    assert.match(content, /\* ds\/deepseek-flash/);
    assert.match(content, /\* kimi\/kimi-k2\.7-code\n/);
    assert.match(content, /  oc\/other\n/);
    assert.equal([...content.matchAll(/ds\/deepseek-flash/g)].length, 1);
  });
});

test('manually selected stars survive refresh, new IDs append without overwriting edits', async () => {
  await withSelectionFile((file) => {
    syncModelSelection(file, ids('ds/first', 'kimi/old'), logger);
    fs.writeFileSync(file, [
      '# 我自己保留的说明', '* kimi/old', '  ds/first', '',
    ].join('\n'));
    const selected = syncModelSelection(file, ids('ds/first', 'kimi/old', 'kimi/new'), logger);
    assert.deepEqual([...selected], ['kimi/old']);
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.startsWith('# 我自己保留的说明\n* kimi/old\n  ds/first\n'));
    assert.ok(after.endsWith('  kimi/new\n'));
    syncModelSelection(file, ids('ds/first', 'kimi/old', 'kimi/new'), logger);
    assert.equal(fs.readFileSync(file, 'utf8'), after);
  });
});

test('when selected model is not discovered, fallback avoids an empty picker', async () => {
  await withSelectionFile((file) => {
    fs.writeFileSync(file, '* kimi/unavailable\n');
    assert.deepEqual([...syncModelSelection(file, ids('ds/new'), logger)], ['ds/new']);
    assert.match(fs.readFileSync(file, 'utf8'), /\* kimi\/unavailable/);
  });
});

test('discovery and model picker share a selection, hidden models stay routable', async () => {
  await withSelectionFile(async (file) => {
    fs.writeFileSync(file, '* ds/selected\n  ds/hidden\n');
    const registry = createProviderRegistry({
      config: { providers: { ds: {
        enabled: true, base_url: 'http://127.0.0.1:1/v1',
        api_key: 'test-key', auth_mode: 'api_key', protocol: 'responses',
        discover_models: true, model_prefix: 'ds/',
        compat_profile: 'passthrough', metadata_profile: 'generic',
      } } },
      localConfig: { providers: {} }, logger,
      discoveryFetchModels: async () => ({ data: [{ id: 'selected' }, { id: 'hidden' }] }),
    });
    let output;
    await sendModelList({}, registry, (_, status, body) => {
      assert.equal(status, 200); output = body;
    }, {}, file);
    assert.deepEqual(output.data.map((model) => model.id), ['ds/selected']);
    assert.deepEqual(output.models.map((model) => model.slug), ['ds/selected']);
    assert.equal(resolveModelSelection('ds/hidden', registry).ok, true);
  });
});
