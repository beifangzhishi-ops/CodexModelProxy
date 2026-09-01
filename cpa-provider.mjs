// CPA 兼容导出层。
// 新代码应使用 provider-registry.mjs 和 model-discovery.mjs；这里仅保留旧调用方接口。

import {
  createModelDiscovery,
  normalizeDiscoveredModels,
} from './model-discovery.mjs';

const DEFAULT_CACHE_TTL_SECONDS = 60;

export function loadCpaConfig(env = process.env, secrets = {}) {
  const baseUrl = String(env.CPA_BASE_URL || '').trim();
  const apiKey = String(env.CPA_API_KEY || secrets.CPA_API_KEY || '').trim();

  if (!baseUrl && !apiKey) return { enabled: false };
  if (!baseUrl) throw new Error('已配置 CPA_API_KEY，但缺少 CPA_BASE_URL');
  if (!apiKey) throw new Error('已配置 CPA_BASE_URL，但缺少 CPA_API_KEY');

  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error(`CPA_BASE_URL 无效：${baseUrl}`);
  }
  if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) {
    throw new Error(`CPA_BASE_URL 仅支持 http 或 https：${parsedBaseUrl.protocol}`);
  }

  const rawTtl = env.CPA_MODELS_CACHE_TTL_SECONDS;
  const ttlSeconds = rawTtl === undefined || String(rawTtl).trim() === ''
    ? DEFAULT_CACHE_TTL_SECONDS
    : Number(rawTtl);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('CPA_MODELS_CACHE_TTL_SECONDS 必须是正整数');
  }

  return {
    enabled: true,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    cacheTtlMs: ttlSeconds * 1000,
  };
}

export function createCpaModelCatalog({
  config,
  logger = console,
  fetchModels,
  resolveProxy = async () => ({ url: '', mode: 'direct' }),
}) {
  const provider = {
    id: 'cpa',
    enabled: true,
    base_url: config.baseUrl,
    api_key: config.apiKey,
    auth_mode: 'api_key',
    model_prefix: 'cpa/',
    discovery: {
      cache_ttl_seconds: config.cacheTtlMs / 1000,
    },
    // 旧兼容测试要求每次过期失败后立即允许下一次尝试。
    failure_cooldown_ms: 0,
  };
  return createModelDiscovery({
    provider,
    logger,
    resolveProxy,
    ...(fetchModels
      ? { fetchModels: async (_provider, proxy) => fetchModels(config, proxy) }
      : {}),
  });
}

export function normalizeCpaModels(models) {
  return normalizeDiscoveredModels(models, { id: 'cpa', model_prefix: 'cpa/' })
    .map(({
      upstream_model: _upstreamModel,
      provider_id: _providerId,
      provider_label: _providerLabel,
      ...model
    }) => model);
}
