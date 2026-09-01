// Provider 的兼容策略定义。具体的 Responses 历史整理仍由 history-normalize.mjs 执行。

import {
  isValidReasoningFormat,
  isValidToolOutputFormat,
} from './history-normalize.mjs';

export const COMPATIBILITY_PROFILES = Object.freeze({
  openai: Object.freeze({
    reasoning_format: 'openai_encrypted',
    tool_output_format: 'passthrough',
  }),
  deepseek: Object.freeze({
    reasoning_format: 'deepseek_plaintext',
    tool_output_format: 'json_string',
  }),
  passthrough: Object.freeze({
    reasoning_format: 'passthrough',
    tool_output_format: 'passthrough',
  }),
  muse: Object.freeze({
    reasoning_format: 'openai_encrypted',
    tool_output_format: 'passthrough',
    tool_schema_compat: 'muse',
  }),
});

// openai-auto 不是新的线协议，而是根据动态模型名选择已有 profile 的策略。
export const SPECIAL_COMPATIBILITY_PROFILES = new Set(['openai-auto']);
export const VALID_COMPATIBILITY_PROFILES = new Set([
  ...Object.keys(COMPATIBILITY_PROFILES),
  ...SPECIAL_COMPATIBILITY_PROFILES,
]);

export function isValidCompatibilityProfile(value) {
  return typeof value === 'string' && VALID_COMPATIBILITY_PROFILES.has(value);
}

export function getCompatibilityProfile(name) {
  if (!isValidCompatibilityProfile(name) || SPECIAL_COMPATIBILITY_PROFILES.has(name)) {
    return null;
  }
  return COMPATIBILITY_PROFILES[name];
}

export function matchWildcard(pattern, value) {
  if (typeof pattern !== 'string' || typeof value !== 'string') return false;
  const escaped = pattern.replace(/[.+^${}()|[\\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

export function resolveCompatibilityProfile({
  provider,
  model,
  modelSpec = {},
  globalOverrides = [],
} = {}) {
  const providerId = provider?.id || '';
  const candidates = [];

  if (modelSpec.compat_profile) {
    candidates.push({ kind: 'exact', profile: modelSpec.compat_profile });
  }

  const providerModelOverrides = Array.isArray(provider?.model_compatibility)
    ? provider.model_compatibility
    : [];
  const providerOverride = findPatternOverride(providerModelOverrides, model);
  if (providerOverride) candidates.push({ kind: 'provider-pattern', profile: providerOverride });

  const globalOverride = findGlobalOverride(globalOverrides, providerId, model);
  if (globalOverride) candidates.push({ kind: 'global-pattern', profile: globalOverride });

  let selected = candidates[0]?.profile || provider?.compat_profile || 'passthrough';
  if (selected === 'openai-auto') {
    selected = classifyOpenAiAutoModel(model, provider?.compat_profile);
  }
  if (!getCompatibilityProfile(selected)) {
    throw new Error(`Provider ${providerId || '(unknown)'} 的 compatibility profile 无效：${selected}`);
  }
  return selected;
}

export function applyCompatibilityProfile(route, profileName) {
  const profile = getCompatibilityProfile(profileName);
  if (!profile) {
    throw new Error(`compatibility profile 无效：${profileName}`);
  }
  return {
    ...route,
    compat_profile: profileName,
    reasoning_format: route.reasoning_format || profile.reasoning_format,
    tool_output_format: route.tool_output_format || profile.tool_output_format,
    ...(route.tool_schema_compat || !profile.tool_schema_compat
      ? {}
      : { tool_schema_compat: profile.tool_schema_compat }),
  };
}

export function validateCompatibilityOverrides(overrides, label = 'compatibility_overrides') {
  if (overrides === undefined) return [];
  if (!Array.isArray(overrides)) {
    throw new Error(`${label} 必须是数组`);
  }
  return overrides.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`${label}[${index}] 必须是对象`);
    }
    const modelPattern = item.model_pattern || item.pattern;
    if (typeof modelPattern !== 'string' || !modelPattern.trim()) {
      throw new Error(`${label}[${index}] 缺少 model_pattern`);
    }
    if (!isValidCompatibilityProfile(item.profile)) {
      throw new Error(`${label}[${index}] profile 无效：${item.profile || '(空)'}`);
    }
    if (label === 'compatibility_overrides' && (typeof item.provider !== 'string' || !item.provider.trim())) {
      throw new Error(`${label}[${index}] 缺少 provider`);
    }
    return {
      ...item,
      model_pattern: modelPattern.trim(),
      profile: item.profile,
      ...(item.provider ? { provider: item.provider.trim() } : {}),
    };
  });
}

function findPatternOverride(overrides, model) {
  for (const item of overrides) {
    if (item && matchWildcard(item.pattern || item.model_pattern, model)) {
      return item.profile;
    }
  }
  return '';
}

function findGlobalOverride(overrides, providerId, model) {
  for (const item of overrides) {
    if (
      item &&
      item.provider === providerId &&
      matchWildcard(item.model_pattern, model)
    ) {
      return item.profile;
    }
  }
  return '';
}

function classifyOpenAiAutoModel(model, providerDefault) {
  const name = String(model || '').toLowerCase();
  if (name.startsWith('gpt-') || name.includes('codex')) return 'openai';
  if (name.startsWith('deepseek-')) return 'deepseek';
  if (providerDefault && providerDefault !== 'openai-auto') return providerDefault;
  return 'passthrough';
}

export function validateRouteCompatibility(route, label = 'route') {
  if (!isValidReasoningFormat(route.reasoning_format)) {
    throw new Error(`${label} 的 reasoning_format 无效：${route.reasoning_format || '(空)'}`);
  }
  if (!isValidToolOutputFormat(route.tool_output_format)) {
    throw new Error(`${label} 的 tool_output_format 无效：${route.tool_output_format || '(空)'}`);
  }
}
