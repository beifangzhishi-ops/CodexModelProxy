// Responses 压缩请求转发：先用请求模型，失败后仅重试一次后备模型。
import http from 'node:http';
import https from 'node:https';
import { normalizeResponsesBody } from './history-normalize.mjs';
import { createProxyAgent } from './proxy-agent.mjs';

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
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

export async function forwardCompactWithFallback({
  req,
  res,
  body,
  slug,
  route,
  fallbackSlug,
  fallbackRoute,
  secrets,
  logger,
  proxyUrl,
  proxyForModel,
  env,
  historyMonitor,
}) {
  const selectProxy = proxyForModel || (async () => ({
    url: proxyUrl || '',
    mode: proxyUrl ? 'fixed-proxy' : 'direct',
  }));
  let firstProxy = { url: '', mode: 'direct' };
  let monitorRequestId;
  let lastNetworkMode = 'direct';
  let activeRequest;
  let clientClosed = false;
  let attemptNumber = 0;
  const recordedMonitorAttempts = new Set();
  const onClientClose = () => {
    clientClosed = true;
    activeRequest?.destroy();
  };
  res.once('close', onClientClose);

  const attempt = async (attemptSlug, attemptRoute, selectedProxy) => {
    const currentAttempt = ++attemptNumber;
    const attemptProxy = selectedProxy || await selectProxy(attemptSlug);
    const attemptProxyUrl = attemptProxy.url;
    lastNetworkMode = attemptProxy.mode;
    const normalization = normalizeResponsesBody(
      body,
      attemptRoute.reasoning_format || 'passthrough',
      attemptRoute.tool_output_format || 'passthrough',
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
    historyMonitor?.recordNormalized({
      requestId: monitorRequestId,
      endpoint: '/v1/responses/compact',
      model: attemptSlug,
      upstreamModel: attemptRoute.upstream_model,
      network: attemptProxy.mode,
      attempt: currentAttempt,
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
        `[codex-proxy] POST /v1/responses/compact model=${attemptSlug} 历史整理：${removedParts.join('、')}`,
      );
    }
    const result = await requestBufferedCompact({
      req,
      body: normalizedBody,
      slug: attemptSlug,
      route: attemptRoute,
      secrets,
      proxyUrl: attemptProxyUrl,
      env,
      onRequest(outgoing) {
        activeRequest = outgoing;
      },
    });
    activeRequest = undefined;
    if (!recordedMonitorAttempts.has(currentAttempt)) {
      recordedMonitorAttempts.add(currentAttempt);
      historyMonitor?.recordResult({
        requestId: monitorRequestId,
        endpoint: '/v1/responses/compact',
        model: attemptSlug,
        upstreamModel: attemptRoute.upstream_model,
        network: attemptProxy.mode,
        attempt: currentAttempt,
        status: result.status ?? (result.error ? 502 : null),
        upstreamHost: result.upstreamHost || '',
        error: result.error || (result.status >= 400 ? new Error(`HTTP ${result.status}`) : null),
      });
    }
    return { ...result, proxyUrl: attemptProxyUrl, networkMode: attemptProxy.mode };
  };

  try {
    firstProxy = await selectProxy(slug);
    lastNetworkMode = firstProxy.mode;
    monitorRequestId = historyMonitor?.startRequest({
      endpoint: '/v1/responses/compact',
      model: slug,
      route,
      network: firstProxy.mode,
      body,
    });
    let result = await attempt(slug, route, firstProxy);
    logAttempt(logger, slug, result);
    if (clientClosed) return;

    if (!isSuccessful(result) && fallbackRoute && fallbackSlug !== slug) {
      const reason = result.error ? result.error.message : `HTTP ${result.status}`;
      logger.warn(`[codex-proxy] 压缩请求 model=${slug} 失败（${reason}），改用 ${fallbackSlug}`);
      result = await attempt(fallbackSlug, fallbackRoute);
      logAttempt(logger, fallbackSlug, result);
      if (clientClosed) return;
    }

    if (result.error) {
      sendJson(res, result.status || 502, {
        error: { type: 'upstream_error', message: `上游压缩请求失败：${result.error.message}` },
      });
      return;
    }
    sendBufferedResponse(res, result);
  } catch (err) {
    if (monitorRequestId && !recordedMonitorAttempts.has(attemptNumber || 1)) {
      recordedMonitorAttempts.add(attemptNumber || 1);
      historyMonitor?.recordResult({
        requestId: monitorRequestId,
        endpoint: '/v1/responses/compact',
        model: attemptNumber > 1 ? fallbackSlug : slug,
        upstreamModel: attemptNumber > 1 ? fallbackRoute?.upstream_model : route.upstream_model,
        network: lastNetworkMode,
        attempt: attemptNumber || 1,
        status: 502,
        upstreamHost: '',
        error: err,
      });
    }
    if (!clientClosed && !res.headersSent) {
      sendJson(res, 502, {
        error: { type: 'upstream_error', message: `上游压缩请求失败：${err.message}` },
      });
    }
    logger.error(`[codex-proxy] 压缩请求异常 model=${slug} err=${err.message}`);
  } finally {
    res.removeListener('close', onClientClose);
  }
}

function requestBufferedCompact({ req, body, slug, route, secrets, proxyUrl, env, onRequest }) {
  return new Promise((resolve) => {
    const authMode = route.auth_mode || 'api_key';
    let upstreamAuthorization;
    if (authMode === 'openai_passthrough') {
      upstreamAuthorization = firstHeader(req.headers.authorization);
      if (!upstreamAuthorization) {
        resolve({
          slug,
          status: 401,
          error: new Error('缺少 ChatGPT 登录认证'),
          upstreamHost: '(未连接)',
        });
        return;
      }
    } else {
      const apiKey = env[route.api_key_env] || secrets[route.api_key_env];
      if (!apiKey) {
        resolve({
          slug,
          status: 500,
          error: new Error(`缺少上游密钥：${route.api_key_env}`),
          upstreamHost: '(未连接)',
        });
        return;
      }
      upstreamAuthorization = `Bearer ${apiKey}`;
    }

    const endpoint = route.upstream_base_url.replace(/\/+$/, '') + '/responses/compact';
    let upstreamUrl;
    try {
      upstreamUrl = new URL(endpoint);
    } catch {
      resolve({
        slug,
        status: 500,
        error: new Error(`上游地址无效：${endpoint}`),
        upstreamHost: '(地址无效)',
      });
      return;
    }

    if (!['http:', 'https:'].includes(upstreamUrl.protocol)) {
      resolve({
        slug,
        status: 500,
        error: new Error(`不支持的上游协议：${upstreamUrl.protocol}`),
        upstreamHost: upstreamUrl.host,
      });
      return;
    }

    const lib = upstreamUrl.protocol === 'https:' ? https : http;
    const agent = upstreamUrl.protocol === 'https:' && proxyUrl ? createProxyAgent(proxyUrl) : undefined;
    const upstreamBody = JSON.stringify({ ...body, model: route.upstream_model });
    const headers = copyRequestHeaders(req.headers);
    headers.authorization = upstreamAuthorization;
    headers['content-length'] = Buffer.byteLength(upstreamBody);
    if (!headers['content-type']) headers['content-type'] = 'application/json';
    if (!headers.accept) headers.accept = 'application/json';
    if (!headers['user-agent']) headers['user-agent'] = 'codexmodelproxy/1.0';

    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      resolve({ slug, upstreamHost: upstreamUrl.host, ...result });
    };
    const requestOptions = { method: 'POST', headers };
    if (agent) requestOptions.agent = agent;
    const outgoing = lib.request(upstreamUrl, requestOptions, (upstreamResponse) => {
      const chunks = [];
      let size = 0;
      upstreamResponse.on('data', (chunk) => {
        if (finished) return;
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          finish({ status: 502, error: new Error('上游压缩响应过大') });
          upstreamResponse.destroy();
          outgoing.destroy();
          return;
        }
        chunks.push(chunk);
      });
      upstreamResponse.on('end', () => {
        finish({
          status: upstreamResponse.statusCode || 502,
          headers: upstreamResponse.headers,
          body: Buffer.concat(chunks),
        });
      });
      upstreamResponse.on('error', (err) => finish({ status: 502, error: err }));
    });
    onRequest(outgoing);
    outgoing.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      outgoing.destroy(new Error('上游响应超时'));
    });
    outgoing.on('error', (err) => finish({ status: 502, error: err }));
    outgoing.end(upstreamBody);
  });
}

function copyRequestHeaders(sourceHeaders) {
  const headers = {};
  for (const [key, value] of Object.entries(sourceHeaders)) {
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
  return headers;
}

function firstHeader(value) {
  return Array.isArray(value) ? (value[0] || '') : (value || '');
}

function isSuccessful(result) {
  return !result.error && result.status >= 200 && result.status < 300;
}

function logAttempt(logger, slug, result) {
  const networkMode = result.networkMode || (result.proxyUrl ? 'fixed-proxy' : 'direct');
  if (result.error) {
    logger.error(
      `[codex-proxy] POST /v1/responses/compact model=${slug} network=${networkMode} -> ${result.upstreamHost} err=${result.error.message}`,
    );
    return;
  }
  logger.info(
    `[codex-proxy] POST /v1/responses/compact model=${slug} network=${networkMode} -> ${result.upstreamHost} status=${result.status}`,
  );
}

function sendBufferedResponse(res, result) {
  const headers = {};
  for (const [key, value] of Object.entries(result.headers || {})) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) headers[key] = value;
  }
  res.writeHead(result.status, headers);
  res.end(result.body);
}

function sendJson(res, status, payload) {
  const raw = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(raw),
  });
  res.end(raw);
}
