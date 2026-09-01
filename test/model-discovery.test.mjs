import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  createModelDiscovery,
  normalizeDiscoveredModels,
  requestProviderModels,
} from '../model-discovery.mjs';

const silentLogger = { info() {}, error() {}, warn() {} };

function provider(overrides = {}) {
  return {
    id: 'foo',
    base_url: 'http://127.0.0.1:1/v1',
    api_key: 'foo-key',
    auth_mode: 'api_key',
    model_prefix: 'foo/',
    discovery: { cache_ttl_seconds: 60, failure_cooldown_seconds: 30, timeout_ms: 1000, max_response_bytes: 1024 },
    ...overrides,
  };
}

test('发现器兼容 data、models、数组响应并去重加命名空间', () => {
  const p = provider();
  assert.deepEqual(normalizeDiscoveredModels({ data: [
    { id: 'alpha', owned_by: 'upstream' },
    { id: 'foo/alpha' },
    { slug: 'beta' },
    { id: '' },
    null,
  ] }, p).map((model) => model.id), ['foo/alpha', 'foo/beta']);
  assert.deepEqual(normalizeDiscoveredModels({ models: ['gamma'] }, p)[0].upstream_model, 'gamma');
  assert.deepEqual(normalizeDiscoveredModels(['delta'], p)[0].id, 'foo/delta');
});

test('并发刷新合并为一次请求，成功缓存按 TTL 返回', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const discovery = createModelDiscovery({
    provider: provider({ cache_ttl_ms: 1000 }),
    logger: silentLogger,
    fetchModels: async () => {
      calls += 1;
      await gate;
      return { data: [{ id: 'alpha' }] };
    },
  });
  const first = discovery.getModels();
  const second = discovery.getModels();
  release();
  const [firstModels, secondModels] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(firstModels, secondModels);
  assert.equal((await discovery.getModels())[0].id, 'foo/alpha');
  assert.equal(calls, 1);
});

test('刷新失败时返回 stale cache，并在 failure cooldown 内不重复请求', async () => {
  let calls = 0;
  const discovery = createModelDiscovery({
    provider: provider({ cache_ttl_ms: 1, failure_cooldown_ms: 50 }),
    logger: silentLogger,
    fetchModels: async () => {
      calls += 1;
      if (calls === 1) return { data: [{ id: 'cached' }] };
      throw new Error('暂时不可用');
    },
  });
  assert.deepEqual((await discovery.getModels()).map((model) => model.id), ['foo/cached']);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual((await discovery.getModels()).map((model) => model.id), ['foo/cached']);
  assert.deepEqual((await discovery.getModels()).map((model) => model.id), ['foo/cached']);
  assert.equal(calls, 2);
  assert.equal(discovery.getState().cachedCount, 1);
});

test('首次发现失败返回空列表并在冷却期内复用空缓存', async () => {
  let calls = 0;
  const discovery = createModelDiscovery({
    provider: provider({ failure_cooldown_ms: 50 }),
    logger: silentLogger,
    fetchModels: async () => {
      calls += 1;
      throw new Error('offline');
    },
  });
  assert.deepEqual(await discovery.getModels(), []);
  assert.deepEqual(await discovery.getModels(), []);
  assert.equal(calls, 1);
});

async function startModelsServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

test('真实通用 /models 请求只携带对应 Provider key', async () => {
  const seen = [];
  const mock = await startModelsServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ id: 'alpha' }] }));
  });
  try {
    const result = await requestProviderModels(provider({ base_url: mock.baseUrl }), { url: '', mode: 'direct' });
    assert.deepEqual(result, { models: [{ id: 'alpha' }] });
    assert.deepEqual(seen, [{ url: '/v1/models', authorization: 'Bearer foo-key' }]);
  } finally {
    await closeServer(mock.server);
  }
});

test('模型发现超时和超大响应都返回失败', async () => {
  const hanging = await startModelsServer((_req, _res) => {});
  try {
    await assert.rejects(
      requestProviderModels(provider({
        base_url: hanging.baseUrl,
        discovery: { timeout_ms: 25, max_response_bytes: 1024 },
      })),
      /请求超时/,
    );
  } finally {
    await closeServer(hanging.server);
  }

  const oversized = await startModelsServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"models":["1234567890"]}');
  });
  try {
    await assert.rejects(
      requestProviderModels(provider({
        base_url: oversized.baseUrl,
        discovery: { timeout_ms: 1000, max_response_bytes: 5 },
      })),
      /响应过大/,
    );
  } finally {
    await closeServer(oversized.server);
  }
});
