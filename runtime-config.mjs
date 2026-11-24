import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_FILE = path.join(root, 'proxy-config.json');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function readConfigObject(file, fallback, allowEmpty = false) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error('Cannot read configuration: ' + file + ' (' + err.code + ')');
  }
  if (allowEmpty && !raw.replace(/^\uFEFF/, '').trim()) return fallback;
  let value;
  try { value = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Invalid JSON configuration: ' + file); }
  if (!isObject(value)) throw new Error('Configuration must be an object: ' + file);
  return value;
}

export function loadConfig(configFile = process.env.PROXY_CONFIG_FILE || DEFAULT_CONFIG_FILE, overridesFile = process.env.MODEL_OVERRIDES_FILE || path.join(path.dirname(path.resolve(configFile)), 'model-overrides.json')) {
  const raw = readConfigObject(configFile, {});
  for (const key of ['models', 'catalog', 'metadata_model_map', 'model_catalog_file', 'compatibility_overrides']) {
    if (Object.hasOwn(raw, key)) throw new Error('Obsolete configuration field: ' + key + '; use model-overrides.json');
  }
  const config = {
    host: '127.0.0.1', port: 8787, pid_file: 'proxy.pid',
    expose_canonical_models: false, model_selection_file: 'models.txt', aliases: {},
    ...raw,
    providers: raw.providers === undefined ? {
      chatgpt: { base_url: 'https://chatgpt.com/backend-api/codex', auth_mode: 'openai_passthrough', protocol: 'responses', compat_profile: 'openai', metadata_profile: 'openai', display_name: 'ChatGPT' },
    } : raw.providers,
  };
  if (!isObject(config.providers)) throw new Error('providers must be an object');
  const overrides = readConfigObject(overridesFile, { providers: {} }, true);
  if (Object.keys(overrides).some(key => key !== 'providers') || (overrides.providers !== undefined && !isObject(overrides.providers))) throw new Error('model-overrides.json must contain a providers object');
  for (const [id, provider] of Object.entries(config.providers)) {
    if (!isObject(provider)) throw new Error('Invalid provider: ' + id);
    for (const key of ['model_overrides', 'model_compatibility']) {
      if (Object.hasOwn(provider, key)) throw new Error('Obsolete provider field: ' + id + '.' + key + '; use model-overrides.json');
    }
    if (provider.models !== undefined) {
      const models = provider.models;
      const valid = Array.isArray(models)
        ? models.every(name => typeof name === 'string' && name.trim())
        : isObject(models) && Object.values(models).every(spec => isObject(spec) && Object.keys(spec).length === 0);
      if (!valid) throw new Error('Static models must contain names only: ' + id + '; use model-overrides.json for fields');
      if (Object.keys(models).length && provider.discover_models !== false) throw new Error('Static models require discover_models:false: ' + id);
    }
    const rules = overrides.providers?.[id];
    if (rules !== undefined) {
      if (!isObject(rules) || Object.values(rules).some(spec => !isObject(spec))) throw new Error('Invalid model override map: ' + id);
      provider.model_overrides = rules;
    }
  }
  for (const id of Object.keys(overrides.providers ?? {})) {
    if (!Object.hasOwn(config.providers, id)) throw new Error('Model override references unknown provider: ' + id);
  }
  return config;
}
