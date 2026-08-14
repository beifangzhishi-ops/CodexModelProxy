// 压缩转发测试：仅使用内存中的 mock 上游，不调用真实 API。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyServer } from '../server.mjs';

const silentLogger = { info() {}, error() {}, warn() {} };

function startMockUpstream({ failModels = new Set() } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ url: req.url, auth: req.headers.authorization || '', body });
      if (failModels.has(body.model)) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock upstream unavailable' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'response.compaction',
        model: body.model,
        output: [{ type: 'compaction', encrypted_content: 'opaque-test-value' }],
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      seen,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

function startProxy(upstreamBaseUrl) {
  const config = {
    compact_fallback_model: 'flash-model',
    models: {
      'default-model': {
        upstream_base_url: upstreamBaseUrl,
        upstream_model: 'default-upstream',
        auth_mode: 'openai_passthrough',
      },
      'flash-model': {
        upstream_base_url: upstreamBaseUrl,
        upstream_model: 'deepseek-v4-flash',
        auth_mode: 'api_key',
        api_key_env: 'FLASH_API_KEY',
      },
    },
  };
  const server = createProxyServer({
    config,
    secrets: { FLASH_API_KEY: 'flash-test-key' },
    logger: silentLogger,
    env: {},
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

async function postCompact(proxyBaseUrl, model) {
  const response = await fetch(`${proxyBaseUrl}/v1/responses/compact`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer chatgpt-login-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, input: [{ role: 'user', content: '测试' }] }),
  });
  return { status: response.status, body: await response.json() };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function withProxy(mockOptions, fn) {
  const upstream = await startMockUpstream(mockOptions);
  const proxy = await startProxy(upstream.baseUrl);
  try {
    await fn(upstream, proxy);
  } finally {
    await closeServer(proxy.server);
    await closeServer(upstream.server);
  }
}

test('压缩请求优先使用请求中的默认模型', async () => {
  await withProxy({}, async (upstream, proxy) => {
    const result = await postCompact(proxy.baseUrl, 'default-model');

    assert.equal(result.status, 200);
    assert.equal(result.body.model, 'default-upstream');
    assert.equal(upstream.seen.length, 1);
    assert.equal(upstream.seen[0].url, '/responses/compact');
    assert.equal(upstream.seen[0].auth, 'Bearer chatgpt-login-token');
    assert.equal(upstream.seen[0].body.model, 'default-upstream');
  });
});

test('默认模型返回非 2xx 后改用 Flash', async () => {
  await withProxy({ failModels: new Set(['default-upstream']) }, async (upstream, proxy) => {
    const result = await postCompact(proxy.baseUrl, 'default-model');

    assert.equal(result.status, 200);
    assert.equal(result.body.model, 'deepseek-v4-flash');
    assert.equal(upstream.seen.length, 2);
    assert.deepEqual(upstream.seen.map((item) => item.body.model), [
      'default-upstream',
      'deepseek-v4-flash',
    ]);
    assert.equal(upstream.seen[1].auth, 'Bearer flash-test-key');
  });
});

test('请求本身已是 Flash 时失败后不重复请求', async () => {
  await withProxy({ failModels: new Set(['deepseek-v4-flash']) }, async (upstream, proxy) => {
    const result = await postCompact(proxy.baseUrl, 'flash-model');

    assert.equal(result.status, 503);
    assert.equal(upstream.seen.length, 1);
    assert.equal(upstream.seen[0].body.model, 'deepseek-v4-flash');
  });
});

test('未知压缩模型返回 400 且不访问上游', async () => {
  await withProxy({}, async (upstream, proxy) => {
    const result = await postCompact(proxy.baseUrl, 'unknown-model');

    assert.equal(result.status, 400);
    assert.match(result.body.error.message, /未知模型/);
    assert.equal(upstream.seen.length, 0);
  });
});
