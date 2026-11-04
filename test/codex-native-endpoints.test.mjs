import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyServer } from '../server.mjs';
import { createProviderRegistry } from '../provider-registry.mjs';
import { resolveModelSelection } from '../model-resolver.mjs';

const quiet = { info() {}, warn() {}, error() {} };

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function chatgptConfig(baseUrl) {
  return {
    providers: {
      chatgpt: {
        enabled: true,
        base_url: baseUrl,
        auth_mode: 'openai_passthrough',
        protocol: 'responses',
        model_prefix: 'chatgpt/',
        discover_models: true,
        network: 'direct',
      },
    },
  };
}

test('Codex built-in native POST endpoints preserve exact bodies, auth and response headers', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      const status = req.url.includes('/images/edits') ? 422 : 200;
      res.writeHead(status, {
        'content-type': 'application/json',
        'x-codex-imagegen-request-id': 'image-id-for-debugging',
      });
      res.end(status === 422
        ? JSON.stringify({ error: { type: 'upstream_test_error' } })
        : JSON.stringify({ data: [{ b64_json: 'dummy' }] }));
    });
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: chatgptConfig(`${upstreamUrl}/backend-api/codex`),
    logger: quiet,
    env: { PROXY_ACCESS_TOKEN: 'local-access' },
    systemProxyResolver: async () => ({ url: '', mode: 'direct' }),
  });
  const proxyUrl = await listen(proxy);
  try {
    const paths = [
      '/v1/images/generations',
      '/v1/images/edits',
      '/v1/alpha/search',
      '/v1/memories/trace_summarize',
      '/v1/realtime/calls?intent=quicksilver',
    ];
    for (const [index, endpoint] of paths.entries()) {
      const raw = index === 4 ? 'v=0\r\no=- 12345' : JSON.stringify({ model: 'gpt-image-2', prompt: 'mock-only' });
      const response = await fetch(`${proxyUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer pass-through-oauth',
          'chatgpt-account-id': 'account-fixture',
          'x-proxy-access-token': 'local-access',
          'content-type': index === 4 ? 'application/sdp' : 'application/json',
        },
        body: raw,
      });
      assert.equal(response.status, index === 1 ? 422 : 200);
      assert.equal(response.headers.get('x-codex-imagegen-request-id'), 'image-id-for-debugging');
      await response.text();
      const latest = seen[index];
      assert.equal(latest.method, 'POST');
      assert.equal(latest.path, `/backend-api/codex${endpoint.slice(3)}`);
      assert.equal(latest.body.toString('utf8'), raw);
      assert.equal(latest.headers.authorization, 'Bearer pass-through-oauth');
      assert.equal(latest.headers['chatgpt-account-id'], 'account-fixture');
      assert.equal(latest.headers['x-proxy-access-token'], undefined);
      assert.equal(latest.headers['content-type'], index === 4 ? 'application/sdp' : 'application/json');
    }
    assert.equal(seen.length, paths.length);

    const missingAuth = await fetch(`${proxyUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { 'x-proxy-access-token': 'local-access' },
      body: '{}',
    });
    assert.equal(missingAuth.status, 401);
    const missingLocalAccess = await fetch(`${proxyUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { authorization: 'Bearer pass-through-oauth' },
      body: '{}',
    });
    assert.equal(missingLocalAccess.status, 401);
    const unknownEndpoint = await fetch(`${proxyUrl}/v1/images/deletions`, {
      method: 'POST',
      headers: { authorization: 'Bearer pass-through-oauth', 'x-proxy-access-token': 'local-access' },
      body: '{}',
    });
    assert.equal(unknownEndpoint.status, 404);
    assert.equal(seen.length, paths.length, 'unregistered or unauthorized paths must never reach upstream');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('Luna Reserve and Codex auto-review use official passthrough even without catalog entries', () => {
  const registry = createProviderRegistry({
    config: chatgptConfig('https://chatgpt.com/backend-api/codex'),
    env: {},
    secrets: {},
    validateCredentials: false,
  });
  for (const model of ['gpt-reserve', 'codex-auto-review']) {
    const result = resolveModelSelection(model, registry);
    assert.equal(result.ok, true, model);
    assert.equal(result.provider_id, 'chatgpt');
    assert.equal(result.route.upstream_model, model);
    assert.equal(result.route.auth_mode, 'openai_passthrough');
  }
});
