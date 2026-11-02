import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPassthroughModelDiscovery, normalizeDiscoveredModels, requestProviderModels } from '../model-discovery.mjs';

const logger = { info() {}, error() {}, warn() {} };

test('GPT catalog requests are not cached by CMP', async () => {
  let calls = 0;
  const fetchModels = async () => {
    calls += 1;
    return { models: [{ slug: 'current-model' }] };
  };
  const discovery = createPassthroughModelDiscovery({
    provider: { id: 'chatgpt', model_prefix: 'chatgpt/', auth_mode: 'openai_passthrough' },
    logger,
    resolveProxy: async () => ({ url: '', mode: 'direct' }),
    fetchModels,
  });
  assert.deepEqual(await discovery.getModels(), []);
  assert.deepEqual((await discovery.getModels({ authorization: 'test-one' })).map(m => m.id), ['chatgpt/current-model']);
  assert.deepEqual((await discovery.getModels({ authorization: 'test-two' })).map(m => m.id), ['chatgpt/current-model']);
  assert.equal(calls, 2);
});

test('catalog filters explicitly unsupported Responses and hidden models', () => {
  const models = normalizeDiscoveredModels({ data: [
    { id: 'allowed' },
    { id: 'private', visibility: 'hide' },
    { id: 'chat-only', api_capabilities: { responses: { supported: false } } },
  ] }, { id: 'provider', model_prefix: 'provider/' });
  assert.deepEqual(models.map(m => m.id), ['provider/allowed']);
});

test('GPT upstream model endpoint uses requesting client version and account header', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, account: req.headers['chatgpt-account-id'], auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ slug: 'active-model' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await requestProviderModels({
      id: 'chatgpt', auth_mode: 'openai_passthrough',
      base_url: 'http://127.0.0.1:' + server.address().port + '/backend-api/codex',
    }, { url: '', mode: 'direct' }, {
      authorization: 'Bearer example', accountId: 'example-account', clientVersion: '0.161.0',
    });
    assert.equal(result.models[0].slug, 'active-model');
    assert.deepEqual(seen, [{
      url: '/backend-api/codex/models?client_version=0.161.0',
      account: 'example-account', auth: 'Bearer example',
    }]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
