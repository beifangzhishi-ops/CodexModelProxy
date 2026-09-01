import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPATIBILITY_PROFILES,
  matchWildcard,
  resolveCompatibilityProfile,
  validateCompatibilityOverrides,
} from '../compatibility-profiles.mjs';

test('兼容 profile 映射到现有 reasoning 与工具输出策略', () => {
  assert.deepEqual(COMPATIBILITY_PROFILES.openai, {
    reasoning_format: 'openai_encrypted',
    tool_output_format: 'passthrough',
  });
  assert.deepEqual(COMPATIBILITY_PROFILES.deepseek, {
    reasoning_format: 'deepseek_plaintext',
    tool_output_format: 'json_string',
  });
  assert.equal(COMPATIBILITY_PROFILES.muse.tool_schema_compat, 'muse');
});

test('profile override 按精确模型、Provider pattern、全局 pattern 的顺序选择', () => {
  const provider = {
    id: 'foo',
    compat_profile: 'passthrough',
    model_compatibility: [{ pattern: 'muse-*', profile: 'muse' }],
  };
  assert.equal(resolveCompatibilityProfile({
    provider,
    model: 'muse-one',
    modelSpec: { compat_profile: 'openai' },
    globalOverrides: [{ provider: 'foo', model_pattern: 'muse-*', profile: 'deepseek' }],
  }), 'openai');
  assert.equal(resolveCompatibilityProfile({
    provider,
    model: 'muse-one',
    globalOverrides: [{ provider: 'foo', model_pattern: 'muse-*', profile: 'deepseek' }],
  }), 'muse');
  assert.equal(resolveCompatibilityProfile({
    provider: { ...provider, model_compatibility: [] },
    model: 'muse-one',
    globalOverrides: [{ provider: 'foo', model_pattern: 'muse-*', profile: 'deepseek' }],
  }), 'deepseek');
});

test('openai-auto 能按动态模型名分类', () => {
  const provider = { id: 'cpa', compat_profile: 'openai-auto' };
  assert.equal(resolveCompatibilityProfile({ provider, model: 'gpt-5.6-sol' }), 'openai');
  assert.equal(resolveCompatibilityProfile({ provider, model: 'codex-new-model' }), 'openai');
  assert.equal(resolveCompatibilityProfile({ provider, model: 'deepseek-v4-flash' }), 'deepseek');
  assert.equal(resolveCompatibilityProfile({ provider, model: 'claude-sonnet' }), 'passthrough');
});

test('简单星号 wildcard 不会误匹配其他模型', () => {
  assert.equal(matchWildcard('muse-*', 'muse-spark'), true);
  assert.equal(matchWildcard('muse-*', 'deepseek-muse'), false);
  assert.equal(matchWildcard('gpt-*', 'gpt-5.6'), true);
  assert.equal(matchWildcard('gpt-*', 'gptx-5.6'), false);
});

test('compatibility_overrides 校验字段和 profile', () => {
  assert.deepEqual(validateCompatibilityOverrides([
    { provider: 'foo', model_pattern: 'muse-*', profile: 'muse' },
  ]), [
    { provider: 'foo', model_pattern: 'muse-*', profile: 'muse' },
  ]);
  assert.throws(
    () => validateCompatibilityOverrides([{ provider: 'foo', model_pattern: 'x', profile: 'missing' }]),
    /profile 无效/,
  );
});
