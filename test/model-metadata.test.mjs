import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCatalogModel,
  GENERIC_BASE_INSTRUCTIONS,
  hasRequiredInstructions,
  inferMetadataProfile,
} from '../model-metadata.mjs';
import { createProxyServer } from '../server.mjs';

const silentLogger = { info() {}, warn() {}, error() {} };

function provider(overrides = {}) {
  return {
    id: 'opencode',
    namespace: 'oc',
    model_prefix: 'oc/',
    display_name: 'OC',
    compat_profile: 'deepseek',
    metadata_profile: 'generic',
    model_overrides: {},
    ...overrides,
  };
}

test('未知动态模型始终满足 Codex 0.153.1 的 instruction 要求', () => {
  const model = buildCatalogModel({
    id: 'oc/minimax-m3',
    modelName: 'minimax-m3',
    provider: provider(),
    source: { id: 'oc/minimax-m3', description: 'dynamic model' },
    priority: 1,
  });

  assert.equal(model.slug, 'oc/minimax-m3');
  assert.equal(model.base_instructions, GENERIC_BASE_INSTRUCTIONS);
  assert.equal(hasRequiredInstructions(model), true);
});

test('上游原生 instructions_template 优先，存在时不注入通用 base_instructions', () => {
  const model = buildCatalogModel({
    id: 'chatgpt/example',
    modelName: 'example',
    provider: provider({
      id: 'chatgpt',
      namespace: 'chatgpt',
      model_prefix: 'chatgpt/',
      display_name: 'ChatGPT',
      compat_profile: 'openai',
      metadata_profile: 'openai',
    }),
    source: {
      model_messages: { instructions_template: 'upstream instructions' },
      context_window: 400000,
      input_modalities: ['text'],
    },
    priority: 2,
  });

  assert.equal(model.model_messages.instructions_template, 'upstream instructions');
  assert.equal(model.base_instructions, undefined);
  assert.equal(model.context_window, 400000);
  assert.equal(model.max_context_window, undefined);
  assert.deepEqual(model.input_modalities, ['text']);
  assert.equal(hasRequiredInstructions(model), true);
});

test('openai-auto 不自动推断 OpenAI 模型能力', () => {
  assert.equal(inferMetadataProfile({ id: 'cpa', compat_profile: 'openai-auto' }), 'generic');
  assert.equal(inferMetadataProfile({ id: 'chatgpt', compat_profile: 'openai' }), 'openai');
});

test('model_overrides 可以只覆盖 metadata profile 和显式 metadata', () => {
  const model = buildCatalogModel({
    id: 'oc/muse-next',
    modelName: 'muse-next',
    provider: provider({
      model_overrides: {
        'muse-*': {
          metadata_profile: 'muse',
          metadata: { context_window: 200000 },
        },
      },
    }),
    priority: 3,
  });

  assert.deepEqual(model.input_modalities, ['text', 'image']);
  assert.equal(model.supports_image_detail_original, true);
  assert.equal(model.context_window, 200000);
});

test('没有上游上下文信息时不捏造 128k，也不伪造压缩阈值', () => {
  const model = buildCatalogModel({
    id: 'oc/unknown-new-model', modelName: 'unknown-new-model', provider: provider(),
    source: { id: 'oc/unknown-new-model' },
  });
  assert.equal(model.context_window, undefined);
  assert.equal(model.max_context_window, undefined);
  assert.equal(model.auto_compact_token_limit, undefined);
  assert.equal(model.effective_context_window_percent, 95);
});

test('优先使用自动发现的原生、嵌套和通用 context_length 元数据', () => {
  const native = buildCatalogModel({
    id: 'ds/large', modelName: 'large', provider: provider(),
    source: { context_window: 1048576, metadata: { max_context_window: 2097152 } },
  });
  assert.equal(native.context_window, 1048576);
  assert.equal(native.max_context_window, 2097152);

  const nested = buildCatalogModel({
    id: 'oc/nested', modelName: 'nested', provider: provider(),
    source: { metadata: { context_length: '262144', effective_context_window_percent: 90 } },
  });
  assert.equal(nested.context_window, 262144);
  assert.equal(nested.effective_context_window_percent, 90);

  const top = buildCatalogModel({
    id: 'oc/top', modelName: 'top', provider: provider(),
    source: { model_metadata: { context_window: 65536 }, context_window: 400000 },
  });
  assert.equal(top.context_window, 400000);
});

test('坏的上下文数据不会污染 Codex 目录或产生小于实际窗口的最大值', () => {
  const model = buildCatalogModel({
    id: 'oc/bad', modelName: 'bad', provider: provider(),
    source: {
      context_window: '524288', max_context_window: 128000,
      auto_compact_token_limit: 'invalid', effective_context_window_percent: 999,
    },
  });
  assert.equal(model.context_window, 524288);
  assert.equal(model.max_context_window, undefined);
  assert.equal(model.auto_compact_token_limit, undefined);
  assert.equal(model.effective_context_window_percent, 95);
});

test('静态 alias 不依赖 retired-model-file.json 也能生成完整模型目录', async () => {
  const server = createProxyServer({
    config: {
      expose_canonical_models: false,
      providers: {
        chatgpt: {
          enabled: true,
          base_url: 'https://chatgpt.com/backend-api/codex',
          auth_mode: 'openai_passthrough',
          protocol: 'responses',
          discover_models: false,
          model_prefix: 'chatgpt/',
          compat_profile: 'openai',
          metadata_profile: 'openai',
          display_name: 'ChatGPT',
          models: {
            'gpt-fixture-sol': { display_name: '5.6 Sol' },
          },
        },
      },
      aliases: {
        'gpt-fixture-sol': 'chatgpt/gpt-fixture-sol',
      },
    },
    localConfig: { providers: {} },
    env: {},
    secrets: {},
    logger: silentLogger,
    systemProxyResolver: async () => ({ url: '', mode: 'direct' }),
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/v1/models`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.data.map((item) => item.id), ['gpt-fixture-sol']);
    assert.deepEqual(payload.models.map((item) => item.slug), ['gpt-fixture-sol']);
    assert.equal(payload.models[0].display_name, '5.6 Sol');
    assert.equal(payload.models[0].context_window, undefined);
    assert.equal(hasRequiredInstructions(payload.models[0]), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('动态 Provider 新模型不会再因缺 instruction 让整份目录失效', async () => {
  const server = createProxyServer({
    config: {
      expose_canonical_models: false,
      providers: {
        opencode: {
          enabled: true,
          base_url: 'http://127.0.0.1:1',
          auth_mode: 'api_key',
          protocol: 'responses',
          discover_models: true,
          model_prefix: 'oc/',
          compat_profile: 'deepseek',
          metadata_profile: 'generic',
          display_name: 'OC',
        },
      },
      aliases: {},
    },
    localConfig: { providers: {} },
    env: {},
    secrets: {},
    logger: silentLogger,
    systemProxyResolver: async () => ({ url: '', mode: 'direct' }),
    discoveryFetchModels: async () => ({
      data: [
        { id: 'minimax-m3' },
        { id: 'another-new-model', model_messages: { instructions_template: 'native' } },
      ],
    }),
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/v1/models`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(
      payload.models.map((item) => item.slug),
      ['oc/minimax-m3', 'oc/another-new-model'],
    );
    assert.ok(payload.models.every(hasRequiredInstructions));
    assert.equal(payload.models[1].base_instructions, undefined);
    assert.equal(payload.models[1].model_messages.instructions_template, 'native');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
