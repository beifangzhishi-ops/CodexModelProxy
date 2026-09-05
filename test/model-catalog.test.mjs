import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveLegacyViews, visiblePublicSlugs } from '../model-catalog.mjs';
import { resolveModelSelection } from '../model-resolver.mjs';
import { createProviderRegistry } from '../provider-registry.mjs';

function createLegacyRegistry() {
  return createProviderRegistry({
    config: {
      models: {
        alpha: {
          provider_id: 'foo',
          upstream_base_url: 'https://example.test/v1',
          upstream_model: 'alpha',
          auth_mode: 'none',
          reasoning_format: 'passthrough',
          tool_output_format: 'passthrough',
        },
      },
    },
    localConfig: { providers: {} },
    env: {},
    secrets: {},
    validateCredentials: false,
  });
}

test('direct/* alias 保留请求解析能力但不进入公开模型目录', () => {
  const registry = createLegacyRegistry();

  assert.equal(registry.aliases.get('direct/alpha'), 'foo/alpha');
  assert.deepEqual(visiblePublicSlugs(registry), ['alpha']);

  const directSelection = resolveModelSelection('direct/alpha', registry);
  assert.equal(directSelection.ok, true);
  assert.equal(directSelection.canonicalModel, 'foo/alpha');
  assert.equal(directSelection.route.network, 'direct');

  const legacyViews = deriveLegacyViews(registry);
  assert.deepEqual(Object.keys(legacyViews.models), ['alpha']);
  assert.deepEqual(legacyViews.catalog.models.map((model) => model.slug), ['alpha']);
});
