// 自动测试：使用内存中的 mock 上游，不调用真实 API，也不消耗任何额度。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  createProxyServer,
  createUpstreamProxyResolver,
  loadConfig,
  loadSecrets,
  parseDirectModels,
  resolveProxyUrl,
} from '../server.mjs';

const MODEL_SLUGS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash-direct',
  'deepseek-v4-pro-direct',
  'muse-spark-1.2-contributor',
  'glm-5.3',
  'glm-5.3-flash',
];

const silentLogger = { info() {}, error() {}, warn() {} };

test('直连白名单会去空格去重，并拒绝未知模型', () => {
  const routes = { first: {}, second: {} };
  assert.deepEqual(
    [...parseDirectModels(' first, first, second , ', routes)],
    ['first', 'second'],
  );
  assert.deepEqual([...parseDirectModels('', routes)], []);
  assert.throws(
    () => parseDirectModels('first,missing-model', routes),
    /DIRECT_MODELS 包含未知模型：missing-model/,
  );
});

test('直连白名单只改变上游代理选择', () => {
  const directModels = parseDirectModels('direct-model', {
    'proxy-model': {},
    'direct-model': {},
  });
  assert.equal(resolveProxyUrl('http://127.0.0.1:7890', directModels, 'proxy-model'), 'http://127.0.0.1:7890');
  assert.equal(resolveProxyUrl('http://127.0.0.1:7890', directModels, 'direct-model'), '');
  assert.equal(resolveProxyUrl('', directModels, 'proxy-model'), '');
});

function testRoutes(mockBaseUrl) {
  return {
    'gpt-5.6-sol': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'gpt-5.6-sol',
      auth_mode: 'openai_passthrough',
      reasoning_format: 'openai_encrypted',
      tool_output_format: 'passthrough',
    },
    'gpt-5.6-terra': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'gpt-5.6-terra',
      auth_mode: 'openai_passthrough',
      reasoning_format: 'openai_encrypted',
      tool_output_format: 'passthrough',
    },
    'gpt-5.6-luna': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'gpt-5.6-luna',
      auth_mode: 'openai_passthrough',
      reasoning_format: 'openai_encrypted',
      tool_output_format: 'passthrough',
    },
    'deepseek-v4-flash': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'deepseek-v4-flash',
      auth_mode: 'api_key',
      api_key_env: 'OPENCODE_API_KEY',
      reasoning_format: 'deepseek_plaintext',
      tool_output_format: 'json_string',
    },
    'deepseek-v4-pro': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'deepseek-v4-pro',
      auth_mode: 'api_key',
      api_key_env: 'OPENCODE_API_KEY',
      reasoning_format: 'deepseek_plaintext',
      tool_output_format: 'json_string',
    },
    'deepseek-v4-flash-direct': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'deepseek-v4-flash',
      auth_mode: 'api_key',
      api_key_env: 'DEEPSEEK_API_KEY',
      reasoning_format: 'deepseek_plaintext',
      tool_output_format: 'json_string',
    },
    'deepseek-v4-pro-direct': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'deepseek-v4-pro',
      auth_mode: 'api_key',
      api_key_env: 'DEEPSEEK_API_KEY',
      reasoning_format: 'deepseek_plaintext',
      tool_output_format: 'json_string',
    },
    'muse-spark-1.2-contributor': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'muse-spark-1.2-contributor',
      auth_mode: 'api_key',
      api_key_env: 'OPENCODE_API_KEY',
      reasoning_format: 'openai_encrypted',
      tool_output_format: 'passthrough',
      tool_schema_compat: 'muse',
    },
    'glm-5.3': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'glm-5.3',
      auth_mode: 'api_key',
      api_key_env: 'ZAI_API_KEY',
      reasoning_format: 'passthrough',
      tool_output_format: 'passthrough',
    },
    'glm-5.3-flash': {
      upstream_base_url: mockBaseUrl,
      upstream_model: 'glm-5.3-flash',
      auth_mode: 'api_key',
      api_key_env: 'ZAI_API_KEY',
      reasoning_format: 'passthrough',
      tool_output_format: 'passthrough',
    },
  };
}

function testCatalog() {
  return {
    models: MODEL_SLUGS.map((slug) => {
      if (slug === 'glm-5.3') {
        return { slug, display_name: slug, input_modalities: ['text'] };
      }
      if (slug === 'glm-5.3-flash') {
        return { slug, display_name: slug, input_modalities: ['text', 'image'], supports_image_detail_original: true };
      }
      return {
        slug,
        display_name: slug,
        input_modalities: ['text', 'image'],
        supports_image_detail_original: true,
      };
    }),
  };
}

function testSecrets() {
  return {
    OPENCODE_API_KEY: 'test-open-key',
    DEEPSEEK_API_KEY: 'test-deep-key',
    ZAI_API_KEY: 'test-zai-key',
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
        cookie: req.headers.cookie || '',
        xApiKey: req.headers['x-api-key'] || '',
        body,
        rawBody,
      });
      if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [
            { id: 'gpt-cpa-one', object: 'model', owned_by: 'cli-proxy-api' },
            { id: 'claude-cpa-two', object: 'model', owned_by: 'cli-proxy-api' },
          ],
        }));
        return;
      }
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

function startProxy(
  config,
  secrets,
  env = {},
  logger = silentLogger,
  systemProxyResolver = async () => ({ url: '', mode: 'direct' }),
  cpaModelFetcher,
) {
  const server = createProxyServer({
    config,
    secrets,
    logger,
    env,
    systemProxyResolver,
    cpaModelFetcher,
  });
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

async function postCompact(baseUrl, body, headers = {}) {
  const res = await fetch(`${baseUrl}/v1/responses/compact`, {
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

async function withServers(fn, {
  secrets = testSecrets(),
  env = {},
  logger = silentLogger,
  systemProxyResolver,
  cpaModelFetcher,
} = {}) {
  const mock = await startMockUpstream();
  const proxyEnv = {
    ...env,
    ...(env.CPA_BASE_URL === '__MOCK_BASE_URL__' ? { CPA_BASE_URL: mock.baseUrl } : {}),
  };
  const proxy = await startProxy(
    { host: '127.0.0.1', port: 0, models: testRoutes(mock.baseUrl), catalog: testCatalog() },
    secrets,
    proxyEnv,
    logger,
    systemProxyResolver,
    cpaModelFetcher,
  );
  try {
    await fn(mock, proxy, logger);
  } finally {
    await closeServers(proxy.server, mock.server);
  }
}

test('健康检查与模型列表包含无前缀及 direct/ 目录项，GLM-5.3 能力保持不变', async () => {
  await withServers(async (mock, proxy) => {
    const health = await fetch(`${proxy.baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const modelsRes = await fetch(`${proxy.baseUrl}/v1/models`);
    assert.equal(modelsRes.status, 200);
    const modelsJson = await modelsRes.json();
    const expectedSlugs = MODEL_SLUGS.flatMap((slug) => [slug, `direct/${slug}`]);
    assert.deepEqual(modelsJson.data.map((model) => model.id), expectedSlugs);
    assert.deepEqual(modelsJson.models.map((model) => model.slug), expectedSlugs);
    const glm = modelsJson.models.find((model) => model.slug === 'glm-5.3');
    assert.deepEqual(glm.input_modalities, ['text']);
    const glmFlash = modelsJson.models.find((model) => model.slug === 'glm-5.3-flash');
    assert.deepEqual(glmFlash.input_modalities, ['text', 'image']);
    assert.equal(glmFlash.supports_image_detail_original, true);
    const imageModels = modelsJson.models.filter(
      (model) => model.slug !== 'glm-5.3' && model.slug !== 'direct/glm-5.3',
    );
    assert.ok(imageModels.every((model) => model.input_modalities.includes('image')));
    assert.ok(imageModels.every((model) => model.supports_image_detail_original === true));
    assert.equal(mock.seen.length, 0);
  });
});

test('十个静态模型均请求 /responses，模型名和密钥按路由隔离', async () => {
  await withServers(async (mock, proxy) => {
    const gptHeaders = { authorization: 'Bearer chatgpt-login-token', 'chatgpt-account-id': 'acct-test' };
    for (const slug of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      const result = await postJson(proxy.baseUrl, { model: slug, input: [{ type: 'input_text', text: 'hello' }] }, gptHeaders);
      assert.equal(result.status, 200);
    }
    for (const slug of ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-direct', 'deepseek-v4-pro-direct', 'muse-spark-1.2-contributor', 'glm-5.3', 'glm-5.3-flash']) {
      const result = await postJson(proxy.baseUrl, { model: slug, input: 'hello' });
      assert.equal(result.status, 200);
    }

    assert.deepEqual(mock.seen.map((request) => request.url), Array(10).fill('/responses'));
    assert.deepEqual(mock.seen.map((request) => request.body.model), [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'muse-spark-1.2-contributor',
      'glm-5.3',
      'glm-5.3-flash',
    ]);
    assert.deepEqual(mock.seen.slice(0, 3).map((request) => request.auth), Array(3).fill('Bearer chatgpt-login-token'));
    assert.deepEqual(mock.seen.slice(0, 3).map((request) => request.accountId), Array(3).fill('acct-test'));
    assert.deepEqual(mock.seen.slice(3).map((request) => request.auth), [
      'Bearer test-open-key',
      'Bearer test-open-key',
      'Bearer test-deep-key',
      'Bearer test-deep-key',
      'Bearer test-open-key',
      'Bearer test-zai-key',
      'Bearer test-zai-key',
    ]);
  });
});

test('direct/ 前缀剥离后复用原静态路由，无前缀行为保持不变', async () => {
  await withServers(async (mock, proxy) => {
    const auth = { authorization: 'Bearer chatgpt-login-token' };
    const prefixed = await postJson(proxy.baseUrl, { model: 'direct/gpt-5.6-sol', input: 'hello' }, auth);
    const legacy = await postJson(proxy.baseUrl, { model: 'gpt-5.6-sol', input: 'hello' }, auth);
    const deepseek = await postJson(proxy.baseUrl, { model: 'direct/deepseek-v4-flash', input: 'hello' });
    assert.equal(prefixed.status, 200);
    assert.equal(legacy.status, 200);
    assert.equal(deepseek.status, 200);
    assert.deepEqual(mock.seen.map((request) => request.body.model), [
      'gpt-5.6-sol',
      'gpt-5.6-sol',
      'deepseek-v4-flash',
    ]);
  });
});

test('CPA 动态模型进入模型列表并使用独立服务端认证', async () => {
  await withServers(async (mock, proxy) => {
    const listResponse = await fetch(`${proxy.baseUrl}/v1/models`);
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.ok(list.data.some((model) => model.id === 'cpa/gpt-cpa-one'));
    assert.ok(list.data.some((model) => model.id === 'cpa/claude-cpa-two'));
    assert.ok(list.models.some((model) => model.slug === 'cpa/gpt-cpa-one'));
    const cpaCatalogModel = list.models.find((model) => model.slug === 'cpa/gpt-cpa-one');
    assert.equal(cpaCatalogModel.display_name, 'CPA · gpt-cpa-one');
    assert.equal(cpaCatalogModel.shell_type, 'shell_command');
    assert.equal(cpaCatalogModel.visibility, 'list');
    assert.equal(cpaCatalogModel.supported_in_api, true);
    assert.ok(cpaCatalogModel.supported_reasoning_levels.length > 0);
    assert.deepEqual(cpaCatalogModel.truncation_policy, { mode: 'tokens', limit: 10000 });
    assert.deepEqual(cpaCatalogModel.additional_speed_tiers, []);
    assert.deepEqual(cpaCatalogModel.service_tiers, []);
    assert.equal(cpaCatalogModel.default_service_tier, null);
    assert.equal(mock.seen[0].url, '/models');
    assert.equal(mock.seen[0].auth, 'Bearer cpa-service-key');

    const result = await postJson(
      proxy.baseUrl,
      { model: 'cpa/gpt-cpa-one', input: 'hello' },
      {
        authorization: 'Bearer caller-token',
        'chatgpt-account-id': 'caller-account',
        cookie: 'session=caller-cookie',
        'x-api-key': 'caller-api-key',
      },
    );
    assert.equal(result.status, 200);
    assert.equal(mock.seen[1].url, '/responses');
    assert.equal(mock.seen[1].body.model, 'gpt-cpa-one');
    assert.equal(mock.seen[1].auth, 'Bearer cpa-service-key');
    assert.equal(mock.seen[1].accountId, '');
    assert.equal(mock.seen[1].cookie, '');
    assert.equal(mock.seen[1].xApiKey, '');
  }, {
    secrets: { ...testSecrets(), CPA_API_KEY: 'cpa-service-key' },
    env: { CPA_BASE_URL: '__MOCK_BASE_URL__' },
  });
});

test('CPA 模型列表、普通请求与 compact 请求共用默认代理选择', async () => {
  let proxyCalls = 0;
  await withServers(async (mock, proxy) => {
    const listResponse = await fetch(`${proxy.baseUrl}/v1/models`);
    assert.equal(listResponse.status, 200);

    const response = await postJson(proxy.baseUrl, {
      model: 'cpa/gpt-cpa-one',
      input: 'hello',
    });
    assert.equal(response.status, 200);

    const compact = await postCompact(proxy.baseUrl, {
      model: 'cpa/gpt-cpa-one',
      input: 'hello',
    });
    assert.equal(compact.status, 200);
    assert.equal(proxyCalls, 3);
    assert.deepEqual(mock.seen.map((request) => request.url), [
      '/models',
      '/responses',
      '/responses/compact',
    ]);
  }, {
    secrets: { ...testSecrets(), CPA_API_KEY: 'cpa-service-key' },
    env: { CPA_BASE_URL: '__MOCK_BASE_URL__' },
    systemProxyResolver: async () => {
      proxyCalls += 1;
      return { url: '', mode: 'direct' };
    },
  });
});

test('CPA 未配置时返回 503，未知 CPA 模型在启用后仍交给上游判断', async () => {
  await withServers(async (mock, proxy) => {
    const disabled = await postJson(proxy.baseUrl, { model: 'cpa/any-model', input: 'hello' });
    assert.equal(disabled.status, 503);
    assert.match(disabled.text, /CPA 未配置/);
    assert.equal(mock.seen.length, 0);
  });

  await withServers(async (mock, proxy) => {
    const enabled = await postJson(proxy.baseUrl, { model: 'cpa/not-in-model-cache', input: 'hello' });
    assert.equal(enabled.status, 200);
    assert.equal(mock.seen.length, 1);
    assert.equal(mock.seen[0].body.model, 'not-in-model-cache');
  }, {
    secrets: { ...testSecrets(), CPA_API_KEY: 'cpa-service-key' },
    env: { CPA_BASE_URL: '__MOCK_BASE_URL__' },
  });
});

test('CPA 保持 SSE 与错误响应，不切换到静态直通路由', async () => {
  const logs = [];
  const logger = {
    info: (message) => logs.push(message),
    error: (message) => logs.push(message),
    warn: (message) => logs.push(message),
  };
  await withServers(async (mock, proxy) => {
    const stream = await postJson(proxy.baseUrl, {
      model: 'cpa/gpt-cpa-one',
      stream: true,
      input: 'hello',
    });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get('x-upstream-marker'), 'sse-preserved');
    assert.match(stream.text, /response\.completed/);

    const failed = await postJson(proxy.baseUrl, {
      model: 'cpa/gpt-cpa-one',
      trigger_error: true,
    });
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get('x-upstream-marker'), 'error-preserved');
    assert.equal(mock.seen.length, 2);
    assert.ok(logs.some((message) => message.includes('provider=cpa model=cpa/gpt-cpa-one')));
  }, {
    secrets: { ...testSecrets(), CPA_API_KEY: 'cpa-service-key' },
    env: { CPA_BASE_URL: '__MOCK_BASE_URL__' },
    logger,
  });
});

test('CPA compact 请求失败时不使用静态后备模型', async () => {
  await withServers(async (mock, proxy) => {
    const result = await postCompact(proxy.baseUrl, {
      model: 'cpa/gpt-cpa-one',
      trigger_error: true,
    }, {
      authorization: 'Bearer caller-token',
      'chatgpt-account-id': 'caller-account',
      cookie: 'session=caller-cookie',
      'x-api-key': 'caller-api-key',
    });
    assert.equal(result.status, 503);
    assert.equal(mock.seen.length, 1);
    assert.equal(mock.seen[0].url, '/responses/compact');
    assert.equal(mock.seen[0].body.model, 'gpt-cpa-one');
    assert.equal(mock.seen[0].auth, 'Bearer cpa-service-key');
    assert.equal(mock.seen[0].accountId, '');
    assert.equal(mock.seen[0].cookie, '');
    assert.equal(mock.seen[0].xApiKey, '');
  }, {
    secrets: { ...testSecrets(), CPA_API_KEY: 'cpa-service-key' },
    env: { CPA_BASE_URL: '__MOCK_BASE_URL__' },
  });
});

test('CPA 与订阅直通并发请求的模型、认证和账号头互不污染', async () => {
  await withServers(async (mock, proxy) => {
    const [directResult, cpaResult] = await Promise.all([
      postJson(
        proxy.baseUrl,
        { model: 'direct/gpt-5.6-sol', input: 'direct' },
        { authorization: 'Bearer chatgpt-token', 'chatgpt-account-id': 'chatgpt-account' },
      ),
      postJson(
        proxy.baseUrl,
        { model: 'cpa/gpt-cpa-one', input: 'cpa' },
        { authorization: 'Bearer caller-token', 'chatgpt-account-id': 'caller-account' },
      ),
    ]);
    assert.equal(directResult.status, 200);
    assert.equal(cpaResult.status, 200);
    const directRequest = mock.seen.find((request) => request.body.model === 'gpt-5.6-sol');
    const cpaRequest = mock.seen.find((request) => request.body.model === 'gpt-cpa-one');
    assert.equal(directRequest.auth, 'Bearer chatgpt-token');
    assert.equal(directRequest.accountId, 'chatgpt-account');
    assert.equal(cpaRequest.auth, 'Bearer cpa-service-key');
    assert.equal(cpaRequest.accountId, '');
  }, {
    secrets: { ...testSecrets(), CPA_API_KEY: 'cpa-service-key' },
    env: { CPA_BASE_URL: '__MOCK_BASE_URL__' },
  });
});

test('Muse 路由补齐工具 required，其他路由与原请求体保持不变', async () => {
  await withServers(async (mock, proxy) => {
    const tools = [
      {
        type: 'tool_search',
        execution: 'client',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'integer' } },
          required: ['query'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'complete_tool',
        parameters: {
          type: 'object',
          properties: { a: { type: 'string' }, b: { type: 'string' } },
          required: ['a', 'b'],
        },
      },
    ];
    const museBody = {
      model: 'muse-spark-1.2-contributor',
      input: 'hello',
      tools: JSON.parse(JSON.stringify(tools)),
    };
    const museResult = await postJson(proxy.baseUrl, museBody);
    assert.equal(museResult.status, 200);
    const museSeen = mock.seen[0];
    assert.equal(museSeen.body.model, 'muse-spark-1.2-contributor');
    assert.equal(museSeen.body.tools[0].type, 'function');
    assert.equal(museSeen.body.tools[0].name, 'tool_search');
    assert.deepEqual(museSeen.body.tools[0].parameters.required, ['query', 'limit']);
    assert.deepEqual(museSeen.body.tools[1].parameters.required, ['a', 'b']);
    assert.deepEqual(museBody.tools[0].parameters.required, ['query']);

    const dsResult = await postJson(proxy.baseUrl, {
      model: 'deepseek-v4-flash',
      input: 'hello',
      tools: JSON.parse(JSON.stringify(tools)),
    });
    assert.equal(dsResult.status, 200);
    assert.deepEqual(mock.seen[1].body.tools[0].parameters.required, ['query']);
  });
});

test('Muse 桥接把 namespace/custom/web_search 展平为上游可接受的工具', async () => {
  await withServers(async (mock, proxy) => {
    const longName = 'mcp__codex_apps__github__list_repository_pull_request_review_comments_for_branch';
    const result = await postJson(proxy.baseUrl, {
      model: 'muse-spark-1.2-contributor',
      input: [
        { type: 'input_text', text: 'hello' },
        {
          type: 'custom_tool_call',
          call_id: 'custom_call_1',
          name: 'apply_patch',
          input: 'patch content',
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'custom_call_1',
          output: 'ok',
        },
      ],
      tools: [
        {
          type: 'namespace',
          name: 'mcp',
          tools: [
            { type: 'function', name: longName, inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } },
          ],
        },
        { type: 'custom', name: 'apply_patch', description: 'raw patch' },
        {
          type: 'tool_search',
          execution: 'client',
          description: 'search tools',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' }, limit: { type: 'integer' } },
            required: ['query'],
          },
        },
        { type: 'web_search', search_content_types: ['text', 'image'], search_context_size: 'medium' },
      ],
    });
    assert.equal(result.status, 200);
    const seen = mock.seen[0].body;
    const types = seen.tools.map((tool) => tool.type);
    assert.ok(types.every((type) => type === 'function' || type === 'web_search'));
    assert.ok(seen.tools.every((tool) => typeof tool.name !== 'string' || tool.name.length <= 64));
    assert.ok(
      seen.tools
        .filter((tool) => tool.type === 'function' && tool.parameters)
        .every((tool) => {
          const keys = Object.keys(tool.parameters.properties || {});
          return keys.every((key) => (tool.parameters.required || []).includes(key));
        }),
    );
    const webSearch = seen.tools.find((tool) => tool.type === 'web_search');
    assert.equal(Object.prototype.hasOwnProperty.call(webSearch, 'search_content_types'), false);
    assert.equal(webSearch.search_context_size, 'medium');
    const flattened = seen.tools.find((tool) => typeof tool.name === 'string' && tool.name.startsWith('mcp__'));
    assert.ok(flattened);
    assert.ok(flattened.name.length <= 64);
    const customCall = seen.input.find((item) => item.call_id === 'custom_call_1' && item.type === 'function_call');
    assert.equal(customCall.name, 'apply_patch');
    assert.deepEqual(JSON.parse(customCall.arguments), { input: 'patch content' });
  });
});

test('GLM 路由直通：reasoning、工具输出、工具定义与 SSE 均原样转发（含 Flash）', async () => {
  await withServers(async (mock, proxy) => {
    const body = {
      model: 'glm-5.3',
      input: [
        { type: 'input_text', text: 'hello' },
        {
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: 'zai-thought' }],
          encrypted_content: 'opaque-private-state',
        },
        { type: 'web_search_call', id: 'call_search_1' },
        { type: 'custom_tool_call_output', call_id: 'call_1', output: { patch: 'ok' } },
      ],
      tools: [
        {
          type: 'custom',
          name: 'apply_patch',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
        },
      ],
    };
    const result = await postJson(proxy.baseUrl, body);
    assert.equal(result.status, 200);
    assert.equal(mock.seen[0].auth, 'Bearer test-zai-key');
    assert.deepEqual(mock.seen[0].body, { ...body, model: 'glm-5.3' });

    const sse = await postJson(proxy.baseUrl, { model: 'glm-5.3', stream: true, input: 'hello' });
    assert.equal(sse.status, 200);
    assert.equal(sse.headers.get('x-upstream-marker'), 'sse-preserved');
    assert.equal(sse.text, 'data: {"type":"response.output_text.delta","delta":"hello"}\n\ndata: {"type":"response.completed"}\n\n');
    const flashBody = { ...body, model: 'glm-5.3-flash' };
    const flashResult = await postJson(proxy.baseUrl, flashBody);
    assert.equal(flashResult.status, 200);
    assert.equal(mock.seen[2].auth, 'Bearer test-zai-key');
    assert.deepEqual(mock.seen[2].body, { ...flashBody, model: 'glm-5.3-flash' });
    assert.equal(mock.seen[2].body.model, 'glm-5.3-flash');
  });
});

test('路由 tool_schema_compat 只接受 muse', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-config-'));
  const file = path.join(dir, 'proxy-config.json');
  fs.writeFileSync(file, JSON.stringify({
    models: {
      'bad-model': {
        upstream_base_url: 'http://127.0.0.1:1',
        upstream_model: 'bad-model',
        auth_mode: 'api_key',
        api_key_env: 'OPENCODE_API_KEY',
        reasoning_format: 'passthrough',
        tool_schema_compat: 'invalid',
      },
    },
  }));
  try {
    assert.throws(() => loadConfig(file), /tool_schema_compat 无效/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('普通请求按 DIRECT_MODELS 选择代理或直连', async () => {
  const logs = [];
  const logger = {
    info: (message) => logs.push(message),
    error: (message) => logs.push(message),
    warn() {},
  };
  await withServers(
    async (mock, proxy) => {
      await postJson(
        proxy.baseUrl,
        { model: 'gpt-5.6-sol', input: 'hello' },
        { authorization: 'Bearer chatgpt-login-token' },
      );
      await postJson(proxy.baseUrl, { model: 'deepseek-v4-flash', input: 'hello' });
      await postJson(proxy.baseUrl, { model: 'deepseek-v4-flash-direct', input: 'hello' });
      await postJson(proxy.baseUrl, { model: 'muse-spark-1.2-contributor', input: 'hello' });
      assert.ok(logs.some((message) => message.includes('model=gpt-5.6-sol network=fixed-proxy')));
      assert.ok(logs.some((message) => message.includes('model=deepseek-v4-flash network=direct')));
      assert.ok(logs.some((message) => message.includes('model=deepseek-v4-flash-direct network=direct')));
      assert.ok(logs.some((message) => message.includes('model=muse-spark-1.2-contributor network=fixed-proxy')));
      assert.equal(mock.seen.length, 4);
    },
    {
      env: {
        PROXY_URL: 'http://127.0.0.1:7890',
        DIRECT_MODELS: ' deepseek-v4-flash, deepseek-v4-flash-direct ',
      },
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
    const removedOx = await postJson(proxy.baseUrl, { model: 'ox-alpha', input: 'hello' });
    assert.equal(removedOx.status, 400);
    assert.match(removedOx.text, /未知模型：ox-alpha/);
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

test('生产配置的静态路由与基础模型目录严格对应', () => {
  const config = loadConfig();
  assert.deepEqual(Object.keys(config.models), MODEL_SLUGS);
  assert.deepEqual(config.catalog.models.map((model) => model.slug), MODEL_SLUGS);
  assert.equal(config.models['deepseek-v4-flash'].auth_mode, 'api_key');
  assert.equal(config.models['gpt-5.6-sol'].auth_mode, 'openai_passthrough');
  assert.equal(config.models['glm-5.3'].auth_mode, 'api_key');
  assert.equal(config.models['glm-5.3'].api_key_env, 'ZAI_API_KEY');
  assert.equal(config.models['glm-5.3'].upstream_model, 'glm-5.3');
  assert.equal(config.models['glm-5.3'].upstream_base_url, 'https://api.z.ai/api/v1');
  assert.equal(config.models['glm-5.3'].reasoning_format, 'passthrough');
  assert.equal(config.models['glm-5.3-flash'].auth_mode, 'api_key');
  assert.equal(config.models['glm-5.3-flash'].api_key_env, 'ZAI_API_KEY');
  assert.equal(config.models['glm-5.3-flash'].upstream_model, 'glm-5.3-flash');
  assert.equal(config.models['glm-5.3-flash'].upstream_base_url, 'https://api.z.ai/api/v1');
  assert.equal(config.models['glm-5.3-flash'].reasoning_format, 'passthrough');
  for (const slug of [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'deepseek-v4-flash-direct',
    'deepseek-v4-pro-direct',
  ]) {
    assert.equal(config.models[slug].tool_output_format, 'json_string');
  }
  for (const slug of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'glm-5.3', 'glm-5.3-flash']) {
    assert.equal(config.models[slug].tool_output_format, 'passthrough');
  }
  const glm = config.catalog.models.find((model) => model.slug === 'glm-5.3');
  assert.deepEqual(glm.input_modalities, ['text']);
  assert.equal(glm.default_reasoning_level, 'max');
  assert.equal(glm.apply_patch_tool_type, 'freeform');
  assert.equal(glm.context_window, 1048576);
  const glmFlash = config.catalog.models.find((model) => model.slug === 'glm-5.3-flash');
  assert.deepEqual(glmFlash.input_modalities, ['text', 'image']);
  assert.equal(glmFlash.supports_image_detail_original, true);
  assert.equal(glmFlash.default_reasoning_level, 'max');
  assert.equal(glmFlash.apply_patch_tool_type, 'freeform');
  assert.equal(glmFlash.context_window, 1048576);
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

const museReasoningFixture = {
  type: 'reasoning',
  id: 'rs_6a9293021ea061d200224fc9:rs_01a04c8e4ce57b009cecb10de9ea4803',
  encrypted_content: 'opaque-muse-state',
  content: null,
};

const museMessageFixture = {
  type: 'message',
  id: 'rs_01a04c8e57b57771947c7cd31c8770d7',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'muse reply' }],
};

const museCustomToolCallFixture = {
  type: 'custom_tool_call',
  id: 'fc_01a04c9483b172c18998f81238bbdb2a',
  call_id: 'call_01a04c9483b172c18998f81238bbdb2a',
  name: 'apply_patch',
  input: 'patch',
};

const museCustomToolOutputFixture = {
  type: 'custom_tool_call_output',
  id: 'ctco_01a04c948dcb7eaf8e0c20159ca1a89c',
  call_id: 'call_01a04c9483b172c18998f81238bbdb2a',
  output: 'ok',
};

const userMessageFixture = {
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: 'hello' }],
};

test('发往 GPT 时保留 DS reasoning 项，仅清空其明文 content', async () => {
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
    assert.deepEqual(mock.seen[0].body.input, [
      { ...dsReasoningFixture, content: [] },
      gptReasoningFixture,
      userMessageFixture,
    ]);
  });
});

test('发往 DS 时保留 GPT reasoning 项，仅清空其 encrypted_content', async () => {
  await withServers(async (mock, proxy) => {
    const body = {
      model: 'deepseek-v4-flash',
      input: [gptReasoningFixture, dsReasoningFixture, userMessageFixture],
    };
    const result = await postJson(proxy.baseUrl, body);
    assert.equal(result.status, 200);
    assert.deepEqual(mock.seen[0].body.input, [
      { ...gptReasoningFixture, encrypted_content: null },
      dsReasoningFixture,
      userMessageFixture,
    ]);
  });
});

test('混合历史分别发往 GPT、OC DS 与直连 DS 时只清空各自冲突字段', async () => {
  await withServers(async (mock, proxy) => {
    const input = [dsReasoningFixture, gptReasoningFixture, userMessageFixture];
    await postJson(
      proxy.baseUrl,
      { model: 'gpt-5.6-terra', input },
      { authorization: 'Bearer chatgpt-login-token' },
    );
    await postJson(proxy.baseUrl, { model: 'deepseek-v4-flash', input });
    await postJson(proxy.baseUrl, { model: 'deepseek-v4-flash-direct', input });

    assert.deepEqual(mock.seen[0].body.input, [
      { ...dsReasoningFixture, content: [] },
      gptReasoningFixture,
      userMessageFixture,
    ]);
    assert.deepEqual(mock.seen[1].body.input, [
      { ...dsReasoningFixture, encrypted_content: null },
      { ...gptReasoningFixture, encrypted_content: null },
      userMessageFixture,
    ]);
    assert.deepEqual(mock.seen[2].body.input, [
      { ...dsReasoningFixture, encrypted_content: null },
      { ...gptReasoningFixture, encrypted_content: null },
      userMessageFixture,
    ]);
  });
});

test('从 Muse 切换到 GPT 时按项目类型规范化 ID', async () => {
  await withServers(async (mock, proxy) => {
    const input = [
      museReasoningFixture,
      museMessageFixture,
      museCustomToolCallFixture,
      museCustomToolOutputFixture,
      userMessageFixture,
    ];
    const result = await postJson(
      proxy.baseUrl,
      { model: 'gpt-5.6-sol', input },
      { authorization: 'Bearer chatgpt-login-token' },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(mock.seen[0].body.input, [
      {
        ...museReasoningFixture,
        id: 'rs_6a9293021ea061d200224fc9_rs_01a04c8e4ce57b009cecb10de9ea4803',
        content: [],
      },
      { ...museMessageFixture, id: `msg_${museMessageFixture.id}` },
      { ...museCustomToolCallFixture, id: `ctc_${museCustomToolCallFixture.id}` },
      museCustomToolOutputFixture,
      userMessageFixture,
    ]);
    assert.equal(mock.seen[0].body.input[2].call_id, mock.seen[0].body.input[3].call_id);
    assert.deepEqual(input, [
      museReasoningFixture,
      museMessageFixture,
      museCustomToolCallFixture,
      museCustomToolOutputFixture,
      userMessageFixture,
    ]);
  });
});

test('代理优先级为直连白名单、PROXY_URL、配置固定代理、Windows 系统代理', async () => {
  let systemCalls = 0;
  const systemProxyResolver = async () => {
    systemCalls += 1;
    return { url: 'http://127.0.0.1:7890', mode: 'system-proxy' };
  };
  const directModels = new Set(['direct-model']);

  const envFixed = createUpstreamProxyResolver({
    config: { proxy: 'http://config.example:8000' },
    env: { PROXY_URL: 'http://env.example:9000' },
    directModels,
    systemProxyResolver,
  });
  assert.deepEqual(await envFixed('direct-model'), { url: '', mode: 'direct' });
  assert.deepEqual(await envFixed('other-model'), {
    url: 'http://env.example:9000',
    mode: 'fixed-proxy',
  });

  const forcedDirect = createUpstreamProxyResolver({
    config: { proxy: 'http://config.example:8000' },
    env: { PROXY_URL: '' },
    directModels: new Set(),
    systemProxyResolver,
  });
  assert.deepEqual(await forcedDirect('other-model'), { url: '', mode: 'direct' });

  const configFixed = createUpstreamProxyResolver({
    config: { proxy: 'http://config.example:8000' },
    env: {},
    directModels: new Set(),
    systemProxyResolver,
  });
  assert.deepEqual(await configFixed('other-model'), {
    url: 'http://config.example:8000',
    mode: 'fixed-proxy',
  });

  const dynamic = createUpstreamProxyResolver({
    config: {},
    env: {},
    directModels: new Set(),
    systemProxyResolver,
  });
  assert.deepEqual(await dynamic('other-model'), {
    url: 'http://127.0.0.1:7890',
    mode: 'system-proxy',
  });
  assert.equal(systemCalls, 1);
});

test('普通请求动态解析 Windows 系统代理，首次解析失败时返回 502', async () => {
  const logs = [];
  let calls = 0;
  const logger = {
    info: (message) => logs.push(message),
    error: (message) => logs.push(message),
    warn: (message) => logs.push(message),
  };
  await withServers(
    async (mock, proxy) => {
      const first = await postJson(proxy.baseUrl, { model: 'deepseek-v4-flash', input: 'first' });
      const second = await postJson(proxy.baseUrl, { model: 'deepseek-v4-flash', input: 'second' });
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(calls, 2);
      assert.ok(logs.some((message) => message.includes('network=system-proxy')));
      assert.equal(mock.seen.length, 2);
    },
    {
      logger,
      systemProxyResolver: async () => {
        calls += 1;
        return { url: `http://127.0.0.1:${calls === 1 ? 7890 : 7891}`, mode: 'system-proxy' };
      },
    },
  );

  await withServers(
    async (mock, proxy) => {
      const result = await postJson(proxy.baseUrl, { model: 'deepseek-v4-flash', input: 'hello' });
      assert.equal(result.status, 502);
      assert.match(JSON.parse(result.text).error.message, /无法确定上游代理/);
      assert.equal(mock.seen.length, 0);
    },
    { systemProxyResolver: async () => { throw new Error('注册表读取失败'); } },
  );
});

test('畸形与不完整 reasoning 对 GPT 和 DS 均保留并安全清空冲突字段', async () => {
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
    assert.deepEqual(mock.seen[0].body.input, [
      { type: 'reasoning' },
      { type: 'reasoning', content: [] },
      { type: 'reasoning', encrypted_content: '' },
      { type: 'reasoning', content: [], encrypted_content: 'opaque' },
      { type: 'reasoning', content: [], encrypted_content: 'opaque' },
      userMessageFixture,
    ]);

    await postJson(proxy.baseUrl, { model: 'deepseek-v4-pro', input: malformed });
    assert.deepEqual(mock.seen[1].body.input, [
      { type: 'reasoning' },
      { type: 'reasoning', content: [] },
      { type: 'reasoning', encrypted_content: null },
      { type: 'reasoning', content: 'not-an-array', encrypted_content: null },
      {
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: 'both' }],
        encrypted_content: null,
      },
      userMessageFixture,
    ]);
  });
});

test('四条 OC/直连 DS 路由完整序列化数组、对象和标量工具输出', async () => {
  const imageOutput = [
    {
      type: 'image',
      image_url: 'data:image/png;base64,view-image-fixture',
      detail: 'original',
    },
  ];
  const objectOutput = { width: 640, height: 480, pixels: [{ r: 1, g: 2, b: 3 }] };
  const input = [
    { type: 'function_call', id: 'fc_view', call_id: 'call_view', name: 'view_image', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_view', output: imageOutput },
    { type: 'custom_tool_call_output', call_id: 'call_object', output: objectOutput },
    { type: 'function_call_output', call_id: 'call_number', output: 7 },
    { type: 'custom_tool_call_output', call_id: 'call_text', output: 'already-text' },
  ];
  const dsSlugs = [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'deepseek-v4-flash-direct',
    'deepseek-v4-pro-direct',
  ];

  await withServers(async (mock, proxy) => {
    for (const slug of dsSlugs) {
      const result = await postJson(proxy.baseUrl, { model: slug, input });
      assert.equal(result.status, 200);
    }
    assert.equal(mock.seen.length, dsSlugs.length);
    for (const request of mock.seen) {
      const seenInput = request.body.input;
      assert.equal(seenInput[0].call_id, 'call_view');
      assert.deepEqual(JSON.parse(seenInput[1].output), imageOutput);
      assert.deepEqual(JSON.parse(seenInput[2].output), objectOutput);
      assert.equal(seenInput[3].output, '7');
      assert.equal(seenInput[4].output, 'already-text');
      assert.deepEqual(seenInput.map((item) => item.call_id), [
        'call_view',
        'call_view',
        'call_object',
        'call_number',
        'call_text',
      ]);
    }
  });
});

test('GPT 路由对工具输出保持原始数组和对象', async () => {
  const imageOutput = [{ type: 'image', data: 'base64-image-fixture' }];
  const objectOutput = { ok: true, value: 3 };
  const input = [
    { type: 'function_call_output', call_id: 'call_image', output: imageOutput },
    { type: 'custom_tool_call_output', call_id: 'call_object', output: objectOutput },
  ];
  await withServers(async (mock, proxy) => {
    await postJson(
      proxy.baseUrl,
      { model: 'gpt-5.6-sol', input },
      { authorization: 'Bearer chatgpt-login-token' },
    );
    assert.deepEqual(mock.seen[0].body.input, input);
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
    assert.deepEqual(mock.seen[0].body.input, [{ ...dsReasoningFixture, content: [] }, ...preserved]);

    await postJson(
      proxy.baseUrl,
      { model: 'deepseek-v4-flash', input: [gptReasoningFixture, ...preserved] },
    );
    assert.deepEqual(mock.seen[1].body.input, [{ ...gptReasoningFixture, encrypted_content: null }, ...preserved]);
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
      assert.ok(logs.some((message) => message.includes('历史整理：reasoning 1 项兼容字段已整理')));
      assert.ok(logs.every((message) => !message.includes('ds-thought') && !message.includes('opaque-gpt')));
    },
    { logger },
  );
});

test('服务端启用历史监控后记录清洗前后结构、结果和 view_image 配对', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proxy-monitor-'));
  const monitorFile = path.join(directory, 'history-monitor.jsonl');
  try {
    const reasoning = {
      type: 'reasoning',
      id: 'rs_monitor',
      content: [{ type: 'reasoning_text', text: 'monitor-reasoning-body' }],
      encrypted_content: 'monitor-encrypted-content',
    };
    const imageOutput = [{
      type: 'image',
      image_url: 'data:image/png;base64,monitor-image-data',
      detail: 'original',
    }];
    await withServers(
      async (mock, proxy) => {
        const result = await postJson(proxy.baseUrl, {
          model: 'deepseek-v4-flash',
          input: [
            reasoning,
            { type: 'function_call', id: 'fc_monitor', call_id: 'call_monitor', name: 'view_image', arguments: '{}' },
            { type: 'function_call_output', call_id: 'call_monitor', output: imageOutput },
          ],
        });
        assert.equal(result.status, 200);
        assert.deepEqual(JSON.parse(mock.seen[0].body.input[2].output), imageOutput);
      },
      {
        env: {
          HISTORY_MONITOR: '1',
          HISTORY_MONITOR_FILE: monitorFile,
        },
      },
    );

    const events = fs.readFileSync(monitorFile, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.event), [
      'request_before',
      'request_after',
      'upstream_result',
    ]);
    assert.ok(events.every((event) => event.request_id === events[0].request_id));
    assert.equal(events[0].history.pairing.function_calls, 1);
    assert.equal(events[0].history.pairing.function_call_outputs, 1);
    assert.equal(events[0].history.pairing.orphan_calls, 0);
    assert.equal(events[0].history.pairing.orphan_outputs, 0);
    assert.equal(events[1].history.items[0].reasoning.encrypted_content.present, false);
    assert.deepEqual(events[1].actions.normalized_reasoning_indexes, [0]);
    assert.deepEqual(events[1].actions.normalized_tool_output_indexes, [2]);
    assert.equal(events[1].history.items[2].output.kind, 'string');
    assert.equal(events[2].status, 200);
    const raw = fs.readFileSync(monitorFile, 'utf8');
    for (const forbidden of [
      'monitor-reasoning-body',
      'monitor-encrypted-content',
      'monitor-image-data',
    ]) {
      assert.equal(raw.includes(forbidden), false, `监控日志不应包含 ${forbidden}`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
