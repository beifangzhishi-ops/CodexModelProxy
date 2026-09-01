import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProviderRegistry, loadRuntimeEnv } from '../provider-registry.mjs';
import { resolveModelSelection } from '../model-resolver.mjs';

function validProvider(overrides = {}) {
  return {
    enabled: true,
    base_url: 'https://foo.example/v1',
    api_key: 'foo-key',
    auth_mode: 'api_key',
    protocol: 'responses',
    discover_models: false,
    model_prefix: 'foo/',
    compat_profile: 'openai',
    network: 'default',
    models: { alpha: {} },
    ...overrides,
  };
}

test('有效 Provider、静态模型和别名可以构建并解析', () => {
  const registry = createProviderRegistry({
    config: {
      providers: { foo: validProvider() },
      aliases: { legacy: 'foo/alpha' },
    },
  });
  assert.equal(registry.getProvider('foo').base_url, 'https://foo.example/v1');
  assert.deepEqual(registry.knownCanonicalModels(), ['foo/alpha']);
  const selection = resolveModelSelection('legacy', registry);
  assert.equal(selection.ok, true);
  assert.equal(selection.provider_id, 'foo');
  assert.equal(selection.route.upstream_model, 'alpha');
  assert.equal(selection.route.auth_mode, 'api_key');
  assert.equal(selection.route.provider_api_key, 'foo-key');
});

test('disabled Provider 不要求 URL/key，也不会暴露静态模型', () => {
  const registry = createProviderRegistry({
    config: { providers: { disabled: validProvider({ enabled: false, base_url: '', api_key: '', model_prefix: 'disabled/' }) } },
  });
  assert.equal(registry.getProvider('disabled').enabled, false);
  assert.deepEqual(registry.knownCanonicalModels(), []);
  assert.equal(resolveModelSelection('disabled/alpha', registry).status, 503);
});

test('openai_passthrough Provider 不需要服务端 key', () => {
  const registry = createProviderRegistry({
    config: { providers: {
      chatgpt: validProvider({
        base_url: 'https://chatgpt.example/codex',
        api_key: '',
        auth_mode: 'openai_passthrough',
        model_prefix: 'chatgpt/',
        compat_profile: 'openai',
      }),
    } },
  });
  assert.equal(registry.getProvider('chatgpt').api_key, '');
});

test('启用 Provider 缺少 URL 或 key 时严格拒绝', () => {
  assert.throws(
    () => createProviderRegistry({ config: { providers: { foo: validProvider({ base_url: '' }) } } }),
    /Provider foo 缺少 base_url/,
  );
  assert.throws(
    () => createProviderRegistry({ config: { providers: { foo: validProvider({ api_key: '' }) } } }),
    /Provider foo 缺少 API key/,
  );
});

test('model_overrides 的路由字段在 Registry 构建期校验', () => {
  const invalidCases = [
    [{ compat_profile: 'missing' }, /model_overrides\.x-\* compat_profile 无效/],
    [{ network: 'invalid' }, /model_overrides\.x-\* network 无效/],
    [{ timeout_ms: 0 }, /model_overrides\.x-\* timeout_ms 必须是正整数/],
    [{ reasoning_format: 'invalid' }, /model_overrides\.x-\* 的 reasoning_format 无效/],
    [{ upstream_base_url: 'ftp://foo.example/v1' }, /model_overrides\.x-\* upstream_base_url 仅支持 http\/https/],
  ];
  for (const [spec, error] of invalidCases) {
    assert.throws(
      () => createProviderRegistry({ config: {
        providers: { foo: validProvider({ model_overrides: { 'x-*': spec } }) },
      } }),
      error,
    );
  }
});

test('数组形式 models 和 model_overrides 合并后仍按名称解析', () => {
  const registry = createProviderRegistry({
    config: {
      providers: {
        foo: validProvider({
          models: ['alpha', 'beta'],
          model_overrides: [{ name: 'gpt-*', compat_profile: 'openai' }],
        }),
      },
    },
    localConfig: {
      providers: {
        foo: {
          models: [{ name: 'gamma' }],
          model_overrides: [{ name: 'claude-*', network: 'direct' }],
        },
      },
    },
  });
  assert.deepEqual(registry.knownCanonicalModels().sort(), ['foo/alpha', 'foo/beta', 'foo/gamma']);
  assert.deepEqual(Object.keys(registry.getProvider('foo').models).sort(), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(Object.keys(registry.getProvider('foo').model_overrides).sort(), ['claude-*', 'gpt-*']);
  assert.equal(registry.getProvider('foo').models[0], undefined);
  assert.equal(registry.getProvider('foo').model_overrides[0], undefined);
  assert.equal(registry.getProvider('foo').model_overrides['gpt-*'].upstream_model, undefined);
  assert.equal(resolveModelSelection('foo/gamma', registry).route.upstream_model, 'gamma');
});

test('Provider protocol、profile、namespace 和保留 id 校验', () => {
  assert.throws(
    () => createProviderRegistry({ config: { providers: { foo: validProvider({ protocol: 'chat_completions' }) } } }),
    /protocol 不支持/,
  );
  assert.throws(
    () => createProviderRegistry({ config: { providers: { foo: validProvider({ compat_profile: 'unknown' }) } } }),
    /compat_profile 无效/,
  );
  assert.throws(
    () => createProviderRegistry({ config: { providers: {
      foo: validProvider(), bar: validProvider({ model_prefix: 'foo/' }),
    } } }),
    /model_prefix.*冲突/,
  );
  assert.throws(
    () => createProviderRegistry({ config: { providers: { direct: validProvider({ model_prefix: 'direct/' }) } } }),
    /Provider id direct 是保留名称/,
  );
});

test('别名目标、别名循环和动态 Provider 校验', () => {
  assert.throws(
    () => createProviderRegistry({ config: {
      providers: { foo: validProvider() },
      aliases: { missing: 'unknown/model' },
    } }),
    /指向未知 Provider 命名空间/,
  );
  assert.throws(
    () => createProviderRegistry({ config: {
      providers: { foo: validProvider() },
      aliases: { a: 'b', b: 'a' },
    } }),
    /alias 存在循环/,
  );
  const dynamic = createProviderRegistry({
    config: { providers: {
      foo: validProvider({ discover_models: true, models: {} }),
    } },
  });
  assert.equal(resolveModelSelection('foo/new-model', dynamic).ok, true);
});

test('本地环境文件由统一加载器读取，显式进程环境优先', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-env-'));
  const file = path.join(directory, 'proxy-local.env');
  try {
    fs.writeFileSync(file, 'PORT=1234\nexport HOST=127.0.0.1\nFROM_FILE=ok\n', 'utf8');
    const env = loadRuntimeEnv({ env: { PORT: '5678', FROM_PROCESS: 'yes' }, envFile: file });
    assert.equal(env.PORT, '5678');
    assert.equal(env.HOST, '127.0.0.1');
    assert.equal(env.FROM_FILE, 'ok');
    assert.equal(env.FROM_PROCESS, 'yes');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
