import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncModelSelection } from '../model-selection.mjs';
import { sendModelList } from '../model-catalog.mjs';
import { createProviderRegistry } from '../provider-registry.mjs';
import { resolveModelSelection } from '../model-resolver.mjs';

const logger = { info() {}, warn() {}, error() {} };

async function withSelectionFile(fn) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '.selection-check-');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  try { return await fn(path.join(dir, 'models.txt')); }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmdirSync(root);
  }
}

function ids(...names) { return names.map((id) => ({ id })); }

test('new file lists discovered IDs and selects one ordinary DS and one Kimi Coding model', async () => {
  await withSelectionFile((file) => {
    const discovered = ids(
      'ds/deepseek-flash', 'ds/deepseek-v4-pro',
      'kimi/kimi-k2.7-code-highspeed', 'kimi/kimi-k2.7-code', 'oc/other',
    );
    const selected = syncModelSelection(file, discovered, logger);
    assert.deepEqual([...selected], ['ds/deepseek-flash', 'kimi/kimi-k2.7-code']);
    const content = fs.readFileSync(file, 'utf8');
    assert.match(content, /\* ds\/deepseek-flash/);
    assert.match(content, /\* kimi\/kimi-k2\.7-code\n/);
    assert.match(content, /  oc\/other\n/);
    assert.equal([...content.matchAll(/ds\/deepseek-flash/g)].length, 1);
  });
});

test('manually selected stars survive refresh, new IDs append without overwriting edits', async () => {
  await withSelectionFile((file) => {
    syncModelSelection(file, ids('ds/first', 'kimi/old'), logger);
    fs.writeFileSync(file, [
      '# 我自己保留的说明', '* kimi/old', '  ds/first', '',
    ].join('\n'));
    const selected = syncModelSelection(file, ids('ds/first', 'kimi/old', 'kimi/new'), logger);
    assert.deepEqual([...selected], ['kimi/old']);
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.startsWith('# 我自己保留的说明\n* kimi/old\n  ds/first\n'));
    assert.ok(after.endsWith('  kimi/new\n'));
    syncModelSelection(file, ids('ds/first', 'kimi/old', 'kimi/new'), logger);
    assert.equal(fs.readFileSync(file, 'utf8'), after);
  });
});

test('favorites discard ChatGPT passthrough rows but retain CPA GPT models and existing stars', async () => {
  await withSelectionFile((file) => {
    const original = [
      '# keep this hand-written comment',
      '* ds/deepseek-flash',
      '  chatgpt/gpt-6.1-sol',
      '* chatgpt/gpt-6-astra',
      '  gpt-6-sol',
      '* cpa/gpt-6-sol',
      '  kimi/kimi-k2.7-code',
      '# end comment',
      '',
    ].join('\r\n');
    fs.writeFileSync(file, original);
    const discovered = ids(
      'chatgpt/gpt-6.1-sol', 'gpt-6-sol',
      'ds/deepseek-flash', 'cpa/gpt-6-sol', 'kimi/kimi-k2.7-code',
    );
    const selected = syncModelSelection(file, discovered, logger);
    assert.deepEqual([...selected], ['ds/deepseek-flash', 'cpa/gpt-6-sol']);
    const expected = [
      '# keep this hand-written comment',
      '* ds/deepseek-flash',
      '* cpa/gpt-6-sol',
      '  kimi/kimi-k2.7-code',
      '# end comment',
      '',
    ].join('\r\n');
    assert.equal(fs.readFileSync(file, 'utf8'), expected);
    syncModelSelection(file, discovered, logger);
    assert.equal(fs.readFileSync(file, 'utf8'), expected);
  });
});

test('passthrough IDs never initialize favorites even if discovery reports them', async () => {
  await withSelectionFile((file) => {
    const selected = syncModelSelection(file, ids(
      'chatgpt/gpt-6.1-sol', 'gpt-6-sol', 'ds/deepseek-flash',
    ), logger);
    assert.deepEqual([...selected], ['ds/deepseek-flash']);
    const content = fs.readFileSync(file, 'utf8');
    assert.match(content, /\* ds\/deepseek-flash/);
    assert.doesNotMatch(content, /chatgpt\/|gpt-6-sol/);
  });
});

test('when selected model is not discovered, fallback avoids an empty picker', async () => {
  await withSelectionFile((file) => {
    fs.writeFileSync(file, '* kimi/unavailable\n');
    assert.deepEqual([...syncModelSelection(file, ids('ds/new'), logger)], ['ds/new']);
    assert.match(fs.readFileSync(file, 'utf8'), /\* kimi\/unavailable/);
  });
});

test('discovery and model picker share a selection, hidden models stay routable', async () => {
  await withSelectionFile(async (file) => {
    fs.writeFileSync(file, '* ds/selected\n  ds/hidden\n');
    const registry = createProviderRegistry({
      config: { providers: { ds: {
        enabled: true, base_url: 'http://127.0.0.1:1/v1',
        api_key: 'test-key', auth_mode: 'api_key', protocol: 'responses',
        discover_models: true, model_prefix: 'ds/',
        compat_profile: 'passthrough', metadata_profile: 'generic',
      } } },
      localConfig: { providers: {} }, logger,
      discoveryFetchModels: async () => ({ data: [{ id: 'selected' }, { id: 'hidden' }] }),
    });
    let output;
    await sendModelList({}, registry, (_, status, body) => {
      assert.equal(status, 200); output = body;
    }, {}, file);
    assert.deepEqual(output.data.map((model) => model.id), ['ds/selected']);
    assert.deepEqual(output.models.map((model) => model.slug), ['ds/selected']);
    assert.equal(resolveModelSelection('ds/hidden', registry).ok, true);
  });
});

test('ChatGPT passthrough stays selectable without stars or login; only third-party models use favorites', async () => {
  await withSelectionFile(async (file) => {
    fs.writeFileSync(file, '* ds/selected\n  ds/hidden\n');
    const registry = createProviderRegistry({
      config: { providers: {
        chatgpt: {
          enabled: true, base_url: 'https://chatgpt.example/codex',
          auth_mode: 'openai_passthrough', protocol: 'responses',
          discover_models: true, model_prefix: 'chatgpt/',
          compat_profile: 'openai', metadata_profile: 'openai',
          models: { 'gpt-6.1-sol': {}, 'gpt-6-astra': {} },
        },
        ds: {
          enabled: true, base_url: 'https://deepseek.example/v1',
          api_key: 'test-key', auth_mode: 'api_key', protocol: 'responses',
          discover_models: true, model_prefix: 'ds/',
          compat_profile: 'deepseek',
        },
      } },
      localConfig: { providers: {} }, logger,
      discoveryFetchModels: async (provider) => provider.id === 'chatgpt'
        ? { models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT 6.1 Sol' }, { slug: 'gpt-new-sol' }] }
        : { data: [{ id: 'selected' }, { id: 'hidden' }] },
    });
    const response = async (context) => {
      let payload;
      await sendModelList({}, registry, (_, status, body) => {
        assert.equal(status, 200);
        payload = body;
      }, context, file);
      assert.deepEqual(payload.models.map((model) => model.slug), payload.data.map((model) => model.id));
      return payload;
    };
    const withoutAuth = await response({});
    assert.deepEqual(withoutAuth.data.map((model) => model.id), [
      'gpt-6.1-sol', 'gpt-6-astra', 'ds/selected',
    ]);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /chatgpt\/|gpt-6/);
    assert.equal(resolveModelSelection('gpt-6.1-sol', registry).route.auth_mode, 'openai_passthrough');
    assert.equal(resolveModelSelection('ds/hidden', registry).ok, true);

    const withAuth = await response({ authorization: 'Bearer test-user-token' });
    assert.deepEqual(withAuth.data.map((model) => model.id), [
      'gpt-6.1-sol', 'gpt-6-astra', 'gpt-new-sol', 'ds/selected',
    ]);
    assert.equal(withAuth.models[0].display_name, 'GPT 6.1 Sol');
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /chatgpt\/|gpt-new/);
  });
});

test('auth-rejected third-party provider is removed from favorites and later returns unstarred', async () => {
  await withSelectionFile(async (file) => {
    const original = '* oc/alpha\n* oc-alias\n* ds/selected\n';
    fs.writeFileSync(file, original);
    let ocAttempts = 0;
    const registry = createProviderRegistry({
      config: {
        expose_canonical_models: true,
        aliases: { 'oc-alias': 'oc/alpha' },
        providers: {
          chatgpt: {
            enabled: true, base_url: 'https://chatgpt.example/codex',
            auth_mode: 'openai_passthrough', protocol: 'responses',
            model_prefix: 'chatgpt/', discover_models: false,
            compat_profile: 'openai', models: { 'gpt-6.1-sol': {} },
          },
          opencode: {
            enabled: true, base_url: 'https://opencode.example/v1',
            api_key: 'fixture-key', auth_mode: 'api_key', protocol: 'responses',
            model_prefix: 'oc/', discover_models: true,
            compat_profile: 'passthrough', models: { alpha: {} },
            cache_ttl_ms: 1, failure_cooldown_ms: 35,
          },
          ds: {
            enabled: true, base_url: 'https://ds.example/v1',
            api_key: 'fixture-key', auth_mode: 'api_key', protocol: 'responses',
            model_prefix: 'ds/', discover_models: true,
            compat_profile: 'passthrough',
          },
        },
      },
      localConfig: { providers: {} },
      logger,
      discoveryFetchModels: async (provider) => {
        if (provider.id === 'opencode') {
          ocAttempts += 1;
          if (ocAttempts === 2) {
            throw Object.assign(new Error('HTTP 401'), { statusCode: 401 });
          }
          return { data: [{ id: 'alpha' }] };
        }
        return { data: [{ id: 'selected' }] };
      },
    });
    const getIds = async () => {
      let result;
      await sendModelList({}, registry, (_, status, payload) => {
        assert.equal(status, 200);
        result = payload;
      }, {}, file);
      assert.deepEqual(result.models.map((model) => model.slug), result.data.map((model) => model.id));
      return result.data.map((model) => model.id);
    };
    const initial = await getIds();
    assert.ok(initial.includes('oc-alias'));
    assert.ok(initial.includes('oc/alpha'));
    assert.ok(initial.includes('ds/selected'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(await getIds(), ['gpt-6.1-sol', 'ds/selected']);
    assert.equal(registry.isCatalogProviderAvailable('opencode'), false);
    assert.equal(fs.readFileSync(file, 'utf8'), '* ds/selected\n');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const recovered = await getIds();
    assert.deepEqual(recovered, ['gpt-6.1-sol', 'ds/selected']);
    assert.equal(registry.isCatalogProviderAvailable('opencode'), true);
    assert.match(fs.readFileSync(file, 'utf8'), /^\* ds\/selected\n(?:  oc-alias\n|  oc\/alpha\n){2}$/);
    assert.equal(ocAttempts, 3);
  });
});

test('successful upstream catalog removes models no longer listed from the favorites file', async () => {
  await withSelectionFile(async (file) => {
    fs.writeFileSync(file, '* ds/alpha\n* ds/retired\n');
    let attempts = 0;
    const registry = createProviderRegistry({
      config: { providers: { ds: {
        enabled: true, base_url: 'https://ds.example/v1',
        api_key: 'fixture-key', auth_mode: 'api_key', protocol: 'responses',
        model_prefix: 'ds/', discover_models: true,
        compat_profile: 'passthrough', cache_ttl_ms: 1,
      } } },
      localConfig: { providers: {} },
      logger,
      discoveryFetchModels: async () => {
        attempts += 1;
        return { data: attempts === 1
          ? [{ id: 'alpha' }, { id: 'retired' }]
          : [{ id: 'alpha' }, { id: 'new' }] };
      },
    });
    const getModels = async () => {
      let payload;
      await sendModelList({}, registry, (_, status, result) => {
        assert.equal(status, 200);
        payload = result;
      }, {}, file);
      return payload.data.map((model) => model.id);
    };
    assert.deepEqual(await getModels(), ['ds/alpha', 'ds/retired']);
    assert.equal(fs.readFileSync(file, 'utf8'), '* ds/alpha\n* ds/retired\n');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(await getModels(), ['ds/alpha']);
    assert.equal(fs.readFileSync(file, 'utf8'), '* ds/alpha\n  ds/new\n');
  });
});

test('temporary provider failure preserves stars and stale favorites rows', async () => {
  await withSelectionFile(async (file) => {
    const original = '* oc/alpha\n* oc/previously-available\n';
    fs.writeFileSync(file, original);
    let attempts = 0;
    const registry = createProviderRegistry({
      config: { providers: { opencode: {
        enabled: true, base_url: 'https://oc.example/v1',
        api_key: 'fixture-key', auth_mode: 'api_key', protocol: 'responses',
        model_prefix: 'oc/', discover_models: true,
        compat_profile: 'passthrough', cache_ttl_ms: 1,
        failure_cooldown_ms: 35,
      } } },
      localConfig: { providers: {} },
      logger,
      discoveryFetchModels: async () => {
        attempts += 1;
        if (attempts === 2) {
          throw Object.assign(new Error('HTTP 429'), { statusCode: 429 });
        }
        return { data: [{ id: 'alpha' }, { id: 'previously-available' }] };
      },
    });
    const getModels = async () => {
      let payload;
      await sendModelList({}, registry, (_, status, result) => {
        assert.equal(status, 200);
        payload = result;
      }, {}, file);
      return payload.data.map((model) => model.id);
    };
    assert.deepEqual(await getModels(), ['oc/alpha', 'oc/previously-available']);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(await getModels(), ['oc/alpha', 'oc/previously-available']);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(attempts, 2);
  });
});
