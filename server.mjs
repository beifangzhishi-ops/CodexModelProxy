// CodexModelProxy 本地中转服务
// 零依赖：仅使用 Node 内置模块。
// 按请求中的 model 将 Codex 的 Responses 请求转发到 OpenCode 或 DeepSeek 上游。
// 安全：不记录提示词、响应正文与 API 密钥；未知模型不访问上游。

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { forwardCompactWithFallback } from './compact-forward.mjs';
import {
  normalizeResponsesBody,
  isValidReasoningFormat,
  isValidToolOutputFormat,
} from './history-normalize.mjs';
import { createHistoryMonitor } from './history-monitor.mjs';
import { createWindowsSystemProxyResolver } from './system-proxy.mjs';
import { createProxyAgent } from './proxy-agent.mjs';

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
// 只追加缺失的 key、保留原有顺序；返回新对象，不修改原请求体，也不影响其他路由。
export function normalizeMuseToolSchema(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.tools)) {
    return body;
  }
  let toolsChanged = false;
  const tools = body.tools.map((tool) => {
    if (!tool || typeof tool !== 'object' || !['function', 'custom'].includes(tool.type)) {
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

export function parseDirectModels(raw, routes) {
  const normalized = raw == null ? '' : String(raw);
  const models = [...new Set(
    normalized
      .split(',')
      .map((slug) => slug.trim())
      .filter(Boolean),
  )];
  const unknownModels = models.filter(
    (slug) => !Object.prototype.hasOwnProperty.call(routes || {}, slug),
  );
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

  return async (slug) => {
    if (directModels.has(slug)) return { url: '', mode: 'direct' };
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
  if (!config.models || typeof config.models !== 'object' || Array.isArray(config.models)) {
    throw new Error('proxy-config.json 缺少 models 对象');
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
  if (
    config.compact_fallback_model !== undefined &&
    (
      typeof config.compact_fallback_model !== 'string' ||
      !config.compact_fallback_model.trim() ||
      !config.models[config.compact_fallback_model]
    )
  ) {
    throw new Error('compact_fallback_model 必须是 models 中已有的模型 slug');
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
    assertSameSlugs('路由与模型目录名册', Object.keys(config.models), catalog.models.map((model) => model.slug));
    config.catalog = catalog;
  }
  return config;
}

export function loadSecrets(secretsFile = process.env.PROXY_SECRETS_FILE || DEFAULT_SECRETS_FILE) {
  const secrets = {};
  let raw = '';
  try {
    raw = fs.readFileSync(secretsFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      // 密钥文件不存在时允许纯环境变量注入，由启动时的缺失检查统一处理
      return secrets;
    }
    throw new Error(`无法读取密钥文件：${secretsFile}（${err.message}）`);
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) secrets[key] = value;
  }
  return secrets;
}

export function createProxyServer({
  config,
  secrets,
  logger = console,
  env = process.env,
  directModels: configuredDirectModels,
  historyMonitor: configuredHistoryMonitor,
  systemProxyResolver: configuredSystemProxyResolver,
}) {
  const routes = config.models || {};
  const catalogModels = Array.isArray(config.catalog?.models) ? config.catalog.models : null;
  const compactFallbackSlug = config.compact_fallback_model || 'deepseek-v4-flash';
  const accessToken = (env.PROXY_ACCESS_TOKEN || config.access_token || '').trim();
  const directModels = configuredDirectModels || parseDirectModels(env.DIRECT_MODELS, routes);
  const systemProxyResolver = configuredSystemProxyResolver || createWindowsSystemProxyResolver({ logger });
  const proxyForModel = createUpstreamProxyResolver({
    config,
    env,
    directModels,
    systemProxyResolver,
  });
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
      const data = Object.keys(routes).map((slug) => ({
        id: slug,
        object: 'model',
        owned_by: 'unified',
      }));
      sendJson(res, 200, {
        object: 'list',
        models: catalogModels || data,
        data,
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
        const route = routes[model];
        if (!route) {
          logger.info(`[codex-proxy] POST /v1/responses model=${model || '(空)'} -> 未知模型 400`);
          sendJson(res, 400, {
            error: { type: 'invalid_request_error', message: `未知模型：${model}` },
          });
          return;
        }
        try {
          const proxy = await proxyForModel(model);
          forwardToUpstream(
            req,
            res,
            body,
            model,
            route,
            secrets,
            logger,
            proxy.url,
            proxy.mode,
            env,
            historyMonitor,
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
        const route = routes[model];
        if (!route) {
          logger.info(`[codex-proxy] POST /v1/responses/compact model=${model || '(空)'} -> 未知模型 400`);
          sendJson(res, 400, {
            error: { type: 'invalid_request_error', message: `未知模型：${model}` },
          });
          return;
        }
        forwardCompactWithFallback({
          req,
          res,
          body,
          slug: model,
          route,
          fallbackSlug: compactFallbackSlug,
          fallbackRoute: routes[compactFallbackSlug],
          secrets,
          logger,
          proxyForModel,
          env,
          historyMonitor,
        });
      });
      return;
    }

    sendJson(res, 404, { error: { type: 'not_found', message: '未找到该路径' } });
  });
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
) {
  const monitorRequestId = historyMonitor.startRequest({
    endpoint: '/v1/responses',
    model: slug,
    route,
    network: networkMode,
    body,
  });
  const schemaCompatibleBody =
    route.tool_schema_compat === 'muse' ? normalizeMuseToolSchema(body) : body;
  const normalization = normalizeResponsesBody(
    schemaCompatibleBody,
    route.reasoning_format || 'passthrough',
    route.tool_output_format || 'passthrough',
  );
  const {
    body: normalizedBody,
    removedReasoningIndexes,
    removedWebSearchIndexes,
    normalizedReasoningIndexes,
    normalizedToolOutputIndexes,
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
      normalized_reasoning_indexes: normalizedReasoningIndexes,
      normalized_tool_output_indexes: normalizedToolOutputIndexes,
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
  } else {
    const apiKey = env[route.api_key_env] || secrets[route.api_key_env];
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
  if (normalizedReasoningIndexes.length > 0) {
    removedParts.push(`reasoning ${normalizedReasoningIndexes.length} 项冲突字段已清空`);
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
      HOP_BY_HOP_HEADERS.has(lower)
    ) {
      continue;
    }
    headers[key] = value;
  }
  headers.authorization = upstreamAuthorization;
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
          `[codex-proxy] 上游诊断 model=${slug} network=${networkMode} status=${status} bytes=${Buffer.byteLength(upstreamBody)} ${extractUpstreamErrorDetail(raw)} 输入[${formatCounts(requestSummary.inputTypes)}] 工具[${formatCounts(requestSummary.toolLabels)}] 孤立调用=${requestSummary.missingOutputs} 孤立输出=${requestSummary.missingCalls}`,
        );
      });
    } else {
      logger.info(`[codex-proxy] POST /v1/responses model=${slug} network=${networkMode} -> ${upstreamUrl.host} status=${status}`);
    }
    res.writeHead(status, outHeaders);
    upRes.pipe(res);
  });
  outgoing.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
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
    logger.error(`[codex-proxy] 上游错误 model=${slug} network=${networkMode} -> ${upstreamUrl.host} err=${err.message}`);
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
  const env = process.env;
  let config;
  let secrets;
  try {
    config = loadConfig();
    secrets = loadSecrets();
  } catch (err) {
    console.error(`[codex-proxy] 启动失败：${err.message}`);
    process.exit(1);
  }
  const missingKeys = [...new Set(
    Object.values(config.models)
      .filter((route) => (route.auth_mode || 'api_key') !== 'openai_passthrough')
      .filter((route) => !(env[route.api_key_env] || secrets[route.api_key_env]))
      .map((route) => route.api_key_env),
  )];
  if (missingKeys.length > 0) {
    console.error(`[codex-proxy] 启动失败：缺少密钥（${missingKeys.join('、')}），请在 proxy-secrets.env 或环境变量中提供`);
    process.exit(1);
  }
  const host = env.HOST || config.host || '127.0.0.1';
  const port = Number(env.PORT) || (config.port ?? 8787);
  const pidFile = path.resolve(__dirname, config.pid_file || 'proxy.pid');
  let directModels;
  let server;
  try {
    directModels = parseDirectModels(env.DIRECT_MODELS, config.models);
    server = createProxyServer({ config, secrets, env, directModels });
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
