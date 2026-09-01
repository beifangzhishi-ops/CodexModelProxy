// Responses compact 转发测试：当前模型失败时只保留一次上游请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyServer } from '../server.mjs';

const silentLogger = { info() {}, error() {}, warn() {} };

function startMockUpstream({ status = 200, statusByModel = {}, hangModels = new Set(), networkErrorModels = new Set() } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ url: req.url, auth: req.headers.authorization || '', body });
      if (networkErrorModels.has(body.model)) {
        req.socket.destroy();
        return;
      }
      if (hangModels.has(body.model)) return;
      const currentStatus = statusByModel[body.model] ?? status;
      if (currentStatus >= 400) {
        res.writeHead(currentStatus, {
          'content-type': 'application/json',
          'x-compact-upstream': 'error-preserved',
        });
        res.end(JSON.stringify({ error: { type: 'compact_test_error', message: `status ${currentStatus}` } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'response.compaction',
        model: body.model,
        output: [{ type: 'compaction', encrypted_content: 'compact-test-value' }],
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

function startProxy(upstreamBaseUrl, {
  secrets = { DEEPSEEK_API_KEY: 'deepseek-test-key', CPA_API_KEY: 'cpa-test-key' },
  env = {},
  logger = silentLogger,
  upstreamTimeoutMs,
} = {}) {
  const server = createProxyServer({
    config: {
      models: {
        'gpt-model': {
          upstream_base_url: upstreamBaseUrl,
          upstream_model: 'gpt-upstream',
          auth_mode: 'openai_passthrough',
          reasoning_format: 'openai_encrypted',
          tool_output_format: 'passthrough',
        },
        'deepseek-model': {
          upstream_base_url: upstreamBaseUrl,
          upstream_model: 'deepseek-upstream',
          auth_mode: 'api_key',
          api_key_env: 'DEEPSEEK_API_KEY',
          reasoning_format: 'deepseek_plaintext',
          tool_output_format: 'json_string',
          ...(upstreamTimeoutMs ? { upstream_timeout_ms: upstreamTimeoutMs } : {}),
        },
      },
    },
    secrets,
    env: { ...env, CPA_BASE_URL: env.CPA_BASE_URL || upstreamBaseUrl },
    logger,
    systemProxyResolver: async () => ({ url: '', mode: 'direct' }),
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

async function postCompact(baseUrl, model, input = [{ role: 'user', content: '测试' }], headers = {}) {
  const response = await fetch(`${baseUrl}/v1/responses/compact`, {
    method: 'POST',
    headers: { authorization: 'Bearer caller-token', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model, input }),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function withServers(mockOptions, proxyOptions, fn) {
  const upstream = await startMockUpstream(mockOptions);
  const proxy = await startProxy(upstream.baseUrl, proxyOptions);
  try {
    await fn(upstream, proxy);
  } finally {
    await closeServer(proxy.server);
    await closeServer(upstream.server);
  }
}

test('GPT compact 失败只请求当前模型一次', async () => {
  await withServers({ statusByModel: { 'gpt-upstream': 503 } }, {}, async (upstream, proxy) => {
    const result = await postCompact(proxy.baseUrl, 'gpt-model');
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('x-compact-upstream'), 'error-preserved');
    assert.equal(upstream.seen.length, 1);
    assert.deepEqual(upstream.seen.map((request) => request.body.model), ['gpt-upstream']);
    assert.equal(upstream.seen[0].auth, 'Bearer caller-token');
  });
});

test('DeepSeek compact 失败只请求当前模型一次', async () => {
  await withServers({ statusByModel: { 'deepseek-upstream': 503 } }, {}, async (upstream, proxy) => {
    const result = await postCompact(proxy.baseUrl, 'deepseek-model');
    assert.equal(result.status, 503);
    assert.equal(upstream.seen.length, 1);
    assert.deepEqual(upstream.seen.map((request) => request.body.model), ['deepseek-upstream']);
    assert.equal(upstream.seen[0].auth, 'Bearer deepseek-test-key');
  });
});

test('CPA compact 失败只请求当前模型一次并使用 Provider key', async () => {
  await withServers({ statusByModel: { 'cpa-model': 503 } }, {}, async (upstream, proxy) => {
    const result = await postCompact(proxy.baseUrl, 'cpa/cpa-model', [{ role: 'user', content: '测试' }], {
      'chatgpt-account-id': 'caller-account',
      cookie: 'caller-cookie',
      'x-api-key': 'caller-api-key',
    });
    assert.equal(result.status, 503);
    assert.equal(upstream.seen.length, 1);
    assert.deepEqual(upstream.seen.map((request) => request.body.model), ['cpa-model']);
    assert.equal(upstream.seen[0].auth, 'Bearer cpa-test-key');
  });
});

test('400、401、429 和 5xx compact 失败都不会触发第二个模型', async () => {
  for (const status of [400, 401, 429, 500, 503]) {
    await withServers({ status }, {}, async (upstream, proxy) => {
      const result = await postCompact(proxy.baseUrl, 'deepseek-model');
      assert.equal(result.status, status);
      assert.equal(upstream.seen.length, 1, `status=${status} 应只有一次请求`);
      assert.equal(upstream.seen[0].body.model, 'deepseek-upstream');
    });
  }
});

test('compact timeout 直接返回错误且不触发第二个模型', async () => {
  const upstream = await startMockUpstream({ hangModels: new Set(['deepseek-upstream']) });
  const proxy = await startProxy(upstream.baseUrl, { upstreamTimeoutMs: 25 });
  try {
    const result = await postCompact(proxy.baseUrl, 'deepseek-model');
    assert.equal(result.status, 502);
    assert.match(result.body.error.message, /上游压缩请求失败/);
    assert.equal(upstream.seen.length, 1);
    assert.equal(upstream.seen[0].body.model, 'deepseek-upstream');
  } finally {
    await closeServer(proxy.server);
    await closeServer(upstream.server);
  }
});

test('compact 网络错误直接返回且不触发第二个模型', async () => {
  await withServers({ networkErrorModels: new Set(['deepseek-upstream']) }, {}, async (upstream, proxy) => {
    const result = await postCompact(proxy.baseUrl, 'deepseek-model');
    assert.equal(result.status, 502);
    assert.match(result.body.error.message, /上游压缩请求失败/);
    assert.equal(upstream.seen.length, 1);
    assert.equal(upstream.seen[0].body.model, 'deepseek-upstream');
  });
});

test('compact 仍按当前 Provider 做 history normalization', async () => {
  const encryptedReasoning = {
    type: 'reasoning',
    encrypted_content: 'opaque-gpt',
    content: [],
  };
  const objectOutput = { width: 80, height: 60 };
  await withServers({}, {}, async (upstream, proxy) => {
    const result = await postCompact(proxy.baseUrl, 'deepseek-model', [
      encryptedReasoning,
      { type: 'function_call_output', call_id: 'call-image', output: objectOutput },
    ]);
    assert.equal(result.status, 200);
    assert.equal(upstream.seen.length, 1);
    assert.deepEqual(upstream.seen[0].body.input, [
      { ...encryptedReasoning, encrypted_content: null },
      { type: 'function_call_output', call_id: 'call-image', output: JSON.stringify(objectOutput) },
    ]);
  });
});

test('CPA compact 动态模型按模型名应用对应 history normalization', async () => {
  const dsReasoning = {
    type: 'reasoning',
    content: [{ type: 'reasoning_text', text: 'ds-thought' }],
    encrypted_content: null,
  };
  const gptReasoning = {
    type: 'reasoning',
    content: [],
    encrypted_content: 'opaque-gpt',
  };
  await withServers({}, {}, async (upstream, proxy) => {
    const gpt = await postCompact(proxy.baseUrl, 'cpa/gpt-current', [dsReasoning]);
    const deepseek = await postCompact(proxy.baseUrl, 'cpa/deepseek-current', [gptReasoning]);
    assert.equal(gpt.status, 200);
    assert.equal(deepseek.status, 200);
    assert.deepEqual(upstream.seen.map((request) => request.body.model), [
      'gpt-current',
      'deepseek-current',
    ]);
    assert.deepEqual(upstream.seen[0].body.input, [{ ...dsReasoning, content: [] }]);
    assert.deepEqual(upstream.seen[1].body.input, [{ ...gptReasoning, encrypted_content: null }]);
  });
});
