// CodexModelProxy 本地中转服务
// 零依赖：仅使用 Node 内置模块。
// 按请求中的 model 将 Codex 的 Responses 请求转发到 OpenCode 或 DeepSeek 上游。
// 安全：不记录提示词、响应正文与 API 密钥；未知模型不访问上游。

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_FILE = path.join(__dirname, 'proxy-config.json');
const DEFAULT_SECRETS_FILE = path.join(__dirname, 'proxy-secrets.env');
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 600000;

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

export function loadConfig(configFile = process.env.PROXY_CONFIG_FILE || DEFAULT_CONFIG_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(configFile, 'utf8');
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
  for (const slug of ['gpt-5.6-luna', 'gpt-5.6-terra']) {
    if (!config.models[slug]) {
      throw new Error(`路由缺少模型：${slug}`);
    }
  }
  for (const [slug, route] of Object.entries(config.models)) {
    if (!route.upstream_base_url || typeof route.upstream_base_url !== 'string') {
      throw new Error(`路由 ${slug} 缺少 upstream_base_url`);
    }
    if (!route.upstream_model || typeof route.upstream_model !== 'string') {
      throw new Error(`路由 ${slug} 缺少 upstream_model`);
    }
    if (!route.api_key_env || typeof route.api_key_env !== 'string') {
      throw new Error(`路由 ${slug} 缺少 api_key_env`);
    }
  }
  return config;
}

export function loadSecrets(secretsFile = process.env.PROXY_SECRETS_FILE || DEFAULT_SECRETS_FILE) {
  const secrets = {};
  let raw = '';
  try {
    raw = fs.readFileSync(secretsFile, 'utf8');
  } catch (err) {
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

export function createProxyServer({ config, secrets, logger = console }) {
  const routes = config.models || {};
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/models') {
      sendJson(res, 200, {
        object: 'list',
        data: Object.keys(routes).map((slug) => ({
          id: slug,
          object: 'model',
          owned_by: 'unified',
        })),
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/responses') {
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
          logger.info(`[codex-proxy] POST /v1/responses model=${model || '(空)'} -> 未知模型 400`);
          sendJson(res, 400, {
            error: { type: 'invalid_request_error', message: `未知模型：${model}` },
          });
          return;
        }
        forwardToUpstream(req, res, body, model, route, secrets, logger);
      });
      return;
    }

    sendJson(res, 404, { error: { type: 'not_found', message: '未找到该路径' } });
  });
  return server;
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

function forwardToUpstream(req, res, body, slug, route, secrets, logger) {
  const apiKey = secrets[route.api_key_env];
  if (!apiKey) {
    sendJson(res, 500, {
      error: { type: 'server_error', message: `缺少上游密钥：${route.api_key_env}` },
    });
    return;
  }
  const endpoint = route.upstream_base_url.replace(/\/+$/, '') + '/responses';
  let upstreamUrl;
  try {
    upstreamUrl = new URL(endpoint);
  } catch (err) {
    sendJson(res, 500, { error: { type: 'server_error', message: `上游地址无效：${endpoint}` } });
    return;
  }
  const lib = upstreamUrl.protocol === 'https:' ? https : http;
  const upstreamBody = JSON.stringify({ ...body, model: route.upstream_model });
  const headers = {
    'content-type': req.headers['content-type'] || 'application/json',
    accept: req.headers.accept || 'application/json',
    authorization: `Bearer ${apiKey}`,
    'user-agent': 'codexmodelproxy/1.0',
    'content-length': Buffer.byteLength(upstreamBody),
  };
  const outgoing = lib.request(upstreamUrl, { method: 'POST', headers }, (upRes) => {
    const status = upRes.statusCode || 502;
    const outHeaders = {};
    for (const [key, value] of Object.entries(upRes.headers)) {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) outHeaders[key] = value;
    }
    res.writeHead(status, outHeaders);
    upRes.pipe(res);
    logger.info(`[codex-proxy] POST /v1/responses model=${slug} -> ${upstreamUrl.host} status=${status}`);
  });
  outgoing.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    outgoing.destroy(new Error('上游响应超时'));
  });
  outgoing.on('error', (err) => {
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: { type: 'upstream_error', message: `上游请求失败：${err.message}` },
      });
    } else {
      res.destroy();
    }
    logger.error(`[codex-proxy] 上游错误 model=${slug} -> ${upstreamUrl.host} err=${err.message}`);
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
      .filter((route) => !secrets[route.api_key_env])
      .map((route) => route.api_key_env),
  )];
  if (missingKeys.length > 0) {
    console.error(`[codex-proxy] 启动失败：proxy-secrets.env 缺少密钥（${missingKeys.join('、')}）`);
    process.exit(1);
  }
  const host = config.host || '127.0.0.1';
  const port = config.port ?? 8787;
  const pidFile = path.resolve(__dirname, config.pid_file || 'proxy.pid');
  const server = createProxyServer({ config, secrets });
  server.on('error', (err) => {
    console.error(`[codex-proxy] 服务错误：${err.message}`);
    removePidFile(pidFile);
    process.exit(1);
  });
  server.listen(port, host, () => {
    writePidFile(pidFile, process.pid);
    console.log(`[codex-proxy] 已启动：http://${host}:${port}`);
    console.log(`[codex-proxy] 模型路由：${Object.keys(config.models).join('、')}`);
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
