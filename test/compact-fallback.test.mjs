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

function startProxy(upstreamBaseUrl, { env = {}, logger = silentLogger } = {}) {
  const config = {
    compact_fallback_model: 'flash-model',
    models: {
      'default-model': {
        upstream_base_url: upstreamBaseUrl,
        upstream_model: 'default-upstream',
        auth_mode: 'openai_passthrough',
        reasoning_format: 'openai_encrypted',
        tool_output_format: 'passthrough',
      },
      'flash-model': {
        upstream_base_url: upstreamBaseUrl,
        upstream_model: 'deepseek-v4-flash',
        auth_mode: 'api_key',
        api_key_env: 'FLASH_API_KEY',
        reasoning_format: 'deepseek_plaintext',
        tool_output_format: 'json_string',
      },
    },
  };
  const server = createProxyServer({
    config,
    secrets: { FLASH_API_KEY: 'flash-test-key' },
    logger,
    env,
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

async function postCompact(proxyBaseUrl, model, input = [{ role: 'user', content: '测试' }]) {
  const response = await fetch(`${proxyBaseUrl}/v1/responses/compact`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer chatgpt-login-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, input }),
  });
  return { status: response.status, body: await response.json() };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function withProxy(mockOptions, fn, proxyOptions = {}) {
  const upstream = await startMockUpstream(mockOptions);
  const proxy = await startProxy(upstream.baseUrl, proxyOptions);
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

test('压缩请求首次和备用请求分别选择网络路径', async () => {
  const logs = [];
  const logger = {
    info: (message) => logs.push(message),
    error: (message) => logs.push(message),
    warn: (message) => logs.push(message),
  };
  await withProxy(
    { failModels: new Set(['default-upstream']) },
    async (upstream, proxy) => {
      const result = await postCompact(proxy.baseUrl, 'default-model');
      assert.equal(result.status, 200);
      assert.ok(logs.some((message) => message.includes('model=default-model network=proxy')));
      assert.ok(logs.some((message) => message.includes('model=flash-model network=direct')));
      assert.equal(upstream.seen.length, 2);
    },
    {
      env: {
        PROXY_URL: 'http://127.0.0.1:7890',
        DIRECT_MODELS: ' flash-model ',
      },
      logger,
    },
  );
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

test('压缩首次请求按 GPT 格式整理，后备请求从原始历史按 DS 格式重新整理', async () => {
  const dsReasoning = {
    type: 'reasoning',
    content: [{ type: 'reasoning_text', text: 'ds-thought' }],
    encrypted_content: null,
  };
  const gptReasoning = {
    type: 'reasoning',
    encrypted_content: 'opaque-gpt',
    content: [],
  };
  const message = {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '测试' }],
  };
  const dsWebSearch = {
    type: 'web_search_call',
    id: 'call_00_test',
    status: 'completed',
  };
  const gptWebSearch = {
    type: 'web_search_call',
    id: 'ws_test',
    status: 'completed',
  };
  const imageOutput = [{
    type: 'image',
    image_url: 'data:image/png;base64,compact-fixture',
    detail: 'original',
  }];
  const objectOutput = { width: 80, height: 60 };
  await withProxy({ failModels: new Set(['default-upstream']) }, async (upstream, proxy) => {
    const result = await postCompact(proxy.baseUrl, 'default-model', [
      dsReasoning,
      gptReasoning,
      dsWebSearch,
      gptWebSearch,
      { type: 'function_call', id: 'fc_view', call_id: 'call_view', name: 'view_image', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_view', output: imageOutput },
      { type: 'custom_tool_call_output', call_id: 'call_object', output: objectOutput },
      message,
    ]);

    assert.equal(result.status, 200);
    assert.equal(upstream.seen.length, 2);
    assert.deepEqual(upstream.seen[0].body.input, [
      { ...dsReasoning, content: [] },
      gptReasoning,
      gptWebSearch,
      { type: 'function_call', id: 'fc_view', call_id: 'call_view', name: 'view_image', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_view', output: imageOutput },
      { type: 'custom_tool_call_output', call_id: 'call_object', output: objectOutput },
      message,
    ]);
    assert.deepEqual(upstream.seen[1].body.input, [
      dsReasoning,
      { ...gptReasoning, encrypted_content: null },
      dsWebSearch,
      gptWebSearch,
      { type: 'function_call', id: 'fc_view', call_id: 'call_view', name: 'view_image', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_view', output: JSON.stringify(imageOutput) },
      { type: 'custom_tool_call_output', call_id: 'call_object', output: JSON.stringify(objectOutput) },
      message,
    ]);
  });
});
