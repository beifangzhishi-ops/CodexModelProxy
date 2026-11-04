import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import WebSocket from 'ws';
import { createProxyServer } from '../server.mjs';

const logger = { info() {}, warn() {}, error() {} };

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('built-in openai uses tokenized openai_base_url without weakening CMP access control', async () => {
  const upstreamSeen = [];
  const upstream = http.createServer((req, res) => {
    upstreamSeen.push({ url: req.url, auth: req.headers.authorization });
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'response', output: [], model: 'gpt-fixture-sol' }));
    });
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      providers: {
        chatgpt: {
          enabled: true, auth_mode: 'openai_passthrough', protocol: 'responses',
          model_prefix: 'chatgpt/', base_url: upstreamUrl, network: 'direct',
          discover_models: false, models: { 'gpt-fixture-sol': {} },
        },
      },
    },
    env: { PROXY_ACCESS_TOKEN: 'local-access-secret' },
    logger,
    systemProxyResolver: async () => ({ url: '', mode: 'direct' }),
  });
  const proxyUrl = await listen(proxy);
  const secret = Buffer.from('local-access-secret').toString('base64url');
  const baseUrl = `${proxyUrl}/_cmp-auth/${secret}/v1`;
  try {
    assert.equal((await fetch(`${baseUrl}/models`)).status, 200);
    assert.equal((await fetch(`${proxyUrl}/v1/models`)).status, 401);
    assert.equal((await fetch(`${proxyUrl}/_cmp-auth/incorrect/v1/models`)).status, 401);
    assert.equal((await fetch(`${proxyUrl}/healthz`)).status, 200);

    const response = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer user-oauth' },
      body: JSON.stringify({ model: 'gpt-fixture-sol', input: 'small test' }),
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamSeen.length, 1);
    assert.equal(upstreamSeen[0].url, '/responses');
    assert.equal(upstreamSeen[0].auth, 'Bearer user-oauth');
    assert.equal(JSON.stringify(upstreamSeen).includes(secret), false);

    const ordinaryHeader = await fetch(`${proxyUrl}/v1/models`, {
      headers: { 'x-proxy-access-token': 'local-access-secret' },
    });
    assert.equal(ordinaryHeader.status, 200);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('CMP accepts Responses WS upgrade and rejects unsupported models at message level', async () => {
  const proxy = createProxyServer({
    config: { providers: {} },
    logger,
    env: {},
    systemProxyResolver: async () => ({ url: '', mode: 'direct' }),
  });
  const proxyUrl = await listen(proxy);
  try {
    const host = new URL(proxyUrl);
    const socket = new WebSocket(`ws://${host.host}/v1/responses`);
    try {
      await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      const result = new Promise((resolve, reject) => {
        socket.once('message', message => resolve(JSON.parse(message.toString())));
        socket.once('error', reject);
      });
      socket.send(JSON.stringify({ type: 'response.create', model: 'not-an-official-model' }));
      assert.equal((await result).type, 'error');
    } finally {
      socket.terminate();
    }
  } finally {
    await close(proxy);
  }
});

test('client aborts during WS upgrade do not terminate the CMP server', async () => {
  const proxy = createProxyServer({
    config: { providers: {} },
    logger,
    env: {},
    systemProxyResolver: async () => ({ url: '', mode: 'direct' }),
  });
  const proxyUrl = await listen(proxy);
  try {
    const host = new URL(proxyUrl);
    await Promise.all(Array.from({ length: 20 }, () => new Promise((resolve, reject) => {
      const socket = net.connect(Number(host.port), host.hostname);
      socket.on('error', () => resolve());
      socket.on('close', () => resolve());
      socket.on('connect', () => {
        socket.write('GET /v1/responses HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
        socket.destroy();
      });
    })));
    // The live server must remain healthy after abrupt connection resets.
    assert.equal((await fetch(`${proxyUrl}/healthz`)).status, 200);
    assert.equal((await fetch(`${proxyUrl}/v1/models`)).status, 200);
  } finally {
    await close(proxy);
  }
});

test('Codex compressed Responses bodies are decoded and forwarded without stale encoding headers', async () => {
  const observed = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      observed.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'response', output: [] }));
    });
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      providers: {
        chatgpt: {
          enabled: true, auth_mode: 'openai_passthrough', protocol: 'responses',
          model_prefix: 'chatgpt/', base_url: upstreamUrl, network: 'direct',
          discover_models: false, models: { 'gpt-fixture-sol': {} },
        },
      },
    },
    logger,
    env: {},
    systemProxyResolver: async () => ({ url: '', mode: 'direct' }),
  });
  const proxyUrl = await listen(proxy);
  try {
    const payload = JSON.stringify({ model: 'gpt-fixture-sol', input: 'small request' });
    const cases = [
      { encoding: 'zstd', compressed: zlib.zstdCompressSync(Buffer.from(payload)) },
      { encoding: 'gzip', compressed: zlib.gzipSync(Buffer.from(payload)) },
    ];
    for (const { encoding, compressed } of cases) {
      const response = await fetch(`${proxyUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-fixture',
          'content-type': 'application/json',
          'content-encoding': encoding,
          'content-md5': 'stale-compressed-body-hash',
        },
        body: compressed,
      });
      assert.equal(response.status, 200, encoding);
      await response.text();
      const latest = observed.at(-1);
      assert.equal(latest.headers['content-encoding'], undefined, encoding);
      assert.equal(latest.headers['content-md5'], undefined, encoding);
      assert.equal(Number(latest.headers['content-length']), latest.body.byteLength, encoding);
      assert.equal(latest.headers.authorization, 'Bearer oauth-fixture');
      assert.equal(JSON.parse(latest.body.toString('utf8')).model, 'gpt-fixture-sol');
    }
    const compactResponse = await fetch(`${proxyUrl}/v1/responses/compact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
      body: zlib.zstdCompressSync(Buffer.from(JSON.stringify({ model: 'not-an-official-model' }))),
    });
    assert.notEqual(compactResponse.status, 200);
    const compactBody = JSON.stringify(await compactResponse.json());
    assert.doesNotMatch(compactBody, /JSON 解析失败|请求体解码/);
    assert.equal(observed.length, 2);
    assert.equal((await fetch(`${proxyUrl}/healthz`)).status, 200);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
