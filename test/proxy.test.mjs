// 自动测试：使用内存中的 mock 上游，不调用真实 API，也不消耗任何额度。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyServer } from '../server.mjs';

const silentLogger = { info() {}, error() {}, warn() {} };

function testRoutes(mockBaseUrl) {
  return {
    'gpt-5.6-luna': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'gpt-5.6-luna',
      api_key_env: 'OPENCODE_API_KEY',
    },
    'gpt-5.6-terra': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'deepseek-v4-flash',
      api_key_env: 'DEEPSEEK_API_KEY',
    },
    'gpt-5.6-sol': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'deepseek-v4-flash',
      api_key_env: 'OPENCODE_API_KEY',
    },
  };
}

function testSecrets() {
  return { OPENCODE_API_KEY: 'test-open-key', DEEPSEEK_API_KEY: 'test-deep-key' };
}

function startMockUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ url: req.url, auth: req.headers.authorization || '', body });
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"type":"response.output_text.delta","delta":"你"}\n\n');
        setTimeout(() => {
          res.write('data: {"type":"response.completed"}\n\n');
          res.end();
        }, 20);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'resp_test', object: 'response', model: body.model, output: [] }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        seen,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

function startProxy(config, secrets) {
  const server = createProxyServer({ config, secrets, logger: silentLogger });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function postJson(baseUrl, pathname, body) {
  const res = await fetch(baseUrl + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

async function withServers(fn) {
  const mock = await startMockUpstream();
  const proxy = await startProxy(
    { host: '127.0.0.1', port: 0, models: testRoutes(mock.baseUrl) },
    testSecrets(),
  );
  try {
    await fn(mock, proxy);
  } finally {
    await new Promise((r) => proxy.server.close(r));
    await new Promise((r) => mock.server.close(r));
  }
}

test('健康检查与模型列表', async () => {
  await withServers(async (mock, proxy) => {
    const health = await fetch(`${proxy.baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const modelsRes = await fetch(`${proxy.baseUrl}/v1/models`);
    assert.equal(modelsRes.status, 200);
    const modelsJson = await modelsRes.json();
    assert.deepEqual(
      modelsJson.data.map((m) => m.id).sort(),
      ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'],
    );
  });
});

test('Luna、Terra 与 Sol 各自转发到正确上游且不串路由', async () => {
  await withServers(async (mock, proxy) => {
    const r1 = await postJson(proxy.baseUrl, '/v1/responses', { model: 'gpt-5.6-luna', input: '你好' });
    assert.equal(r1.status, 200);
    const r2 = await postJson(proxy.baseUrl, '/v1/responses', { model: 'gpt-5.6-sol', input: '你好' });
    assert.equal(r2.status, 200);
    const r3 = await postJson(proxy.baseUrl, '/v1/responses', { model: 'gpt-5.6-terra', input: '你好' });
    assert.equal(r3.status, 200);

    assert.equal(mock.seen.length, 3);
    assert.equal(mock.seen[0].url, '/responses');
    assert.equal(mock.seen[0].auth, 'Bearer test-open-key');
    assert.equal(mock.seen[0].body.model, 'gpt-5.6-luna');
    assert.equal(mock.seen[1].url, '/responses');
    assert.equal(mock.seen[1].auth, 'Bearer test-open-key');
    assert.equal(mock.seen[1].body.model, 'deepseek-v4-flash');
    assert.equal(mock.seen[2].url, '/responses');
    assert.equal(mock.seen[2].auth, 'Bearer test-deep-key');
    assert.equal(mock.seen[2].body.model, 'deepseek-v4-flash');
  });
});

test('未知模型返回 4xx 且不访问上游', async () => {
  await withServers(async (mock, proxy) => {
    const r = await postJson(proxy.baseUrl, '/v1/responses', { model: 'unknown-model', input: '你好' });
    assert.equal(r.status, 400);
    assert.match(r.text, /未知模型/);
    assert.equal(mock.seen.length, 0);
  });
});

test('SSE 流式响应原样透传', async () => {
  await withServers(async (mock, proxy) => {
    const res = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-luna', stream: true, input: '你好' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^text\/event-stream/);
    const text = await res.text();
    assert.match(text, /response.output_text.delta/);
    assert.match(text, /response.completed/);
    assert.equal(mock.seen.length, 1);
  });
});
