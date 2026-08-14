// Responses 压缩请求转发：先用请求模型，失败后仅重试一次后备模型。
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

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
  env,
}) {
  let activeRequest;
  let clientClosed = false;
  const onClientClose = () => {
    clientClosed = true;
    activeRequest?.destroy();
  };
  res.once('close', onClientClose);

  const attempt = async (attemptSlug, attemptRoute) => {
    const result = await requestBufferedCompact({
      req,
      body,
      slug: attemptSlug,
      route: attemptRoute,
      secrets,
      proxyUrl,
      env,
      onRequest(outgoing) {
        activeRequest = outgoing;
      },
    });
    activeRequest = undefined;
    return result;
  };

  try {
    let result = await attempt(slug, route);
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

function createProxyAgent(proxyUrl) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (options, callback) => {
    let done = false;
    let connected = false;
    const finish = (err, socket) => {
      if (done) return;
      done = true;
      callback(err, socket);
    };
    let proxyUrlObject;
    try {
      proxyUrlObject = new URL(proxyUrl);
    } catch (err) {
      finish(err);
      return;
    }
    const targetHost = options.host || options.servername || '';
    const targetPort = options.port || 443;
    const socket = net.connect(Number(proxyUrlObject.port || 80), proxyUrlObject.hostname);
    socket.on('connect', () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });
    let buffer = '';
    const onData = (chunk) => {
      if (done || connected) return;
      buffer += chunk.toString('latin1');
      const endOfHeaders = buffer.indexOf('\r\n\r\n');
      if (endOfHeaders === -1) return;
      const head = buffer.slice(0, endOfHeaders);
      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        socket.destroy();
        finish(new Error(`proxy CONNECT failed: ${head.split('\r\n')[0]}`));
        return;
      }
      connected = true;
      socket.removeListener('data', onData);
      const tlsSocket = tls.connect({ socket, servername: targetHost });
      tlsSocket.once('secureConnect', () => finish(null, tlsSocket));
      tlsSocket.once('error', finish);
    };
    socket.on('data', onData);
    socket.on('error', finish);
  };
  return agent;
}

function firstHeader(value) {
  return Array.isArray(value) ? (value[0] || '') : (value || '');
}

function isSuccessful(result) {
  return !result.error && result.status >= 200 && result.status < 300;
}

function logAttempt(logger, slug, result) {
  if (result.error) {
    logger.error(
      `[codex-proxy] POST /v1/responses/compact model=${slug} -> ${result.upstreamHost} err=${result.error.message}`,
    );
    return;
  }
  logger.info(
    `[codex-proxy] POST /v1/responses/compact model=${slug} -> ${result.upstreamHost} status=${result.status}`,
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
