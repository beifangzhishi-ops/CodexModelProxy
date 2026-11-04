import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import WebSocket, { WebSocketServer } from 'ws';
import { normalizeResponsesBody } from './history-normalize.mjs';
import { resolveRouteApiKey } from './provider-registry.mjs';
import { createProxyAgent } from './proxy-agent.mjs';
import { resolveModelSelection } from './model-resolver.mjs';

const MAX_MESSAGE = 64 * 1024 * 1024;
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_CONTEXT = 16 * 1024 * 1024;
const MAX_STREAMS = 8;
const MAX_HISTORY = 12;

function getHeader(req, key) {
  const value = req.headers[key.toLowerCase()];
  return Array.isArray(value) ? (value[0] || '') : (value || '');
}

function allowedOrigin(origin) {
  if (!origin || origin === 'null') return true;
  try {
    const url = new URL(origin);
    if (url.protocol === 'file:' || url.protocol === 'vscode-file:') return true;
    return ['http:', 'https:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function refuse(socket, code, reason) {
  socket.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function emit(socket, event) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > MAX_BUFFER) {
    socket.close(1013, 'Response backlog exceeded');
    return false;
  }
  socket.send(Buffer.isBuffer(event) || typeof event === 'string' ? event : JSON.stringify(event), err => {
    if (err && socket.readyState === WebSocket.OPEN) socket.close(1011, 'WS write failure');
  });
  return true;
}

function forwardNative({ client, frame, session, route, req, proxyForModel, selection, logger, secrets, env, closed }) {
  const authMode = route.auth_mode || 'api_key';
  const headers = route.provider_id === 'chatgpt' ? upstreamHeaders(req) : {};
  if (authMode === 'openai_passthrough') {
    if (route.provider_id !== 'chatgpt') {
      emitError(client, 'authentication_error', 'OAuth passthrough is limited to ChatGPT', 403, frame.stream_id);
      return;
    }
  } else if (authMode === 'api_key') {
    const key = resolveRouteApiKey(route, env, secrets);
    if (key) headers.authorization = `Bearer ${key}`;
  }
  if (authMode !== 'none' && !headers.authorization) {
    emitError(client, 'authentication_error', 'Missing upstream credentials', 401, frame.stream_id);
    return;
  }
  if (session.queue.length >= 32) {
    emitError(client, 'invalid_request_error', 'WebSocket send queue full', 429, frame.stream_id);
    return;
  }
  const forwarded = { ...frame, model: route.upstream_model };
  const payload = JSON.stringify(forwarded);
  const pendingBytes = session.queue.reduce((total, item) => total + Buffer.byteLength(item), 0);
  if (pendingBytes + Buffer.byteLength(payload) > MAX_MESSAGE) {
    emitError(client, 'invalid_request_error', 'WebSocket send queue exceeded limit', 413, frame.stream_id);
    return;
  }
  session.queue.push(payload);
  if (session.upstream?.readyState === WebSocket.OPEN) {
    while (session.queue.length && session.upstream.readyState === WebSocket.OPEN) {
      session.upstream.send(session.queue.shift());
    }
    return;
  }
  if (session.connecting) return;
  session.connecting = true;
  void (async () => {
    const proxy = await proxyForModel(selection.routeSlug, route.network);
    if (closed()) return;
    const url = upstreamWsUrl(route.upstream_base_url);
    const agent = url.protocol === 'wss:' && proxy.url ? createProxyAgent(proxy.url) : undefined;
    const upstream = new WebSocket(url, {
      headers, agent, handshakeTimeout: 15_000,
      maxPayload: MAX_MESSAGE, perMessageDeflate: true,
    });
    session.upstream = upstream;
    let failed = false;
    upstream.on('open', () => {
      if (closed()) return;
      logger.info(`[codex-proxy] Responses WS upstream connected provider=${route.provider_id} network=${proxy.mode}`);
      while (session.queue.length && upstream.readyState === WebSocket.OPEN) {
        upstream.send(session.queue.shift());
      }
    });
    upstream.on('message', (payload, binary) => {
      if (!closed()) emit(client, binary ? payload : payload.toString('utf8'));
    });
    upstream.on('error', () => {
      if (!closed() && !failed) {
        failed = true;
        emitError(client, 'upstream_error', 'ChatGPT WebSocket connection failed', 502, frame.stream_id);
      }
    });
    upstream.on('close', code => {
      if (!closed() && client.readyState === WebSocket.OPEN) {
        if (code === 1000 || code === 1001) {
          client.close(code, 'Upstream connection closed');
        } else {
          if (!failed) emitError(client, 'upstream_error', 'ChatGPT WebSocket connection closed', 502, frame.stream_id);
          client.close(1011, 'Upstream connection closed');
        }
      }
    });
    session.controller.signal.addEventListener('abort', () => upstream.terminate(), { once: true });
  })().catch(() => {
    if (!closed()) {
      emitError(client, 'upstream_error', 'ChatGPT WebSocket setup failed', 502, frame.stream_id);
      client.close(1011, 'Upstream setup failed');
    }
  });
}

function emitError(socket, type, message, status = 502, streamId) {
  const event = { type: 'error', status, error: { type, message } };
  if (streamId !== undefined) event.stream_id = streamId;
  emit(socket, event);
}

function upstreamHeaders(req) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (name === 'authorization' || name === 'chatgpt-account-id' ||
        name === 'user-agent' || name === 'openai-beta' ||
        name.startsWith('x-codex-') || name.startsWith('x-openai-')) {
      headers[name] = value;
    }
  }
  return headers;
}

function upstreamWsUrl(base) {
  const url = new URL(base.replace(/\/+$/, '') + '/responses');
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  else throw new Error('Unsupported upstream WebSocket URL');
  return url;
}

function streamKey(frame) {
  if (frame.stream_id === undefined || frame.stream_id === null) return '__default__';
  if (!['string', 'number'].includes(typeof frame.stream_id)) throw new Error('Invalid stream id');
  return String(frame.stream_id);
}

function withStreamId(event, streamId) {
  return streamId === undefined ? event : { ...event, stream_id: streamId };
}

function pruneHistory(session) {
  while (session.histories.size > MAX_HISTORY) {
    session.histories.delete(session.histories.keys().next().value);
  }
}

async function bridgeHttpResponse({ client, frame, session, route, proxyUrl, networkMode, logger, secrets, env, req, signal }) {
  const streamId = frame.stream_id;
  const model = route.upstream_model;
  let history = [];
  if (frame.previous_response_id) {
    const previous = session.histories.get(frame.previous_response_id);
    if (!previous) {
      emitError(client, 'previous_response_not_found', 'Previous response is unavailable on this connection', 400, streamId);
      return;
    }
    history = previous;
  }
  if (frame.input !== undefined && !Array.isArray(frame.input) && typeof frame.input !== 'string') {
    emitError(client, 'invalid_request_error', 'Invalid input', 400, streamId);
    return;
  }
  const input = typeof frame.input === 'string'
    ? [{ role: 'user', content: [{ type: 'input_text', text: frame.input }] }]
    : (frame.input || []);
  const fullInput = [...history, ...input];
  if (Buffer.byteLength(JSON.stringify(fullInput)) > MAX_CONTEXT) {
    emitError(client, 'invalid_request_error', 'Connection context exceeds limit', 413, streamId);
    return;
  }
  if (frame.generate === false) {
    const id = `resp_cmp_${randomBytes(12).toString('hex')}`;
    session.histories.set(id, fullInput);
    pruneHistory(session);
    emit(client, withStreamId({ type: 'response.created', response: { id, model } }, streamId));
    emit(client, withStreamId({ type: 'response.completed', response: {
      id, model, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    } }, streamId));
    return;
  }
  const raw = { ...frame, model, input: fullInput, stream: true };
  delete raw.type;
  delete raw.stream_id;
  delete raw.previous_response_id;
  delete raw.generate;
  const normalized = normalizeResponsesBody(
    raw, route.reasoning_format || 'passthrough', route.tool_output_format || 'passthrough',
  ).body;
  const body = Buffer.from(JSON.stringify(normalized));
  const authMode = route.auth_mode || 'api_key';
  let authorization = '';
  if (authMode === 'openai_passthrough') authorization = getHeader(req, 'authorization');
  else if (authMode !== 'none') {
    const key = resolveRouteApiKey(route, env, secrets);
    if (key) authorization = `Bearer ${key}`;
  }
  if (authMode !== 'none' && !authorization) {
    emitError(client, 'authentication_error', 'Missing upstream credentials', 401, streamId);
    return;
  }
  const url = new URL(route.upstream_base_url.replace(/\/+$/, '') + '/responses');
  const lib = url.protocol === 'https:' ? https : http;
  const headers = {
    'content-type': 'application/json', accept: 'text/event-stream',
    'content-length': String(body.length),
  };
  if (authorization) headers.authorization = authorization;
  if (getHeader(req, 'user-agent')) headers['user-agent'] = getHeader(req, 'user-agent');
  const agent = url.protocol === 'https:' && proxyUrl ? createProxyAgent(proxyUrl) : undefined;
  await new Promise(resolve => {
    let ended = false;
    let createdId = '';
    const output = [];
    let receivedCompleted = false;
    let outgoing;
    const abort = () => { outgoing.destroy(); finish(); };
    function finish() {
      if (ended) return;
      ended = true;
      signal.removeEventListener('abort', abort);
      resolve();
    }
    outgoing = lib.request(url, { method: 'POST', headers, ...(agent ? { agent } : {}) }, upstream => {
      logger.info(`[codex-proxy] Responses WS HTTP bridge provider=${route.provider_id} network=${networkMode} status=${upstream.statusCode || 502}`);
      if ((upstream.statusCode || 502) >= 400) {
        upstream.resume();
        emitError(client, 'upstream_error', `HTTP ${upstream.statusCode}`, upstream.statusCode, streamId);
        finish();
        return;
      }
      let buffer = '';
      const decoder = new StringDecoder('utf8');
      let sawEvent = false;
      function acceptEvent(data) {
        if (data === '[DONE]' || !data) return;
        let event;
        try { event = JSON.parse(data); } catch { return; }
        if (!event || typeof event !== 'object') return;
        sawEvent = true;
        if (event.type === 'response.created' && event.response?.id) createdId = event.response.id;
        if (event.type === 'response.output_item.done' && event.item) output.push(event.item);
        if (event.type === 'response.completed' || event.type === 'response.done') {
          receivedCompleted = true;
          const id = event.response?.id || createdId;
          if (id) {
            session.histories.set(id, [...fullInput, ...output]);
            pruneHistory(session);
          }
        }
        emit(client, withStreamId(event, streamId));
      }
      function parseSse() {
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = block.split('\n').filter(x => x.startsWith('data:'))
            .map(x => x.slice(5).trim()).join('\n');
          acceptEvent(data);
        }
      }
      upstream.on('data', chunk => {
        buffer = (buffer + decoder.write(chunk)).replace(/\r\n/g, '\n');
        if (buffer.length > MAX_CONTEXT) {
          emitError(client, 'upstream_error', 'SSE event too large', 502, streamId);
          outgoing.destroy();
          return;
        }
        if (String(upstream.headers['content-type'] || '').includes('text/event-stream')) parseSse();
      });
      upstream.once('end', () => {
        buffer += decoder.end();
        if (!sawEvent && String(upstream.headers['content-type'] || '').includes('application/json')) {
          try {
            const response = JSON.parse(buffer);
            if (response?.id) {
              const id = response.id;
              emit(client, withStreamId({ type: 'response.created', response: { id, model } }, streamId));
              for (const item of response.output || []) {
                output.push(item);
                emit(client, withStreamId({ type: 'response.output_item.done', item }, streamId));
              }
              session.histories.set(id, [...fullInput, ...output]);
              pruneHistory(session);
              emit(client, withStreamId({ type: 'response.completed', response }, streamId));
              receivedCompleted = true;
            }
          } catch { /* Invalid JSON is reported below. */ }
        }
        if (!receivedCompleted) emitError(client, 'upstream_error', 'Upstream ended without response.completed', 502, streamId);
        finish();
      });
      upstream.once('error', () => {
        if (!ended) emitError(client, 'upstream_error', 'Upstream response interrupted', 502, streamId);
        finish();
      });
    });
    signal.addEventListener('abort', abort, { once: true });
    outgoing.setTimeout(Number(route.upstream_timeout_ms ?? route.timeout_ms ?? 600_000), () => {
      emitError(client, 'upstream_timeout', 'Upstream response timed out', 504, streamId);
      outgoing.destroy();
      finish();
    });
    outgoing.once('error', () => {
      if (!ended && !signal.aborted) emitError(client, 'upstream_error', 'Upstream connection failed', 502, streamId);
      finish();
    });
    outgoing.end(body);
    if (signal.aborted) abort();
  });
}

export function installResponsesWebsocketGateway(server, {
  registry, proxyForModel, isAuthorized, urlAccessToken, safeEqual,
  logger, secrets, env,
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false });
  let connections = 0;
  server.on('upgrade', (req, socket, head) => {
    // HTTP upgrades are detached from Node's server error handling.
    socket.on('error', () => socket.destroy());
    let pathname;
    try { pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname; }
    catch { refuse(socket, 400, 'Bad Request'); return; }
    const privatePath = /^\/_cmp-auth\/([^/]+)(\/v1\/responses)$/.exec(pathname);
    const tokenValid = Boolean(privatePath && urlAccessToken && safeEqual(privatePath[1], urlAccessToken));
    const requestedPath = tokenValid ? privatePath[2] : pathname;
    if (privatePath && !tokenValid) {
      refuse(socket, 401, 'Unauthorized');
      return;
    }
    if (requestedPath !== '/v1/responses' || req.method !== 'GET') {
      refuse(socket, 404, 'Not Found');
      return;
    }
    if (!isAuthorized(req, tokenValid)) { refuse(socket, 401, 'Unauthorized'); return; }
    if (!allowedOrigin(getHeader(req, 'origin'))) { refuse(socket, 403, 'Forbidden'); return; }
    const hostname = getHeader(req, 'host').split(':')[0];
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
      refuse(socket, 403, 'Forbidden');
      return;
    }
    if (connections >= 32) { refuse(socket, 503, 'Service Unavailable'); return; }
    try {
      wss.handleUpgrade(req, socket, head, client => {
        connections += 1;
        wss.emit('connection', client, req);
      });
    } catch {
      socket.destroy();
    }
  });
  wss.on('connection', (client, req) => {
    const sessions = new Map();
    let closed = false;
    const firstTimer = setTimeout(() => {
      if (!sessions.size && client.readyState === WebSocket.OPEN) client.close(1008, 'Missing response.create');
    }, 20_000);
    firstTimer.unref?.();
    let idleTimer = setTimeout(() => client.close(1001, 'Idle timeout'), 600_000);
    idleTimer.unref?.();
    const abortAll = new AbortController();
    function cleanUp() {
      if (closed) return;
      closed = true;
      connections -= 1;
      clearTimeout(firstTimer);
      clearTimeout(idleTimer);
      abortAll.abort();
      for (const session of sessions.values()) {
        session.controller.abort();
        session.upstream?.terminate();
      }
      sessions.clear();
    }
    client.on('error', cleanUp);
    client.on('close', cleanUp);
    client.on('message', (data, binary) => {
      if (closed) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => client.close(1001, 'Idle timeout'), 600_000);
      idleTimer.unref?.();
      if (binary) { client.close(1003, 'Expected JSON text'); return; }
      let frame;
      try { frame = JSON.parse(data.toString('utf8')); }
      catch { emitError(client, 'invalid_request_error', 'Malformed JSON', 400); return; }
      if (!frame || typeof frame !== 'object' || frame.type !== 'response.create') {
        emitError(client, 'invalid_request_error', 'Unsupported Responses WS event', 400, frame?.stream_id);
        return;
      }
      let key;
      try { key = streamKey(frame); }
      catch { emitError(client, 'invalid_request_error', 'Invalid stream_id', 400); return; }
      let selection;
      try { selection = resolveModelSelection(frame.model, registry); }
      catch { emitError(client, 'server_error', 'Model route failed', 500, frame.stream_id); return; }
      if (!selection.ok) {
        emitError(client, selection.errorType || 'invalid_request_error', selection.message || 'Unknown model',
          selection.status || 400, frame.stream_id);
        return;
      }
      let session = sessions.get(key);
      if (!session) {
        if (sessions.size >= MAX_STREAMS) {
          emitError(client, 'invalid_request_error', 'Too many WS streams', 429, frame.stream_id);
          return;
        }
        session = {
          route: selection.route, key, queue: [], histories: new Map(), pending: Promise.resolve(),
          upstream: null, connecting: false, controller: new AbortController(),
        };
        sessions.set(key, session);
        clearTimeout(firstTimer);
      } else if (
        session.route.upstream_base_url !== selection.route.upstream_base_url ||
        session.route.upstream_model !== selection.route.upstream_model ||
        session.route.provider_id !== selection.route.provider_id
      ) {
        emitError(client, 'invalid_request_error', 'Cannot switch model within a WS stream', 400, frame.stream_id);
        return;
      }
      const route = session.route;
      if (route.ws_transport === 'native') {
        forwardNative({ client, frame, session, route, req, proxyForModel, selection, logger, secrets, env, closed: () => closed });
      } else {
        session.pending = session.pending.then(async () => {
          if (closed) return;
          const proxy = await proxyForModel(selection.routeSlug, route.network);
          await bridgeHttpResponse({
            client, frame, session, route, proxyUrl: proxy.url, networkMode: proxy.mode,
            logger, secrets, env, req,
            signal: abortAll.signal,
          });
        }).catch(() => {
          if (!closed) emitError(client, 'upstream_error', 'HTTP Responses bridge failed', 502, frame.stream_id);
        });
      }
    });
  });
  server.on('close', () => {
    for (const client of wss.clients) client.terminate();
  });
  return wss;
}
