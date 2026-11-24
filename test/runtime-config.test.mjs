import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../runtime-config.mjs';
import { createProviderRegistry } from '../provider-registry.mjs';
import { sendModelList } from '../model-catalog.mjs';
import { resolveModelSelection } from '../model-resolver.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('single file controls metadata and route overrides without pinning inventory or rewriting local files', async () => {
  const dir = fs.mkdtempSync(path.join(root, '.cmp-config-test-'));
  const configFile = path.join(dir, 'proxy-config.json');
  const overridesFile = path.join(dir, 'model-overrides.json');
  const config = { providers: { fixture: {
    base_url: 'https://fixture.example/v1', auth_mode: 'none', model_prefix: 'fx/',
    metadata_profile: 'generic',
  } } };
  const rules = { providers: { fixture: {
    '*': { network: 'direct', metadata: { use_responses_lite: false } },
    'demo-*': { timeout_ms: 4000, metadata: { supports_parallel_tool_calls: false } },
    'demo-one': { compat_profile: 'openai', metadata: { tool_mode: null } },
  } } };
  try {
    fs.writeFileSync(configFile, JSON.stringify(config));
    assert.equal(loadConfig(configFile).providers.fixture.model_overrides, undefined);
    fs.writeFileSync(overridesFile, '  ');
    assert.equal(loadConfig(configFile).providers.fixture.model_overrides, undefined);
    fs.writeFileSync(overridesFile, '{}');
    assert.equal(loadConfig(configFile).providers.fixture.model_overrides, undefined);
    const before = JSON.stringify(rules);
    fs.writeFileSync(overridesFile, before);
    const registry = createProviderRegistry({
      config: loadConfig(configFile), env: {}, validateCredentials: false,
      discoveryFetchModels: async () => ({ data: [{ id: 'demo-one', context_window: 200000, use_responses_lite: true, tool_mode: 'upstream' }] }),
    });
    let payload;
    await sendModelList({}, registry, (_, status, body) => { assert.equal(status, 200); payload = body; });
    const model = payload.models.find(m => m.slug === 'fx/demo-one');
    assert.equal(model.context_window, 200000);
    assert.equal(model.use_responses_lite, false);
    assert.equal(model.supports_parallel_tool_calls, false);
    assert.equal(model.tool_mode, null);
    const route = resolveModelSelection('fx/demo-one', registry).route;
    assert.equal(route.network, 'direct');
    assert.equal(route.timeout_ms, 4000);
    assert.equal(route.compat_profile, 'openai');
    assert.equal(fs.readFileSync(overridesFile, 'utf8'), before);
    assert.equal(fs.readFileSync(configFile, 'utf8'), JSON.stringify(config));
    fs.writeFileSync(configFile, JSON.stringify({ providers: { fixture: { ...config.providers.fixture, model_overrides: {} } } }));
    assert.throws(() => loadConfig(configFile), /Obsolete provider field/);
    fs.writeFileSync(configFile, JSON.stringify({ providers: { fixture: { ...config.providers.fixture, models: { 'demo-one': { metadata: {} } } } } }));
    assert.throws(() => loadConfig(configFile), /Static models must contain names only/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
