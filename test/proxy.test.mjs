// 自动测试：使用内存中的 mock 上游，不调用真实 API，也不消耗任何额度。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyServer, loadConfig, loadSecrets } from '../server.mjs';

const MODEL_SLUGS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash-direct',
  'deepseek-v4-pro-direct',
];

const silentLogger = { info() {}, error() {}, warn() {} };

function testRoutes(mockBaseUrl) {
  return {
    'gpt-5.6-sol': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'gpt-5.6-sol',
      auth_mode: 'openai_passthrough',
    },
    'gpt-5.6-terra': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'gpt-5.6-terra',
      auth_mode: 'openai_passthrough',
    },
    'gpt-5.6-luna': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'gpt-5.6-luna',
      auth_mode: 'openai_passthrough',
    },
    'deepseek-v4-flash': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'deepseek-v4-flash',
      auth_mode: 'api_key',
      api_key_env: 'OPENCODE_API_KEY',
    },
    'deepseek-v4-pro': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'deepseek-v4-pro',
      auth_mode: 'api_key',
      api_key_env: 'OPENCODE_API_KEY',
    },
    'deepseek-v4-flash-direct': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'deepseek-v4-flash',
      auth_mode: 'api_key',
      api_key_env: 'DEEPSEEK_API_KEY',
    },
    'deepseek-v4-pro-direct': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'deepseek-v4-pro',
      auth_mode: 'api_key',
      api_key_env: 'DEEPSEEK_API_KEY',
    },
  };
}

function testCatalog() {
  return {
    models: MODEL_SLUGS.map((slug) => ({
      slug,
      display_name: slug,
      input_modalities: ['text', 'image'],
      supports_image_detail_original: true,
    })),
  };
}

function testSecrets() {
  return { OPENCODE_API_KEY: 'test-open-key', DEEPSEEK_API_KEY: 'test-deep-key' };
}

function startMockUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const body = rawBody ? JSON.parse(rawBody) : {};
      seen.push({
        url: req.url,
        auth: req.headers.authorization || '',
        proxyAccessToken: req.headers['x-proxy-access-token'] || '',
        accountId: req.headers['chatgpt-account-id'] || '',
        body,
        rawBody,
      });
      if (body.trigger_error) {
        res.writeHead(503, { 'content-type': 'application/json', 'x-upstream-marker': 'error-preserved' });
        res.end('{"error":{"type":"upstream_test_error","message":"preserve me"}}');
        return;
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream-marker': 'sse-preserved' });
        res.write('data: {"type":"response.output_text.delta","delta":"hello"}\n\n');
        setTimeout(() => {
          res.write('data: {"type":"response.completed"}\n\n');
          res.end();
        }, 10);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream-marker': 'json-preserved' });
      res.end(JSON.stringify({ id: 'resp_test', object: 'response', model: body.model, output: [] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        seen,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

function startProxy(config, secrets, env = {}, logger = silentLogger) {
  const server = createProxyServer({ config, secrets, logger, env });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function postJson(baseUrl, body, headers = {}) {
  const res = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

async function closeServers(...servers) {
  for (const server of servers) {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withServers(fn, { secrets = testSecrets(), env = {}, logger = silentLogger } = {}) {
  const mock = await startMockUpstream();
  const proxy = await startProxy(
    { host: '127.0.0.1', port: 0, models: testRoutes(mock.baseUrl), catalog: testCatalog() },
    secrets,
    env,
    logger,
  );
  try {
    await fn(mock, proxy, logger);
  } finally {
    await closeServers(proxy.server, mock.server);
  }
}

test('健康检查与模型列表包含七个目录项，并声明图片输入', async () => {
  await withServers(async (mock, proxy) => {
    const health = await fetch(`${proxy.baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const modelsRes = await fetch(`${proxy.baseUrl}/v1/models`);
    assert.equal(modelsRes.status, 200);
    const modelsJson = await modelsRes.json();
    assert.deepEqual(modelsJson.data.map((model) => model.id), MODEL_SLUGS);
    assert.deepEqual(modelsJson.models.map((model) => model.slug), MODEL_SLUGS);
    assert.ok(modelsJson.models.every((model) => model.input_modalities.includes('image')));
    assert.ok(modelsJson.models.every((model) => model.supports_image_detail_original === true));
    assert.equal(mock.seen.length, 0);
  });
});

test('七个模型均请求 /responses，模型名和密钥按路由隔离', async () => {
  await withServers(async (mock, proxy) => {
    const gptHeaders = { authorization: 'Bearer chatgpt-login-token', 'chatgpt-account-id': 'acct-test' };
    for (const slug of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      const result = await postJson(proxy.baseUrl, { model: slug, input: [{ type: 'input_text', text: 'hello' }] }, gptHeaders);
      assert.equal(result.status, 200);
    }
    for (const slug of ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-direct', 'deepseek-v4-pro-direct']) {
      const result = await postJson(proxy.baseUrl, { model: slug, input: 'hello' });
      assert.equal(result.status, 200);
    }

    assert.deepEqual(mock.seen.map((request) => request.url), Array(7).fill('/responses'));
    assert.deepEqual(mock.seen.map((request) => request.body.model), [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ]);
    assert.deepEqual(mock.seen.slice(0, 3).map((request) => request.auth), Array(3).fill('Bearer chatgpt-login-token'));
    assert.deepEqual(mock.seen.slice(0, 3).map((request) => request.accountId), Array(3).fill('acct-test'));
    assert.deepEqual(mock.seen.slice(3).map((request) => request.auth), [
      'Bearer test-open-key',
      'Bearer test-open-key',
      'Bearer test-deep-key',
      'Bearer test-deep-key',
    ]);
  });
});

test('请求体除 model 外保持一致，JSON 响应状态、头和正文原样返回', async () => {
  await withServers(async (mock, proxy) => {
    const body = {
      model: 'deepseek-v4-flash',
      input: [{ type: 'input_text', text: 'hello' }],
      tools: [{ type: 'function', name: 'demo', parameters: { type: 'object' } }],
      previous_response_id: 'resp_previous',
      include: ['reasoning.encrypted_content'],
      metadata: { keep: true },
    };
    const result = await postJson(proxy.baseUrl, body);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('x-upstream-marker'), 'json-preserved');
    assert.deepEqual(JSON.parse(result.text), {
      id: 'resp_test',
      object: 'response',
      model: 'deepseek-v4-flash',
      output: [],
    });
    assert.deepEqual(mock.seen[0].body, { ...body, model: 'deepseek-v4-flash' });
  });
});

test('SSE 响应原样透传', async () => {
  await withServers(async (mock, proxy) => {
    const result = await postJson(
      proxy.baseUrl,
      { model: 'gpt-5.6-sol', stream: true, input: 'hello' },
      { authorization: 'Bearer chatgpt-login-token' },
    );
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('x-upstream-marker'), 'sse-preserved');
    assert.equal(result.text, 'data: {"type":"response.output_text.delta","delta":"hello"}\n\ndata: {"type":"response.completed"}\n\n');
    assert.equal(mock.seen.length, 1);
  });
});

test('本地访问令牌使用 X-Proxy-Access-Token，且不覆盖 ChatGPT Authorization', async () => {
  const mock = await startMockUpstream();
  const proxy = await startProxy(
    { host: '127.0.0.1', port: 0, models: testRoutes(mock.baseUrl), catalog: testCatalog() },
    testSecrets(),
    { PROXY_ACCESS_TOKEN: 'secret-token' },
  );
  try {
    const noAuth = await fetch(`${proxy.baseUrl}/v1/models`);
    assert.equal(noAuth.status, 401);
    const legacyAuth = await fetch(`${proxy.baseUrl}/v1/models`, { headers: { authorization: 'Bearer secret-token' } });
    assert.equal(legacyAuth.status, 401);
    const wrong = await fetch(`${proxy.baseUrl}/v1/models`, { headers: { 'x-proxy-access-token': 'wrong-token' } });
    assert.equal(wrong.status, 401);

    const modelsOk = await fetch(`${proxy.baseUrl}/v1/models`, { headers: { 'X-Proxy-Access-Token': 'secret-token' } });
    assert.equal(modelsOk.status, 200);
    const result = await postJson(
      proxy.baseUrl,
      { model: 'gpt-5.6-sol', input: 'hello' },
      { 'X-Proxy-Access-Token': 'secret-token', authorization: 'Bearer chatgpt-login-token' },
    );
    assert.equal(result.status, 200);
    assert.equal(mock.seen[0].auth, 'Bearer chatgpt-login-token');
    assert.equal(mock.seen[0].proxyAccessToken, '');

    const health = await fetch(`${proxy.baseUrl}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    await closeServers(mock.server, proxy.server);
  }
});

test('进程环境变量优先于密钥文件，日志不泄露密钥', async () => {
  const logs = [];
  const logger = { info: (message) => logs.push(message), error: (message) => logs.push(message), warn() {} };
  await withServers(
    async (mock, proxy) => {
      await postJson(proxy.baseUrl, { model: 'deepseek-v4-flash', input: 'hello' });
      await postJson(proxy.baseUrl, { model: 'deepseek-v4-flash-direct', input: 'hello' });
      assert.equal(mock.seen[0].auth, 'Bearer env-open-key');
      assert.equal(mock.seen[1].auth, 'Bearer env-deep-key');
      assert.ok(logs.every((message) => !message.includes('env-open-key') && !message.includes('env-deep-key')));
    },
    {
      secrets: { OPENCODE_API_KEY: 'file-open-key', DEEPSEEK_API_KEY: 'file-deep-key' },
      env: { OPENCODE_API_KEY: 'env-open-key', DEEPSEEK_API_KEY: 'env-deep-key' },
      logger,
    },
  );
});

test('缺少 ChatGPT 登录认证、缺少静态密钥和未知模型均不访问上游', async () => {
  await withServers(async (mock, proxy) => {
    const noGptAuth = await postJson(proxy.baseUrl, { model: 'gpt-5.6-sol', input: 'hello' });
    assert.equal(noGptAuth.status, 401);

    const unknown = await postJson(proxy.baseUrl, { model: 'unknown-model', input: 'hello' });
    assert.equal(unknown.status, 400);
    assert.match(unknown.text, /未知模型/);
    assert.equal(mock.seen.length, 0);
  }, { secrets: {} });
});

test('上游错误状态、响应头和正文保持不变', async () => {
  await withServers(async (mock, proxy) => {
    const result = await postJson(proxy.baseUrl, { model: 'deepseek-v4-flash', trigger_error: true });
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('x-upstream-marker'), 'error-preserved');
    assert.equal(result.text, '{"error":{"type":"upstream_test_error","message":"preserve me"}}');
  });
});

test('生产配置的路由与统一模型目录严格对应', () => {
  const config = loadConfig();
  assert.deepEqual(Object.keys(config.models), MODEL_SLUGS);
  assert.deepEqual(config.catalog.models.map((model) => model.slug), MODEL_SLUGS);
  assert.equal(config.models['deepseek-v4-flash'].auth_mode, 'api_key');
  assert.equal(config.models['gpt-5.6-sol'].auth_mode, 'openai_passthrough');
});

test('密钥文件缺失时返回空对象', () => {
  assert.deepEqual(loadSecrets('./__missing_secrets_never_exists__.env'), {});
});
