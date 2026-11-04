import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { createProxyServer } from '../server.mjs';

const logger = { info() {}, warn() {}, error() {} };

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

async function connect(url, headers) {
  const socket = new WebSocket(url, { headers });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

async function sendTurn(ws, frame) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => finish(new Error('Timed out waiting for Responses WS completion')), 4000);
    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
    }
    function finish(err, result) {
      cleanup();
      if (err) reject(err);
      else resolve(result);
    }
    function onError(err) { finish(err); }
    function onMessage(raw) {
      const event = JSON.parse(raw.toString('utf8'));
      events.push(event);
      if (event.type === 'response.completed' || event.type === 'response.done' ||
          event.type === 'error') finish(null, events);
    }
    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.send(JSON.stringify({ type: 'response.create', ...frame }));
  });
}

test('ChatGPT Responses WS forwards full prewarm, generation, OAuth and continuation', async () => {
  const requests = [];
  const upstreamHeaders = [];
  const upstream = http.createServer();
  const wss = new WebSocketServer({ server: upstream, path: '/responses' });
  wss.on('connection', (socket, req) => {
    upstreamHeaders.push(req.headers);
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString('utf8'));
      requests.push(frame);
      const id = `resp_mock_${requests.length}`;
      socket.send(JSON.stringify({ type: 'response.created', response: { id } }));
      if (frame.generate !== false) {
        socket.send(JSON.stringify({
          type: 'response.output_item.done',
          item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] },
        }));
      }
      socket.send(JSON.stringify({ type: 'response.completed', response: {
        id, output: [], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      } }));
    });
  });
  const upstreamBase = await listen(upstream);
  const proxy = createProxyServer({
    config: { providers: { chatgpt: {
      enabled: true, auth_mode: 'openai_passthrough', protocol: 'responses', network: 'direct',
      model_prefix: 'chatgpt/', base_url: upstreamBase, discover_models: false,
      models: { 'gpt-ws-fixture': {} },
    } } },
    logger, env: {}, systemProxyResolver: async () => ({ url: '', mode: 'direct' }),
  });
  const proxyBase = await listen(proxy);
  let client;
  try {
    client = await connect(proxyBase.replace('http:', 'ws:') + '/v1/responses', {
      authorization: 'Bearer test-oauth', 'chatgpt-account-id': 'test-account',
    });
    const warmup = await sendTurn(client, {
      model: 'gpt-ws-fixture', input: [{ role: 'user', content: 'hello' }], generate: false,
    });
    assert.deepEqual(warmup.map(x => x.type), ['response.created', 'response.completed']);
    const response = await sendTurn(client, {
      model: 'gpt-ws-fixture', previous_response_id: 'resp_mock_1',
      input: [{ role: 'user', content: 'continue' }],
    });
    assert.deepEqual(response.map(x => x.type), [
      'response.created', 'response.output_item.done', 'response.completed',
    ]);
    assert.equal(response[1].item.content[0].text, 'OK');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].generate, false);
    assert.equal(requests[1].previous_response_id, 'resp_mock_1');
    assert.equal(requests[0].model, 'gpt-ws-fixture');
    assert.equal(upstreamHeaders.length, 1);
    assert.equal(upstreamHeaders[0].authorization, 'Bearer test-oauth');
    assert.equal(upstreamHeaders[0]['chatgpt-account-id'], 'test-account');
    assert.equal((await fetch(proxyBase + '/healthz')).status, 200);
  } finally {
    client?.terminate();
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    await close(proxy);
    await close(upstream);
  }
});

test('third-party WS-to-HTTP bridge streams real SSE and reconstructs prior context', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        url: req.url, headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      const id = `resp_http_${seen.length}`;
      const events = [
        { type: 'response.created', response: { id } },
        { type: 'response.output_item.done', item: {
          type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'HTTP bridge OK' }],
        } },
        { type: 'response.completed', response: { id, usage: {
          input_tokens: 8, output_tokens: 3, total_tokens: 11,
        } } },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of events) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
  });
  const upstreamBase = await listen(upstream);
  const proxy = createProxyServer({
    config: { providers: { deepseek: {
      enabled: true, auth_mode: 'api_key', api_key_env: 'DS_TEST_KEY',
      protocol: 'responses', network: 'direct',
      model_prefix: 'ds/', base_url: upstreamBase, discover_models: false,
      models: { 'ds-fixture': {} },
    } } },
    logger, env: { DS_TEST_KEY: 'third-party-test-token' },
    systemProxyResolver: async () => ({ url: '', mode: 'direct' }),
  });
  const proxyBase = await listen(proxy);
  let client;
  try {
    client = await connect(proxyBase.replace('http:', 'ws:') + '/v1/responses', {
      authorization: 'Bearer must-not-leak-oauth',
    });
    const warmup = await sendTurn(client, {
      model: 'ds/ds-fixture', stream_id: 'one',
      generate: false, input: [{ role: 'user', content: 'first' }],
    });
    assert.deepEqual(warmup.map(x => x.type), ['response.created', 'response.completed']);
    const warmupId = warmup[0].response.id;
    assert.match(warmupId, /^resp_cmp_/);
    const result = await sendTurn(client, {
      model: 'ds/ds-fixture', stream_id: 'one',
      previous_response_id: warmupId, input: [{ role: 'user', content: 'second' }],
    });
    assert.deepEqual(result.map(x => x.type), [
      'response.created', 'response.output_item.done', 'response.completed',
    ]);
    assert.equal(result[1].item.content[0].text, 'HTTP bridge OK');
    assert.equal(result[1].stream_id, 'one');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/responses');
    assert.equal(seen[0].headers.authorization, 'Bearer third-party-test-token');
    assert.equal(seen[0].body.model, 'ds-fixture');
    assert.equal(seen[0].body.input.length, 2);
    const next = await sendTurn(client, {
      model: 'ds/ds-fixture', stream_id: 'one',
      previous_response_id: result.at(-1).response.id,
      input: [{ type: 'function_call_output', call_id: 'call-1', output: 'tool done' }],
    });
    assert.equal(next.at(-1).type, 'response.completed');
    assert.equal(seen[1].body.input.length, 4);
    assert.equal(seen[1].body.input[2].type, 'message');
    assert.equal(seen[1].body.input[3].type, 'function_call_output');
  } finally {
    client?.terminate();
    await close(proxy);
    await close(upstream);
  }
});

test('Responses WS upgrade rejects incorrect local token and cross-origin access', async () => {
  const proxy = createProxyServer({
    config: { providers: {} }, env: { PROXY_ACCESS_TOKEN: 'ws-private-token' }, logger,
    systemProxyResolver: async () => ({ url: '', mode: 'direct' }),
  });
  const base = await listen(proxy);
  const wsBase = base.replace('http:', 'ws:');
  async function rejectStatus(url, headers, expected) {
    const result = await new Promise(resolve => {
      const ws = new WebSocket(url, { headers });
      ws.once('unexpected-response', (_req, response) => {
        const status = response.statusCode;
        response.resume();
        ws.terminate();
        resolve(status);
      });
      ws.once('error', () => resolve(0));
    });
    assert.equal(result, expected);
  }
  try {
    await rejectStatus(wsBase + '/v1/responses', {}, 401);
    await rejectStatus(wsBase + '/v1/responses', {
      'x-proxy-access-token': 'ws-private-token',
      origin: 'https://malicious.example',
    }, 403);
    const secret = Buffer.from('ws-private-token').toString('base64url');
    const client = await connect(`${wsBase}/_cmp-auth/${secret}/v1/responses`);
    client.terminate();
    assert.equal((await fetch(base + '/healthz')).status, 200);
  } finally {
    await close(proxy);
  }
});
