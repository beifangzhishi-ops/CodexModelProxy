import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCpaModelCatalog,
  loadCpaConfig,
  normalizeCpaModels,
} from '../cpa-provider.mjs';

test('CPA 配置支持关闭、完整启用，并拒绝缺项与无效 TTL', () => {
  assert.deepEqual(loadCpaConfig({}, {}), { enabled: false });

  const enabled = loadCpaConfig(
    { CPA_BASE_URL: 'http://127.0.0.1:8317/v1/', CPA_MODELS_CACHE_TTL_SECONDS: '90' },
    { CPA_API_KEY: 'secret-key' },
  );
  assert.deepEqual(enabled, {
    enabled: true,
    baseUrl: 'http://127.0.0.1:8317/v1',
    apiKey: 'secret-key',
    cacheTtlMs: 90000,
  });

  assert.throws(
    () => loadCpaConfig({ CPA_BASE_URL: 'http://127.0.0.1:8317/v1' }, {}),
    /缺少 CPA_API_KEY/,
  );
  assert.throws(
    () => loadCpaConfig({ CPA_API_KEY: 'secret-key' }, {}),
    /缺少 CPA_BASE_URL/,
  );
  assert.throws(
    () => loadCpaConfig({
      CPA_BASE_URL: 'http://127.0.0.1:8317/v1',
      CPA_API_KEY: 'secret-key',
      CPA_MODELS_CACHE_TTL_SECONDS: '0',
    }, {}),
    /必须是正整数/,
  );
});

test('CPA 模型规范化会加命名空间、保留元数据并去重', () => {
  assert.deepEqual(normalizeCpaModels([
    { id: 'gpt-one', object: 'model', owned_by: 'upstream', created: 123 },
    { id: 'gpt-one' },
    'claude-two',
    { id: '' },
    null,
  ]), [
    { id: 'cpa/gpt-one', object: 'model', owned_by: 'upstream', created: 123 },
    { id: 'cpa/claude-two', object: 'model', owned_by: 'cpa' },
  ]);
});

test('CPA 模型缓存合并并发刷新，刷新失败时保留最近成功结果', async () => {
  let calls = 0;
  let proxyCalls = 0;
  const warnings = [];
  const expectedProxy = { url: 'http://127.0.0.1:7890', mode: 'fixed-proxy' };
  const catalog = createCpaModelCatalog({
    config: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'secret-key',
      cacheTtlMs: 1,
    },
    logger: { warn: (message) => warnings.push(message) },
    async resolveProxy() {
      proxyCalls += 1;
      return expectedProxy;
    },
    async fetchModels(config, proxy) {
      calls += 1;
      assert.equal(config.apiKey, 'secret-key');
      assert.deepEqual(proxy, expectedProxy);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (calls > 1) throw new Error('temporary failure');
      return [{ id: 'gpt-one' }];
    },
  });

  const concurrent = await Promise.all([
    catalog.getModels(),
    catalog.getModels(),
    catalog.getModels(),
  ]);
  assert.equal(calls, 1);
  assert.equal(proxyCalls, 1);
  assert.ok(concurrent.every((models) => models[0].id === 'cpa/gpt-one'));

  await new Promise((resolve) => setTimeout(resolve, 5));
  const stale = await catalog.getModels();
  assert.equal(calls, 2);
  assert.equal(proxyCalls, 2);
  assert.deepEqual(stale.map((model) => model.id), ['cpa/gpt-one']);
  assert.ok(warnings.some((message) => message.includes('使用最近缓存')));
});

test('CPA 首次模型同步失败时返回空列表', async () => {
  const catalog = createCpaModelCatalog({
    config: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'secret-key',
      cacheTtlMs: 60000,
    },
    logger: { warn() {} },
    async fetchModels() {
      throw new Error('unavailable');
    },
  });
  assert.deepEqual(await catalog.getModels(), []);
});
