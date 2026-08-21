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
  'ox-alpha',
];

const silentLogger = { info() {}, error() {}, warn() {} };

function testRoutes(mockBaseUrl) {
  return {
    'gpt-5.6-sol': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'gpt-5.6-sol',
      auth_mode: 'openai_passthrough',
      reasoning_format: 'openai_encrypted',
    },
    'gpt-5.6-terra': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'gpt-5.6-terra',
      auth_mode: 'openai_passthrough',
      reasoning_format: 'openai_encrypted',
    },
    'gpt-5.6-luna': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'gpt-5.6-luna',
      auth_mode: 'openai_passthrough',
      reasoning_format: 'openai_encrypted',
    },
    'deepseek-v4-flash': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'deepseek-v4-flash',
      auth_mode: 'api_key',
      api_key_env: 'OPENCODE_API_KEY',
      reasoning_format: 'deepseek_plaintext',
    },
    'deepseek-v4-pro': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'deepseek-v4-pro',
      auth_mode: 'api_key',
      api_key_env: 'OPENCODE_API_KEY',
      reasoning_format: 'deepseek_plaintext',
    },
    'deepseek-v4-flash-direct': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'deepseek-v4-flash',
      auth_mode: 'api_key',
      api_key_env: 'DEEPSEEK_API_KEY',
      reasoning_format: 'deepseek_plaintext',
    },
    'deepseek-v4-pro-direct': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'deepseek-v4-pro',
      auth_mode: 'api_key',
      api_key_env: 'DEEPSEEK_API_KEY',
      reasoning_format: 'deepseek_plaintext',
    },
    'ox-alpha': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'stealth/ox-alpha',
      auth_mode: 'api_key',
      api_key_env: 'OPENROUTER_API_KEY',
      reasoning_format: 'passthrough',
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
  return {
    OPENCODE_API_KEY: 'test-open-key',
    DEEPSEEK_API_KEY: 'test-deep-key',
    OPENROUTER_API_KEY: 'test-or-key',
  };
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

test('健康检查与模型列表包含八个目录项，并声明图片输入', async () => {
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

test('八个模型均请求 /responses，模型名和密钥按路由隔离', async () => {
  await withServers(async (mock, proxy) => {
    const gptHeaders = { authorization: 'Bearer chatgpt-login-token', 'chatgpt-account-id': 'acct-test' };
    for (const slug of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      const result = await postJson(proxy.baseUrl, { model: slug, input: [{ type: 'input_text', text: 'hello' }] }, gptHeaders);
      assert.equal(result.status, 200);
    }
    for (const slug of ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-direct', 'deepseek-v4-pro-direct', 'ox-alpha']) {
      const result = await postJson(proxy.baseUrl, { model: slug, input: 'hello' });
      assert.equal(result.status, 200);
    }

    assert.deepEqual(mock.seen.map((request) => request.url), Array(8).fill('/responses'));
    assert.deepEqual(mock.seen.map((request) => request.body.model), [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'stealth/ox-alpha',
    ]);
    assert.deepEqual(mock.seen.slice(0, 3).map((request) => request.auth), Array(3).fill('Bearer chatgpt-login-token'));
    assert.deepEqual(mock.seen.slice(0, 3).map((request) => request.accountId), Array(3).fill('acct-test'));
    assert.deepEqual(mock.seen.slice(3).map((request) => request.auth), [
      'Bearer test-open-key',
      'Bearer test-open-key',
      'Bearer test-deep-key',
      'Bearer test-deep-key',
      'Bearer test-or-key',
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
  assert.equal(config.models['ox-alpha'].upstream_model, 'stealth/ox-alpha');
  assert.equal(config.models['ox-alpha'].api_key_env, 'OPENROUTER_API_KEY');
  assert.equal(config.models['ox-alpha'].reasoning_format, 'passthrough');
});

test('密钥文件缺失时返回空对象', () => {
  assert.deepEqual(loadSecrets('./__missing_secrets_never_exists__.env'), {});
});

const dsReasoningFixture = {
  type: 'reasoning',
  content: [{ type: 'reasoning_text', text: 'ds-thought' }],
  encrypted_content: null,
};

const gptReasoningFixture = {
  type: 'reasoning',
  encrypted_content: 'opaque-gpt',
  content: [],
};

const userMessageFixture = {
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: 'hello' }],
};

test('发往 GPT 时移除 DS 明文 reasoning，保留 GPT 加密 reasoning', async () => {
  await withServers(async (mock, proxy) => {
    const body = {
      model: 'gpt-5.6-sol',
      input: [dsReasoningFixture, gptReasoningFixture, userMessageFixture],
    };
    const result = await postJson(
      proxy.baseUrl,
      body,
      { authorization: 'Bearer chatgpt-login-token' },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(mock.seen[0].body.input, [gptReasoningFixture, userMessageFixture]);
  });
});

test('发往 DS 时移除 GPT 加密 reasoning，保留 DS 明文 reasoning', async () => {
  await withServers(async (mock, proxy) => {
    const body = {
      model: 'deepseek-v4-flash',
      input: [gptReasoningFixture, dsReasoningFixture, userMessageFixture],
    };
    const result = await postJson(proxy.baseUrl, body);
    assert.equal(result.status, 200);
    assert.deepEqual(mock.seen[0].body.input, [dsReasoningFixture, userMessageFixture]);
  });
});

test('混合历史分别发往 GPT、OC DS 与直连 DS 时只保留各自兼容格式', async () => {
  await withServers(async (mock, proxy) => {
    const input = [dsReasoningFixture, gptReasoningFixture, userMessageFixture];
    await postJson(
      proxy.baseUrl,
      { model: 'gpt-5.6-terra', input },
      { authorization: 'Bearer chatgpt-login-token' },
    );
    await postJson(proxy.baseUrl, { model: 'deepseek-v4-flash', input });
    await postJson(proxy.baseUrl, { model: 'deepseek-v4-flash-direct', input });

    assert.deepEqual(mock.seen[0].body.input, [gptReasoningFixture, userMessageFixture]);
    assert.deepEqual(mock.seen[1].body.input, [dsReasoningFixture, userMessageFixture]);
    assert.deepEqual(mock.seen[2].body.input, [dsReasoningFixture, userMessageFixture]);
  });
});

test('畸形与不完整 reasoning 对 GPT 和 DS 均安全移除', async () => {
  await withServers(async (mock, proxy) => {
    const malformed = [
      { type: 'reasoning' },
      { type: 'reasoning', content: [] },
      { type: 'reasoning', encrypted_content: '' },
      { type: 'reasoning', content: 'not-an-array', encrypted_content: 'opaque' },
      {
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: 'both' }],
        encrypted_content: 'opaque',
      },
      userMessageFixture,
    ];
    await postJson(
      proxy.baseUrl,
      { model: 'gpt-5.6-luna', input: malformed },
      { authorization: 'Bearer chatgpt-login-token' },
    );
    assert.deepEqual(mock.seen[0].body.input, [userMessageFixture]);

    await postJson(proxy.baseUrl, { model: 'deepseek-v4-pro', input: malformed });
    assert.deepEqual(mock.seen[1].body.input, [userMessageFixture]);
  });
});

test('普通消息、工具调用、搜索与压缩项在历史整理中保持不变', async () => {
  await withServers(async (mock, proxy) => {
    const preserved = [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'hi' },
          { type: 'input_image', image_url: 'https://example.com/a.png' },
        ],
      },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'demo', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
      { type: 'search_call', id: 'sc_1', query: 'x' },
      {
        type: 'search_result',
        id: 'sr_1',
        source: { id: 's1' },
        content: [{ type: 'output_text', text: 'result' }],
      },
      { type: 'compaction', encrypted_content: 'opaque-compact' },
      { type: 'item_reference', id: 'item_1' },
    ];
    await postJson(
      proxy.baseUrl,
      { model: 'gpt-5.6-sol', input: [dsReasoningFixture, ...preserved] },
      { authorization: 'Bearer chatgpt-login-token' },
    );
    assert.deepEqual(mock.seen[0].body.input, preserved);

    await postJson(
      proxy.baseUrl,
      { model: 'deepseek-v4-flash', input: [gptReasoningFixture, ...preserved] },
    );
    assert.deepEqual(mock.seen[1].body.input, preserved);
  });
});

test('字符串 input 与不含 reasoning 的 input 保持原样', async () => {
  await withServers(async (mock, proxy) => {
    const stringBody = { model: 'deepseek-v4-flash', input: 'hello' };
    await postJson(proxy.baseUrl, stringBody);
    assert.equal(mock.seen[0].body.input, 'hello');

    const plainInput = [{ type: 'input_text', text: 'hello' }];
    const plainBody = {
      model: 'gpt-5.6-sol',
      input: plainInput,
      tools: [{ type: 'function', name: 'demo' }],
      previous_response_id: 'resp_prev',
      metadata: { keep: true },
    };
    await postJson(
      proxy.baseUrl,
      plainBody,
      { authorization: 'Bearer chatgpt-login-token' },
    );
    assert.deepEqual(mock.seen[1].body, { ...plainBody, model: 'gpt-5.6-sol' });
  });
});

test('历史整理日志只记录数量，不泄露推理正文', async () => {
  const logs = [];
  const logger = { info: (message) => logs.push(message), error() {}, warn() {} };
  await withServers(
    async (mock, proxy) => {
      await postJson(
        proxy.baseUrl,
        { model: 'gpt-5.6-sol', input: [dsReasoningFixture, gptReasoningFixture, userMessageFixture] },
        { authorization: 'Bearer chatgpt-login-token' },
      );
      assert.ok(logs.some((message) => message.includes('历史整理：移除 reasoning 1 项')));
      assert.ok(logs.every((message) => !message.includes('ds-thought') && !message.includes('opaque-gpt')));
    },
    { logger },
  );
});

const dsWebSearchFixture = {
  type: 'web_search_call',
  id: 'call_00_bXZiVEuheXGCpYHtDOCm5367',
  status: 'completed',
};

const gptWebSearchFixture = {
  type: 'web_search_call',
  id: 'ws_67ccf18f64008190a39b619f4c8455ef',
  status: 'completed',
};

test('发往 GPT 时移除 DS 风格 web_search_call，保留 ws_ 前缀记录', async () => {
  await withServers(async (mock, proxy) => {
    const result = await postJson(
      proxy.baseUrl,
      {
        model: 'gpt-5.6-sol',
        input: [dsWebSearchFixture, gptWebSearchFixture, userMessageFixture],
      },
      { authorization: 'Bearer chatgpt-login-token' },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(mock.seen[0].body.input, [gptWebSearchFixture, userMessageFixture]);
  });
});

test('发往 DS 时保留全部 web_search_call', async () => {
  await withServers(async (mock, proxy) => {
    const input = [dsWebSearchFixture, gptWebSearchFixture];
    const result = await postJson(proxy.baseUrl, { model: 'deepseek-v4-flash', input });
    assert.equal(result.status, 200);
    assert.deepEqual(mock.seen[0].body.input, input);
  });
});

test('历史整理日志记录 web_search_call 数量，不泄露搜索 ID', async () => {
  const logs = [];
  const logger = { info: (message) => logs.push(message), error() {}, warn() {} };
  await withServers(
    async (mock, proxy) => {
      await postJson(
        proxy.baseUrl,
        { model: 'gpt-5.6-sol', input: [dsWebSearchFixture, userMessageFixture] },
        { authorization: 'Bearer chatgpt-login-token' },
      );
      assert.ok(logs.some((message) => message.includes('web_search_call 1 项')));
      assert.ok(
        logs.every((message) => !message.includes('call_00_bXZiVEuheXGCpYHtDOCm5367')),
      );
    },
    { logger },
  );
});
