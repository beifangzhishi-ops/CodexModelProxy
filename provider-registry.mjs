// Provider Registry：集中管理 Provider 连接、静态模型、别名和认证来源。
// 本模块不发起网络请求；模型发现由 model-discovery.mjs 负责。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelDiscovery } from './model-discovery.mjs';
import {
  isValidCompatibilityProfile,
  validateCompatibilityOverrides,
  validateRouteCompatibility,
} from './compatibility-profiles.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_PROVIDERS_FILE = path.join(__dirname, 'providers.local.json');
export const DEFAULT_LOCAL_ENV_FILE = path.join(__dirname, 'proxy-local.env');
export const SUPPORTED_AUTH_MODES = new Set(['api_key', 'openai_passthrough', 'none']);
export const SUPPORTED_PROTOCOLS = new Set(['responses']);
export const RESERVED_PROVIDER_NAMESPACES = new Set(['direct']);

const LEGACY_PROVIDER_KEY_ENV = Object.freeze({
  cpa: 'CPA_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  zai: 'ZAI_API_KEY',
});

export function parseEnvFile(raw) {
  const values = {};
  for (const sourceLine of String(raw || '').split(/\r?\n/)) {
    let line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export function loadRuntimeEnv({
  env = process.env,
  envFile = env.PROXY_LOCAL_ENV_FILE || DEFAULT_LOCAL_ENV_FILE,
} = {}) {
  let fileValues = {};
  try {
    fileValues = parseEnvFile(fs.readFileSync(path.resolve(envFile), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`无法读取本地环境配置：${envFile}（${err.message}）`);
    }
  }
  // process.env 是显式覆盖层；文件值只补充未设置的变量。
  return { ...fileValues, ...env };
}

export function loadProviderFile(file = DEFAULT_PROVIDERS_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(path.resolve(file), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { providers: {} };
    throw new Error(`无法读取 Provider 配置：${file}（${err.message}）`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Provider 配置 JSON 无效：${file}（${err.message}）`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Provider 配置顶层必须是对象：${file}`);
  }
  if (parsed.providers === undefined) parsed.providers = {};
  if (!parsed.providers || typeof parsed.providers !== 'object' || Array.isArray(parsed.providers)) {
    throw new Error('Provider 配置的 providers 必须是对象');
  }
  return parsed;
}

export function resolveProviderApiKey(provider, env = {}, secrets = {}) {
  const envName = provider.api_key_env || provider.key_env || LEGACY_PROVIDER_KEY_ENV[provider.id];
  const explicit = envName ? env[envName] : undefined;
  if (explicit !== undefined && String(explicit).trim()) return String(explicit).trim();
  if (provider.api_key !== undefined && provider.api_key !== null && String(provider.api_key).trim()) {
    return String(provider.api_key).trim();
  }
  const secretValue = envName ? secrets[envName] : undefined;
  if (secretValue !== undefined && String(secretValue).trim()) return String(secretValue).trim();
  return '';
}

export function resolveRouteApiKey(route, env = {}, secrets = {}) {
  const explicit = String(route?.api_key || '').trim();
  if (explicit) return explicit;

  const envName = String(route?.api_key_env || '').trim();
  if (envName) {
    const value = env[envName] ?? secrets[envName];
    if (value !== undefined && String(value).trim()) return String(value).trim();
  }

  return String(route?.provider_api_key || '').trim();
}

export function validateProvider(providerId, raw, {
  resolvedApiKey = '',
  allowMissingBaseUrl = false,
  validateCredentials = true,
} = {}) {
  if (typeof providerId !== 'string' || !providerId.trim()) {
    throw new Error('Provider id 必须是非空字符串');
  }
  const id = providerId.trim();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Provider ${id} 配置必须是对象`);
  }
  const enabled = raw.enabled !== false;
  const authMode = raw.auth_mode || 'api_key';
  const protocol = raw.protocol || 'responses';
  const baseUrl = String(raw.base_url || '').trim();
  const namespace = normalizeNamespace(raw.model_prefix || `${id}/`, id);

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error(`Provider ${id} 字段 enabled 必须是布尔值`);
  }

  if (!SUPPORTED_AUTH_MODES.has(authMode)) {
    throw new Error(`Provider ${id} 字段 auth_mode 无效：${authMode}；可选 api_key、openai_passthrough、none`);
  }
  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    throw new Error(`Provider ${id} 字段 protocol 不支持：${protocol}；当前仅支持 responses`);
  }
  if (enabled && !baseUrl && !allowMissingBaseUrl) {
    throw new Error(`Provider ${id} 缺少 base_url；请在 providers.local.json 中填写 API 根地址`);
  }
  if (baseUrl) {
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error(`Provider ${id} 字段 base_url 无效：${baseUrl}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Provider ${id} 字段 base_url 仅支持 http 或 https：${parsed.protocol}`);
    }
  }
  if (validateCredentials && enabled && authMode === 'api_key' && !resolvedApiKey) {
    const keyHint = raw.api_key_env || raw.key_env || LEGACY_PROVIDER_KEY_ENV[id] || '对应密钥字段';
    throw new Error(`Provider ${id} 缺少 API key；请在 providers.local.json 填 api_key，或提供 ${keyHint}`);
  }
  if (!isValidCompatibilityProfile(raw.compat_profile || 'passthrough')) {
    throw new Error(`Provider ${id} 字段 compat_profile 无效：${raw.compat_profile || '(空)'}`);
  }
  if (raw.discover_models !== undefined && typeof raw.discover_models !== 'boolean') {
    throw new Error(`Provider ${id} 字段 discover_models 必须是布尔值`);
  }
  if (raw.discovery !== undefined && (!raw.discovery || typeof raw.discovery !== 'object' || Array.isArray(raw.discovery))) {
    throw new Error(`Provider ${id} 字段 discovery 必须是对象`);
  }
  if (raw.network !== undefined && !['default', 'direct', 'system'].includes(raw.network)) {
    throw new Error(`Provider ${id} 字段 network 无效：${raw.network}`);
  }
  if (raw.models !== undefined && !isModelMap(raw.models)) {
    throw new Error(`Provider ${id} 字段 models 必须是对象或数组`);
  }
  if (raw.model_overrides !== undefined && !isModelMap(raw.model_overrides)) {
    throw new Error(`Provider ${id} 字段 model_overrides 必须是对象或数组`);
  }
  validateProviderDiscoverySettings(id, raw);
  validateProviderCompatibilityOverrides(id, raw.model_compatibility);

  return {
    ...raw,
    id,
    enabled,
    base_url: baseUrl.replace(/\/+$/, ''),
    auth_mode: authMode,
    protocol,
    discover_models: raw.discover_models === true,
    model_prefix: `${namespace}/`,
    namespace,
    compat_profile: raw.compat_profile || 'passthrough',
    network: raw.network || 'default',
    api_key_env: raw.api_key_env || raw.key_env || LEGACY_PROVIDER_KEY_ENV[id] || '',
    api_key: resolvedApiKey,
    strip_client_credentials: raw.strip_client_credentials === undefined
      ? authMode === 'api_key'
      : Boolean(raw.strip_client_credentials),
    models: normalizeModelMap(raw.models),
    model_overrides: normalizeModelOverrides(raw.model_overrides, id),
    model_compatibility: normalizePatternOverrides(raw.model_compatibility),
  };
}

export function createProviderRegistry({
  config = {},
  localConfig = { providers: {} },
  env = {},
  secrets = {},
  logger = console,
  resolveProxy = async () => ({ url: '', mode: 'direct' }),
  discoveryFetchModels,
  discoveryFactory = createModelDiscovery,
  validateCredentials = true,
  includeOptionalProviders = false,
} = {}) {
  const legacy = collectLegacyProviders(config.models || {});
  if (config.providers !== undefined && (!config.providers || typeof config.providers !== 'object' || Array.isArray(config.providers))) {
    throw new Error('proxy-config.json 的 providers 必须是对象');
  }
  if (config.aliases !== undefined && (!config.aliases || typeof config.aliases !== 'object' || Array.isArray(config.aliases))) {
    throw new Error('proxy-config.json 的 aliases 必须是对象');
  }
  const configuredProviders = config.providers || {};
  const localProviders = localConfig?.providers || {};
  if (!localConfig || typeof localConfig !== 'object' || Array.isArray(localConfig) || !localConfig.providers || typeof localConfig.providers !== 'object' || Array.isArray(localConfig.providers)) {
    throw new Error('Provider 配置的 providers 必须是对象');
  }
  const providerIds = new Set([
    ...Object.keys(legacy.providers),
    ...Object.keys(configuredProviders),
    ...Object.keys(localProviders),
  ]);

  // 旧 CPA 环境变量只作为迁移兼容层，且显式环境变量优先于 JSON 文件。
  if (env.CPA_BASE_URL || env.CPA_API_KEY || secrets.CPA_API_KEY) providerIds.add('cpa');
  if (includeOptionalProviders && !providerIds.has('cpa')) providerIds.add('cpa');

  const globalOverrides = validateCompatibilityOverrides(config.compatibility_overrides);
  const providers = new Map();
  const namespaces = new Map();
  const legacyRoutes = new Map(Object.entries(config.models || {}));
  const staticModels = new Map();

  for (const providerId of providerIds) {
    const legacyProvider = legacy.providers[providerId] || {};
    const trackedProvider = configuredProviders[providerId] || {};
    const localProvider = localProviders[providerId] || {};
    const raw = mergeProvider(
      mergeProvider(legacyProvider, trackedProvider),
      localProvider,
    );
    if (providerId === 'cpa') {
      const hasExplicitConfig = Object.keys(raw).length > 0;
      if (env.CPA_BASE_URL !== undefined) raw.base_url = env.CPA_BASE_URL;
      raw.api_key_env = raw.api_key_env || 'CPA_API_KEY';
      if (raw.discover_models === undefined) raw.discover_models = true;
      if (raw.model_prefix === undefined) raw.model_prefix = 'cpa/';
      if (raw.compat_profile === undefined) raw.compat_profile = 'openai-auto';
      if (raw.display_name === undefined) raw.display_name = 'CPA';
      if (!hasExplicitConfig && !raw.base_url && !env.CPA_BASE_URL && !env.CPA_API_KEY && !secrets.CPA_API_KEY) {
        raw.enabled = false;
        raw.disabled_message = 'CPA 未配置：请同时设置 CPA_BASE_URL 与 CPA_API_KEY';
      }
    }
    const apiKey = resolveProviderApiKey({ ...raw, id: providerId }, env, secrets);
    const provider = validateProvider(providerId, raw, {
      resolvedApiKey: apiKey,
      allowMissingBaseUrl: raw.enabled === false,
      validateCredentials,
    });
    if (namespaces.has(provider.namespace)) {
      throw new Error(
        `Provider ${providerId} 的 model_prefix 与 Provider ${namespaces.get(provider.namespace)} 冲突：${provider.model_prefix}`,
      );
    }
    if (providerId === 'direct') {
      throw new Error('Provider id direct 是保留名称，不能作为新 Provider');
    }
    if (RESERVED_PROVIDER_NAMESPACES.has(provider.namespace)) {
      // direct 是旧请求前缀，不允许新 Provider 占用；cpa 在迁移期明确保留。
      throw new Error(`Provider ${providerId} 的 model_prefix 使用保留命名空间：${provider.namespace}/`);
    }
    providers.set(providerId, provider);
    namespaces.set(provider.namespace, providerId);
  }

  // 旧 route 迁移为 Provider 静态模型；已有新配置优先，旧 route 只补缺项。
  for (const [slug, route] of Object.entries(config.models || {})) {
    const providerId = legacy.routeProviders.get(slug);
    const provider = providers.get(providerId);
    if (!provider) continue;
    const upstreamModel = String(route.upstream_model || slug).trim();
    const existing = provider.models[upstreamModel];
    if (!existing) {
      provider.models[upstreamModel] = {
        ...route,
        upstream_model: upstreamModel,
        legacy_slugs: [slug],
      };
    } else if (!Array.isArray(existing.legacy_slugs) || !existing.legacy_slugs.includes(slug)) {
      existing.legacy_slugs = [...(existing.legacy_slugs || []), slug];
    }
  }

  for (const provider of providers.values()) {
    if (!provider.enabled) continue;
    for (const [modelName, modelSpec] of Object.entries(provider.models)) {
      const normalizedModelName = normalizeModelName(modelName, provider.id);
      const spec = normalizeModelSpec(modelName, modelSpec, provider.id);
      if (spec.enabled === false) continue;
      const canonical = `${provider.model_prefix}${normalizedModelName}`;
      staticModels.set(canonical, { provider, modelName: normalizedModelName, spec });
    }
  }

  const aliases = new Map();
  for (const [alias, target] of Object.entries(config.aliases || {})) {
    if (typeof alias !== 'string' || !alias.trim() || typeof target !== 'string' || !target.trim()) {
      throw new Error('aliases 的键和值必须是非空字符串');
    }
    aliases.set(alias.trim(), target.trim());
  }
  for (const [slug, route] of Object.entries(config.models || {})) {
    const providerId = legacy.routeProviders.get(slug);
    const provider = providers.get(providerId);
    if (!provider) continue;
    const upstreamModel = String(route.upstream_model || slug).trim();
    const canonical = `${provider.model_prefix}${upstreamModel}`;
    if (!aliases.has(slug)) aliases.set(slug, canonical);
    for (const legacySlug of route.legacy_slugs || []) {
      if (!aliases.has(legacySlug)) aliases.set(legacySlug, canonical);
    }
    const directSlug = `direct/${slug}`;
    const directRouteSlug = config.models[`${slug}-direct`] ? `${slug}-direct` : slug;
    const directProviderId = legacy.routeProviders.get(directRouteSlug) || providerId;
    const directProvider = providers.get(directProviderId) || provider;
    const directRoute = config.models[directRouteSlug] || route;
    const directCanonical = `${directProvider.model_prefix}${String(directRoute.upstream_model || directRouteSlug).trim()}`;
    if (!aliases.has(directSlug)) aliases.set(directSlug, directCanonical);
  }
  validateAliasGraph(aliases, providers, staticModels);

  const discoveries = new Map();
  for (const provider of providers.values()) {
    if (!provider.enabled || !provider.discover_models) continue;
    discoveries.set(provider.id, discoveryFactory({
      provider,
      logger,
      resolveProxy: () => resolveProxy(provider.id, provider.network),
      ...(discoveryFetchModels ? { fetchModels: discoveryFetchModels } : {}),
    }));
  }

  return {
    config,
    providers,
    namespaces,
    aliases,
    legacyRoutes,
    legacyRouteProviders: legacy.routeProviders,
    staticModels,
    discoveries,
    globalOverrides,
    getProvider(id) {
      return providers.get(id) || null;
    },
    getProviderByNamespace(namespace) {
      const providerId = namespaces.get(namespace);
      return providerId ? providers.get(providerId) : null;
    },
    getStaticModel(canonical) {
      return staticModels.get(canonical) || null;
    },
    getDiscovery(providerId) {
      return discoveries.get(providerId) || null;
    },
    listProviders() {
      return [...providers.values()];
    },
    knownLegacySlugs() {
      return [...legacyRoutes.keys()];
    },
    visibleLegacySlugs() {
      return [...legacyRoutes.keys()].filter((slug) => {
        const providerId = legacy.routeProviders.get(slug);
        return providers.get(providerId)?.enabled === true;
      });
    },
    knownCanonicalModels() {
      return [...staticModels.keys()];
    },
    async discoverAll() {
      const lists = await Promise.all(
        [...discoveries.entries()].map(async ([providerId, discovery]) => ({
          providerId,
          models: await discovery.getModels(),
        })),
      );
      return lists.flatMap((item) => item.models);
    },
  };
}

function collectLegacyProviders(routes) {
  const providers = {};
  const routeProviders = new Map();
  for (const [slug, route] of Object.entries(routes)) {
    const providerId = inferLegacyProviderId(slug, route);
    routeProviders.set(slug, providerId);
    if (!providers[providerId]) {
      const profile = inferProfileFromRoute(route);
      providers[providerId] = {
        enabled: true,
        base_url: route.upstream_base_url,
        auth_mode: route.auth_mode || 'api_key',
        protocol: 'responses',
        discover_models: false,
        model_prefix: `${providerId}/`,
        compat_profile: profile,
        network: route.network || 'default',
        ...(route.api_key_env ? { api_key_env: route.api_key_env } : {}),
        strip_client_credentials: route.provider === 'cpa' || route.provider_id === 'cpa',
        models: {},
      };
    }
  }
  return { providers, routeProviders };
}

function inferLegacyProviderId(slug, route) {
  if (route.provider_id && route.provider_id !== 'direct') return String(route.provider_id);
  if (route.provider && route.provider !== 'direct') return String(route.provider);
  if (route.auth_mode === 'openai_passthrough') return 'chatgpt';
  if (route.api_key_env === 'OPENCODE_API_KEY') return 'opencode';
  if (route.api_key_env === 'DEEPSEEK_API_KEY') return 'deepseek';
  if (route.api_key_env === 'ZAI_API_KEY') return 'zai';
  if (route.api_key_env === 'CPA_API_KEY' || slug.startsWith('cpa/')) return 'cpa';
  return 'legacy';
}

function inferProfileFromRoute(route) {
  if (route.compat_profile) return route.compat_profile;
  if (route.tool_schema_compat === 'muse') return 'muse';
  if (route.reasoning_format === 'deepseek_plaintext') return 'deepseek';
  if (route.reasoning_format === 'openai_encrypted') return 'openai';
  return 'passthrough';
}

function mergeProvider(base, override) {
  const result = { ...(base || {}), ...(override || {}) };
  if (base?.models !== undefined || override?.models !== undefined) {
    result.models = mergeModelMaps(base?.models, override?.models);
  }
  if (base?.model_overrides !== undefined || override?.model_overrides !== undefined) {
    result.model_overrides = mergeModelMaps(base?.model_overrides, override?.model_overrides);
  }
  if (base?.discovery !== undefined || override?.discovery !== undefined) {
    result.discovery = { ...(base?.discovery || {}), ...(override?.discovery || {}) };
  }
  if (override?.model_compatibility !== undefined) result.model_compatibility = override.model_compatibility;
  return result;
}

function mergeModelMaps(baseValue, overrideValue) {
  return {
    ...normalizeModelMap(baseValue),
    ...normalizeModelMap(overrideValue),
  };
}

function normalizeNamespace(raw, providerId) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value || value.includes('/')) {
    throw new Error(`Provider ${providerId} 字段 model_prefix 必须是单层非空命名空间，例如 ${providerId}/`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Provider ${providerId} 字段 model_prefix 含有非法字符：${value}/`);
  }
  return value;
}

function normalizeModelName(name, providerId) {
  const value = String(name || '').trim();
  if (!value) throw new Error(`Provider ${providerId} 存在空模型名`);
  return value;
}

function normalizeModelMap(value) {
  if (value === undefined) return {};
  if (Array.isArray(value)) {
    return Object.fromEntries(value.flatMap((item) => {
      if (typeof item === 'string') return [[item, {}]];
      if (!item || typeof item !== 'object') return [];
      const name = item.name || item.id || item.slug || item.model || item.upstream_model;
      if (!name) return [];
      const spec = { ...item };
      delete spec.name;
      delete spec.id;
      delete spec.slug;
      delete spec.model;
      return [[String(name), spec]];
    }));
  }
  return { ...value };
}

function isModelMap(value) {
  return Array.isArray(value) || (value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeModelSpec(modelName, raw, providerId) {
  const spec = typeof raw === 'string' ? { upstream_model: raw } : { ...(raw || {}) };
  const label = `Provider ${providerId} 模型 ${modelName}`;
  validateModelSpecFields(spec, label);
  if (spec.enabled === false) return { ...spec, upstream_model: spec.upstream_model || modelName };
  const upstreamModel = String(spec.upstream_model || modelName).trim();
  if (!upstreamModel) throw new Error(`Provider ${providerId} 模型 ${modelName} 缺少 upstream_model`);
  return { ...spec, upstream_model: upstreamModel };
}

function normalizeModelOverrides(value, providerId) {
  const map = normalizeModelMap(value);
  const result = {};
  for (const [pattern, raw] of Object.entries(map)) {
    const normalizedPattern = String(pattern).trim();
    if (!normalizedPattern) {
      throw new Error(`Provider ${providerId} 存在空 model override`);
    }
    const spec = typeof raw === 'string' ? { upstream_model: raw } : { ...(raw || {}) };
    validateModelSpecFields(spec, `Provider ${providerId} model_overrides.${normalizedPattern}`);
    result[normalizedPattern] = spec;
  }
  return result;
}

function validateModelSpecFields(spec, label) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`${label} 必须是对象`);
  }
  if (spec.enabled !== undefined && typeof spec.enabled !== 'boolean') {
    throw new Error(`${label} enabled 必须是布尔值`);
  }
  if (spec.compat_profile !== undefined && !isValidCompatibilityProfile(spec.compat_profile)) {
    throw new Error(`${label} compat_profile 无效：${spec.compat_profile}`);
  }
  if (spec.reasoning_format || spec.tool_output_format) {
    validateRouteCompatibility({
      reasoning_format: spec.reasoning_format || 'passthrough',
      tool_output_format: spec.tool_output_format || 'passthrough',
    }, label);
  }
  if (spec.auth_mode !== undefined && !SUPPORTED_AUTH_MODES.has(spec.auth_mode)) {
    throw new Error(`${label} auth_mode 无效：${spec.auth_mode}`);
  }
  if (spec.network !== undefined && !['default', 'direct', 'system'].includes(spec.network)) {
    throw new Error(`${label} network 无效：${spec.network}`);
  }
  for (const field of ['timeout_ms', 'upstream_timeout_ms']) {
    if (spec[field] !== undefined) {
      const value = Number(spec[field]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${label} ${field} 必须是正整数`);
      }
    }
  }
  if (spec.api_key_env !== undefined && (typeof spec.api_key_env !== 'string' || !spec.api_key_env.trim())) {
    throw new Error(`${label} api_key_env 必须是非空字符串`);
  }
  if (spec.upstream_model !== undefined && (typeof spec.upstream_model !== 'string' || !spec.upstream_model.trim())) {
    throw new Error(`${label} upstream_model 必须是非空字符串`);
  }
  if (spec.upstream_base_url !== undefined) {
    let parsed;
    try {
      parsed = new URL(spec.upstream_base_url);
    } catch {
      throw new Error(`${label} upstream_base_url 无效`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`${label} upstream_base_url 仅支持 http/https`);
    }
  }
  if (
    spec.strip_client_credentials !== undefined &&
    typeof spec.strip_client_credentials !== 'boolean'
  ) {
    throw new Error(`${label} strip_client_credentials 必须是布尔值`);
  }
  if (spec.tool_schema_compat !== undefined && spec.tool_schema_compat !== 'muse') {
    throw new Error(`${label} tool_schema_compat 无效：${spec.tool_schema_compat}`);
  }
}

function normalizePatternOverrides(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({ ...item }));
}

function validateProviderCompatibilityOverrides(providerId, value) {
  if (value === undefined) return;
  validateCompatibilityOverrides(value, `Provider ${providerId} model_compatibility`);
}

function validateProviderDiscoverySettings(providerId, provider) {
  const discovery = provider.discovery || {};
  for (const [name, fallback] of [
    ['cache_ttl_seconds', 60],
    ['failure_cooldown_seconds', 30],
    ['timeout_ms', 10000],
    ['max_response_bytes', 8 * 1024 * 1024],
  ]) {
    const value = discovery[name] === undefined ? fallback : Number(discovery[name]);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Provider ${providerId} discovery.${name} 必须是正整数`);
    }
  }
}

function validateAliasGraph(aliases, providers, staticModels) {
  for (const [alias, target] of aliases) {
    if (alias === target) throw new Error(`alias ${alias} 不能指向自身`);
    const chain = new Set([alias]);
    let current = target;
    while (aliases.has(current)) {
      if (chain.has(current)) {
        throw new Error(`alias 存在循环：${[...chain, current].join(' -> ')}`);
      }
      chain.add(current);
      current = aliases.get(current);
    }
    validateModelTarget(current, providers, staticModels, alias);
  }
}

function validateModelTarget(target, providers, staticModels, alias) {
  const slash = target.indexOf('/');
  if (slash <= 0 || slash === target.length - 1) {
    throw new Error(`alias ${alias} 的目标无效：${target}`);
  }
  const namespace = target.slice(0, slash);
  const modelName = target.slice(slash + 1);
  const provider = [...providers.values()].find((item) => item.namespace === namespace);
  if (!provider) throw new Error(`alias ${alias} 指向未知 Provider 命名空间：${namespace}`);
  if (!provider.enabled) {
    if (!provider.discover_models && !Object.prototype.hasOwnProperty.call(provider.models || {}, modelName)) {
      throw new Error(`alias ${alias} 指向未配置的静态模型：${target}`);
    }
    return;
  }
  if (!provider.discover_models && !staticModels.has(target)) {
    throw new Error(`alias ${alias} 指向未配置的静态模型：${target}`);
  }
}
