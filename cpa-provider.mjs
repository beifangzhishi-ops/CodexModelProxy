import http from 'node:http';
import https from 'node:https';
import { createProxyAgent } from './proxy-agent.mjs';

const DEFAULT_CACHE_TTL_SECONDS = 60;
const MODEL_LIST_TIMEOUT_MS = 10000;
const MAX_MODEL_LIST_BYTES = 8 * 1024 * 1024;

export function loadCpaConfig(env = process.env, secrets = {}) {
  const baseUrl = String(env.CPA_BASE_URL || '').trim();
  const apiKey = String(env.CPA_API_KEY || secrets.CPA_API_KEY || '').trim();

  if (!baseUrl && !apiKey) {
    return { enabled: false };
  }
  if (!baseUrl) {
    throw new Error('已配置 CPA_API_KEY，但缺少 CPA_BASE_URL');
  }
  if (!apiKey) {
    throw new Error('已配置 CPA_BASE_URL，但缺少 CPA_API_KEY');
  }

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
  fetchModels = requestCpaModels,
  resolveProxy = async () => ({ url: '', mode: 'direct' }),
}) {
  let cachedModels = [];
  let refreshedAt = 0;
  let refreshPromise = null;

  return {
    async getModels() {
      if (!config.enabled) return [];
      if (refreshedAt > 0 && Date.now() - refreshedAt < config.cacheTtlMs) {
        return cachedModels;
      }
      if (!refreshPromise) {
        refreshPromise = Promise.resolve()
          .then(() => resolveProxy())
          .then((proxy) => fetchModels(config, proxy))
          .then((models) => {
            cachedModels = normalizeCpaModels(models);
            refreshedAt = Date.now();
            return cachedModels;
          })
          .catch((err) => {
            const fallback = refreshedAt > 0 ? '使用最近缓存' : '暂无缓存';
            logger.warn(`[codex-proxy] CPA 模型同步失败，${fallback}：${err.message}`);
            return cachedModels;
          })
          .finally(() => {
            refreshPromise = null;
          });
      }
      return refreshPromise;
    },
  };
}

export function normalizeCpaModels(models) {
  if (!Array.isArray(models)) {
    throw new Error('CPA /models 响应缺少 data 或 models 数组');
  }
  const seen = new Set();
  const normalized = [];
  for (const item of models) {
    const source = typeof item === 'string' ? { id: item } : item;
    const id = source && typeof source.id === 'string' ? source.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push({
      ...source,
      id: `cpa/${id}`,
      object: source.object || 'model',
      owned_by: source.owned_by || 'cpa',
    });
  }
  return normalized;
}

function requestCpaModels(config, proxy) {
  return new Promise((resolve, reject) => {
    const upstreamUrl = new URL(`${config.baseUrl}/models`);
    const lib = upstreamUrl.protocol === 'https:' ? https : http;
    const agent = upstreamUrl.protocol === 'https:' && proxy?.url
      ? createProxyAgent(proxy.url)
      : undefined;
    const outgoing = lib.request(upstreamUrl, {
      method: 'GET',
      agent,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        accept: 'application/json',
        'user-agent': 'codexmodelproxy/1.0',
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_MODEL_LIST_BYTES) {
          reject(new Error('CPA 模型列表响应过大'));
          res.destroy();
          outgoing.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode || 500) >= 400) {
          reject(new Error(`CPA /models 返回 HTTP ${res.statusCode || 500}`));
          return;
        }
        try {
          const payload = JSON.parse(raw);
          resolve(Array.isArray(payload.data) ? payload.data : payload.models);
        } catch (err) {
          reject(new Error(`CPA /models 响应解析失败：${err.message}`));
        }
      });
      res.on('error', reject);
    });
    outgoing.setTimeout(MODEL_LIST_TIMEOUT_MS, () => {
      outgoing.destroy(new Error('CPA 模型列表请求超时'));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}
