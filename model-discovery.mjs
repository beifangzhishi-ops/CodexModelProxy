// 通用 OpenAI-compatible Provider 模型发现。
// 本模块只负责 /models 请求和缓存，不决定模型如何解析或如何转发。

import http from 'node:http';
import https from 'node:https';
import { createProxyAgent } from './proxy-agent.mjs';

export const DEFAULT_DISCOVERY_CACHE_TTL_MS = 60 * 1000;
export const DEFAULT_DISCOVERY_FAILURE_COOLDOWN_MS = 30 * 1000;
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 10 * 1000;
export const DEFAULT_DISCOVERY_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export function createModelDiscovery({
  provider,
  logger = console,
  fetchModels = requestProviderModels,
  resolveProxy = async () => ({ url: '', mode: 'direct' }),
} = {}) {
  const settings = getDiscoverySettings(provider);
  let cachedModels = [];
  let lastSuccessAt = 0;
  let lastAttemptAt = 0;
  let lastFailureAt = 0;
  let refreshPromise = null;

  return {
    async getModels() {
      const now = Date.now();
      if (lastSuccessAt > 0 && now - lastSuccessAt < settings.cacheTtlMs) {
        return cachedModels;
      }
      if (lastFailureAt > 0 && now - lastFailureAt < settings.failureCooldownMs) {
        return cachedModels;
      }
      if (!refreshPromise) {
        lastAttemptAt = now;
        refreshPromise = Promise.resolve()
          .then(() => resolveProxy(provider))
          .then((proxy) => fetchModels(provider, proxy))
          .then((payload) => {
            const models = normalizeDiscoveredModels(payload, provider);
            cachedModels = models;
            lastSuccessAt = Date.now();
            lastFailureAt = 0;
            return cachedModels;
          })
          .catch((err) => {
            lastFailureAt = Date.now();
            const fallback = lastSuccessAt > 0 ? '使用最近缓存' : '暂无缓存';
            logger.warn(
              `[codex-proxy] Provider ${provider.id} 模型同步失败，${fallback}：${err.message}`,
            );
            return cachedModels;
          })
          .finally(() => {
            refreshPromise = null;
          });
      }
      return refreshPromise;
    },
    getState() {
      return {
        cachedCount: cachedModels.length,
        lastSuccessAt,
        lastAttemptAt,
        lastFailureAt,
        refreshing: Boolean(refreshPromise),
      };
    },
  };
}

export function normalizeDiscoveredModels(payload, provider) {
  const rawModels = extractModelArray(payload);
  if (!Array.isArray(rawModels)) {
    throw new Error(`Provider ${provider.id} /models 响应缺少 data 或 models 数组`);
  }
  const prefix = normalizePrefix(provider.model_prefix, provider.id);
  const seen = new Set();
  const normalized = [];
  for (const item of rawModels) {
    const source = typeof item === 'string'
      ? { id: item }
      : item && typeof item === 'object'
        ? item
        : null;
    const rawId = String(source?.id || source?.slug || '').trim();
    if (!rawId) continue;
    const upstreamModel = rawId.startsWith(prefix) ? rawId.slice(prefix.length) : rawId;
    if (!upstreamModel || seen.has(upstreamModel)) continue;
    seen.add(upstreamModel);
    normalized.push({
      ...source,
      id: `${prefix}${upstreamModel}`,
      upstream_model: upstreamModel,
      provider_id: provider.id,
      provider_label: source.provider_label || provider.display_name || provider.id,
      object: source.object || 'model',
      owned_by: source.owned_by || provider.id,
    });
  }
  return normalized;
}

export function extractModelArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.models)) return payload.models;
  return null;
}

export function requestProviderModels(provider, proxy = { url: '', mode: 'direct' }) {
  let endpoint;
  try {
    endpoint = new URL(`${String(provider.base_url).replace(/\/+$/, '')}/models`);
  } catch {
    return Promise.reject(new Error(`Provider ${provider.id} base_url 无效`));
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    return Promise.reject(new Error(`Provider ${provider.id} 不支持的 URL 协议：${endpoint.protocol}`));
  }

  const headers = {
    accept: 'application/json',
    'user-agent': 'codexmodelproxy/1.0',
  };
  if (provider.auth_mode === 'api_key' && provider.api_key) {
    headers.authorization = `Bearer ${provider.api_key}`;
  }
  const lib = endpoint.protocol === 'https:' ? https : http;
  const agent = endpoint.protocol === 'https:' && proxy?.url
    ? createProxyAgent(proxy.url)
    : undefined;
  const requestOptions = { method: 'GET', headers };
  if (agent) requestOptions.agent = agent;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };
    const outgoing = lib.request(endpoint, requestOptions, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > getDiscoverySettings(provider).maxResponseBytes) {
          finish(new Error(`Provider ${provider.id} /models 响应过大`));
          response.destroy();
          outgoing.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const status = response.statusCode || 500;
        const raw = Buffer.concat(chunks).toString('utf8');
        if (status < 200 || status >= 300) {
          finish(new Error(`Provider ${provider.id} /models 返回 HTTP ${status}`));
          return;
        }
        try {
          finish(null, JSON.parse(raw));
        } catch (err) {
          finish(new Error(`Provider ${provider.id} /models 响应解析失败：${err.message}`));
        }
      });
      response.on('error', (err) => finish(err));
    });
    outgoing.setTimeout(getDiscoverySettings(provider).timeoutMs, () => {
      outgoing.destroy(new Error(`Provider ${provider.id} /models 请求超时`));
    });
    outgoing.on('error', (err) => finish(err));
    outgoing.end();
  });
}

function getDiscoverySettings(provider) {
  const discovery = provider?.discovery || {};
  return {
    cacheTtlMs: positiveNumber(
      provider?.cache_ttl_ms,
      discovery.cache_ttl_seconds === undefined
        ? DEFAULT_DISCOVERY_CACHE_TTL_MS
        : Number(discovery.cache_ttl_seconds) * 1000,
    ),
    failureCooldownMs: provider?.failure_cooldown_ms === 0
      ? 0
      : positiveNumber(
        provider?.failure_cooldown_ms,
        discovery.failure_cooldown_seconds === undefined
          ? DEFAULT_DISCOVERY_FAILURE_COOLDOWN_MS
          : Number(discovery.failure_cooldown_seconds) * 1000,
      ),
    timeoutMs: positiveNumber(
      provider?.discovery_timeout_ms,
      discovery.timeout_ms === undefined ? DEFAULT_DISCOVERY_TIMEOUT_MS : Number(discovery.timeout_ms),
    ),
    maxResponseBytes: positiveNumber(
      provider?.discovery_max_response_bytes,
      discovery.max_response_bytes === undefined
        ? DEFAULT_DISCOVERY_MAX_RESPONSE_BYTES
        : Number(discovery.max_response_bytes),
    ),
  };
}

function positiveNumber(preferred, fallback) {
  const value = preferred === undefined ? fallback : Number(preferred);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizePrefix(value, providerId) {
  const prefix = String(value || `${providerId}/`).trim();
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}
