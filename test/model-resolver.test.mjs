import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderRegistry } from '../provider-registry.mjs';
import { resolveModelSelection } from '../model-resolver.mjs';

function registry() {
  return createProviderRegistry({
    config: {
      providers: {
        opencode: {
          base_url: 'https://opencode.example/v1',
          api_key: 'oc-key',
          auth_mode: 'api_key',
          protocol: 'responses',
          model_prefix: 'oc/',
          compat_profile: 'deepseek',
          network: 'default',
          models: { 'deepseek-v4-flash': {}, 'muse-spark': {} },
          model_compatibility: [{ pattern: 'muse-*', profile: 'muse' }],
        },
        deepseek: {
          base_url: 'https://deepseek.example/v1',
          api_key: 'ds-key',
          auth_mode: 'api_key',
          protocol: 'responses',
          model_prefix: 'ds/',
          compat_profile: 'deepseek',
          network: 'direct',
          models: { 'deepseek-v4-flash': {} },
        },
        cpa: {
          base_url: 'https://cpa.example/v1',
          api_key: 'cpa-key',
          auth_mode: 'api_key',
          protocol: 'responses',
          discover_models: true,
          model_prefix: 'cpa/',
          compat_profile: 'openai-auto',
          network: 'default',
        },
        chatgpt: {
          base_url: 'https://chatgpt.example/codex',
          auth_mode: 'openai_passthrough',
          protocol: 'responses',
          model_prefix: 'chatgpt/',
          compat_profile: 'openai',
          models: { 'gpt-5.6-sol': {} },
        },
      },
      aliases: {
        'deepseek-v4-flash': 'oc/deepseek-v4-flash',
        'deepseek-v4-flash-direct': 'ds/deepseek-v4-flash',
        'gpt-5.6-sol': 'chatgpt/gpt-5.6-sol',
      },
    },
  });
}

test('canonical、legacy alias 和 direct/ 请求统一解析', () => {
  const r = registry();
  const canonical = resolveModelSelection('oc/deepseek-v4-flash', r);
  const legacy = resolveModelSelection('deepseek-v4-flash', r);
  const direct = resolveModelSelection('direct/deepseek-v4-flash', r);
  assert.equal(canonical.provider_id, 'opencode');
  assert.equal(legacy.canonicalModel, 'oc/deepseek-v4-flash');
  assert.equal(direct.provider_id, 'deepseek');
  assert.equal(direct.route.network, 'direct');
  assert.equal(direct.route.upstream_model, 'deepseek-v4-flash');
});

test('不同 Provider 的同名模型保留各自 URL、key 和网络策略', () => {
  const r = registry();
  const oc = resolveModelSelection('oc/deepseek-v4-flash', r);
  const ds = resolveModelSelection('ds/deepseek-v4-flash', r);
  assert.equal(oc.route.upstream_base_url, 'https://opencode.example/v1');
  assert.equal(oc.route.provider_api_key, 'oc-key');
  assert.equal(oc.route.network, 'default');
  assert.equal(ds.route.upstream_base_url, 'https://deepseek.example/v1');
  assert.equal(ds.route.provider_api_key, 'ds-key');
  assert.equal(ds.route.network, 'direct');
});

test('动态 Provider 接受未出现在缓存中的模型并按名称选择 profile', () => {
  const r = registry();
  const gpt = resolveModelSelection('cpa/gpt-new', r);
  const deepseek = resolveModelSelection('cpa/deepseek-v4-flash', r);
  const other = resolveModelSelection('cpa/claude-new', r);
  assert.equal(gpt.ok, true);
  assert.equal(gpt.route.compat_profile, 'openai');
  assert.equal(deepseek.route.compat_profile, 'deepseek');
  assert.equal(other.route.compat_profile, 'passthrough');
  assert.equal(gpt.route.provider_api_key, 'cpa-key');
});

test('未知 Provider、未知静态模型和空模型返回明确错误', () => {
  const r = registry();
  assert.equal(resolveModelSelection('missing/model', r).status, 400);
  assert.equal(resolveModelSelection('oc/missing', r).status, 400);
  assert.equal(resolveModelSelection('', r).status, 400);
});

test('Muse model override 保留 Muse tool schema 兼容', () => {
  const selection = resolveModelSelection('oc/muse-spark', registry());
  assert.equal(selection.route.compat_profile, 'muse');
  assert.equal(selection.route.tool_schema_compat, 'muse');
});
