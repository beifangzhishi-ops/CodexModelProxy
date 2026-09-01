// CodexModelProxy 本地中转服务
// 零依赖：仅使用 Node 内置模块。
// 按请求中的 model 将 Codex 的 Responses 请求转发到 OpenCode 或 DeepSeek 上游。
// 安全：不记录提示词、响应正文与 API 密钥；未知模型不访问上游。

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { forwardCompact } from './compact-forward.mjs';
import {
  normalizeResponsesBody,
  isValidReasoningFormat,
  isValidToolOutputFormat,
} from './history-normalize.mjs';
import {
  prepareMuseRequest,
  restoreMuseJsonPayload,
  MuseSseRestoreTransform,
} from './muse-tool-compat.mjs';
import { createHistoryMonitor } from './history-monitor.mjs';
import { createWindowsSystemProxyResolver } from './system-proxy.mjs';
import { createProxyAgent } from './proxy-agent.mjs';
import {
  createProviderRegistry,
  DEFAULT_PROVIDERS_FILE,
  loadProviderFile,
  loadRuntimeEnv,
  parseEnvFile,
  resolveRouteApiKey,
} from './provider-registry.mjs';
import { resolveModelSelection as resolveRegistryModelSelection } from './model-resolver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_FILE = path.join(__dirname, 'proxy-config.json');
const DEFAULT_SECRETS_FILE = path.join(__dirname, 'proxy-secrets.env');
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 600000;

const VALID_TOOL_SCHEMA_COMPAT = new Set(['muse']);
export function isValidToolSchemaCompat(value) {
  return VALID_TOOL_SCHEMA_COMPAT.has(value);
}

// Muse 原生透传工具定义时，Meta 上游要求 parameters.required 覆盖 properties 中的每个 key。
// Codex 的搜索工具类型是 tool_search / web_search（不是 function/custom），因此不按类型过滤，
// 只要顶层工具带对象形式的 parameters.properties 就补齐。只追加缺失的 key、保留原有顺序；
// 返回新对象，不修改原请求体，也不影响其他路由。
export function normalizeMuseToolSchema(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.tools)) {
    return body;
  }
  let toolsChanged = false;
  const tools = body.tools.map((tool) => {
    if (!tool || typeof tool !== 'object') {
      return tool;
    }
    const parameters = tool.parameters;
    if (
      !parameters ||
      typeof parameters !== 'object' ||
      typeof parameters.properties !== 'object' ||
      parameters.properties === null
    ) {
      return tool;
    }
    const propertyKeys = Object.keys(parameters.properties);
    const required = Array.isArray(parameters.required)
      ? parameters.required.filter((key) => typeof key === 'string')
      : [];
    const requiredSet = new Set(required);
    const missing = propertyKeys.filter((key) => !requiredSet.has(key));
    if (missing.length === 0) {
      return tool;
    }
    toolsChanged = true;
    return {
      ...tool,
      parameters: {
        ...parameters,
        required: [...required, ...missing],
      },
    };
  });
  return toolsChanged ? { ...body, tools } : body;
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const CLIENT_CREDENTIAL_HEADERS = new Set([
  'chatgpt-account-id',
  'cookie',
  'openai-organization',
  'openai-project',
  'x-api-key',
]);

export function parseDirectModels(raw, routes) {
  const normalized = raw == null ? '' : String(raw);
  const models = [...new Set(
    normalized
      .split(',')
      .map((slug) => slug.trim())
      .filter(Boolean),
  )];
  const knownModels = routes instanceof Set
    ? routes
    : new Set(Object.keys(routes || {}));
  const unknownModels = models.filter((slug) => !knownModels.has(slug));
  if (unknownModels.length > 0) {
    throw new Error(`DIRECT_MODELS 包含未知模型：${unknownModels.join('、')}`);
  }
  return new Set(models);
}

export function resolveProxyUrl(proxyUrl, directModels, slug) {
  return directModels.has(slug) ? '' : proxyUrl;
}

export function createUpstreamProxyResolver({
  config,
  env,
  directModels,
  systemProxyResolver,
}) {
  const hasEnvOverride = env.PROXY_URL !== undefined;
  const configProxyUrl = String(config.proxy || '').trim();
  const hasConfigOverride = !hasEnvOverride && configProxyUrl.length > 0;
  const fixedProxyUrl = hasEnvOverride ? String(env.PROXY_URL).trim() : configProxyUrl;

  return async (slug, networkPolicy = 'default') => {
    if (networkPolicy === 'direct' || directModels.has(slug)) {
      return { url: '', mode: 'direct' };
    }
    if (networkPolicy === 'system') return systemProxyResolver();
    if (hasEnvOverride || hasConfigOverride) {
      return {
        url: fixedProxyUrl,
        mode: fixedProxyUrl ? 'fixed-proxy' : 'direct',
      };
    }
    return systemProxyResolver();
  };
}

export function loadConfig(configFile = process.env.PROXY_CONFIG_FILE || DEFAULT_CONFIG_FILE) {
  const resolvedConfigFile = path.resolve(configFile);
  let raw;
  try {
    raw = fs.readFileSync(resolvedConfigFile, 'utf8');
  } catch (err) {
    throw new Error(`无法读取配置文件：${configFile}（${err.message}）`);
  }
  const config = JSON.parse(raw);
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('proxy-config.json 顶层必须是对象');
  }
  if (config.models === undefined) config.models = {};
  if (typeof config.models !== 'object' || Array.isArray(config.models)) {
    throw new Error('proxy-config.json 的 models 必须是对象');
  }
  for (const [slug, route] of Object.entries(config.models)) {
    if (!route.upstream_base_url || typeof route.upstream_base_url !== 'string') {
      throw new Error(`路由 ${slug} 缺少 upstream_base_url`);
    }
    if (!route.upstream_model || typeof route.upstream_model !== 'string') {
      throw new Error(`路由 ${slug} 缺少 upstream_model`);
    }
    const authMode = route.auth_mode || 'api_key';
    if (!['api_key', 'openai_passthrough'].includes(authMode)) {
      throw new Error(`路由 ${slug} auth_mode 无效`);
    }
    if (authMode === 'api_key' && (!route.api_key_env || typeof route.api_key_env !== 'string')) {
      throw new Error(`路由 ${slug} 缺少 api_key_env`);
    }
    if (!route.reasoning_format || !isValidReasoningFormat(route.reasoning_format)) {
      throw new Error(`路由 ${slug} 缺少或无效的 reasoning_format`);
    }
    if (
      route.tool_output_format !== undefined &&
      !isValidToolOutputFormat(route.tool_output_format)
    ) {
      throw new Error(`路由 ${slug} 的 tool_output_format 无效`);
    }
    if (
      route.tool_schema_compat !== undefined &&
      !isValidToolSchemaCompat(route.tool_schema_compat)
    ) {
      throw new Error(`路由 ${slug} 的 tool_schema_compat 无效`);
    }
  }
  if (config.model_catalog_file) {
    const catalogFile = path.resolve(path.dirname(resolvedConfigFile), config.model_catalog_file);
    let catalog;
    try {
      catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    } catch (err) {
      throw new Error(`无法读取模型目录：${catalogFile}（${err.message}）`);
    }
    if (!catalog || !Array.isArray(catalog.models)) {
      throw new Error('模型目录必须包含 models 数组');
    }
    if (Object.keys(config.models).length > 0) {
      assertSameSlugs('路由与模型目录名册', Object.keys(config.models), catalog.models.map((model) => model.slug));
    }
    config.catalog = catalog;
  }
  return config;
}

export function loadSecrets(secretsFile = process.env.PROXY_SECRETS_FILE || DEFAULT_SECRETS_FILE) {
  let raw = '';
  try {
    raw = fs.readFileSync(secretsFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      // 密钥文件不存在时允许纯环境变量注入，由启动时的缺失检查统一处理
      return {};
    }
    throw new Error(`无法读取密钥文件：${secretsFile}（${err.message}）`);
  }
  return parseEnvFile(raw);
}

export function createProxyServer({
  config,
  secrets = {},
  logger = console,
  env = process.env,
  directModels: configuredDirectModels,
  historyMonitor: configuredHistoryMonitor,
  systemProxyResolver: configuredSystemProxyResolver,
  registry: configuredRegistry,
  localConfig: configuredLocalConfig,
  discoveryFetchModels,
  validateProviderCredentials = false,
}) {
  const routes = config.models || {};
  const catalogModels = Array.isArray(config.catalog?.models) ? config.catalog.models : null;
  const accessToken = (env.PROXY_ACCESS_TOKEN || config.access_token || '').trim();
  const systemProxyResolver = configuredSystemProxyResolver || createWindowsSystemProxyResolver({ logger });
  let proxyForModel;
  const registry = configuredRegistry || createProviderRegistry({
    config,
    localConfig: configuredLocalConfig || { providers: {} },
    env,
    secrets,
    logger,
    resolveProxy: (_providerId, networkPolicy) => proxyForModel
      ? proxyForModel(_providerId, networkPolicy)
      : Promise.resolve({ url: '', mode: 'direct' }),
    discoveryFetchModels,
    validateCredentials: validateProviderCredentials,
    includeOptionalProviders: true,
  });
  const knownModels = new Set([
    ...Object.keys(routes),
    ...Object.keys(config.aliases || {}),
    ...registry.knownLegacySlugs(),
    ...registry.knownCanonicalModels(),
  ]);
  const directModels = configuredDirectModels || parseDirectModels(env.DIRECT_MODELS, knownModels);
  proxyForModel = createUpstreamProxyResolver({ config, env, directModels, systemProxyResolver });
  const requireToken = accessToken.length > 0;
  const historyMonitor = configuredHistoryMonitor || createHistoryMonitor({ env, logger });

  function isAuthorized(req) {
    if (!requireToken) return true;
    return safeEqual(getHeader(req, 'x-proxy-access-token'), accessToken);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (!isAuthorized(req)) {
      sendJson(res, 401, {
        error: { type: 'authentication_error', message: '未授权：缺少或错误的访问令牌' },
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/models') {
      void sendModelList(res, registry, catalogModels).catch((err) => {
        logger.error(`[codex-proxy] 模型列表生成失败：${err.message}`);
        if (!res.headersSent) {
          sendJson(res, 500, {
            error: { type: 'server_error', message: '模型列表生成失败' },
          });
        }
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/responses') {
      readJsonBody(req, async (err, body) => {
        if (err) {
          sendJson(res, 400, {
            error: { type: 'invalid_request_error', message: `请求体解析失败：${err.message}` },
          });
          return;
        }
        const model = body && typeof body.model === 'string' ? body.model : '';
        let selection;
        try {
          selection = resolveRegistryModelSelection(model, registry);
        } catch (err) {
          logger.error(`[codex-proxy] 模型路由解析异常 model=${model || '(空)'} err=${err.message}`);
          sendJson(res, 500, {
            error: { type: 'server_error', message: '模型路由配置错误' },
          });
          return;
        }
        if (!selection.ok) {
          logger.info(`[codex-proxy] POST /v1/responses model=${model || '(空)'} -> ${selection.message} ${selection.status}`);
          sendJson(res, selection.status, {
            error: { type: selection.errorType, message: selection.message },
          });
          return;
        }
        try {
          const proxy = await proxyForModel(selection.routeSlug, selection.route.network);
          forwardToUpstream(
            req,
            res,
            body,
            model,
            selection.route,
            secrets,
            logger,
            proxy.url,
            proxy.mode,
            env,
            historyMonitor,
            selection.provider_id,
          );
        } catch (proxyError) {
          logger.error(`[codex-proxy] 系统代理解析失败 model=${model} err=${proxyError.message}`);
          sendJson(res, 502, {
            error: { type: 'upstream_error', message: `无法确定上游代理：${proxyError.message}` },
          });
        }
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/responses/compact') {
      readJsonBody(req, (err, body) => {
        if (err) {
          sendJson(res, 400, {
            error: { type: 'invalid_request_error', message: `请求体解析失败：${err.message}` },
          });
          return;
        }
        const model = body && typeof body.model === 'string' ? body.model : '';
        let selection;
        try {
          selection = resolveRegistryModelSelection(model, registry);
        } catch (err) {
          logger.error(`[codex-proxy] 模型路由解析异常 model=${model || '(空)'} err=${err.message}`);
          sendJson(res, 500, {
            error: { type: 'server_error', message: '模型路由配置错误' },
          });
          return;
        }
        if (!selection.ok) {
          logger.info(`[codex-proxy] POST /v1/responses/compact model=${model || '(空)'} -> ${selection.message} ${selection.status}`);
          sendJson(res, selection.status, {
            error: { type: selection.errorType, message: selection.message },
          });
          return;
        }
        forwardCompact({
          req,
          res,
          body,
          slug: model,
          route: selection.route,
          secrets,
          logger,
          proxyForModel: async (attemptSlug, attemptRoute) => proxyForModel(
            attemptSlug === model ? selection.routeSlug : attemptSlug,
            attemptRoute?.network,
          ),
          env,
          historyMonitor,
        });
      });
      return;
    }

    sendJson(res, 404, { error: { type: 'not_found', message: '未找到该路径' } });
  });
  server.providerRegistry = registry;
  server.directModels = directModels;
  return server;
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  const len = Math.max(bufA.length, bufB.length);
  let diff = bufA.length ^ bufB.length;
  for (let i = 0; i < len; i++) {
    diff |= (bufA[i] || 0) ^ (bufB[i] || 0);
  }
  return diff === 0;
}

function getHeader(req, name) {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? (value[0] || '') : (value || '');
}

function assertSameSlugs(label, expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  if (
    expectedSet.size !== expected.length ||
    actualSet.size !== actual.length ||
    expectedSet.size !== actualSet.size ||
    [...expectedSet].some((slug) => !actualSet.has(slug))
  ) {
    throw new Error(`${label}不一致：路由=${expected.join(',')}，目录=${actual.join(',')}`);
  }
}

function summarizeResponsesRequest(body) {
  const inputTypes = {};
  const toolLabels = {};
  const callIds = new Set();
  const outputIds = new Set();
  const bump = (map, key) => {
    map[key] = (map[key] || 0) + 1;
  };
  const items = Array.isArray(body.input)
    ? body.input
    : typeof body.input === 'string'
      ? [{ type: 'input_string' }]
      : [];
  for (const item of items) {
    bump(inputTypes, item && typeof item.type === 'string' ? item.type : 'invalid_item');
    if (item && typeof item.call_id === 'string') {
      if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        outputIds.add(item.call_id);
      } else {
        callIds.add(item.call_id);
      }
    }
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!tool || typeof tool !== 'object') continue;
      const kind = typeof tool.type === 'string' ? tool.type : 'invalid_tool';
      bump(toolLabels, typeof tool.name === 'string' ? `${kind}:${tool.name}` : kind);
    }
  }
  let missingOutputs = 0;
  let missingCalls = 0;
  for (const id of callIds) if (!outputIds.has(id)) missingOutputs += 1;
  for (const id of outputIds) if (!callIds.has(id)) missingCalls += 1;
  return { inputTypes, toolLabels, missingOutputs, missingCalls };
}

function formatCounts(counts) {
  return Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(',') || 'none';
}

function extractUpstreamErrorDetail(raw) {
  const text = String(raw);
  try {
    const parsed = JSON.parse(text);
    const err = parsed && typeof parsed.error === 'object' && parsed.error !== null ? parsed.error : parsed;
    const parts = [];
    if (err && err.message) parts.push(`msg=${String(err.message).slice(0, 800)}`);
    if (err && err.code !== undefined && err.code !== null) parts.push(`code=${String(err.code).slice(0, 100)}`);
    const metadata = err && typeof err.metadata === 'object' && err.metadata !== null ? err.metadata : {};
    const rawDetail = metadata.raw || err?.raw;
    if (rawDetail) {
      let providerMsg = String(rawDetail);
      try {
        const providerParsed = JSON.parse(providerMsg);
        if (providerParsed?.error?.message) providerMsg = String(providerParsed.error.message);
      } catch {}
      parts.push(`provider=${providerMsg.replace(/\s+/g, ' ').slice(0, 600)}`);
    }
    if (parts.length > 0) return parts.join(' ');
    return `body=${text.replace(/\s+/g, ' ').slice(0, 500)}`;
  } catch {
    return `text=${text.replace(/\s+/g, ' ').slice(0, 500)}`;
  }
}

function sendJson(res, status, payload) {
  const raw = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(raw),
  });
  res.end(raw);
}

function readJsonBody(req, callback) {
  const chunks = [];
  let size = 0;
  let done = false;
  const finish = (err, body) => {
    if (done) return;
    done = true;
    callback(err, body);
  };
  req.on('data', (chunk) => {
    if (done) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      finish(new Error('请求体过大'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (done) return;
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) {
      finish(new Error('请求体为空'));
      return;
    }
    try {
      finish(null, JSON.parse(raw));
    } catch (err) {
      finish(new Error(`JSON 解析失败：${err.message}`));
    }
  });
  req.on('error', (err) => finish(err));
}

export function resolveModelSelection(model, registryOrRoutes) {
  if (registryOrRoutes && typeof registryOrRoutes.getProviderByNamespace === 'function') {
    return resolveRegistryModelSelection(model, registryOrRoutes);
  }
  const registry = createProviderRegistry({
    config: { models: registryOrRoutes || {} },
    localConfig: { providers: {} },
    env: {},
    secrets: {},
  });
  return resolveRegistryModelSelection(model, registry);
}

async function sendModelList(res, registry, catalogModels) {
  const dynamicModels = await registry.discoverAll();
  const legacySlugs = registry.visibleLegacySlugs();
  const staticData = legacySlugs.map((slug) => ({
    id: slug,
    object: 'model',
    owned_by: 'unified',
  }));
  const templateCatalog = catalogModels || registry.knownLegacySlugs().map((slug) => ({
    slug,
    display_name: slug,
  }));
  const visibleLegacySet = new Set(legacySlugs);
  const visibleBaseCatalog = templateCatalog.filter((model) => visibleLegacySet.has(model.slug));
  const dynamicCatalogModels = buildProviderCatalogModels(
    dynamicModels,
    templateCatalog,
    visibleBaseCatalog.length,
    registry.config,
  );
  const canonicalData = registry.config.expose_canonical_models === true
    ? registry.knownCanonicalModels()
      .filter((slug) => !slug.startsWith('direct/'))
      .filter((slug) => !staticData.some((model) => model.id === slug))
      .map((slug) => ({ id: slug, object: 'model', owned_by: 'unified' }))
    : [];
  const canonicalCatalog = registry.config.expose_canonical_models === true
    ? buildCanonicalCatalogModels(
      registry,
      templateCatalog,
      visibleBaseCatalog.length + dynamicCatalogModels.length,
    )
    : [];
  sendJson(res, 200, {
    object: 'list',
    models: [...visibleBaseCatalog, ...canonicalCatalog, ...dynamicCatalogModels],
    data: [...staticData, ...canonicalData, ...dynamicModels],
  });
}

export function buildProviderCatalogModels(dynamicModels, baseCatalog, priorityStart = 0, config = {}) {
  const templates = new Map(
    (Array.isArray(baseCatalog) ? baseCatalog : [])
      .filter((model) => model && typeof model.slug === 'string')
      .map((model) => [model.slug, model]),
  );
  const defaultTemplate = config.dynamic_model_template
    ? templates.get(config.dynamic_model_template) || {}
    : {};

  const metadataMap = config.metadata_model_map || {};
  return (Array.isArray(dynamicModels) ? dynamicModels : []).map((model, index) => {
    const providerId = model.provider_id || model.id.split('/')[0] || 'provider';
    const upstreamSlug = model.upstream_model || model.id.slice(`${providerId}/`.length);
    const templateSlug = templates.has(upstreamSlug)
      ? upstreamSlug
      : metadataMap[model.id] || metadataMap[upstreamSlug];
    const template = templates.get(templateSlug) || defaultTemplate;
    const providerLabel = model.provider_label || (providerId === 'cpa' ? 'CPA' : providerId);
    return {
      ...defaultModelInfo(priorityStart + index + 1),
      ...template,
      slug: model.id,
      display_name: `${providerLabel} · ${upstreamSlug}`,
      description: `${model.description || `${providerLabel} 动态模型`} · ${upstreamSlug}`,
      priority: priorityStart + index + 1,
      additional_speed_tiers: [],
      service_tiers: [],
      default_service_tier: null,
      availability_nux: null,
      upgrade: null,
    };
  });
}

function buildCanonicalCatalogModels(registry, baseCatalog, priorityStart) {
  const templates = new Map(
    (Array.isArray(baseCatalog) ? baseCatalog : [])
      .filter((model) => model && typeof model.slug === 'string')
      .map((model) => [model.slug, model]),
  );
  const defaultTemplate = registry.config.dynamic_model_template
    ? templates.get(registry.config.dynamic_model_template) || {}
    : {};
  return registry.knownCanonicalModels()
    .filter((slug) => !slug.startsWith('direct/'))
    .map((slug, index) => {
      const modelName = slug.slice(slug.indexOf('/') + 1);
      const template = templates.get(modelName) || defaultTemplate;
      return {
        ...defaultModelInfo(priorityStart + index + 1),
        ...template,
        slug,
        display_name: slug,
        priority: priorityStart + index + 1,
      };
    });
}

function defaultModelInfo(priority) {
  return {
    slug: '',
    display_name: '',
    description: null,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
    ],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    model_messages: null,
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: true,
    supports_reasoning_summary_parameter: true,
    default_reasoning_summary: 'none',
    support_verbosity: true,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: false,
    context_window: 128000,
    max_context_window: 128000,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ['text'],
    supports_search_tool: false,
    use_responses_lite: true,
    tool_mode: 'code_mode_only',
    multi_agent_version: 'v2',
  };
}

function relayRestoredMuseJson(res, upRes, status, headers, museContext, logger, slug) {
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  upRes.on('data', (chunk) => {
    if (overflow) return;
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      overflow = true;
      chunks.length = 0;
      return;
    }
    chunks.push(chunk);
  });
  upRes.on('end', () => {
    if (overflow) {
      logger.error(`[codex-proxy] Muse JSON 响应超过缓冲上限，终止连接 model=${slug}`);
      res.destroy();
      return;
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      const payload = JSON.parse(raw);
      const restored = restoreMuseJsonPayload(payload, museContext);
      if (restored === payload) {
        res.writeHead(status, headers);
        res.end(raw);
        return;
      }
      const body = JSON.stringify(restored);
      const nextHeaders = { ...headers };
      nextHeaders['content-length'] = String(Buffer.byteLength(body));
      res.writeHead(status, nextHeaders);
      res.end(body);
    } catch (err) {
      logger.warn(
        `[codex-proxy] Muse JSON 恢复失败，原样返回 model=${slug} err=${err.message}`,
      );
      res.writeHead(status, headers);
      res.end(raw);
    }
  });
  upRes.on('error', (err) => {
    logger.error(`[codex-proxy] Muse JSON 响应读取失败 model=${slug} err=${err.message}`);
    if (!res.headersSent) res.destroy();
  });
}

function forwardToUpstream(
  req,
  res,
  body,
  slug,
  route,
  secrets,
  logger,
  proxyUrl,
  networkMode,
  env,
  historyMonitor,
  provider = 'direct',
) {
  const startedAt = Date.now();
  let museContext = null;
  let upstreamSourceBody = body;
  if (route.tool_schema_compat === 'muse') {
    const prepared = prepareMuseRequest(body);
    upstreamSourceBody = prepared.body;
    museContext = prepared.ctx;
  }
  const monitorRequestId = historyMonitor.startRequest({
    endpoint: '/v1/responses',
    model: slug,
    route,
    network: networkMode,
    body: upstreamSourceBody,
  });
  const schemaCompatibleBody =
    route.tool_schema_compat === 'muse' ? normalizeMuseToolSchema(upstreamSourceBody) : upstreamSourceBody;
  const normalization = normalizeResponsesBody(
    schemaCompatibleBody,
    route.reasoning_format || 'passthrough',
    route.tool_output_format || 'passthrough',
  );
  const {
    body: normalizedBody,
    removedReasoningIndexes,
    removedWebSearchIndexes,
    normalizedItemIdIndexes,
    normalizedReasoningIndexes,
    normalizedToolOutputIndexes,
    itemIdChanges,
    reasoningChanges,
    toolOutputChanges,
  } = normalization;
  historyMonitor.recordNormalized({
    requestId: monitorRequestId,
    endpoint: '/v1/responses',
    model: slug,
    upstreamModel: route.upstream_model,
    network: networkMode,
    attempt: 1,
    body: normalizedBody,
    actions: {
      removed_reasoning_indexes: removedReasoningIndexes,
      removed_web_search_indexes: removedWebSearchIndexes,
      normalized_item_id_indexes: normalizedItemIdIndexes,
      normalized_reasoning_indexes: normalizedReasoningIndexes,
      normalized_tool_output_indexes: normalizedToolOutputIndexes,
      item_id_changes: itemIdChanges,
      reasoning_changes: reasoningChanges,
      tool_output_changes: toolOutputChanges,
    },
  });
  let monitorResultRecorded = false;
  const recordMonitorResult = ({ status, upstreamHost = '', error = null }) => {
    if (monitorResultRecorded) return;
    monitorResultRecorded = true;
    historyMonitor.recordResult({
      requestId: monitorRequestId,
      endpoint: '/v1/responses',
      model: slug,
      upstreamModel: route.upstream_model,
      network: networkMode,
      attempt: 1,
      status,
      upstreamHost,
      error,
    });
  };
  const authMode = route.auth_mode || 'api_key';
  let upstreamAuthorization;
  if (authMode === 'openai_passthrough') {
    upstreamAuthorization = getHeader(req, 'authorization');
    if (!upstreamAuthorization) {
      recordMonitorResult({ status: 401, error: new Error('缺少 ChatGPT 登录认证') });
      sendJson(res, 401, {
        error: { type: 'authentication_error', message: '缺少 ChatGPT 登录认证' },
      });
      return;
    }
  } else if (authMode === 'none') {
    upstreamAuthorization = '';
  } else {
    const apiKey = resolveRouteApiKey(route, env, secrets);
    if (!apiKey) {
      recordMonitorResult({
        status: 500,
        error: new Error(`缺少上游密钥：${route.api_key_env}`),
      });
      sendJson(res, 500, {
        error: { type: 'server_error', message: `缺少上游密钥：${route.api_key_env}` },
      });
      return;
    }
    upstreamAuthorization = `Bearer ${apiKey}`;
  }
  const endpoint = route.upstream_base_url.replace(/\/+$/, '') + '/responses';
  let upstreamUrl;
  try {
    upstreamUrl = new URL(endpoint);
  } catch (err) {
    recordMonitorResult({ status: 500, error: new Error(`上游地址无效：${endpoint}`) });
    sendJson(res, 500, { error: { type: 'server_error', message: `上游地址无效：${endpoint}` } });
    return;
  }
  const lib = upstreamUrl.protocol === 'https:' ? https : http;
  const agent = upstreamUrl.protocol === 'https:' && proxyUrl ? createProxyAgent(proxyUrl) : undefined;
  const removedParts = [];
  if (normalizedItemIdIndexes.length > 0) {
    removedParts.push(`输入项 ID ${normalizedItemIdIndexes.length} 项已整理`);
  }
  if (normalizedReasoningIndexes.length > 0) {
    removedParts.push(`reasoning ${normalizedReasoningIndexes.length} 项兼容字段已整理`);
  }
  if (normalizedToolOutputIndexes.length > 0) {
    removedParts.push(`工具输出 ${normalizedToolOutputIndexes.length} 项已转为 JSON 文本`);
  }
  if (removedWebSearchIndexes.length > 0) {
    removedParts.push(`移除 web_search_call ${removedWebSearchIndexes.length} 项`);
  }
  if (removedParts.length > 0) {
    logger.info(
      `[codex-proxy] POST /v1/responses model=${slug} 历史整理：${removedParts.join('、')}`,
    );
  }
  const upstreamBody = JSON.stringify({ ...normalizedBody, model: route.upstream_model });
  const requestSummary = summarizeResponsesRequest(normalizedBody);
  // 尽量原样转发客户端请求头（与 Codex 直连上游时看到的请求一致），
  // 只替换鉴权与 content-length，并剔除逐跳头。
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (
      lower === 'host' ||
      lower === 'authorization' ||
      lower === 'x-proxy-access-token' ||
      lower === 'content-length' ||
      (route.strip_client_credentials === true && CLIENT_CREDENTIAL_HEADERS.has(lower)) ||
      HOP_BY_HOP_HEADERS.has(lower)
    ) {
      continue;
    }
    headers[key] = value;
  }
  if (upstreamAuthorization) headers.authorization = upstreamAuthorization;
  headers['content-length'] = Buffer.byteLength(upstreamBody);
  if (!headers['content-type']) headers['content-type'] = 'application/json';
  if (!headers.accept) headers.accept = 'application/json';
  if (!headers['user-agent']) headers['user-agent'] = 'codexmodelproxy/1.0';
  const requestOptions = { method: 'POST', headers };
  if (agent) requestOptions.agent = agent;
  const outgoing = lib.request(upstreamUrl, requestOptions, (upRes) => {
    const status = upRes.statusCode || 502;
    recordMonitorResult({
      status,
      upstreamHost: upstreamUrl.host,
      error: status >= 400 ? new Error(`HTTP ${status}`) : null,
    });
    const outHeaders = {};
    for (const [key, value] of Object.entries(upRes.headers)) {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) outHeaders[key] = value;
    }
    if (status >= 400) {
      const errChunks = [];
      let errBytes = 0;
      upRes.on('data', (chunk) => {
        if (errBytes < 65536) {
          errChunks.push(chunk);
          errBytes += chunk.length;
        }
      });
      upRes.on('end', () => {
        const raw = Buffer.concat(errChunks).toString('utf8');
        logger.error(
          `[codex-proxy] 上游诊断 provider=${provider} model=${slug} network=${networkMode} status=${status} duration_ms=${Date.now() - startedAt} bytes=${Buffer.byteLength(upstreamBody)} ${extractUpstreamErrorDetail(raw)} 输入[${formatCounts(requestSummary.inputTypes)}] 工具[${formatCounts(requestSummary.toolLabels)}] 孤立调用=${requestSummary.missingOutputs} 孤立输出=${requestSummary.missingCalls}`,
        );
      });
    } else {
      logger.info(`[codex-proxy] POST /v1/responses provider=${provider} model=${slug} network=${networkMode} -> ${upstreamUrl.host} status=${status} duration_ms=${Date.now() - startedAt}`);
    }
    if (museContext && status >= 200 && status < 300) {
      const contentType = String(outHeaders['content-type'] || '').toLowerCase();
      if (contentType.includes('text/event-stream')) {
        res.writeHead(status, outHeaders);
        upRes.pipe(new MuseSseRestoreTransform(museContext)).pipe(res);
        return;
      }
      if (contentType.includes('application/json')) {
        relayRestoredMuseJson(res, upRes, status, outHeaders, museContext, logger, slug);
        return;
      }
    }
    res.writeHead(status, outHeaders);
    upRes.pipe(res);
  });
  const timeoutMs = Number(route.upstream_timeout_ms ?? route.timeout_ms ?? UPSTREAM_TIMEOUT_MS);
  outgoing.setTimeout(Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : UPSTREAM_TIMEOUT_MS, () => {
    outgoing.destroy(new Error('上游响应超时'));
  });
  outgoing.on('error', (err) => {
    recordMonitorResult({ status: 502, upstreamHost: upstreamUrl.host, error: err });
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: { type: 'upstream_error', message: `上游请求失败：${err.message}` },
      });
    } else {
      res.destroy();
    }
    logger.error(`[codex-proxy] 上游错误 provider=${provider} model=${slug} network=${networkMode} -> ${upstreamUrl.host} duration_ms=${Date.now() - startedAt} err=${err.message}`);
  });
  res.on('close', () => outgoing.destroy());
  outgoing.end(upstreamBody);
}

function writePidFile(pidFile, pid) {
  fs.writeFileSync(pidFile, String(pid), 'utf8');
}

function removePidFile(pidFile) {
  try {
    fs.unlinkSync(pidFile);
  } catch {
    // 忽略：文件可能已被清理
  }
}

function isMain() {
  return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isMain()) {
  const env = loadRuntimeEnv();
  let config;
  let secrets;
  let localConfig;
  try {
    config = loadConfig(env.PROXY_CONFIG_FILE || DEFAULT_CONFIG_FILE);
    secrets = loadSecrets(env.PROXY_SECRETS_FILE || DEFAULT_SECRETS_FILE);
    localConfig = loadProviderFile(env.PROVIDERS_CONFIG_FILE || DEFAULT_PROVIDERS_FILE);
  } catch (err) {
    console.error(`[codex-proxy] 启动失败：${err.message}`);
    process.exit(1);
  }
  const host = env.HOST || config.host || '127.0.0.1';
  const port = Number(env.PORT) || (config.port ?? 8787);
  const pidFile = path.resolve(__dirname, config.pid_file || 'proxy.pid');
  let directModels;
  let server;
  try {
    server = createProxyServer({
      config,
      secrets,
      env,
      localConfig,
      validateProviderCredentials: true,
    });
    directModels = server.directModels || parseDirectModels(env.DIRECT_MODELS, new Set([
      ...Object.keys(config.models || {}),
      ...Object.keys(config.aliases || {}),
    ]));
  } catch (err) {
    console.error(`[codex-proxy] 启动失败：${err.message}`);
    process.exit(1);
  }
  server.on('error', (err) => {
    console.error(`[codex-proxy] 服务错误：${err.message}`);
    removePidFile(pidFile);
    process.exit(1);
  });
  server.listen(port, host, () => {
    writePidFile(pidFile, process.pid);
    console.log(`[codex-proxy] 已启动：http://${host}:${port}`);
    console.log(`[codex-proxy] 模型路由：${Object.keys(config.models).join('、')}`);
    console.log(`[codex-proxy] Provider：${server.providerRegistry?.listProviders().filter((provider) => provider.enabled).map((provider) => provider.id).join('、') || '(空)'}`);
    const configuredProxy = env.PROXY_URL !== undefined
      ? String(env.PROXY_URL).trim()
      : String(config.proxy || '').trim();
    const defaultNetwork = env.PROXY_URL !== undefined
      ? (configuredProxy ? '固定代理' : '直连')
      : (configuredProxy ? '固定代理' : '动态 Windows 系统代理');
    console.log(`[codex-proxy] 上游网络：默认${defaultNetwork}；直连白名单：${[...directModels].join('、') || '(空)'}`);
  });
  const shutdown = () => {
    removePidFile(pidFile);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  server.on('close', () => removePidFile(pidFile));
}
