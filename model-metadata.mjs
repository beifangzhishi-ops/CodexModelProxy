// Codex 模型目录 metadata 层。
// Provider 决定“有哪些模型”；本模块只决定这些模型如何描述给 Codex App Server。

import { matchWildcard } from './compatibility-profiles.mjs';

export const GENERIC_BASE_INSTRUCTIONS =
  "You are a coding agent. Follow the user's instructions, use the available tools when helpful, and complete the task carefully.";

const BASE_METADATA = Object.freeze({
  description: null,
  default_reasoning_level: 'medium',
  supported_reasoning_levels: [
    { effort: 'low', description: 'Fast responses with lighter reasoning' },
    { effort: 'medium', description: 'Balances speed and reasoning depth' },
    { effort: 'high', description: 'Greater reasoning depth for complex problems' },
  ],
  shell_type: 'shell_command',
  visibility: 'list',
  supported_in_api: true,
  additional_speed_tiers: [],
  service_tiers: [],
  default_service_tier: null,
  availability_nux: null,
  upgrade: null,
  model_messages: null,
  include_skills_usage_instructions: false,
  include_plugin_usage_instructions: false,
  include_apps_usage_instructions: true,
  supports_reasoning_summary_parameter: true,
  default_reasoning_summary: 'none',
  support_verbosity: true,
  default_verbosity: 'low',
  apply_patch_tool_type: 'freeform',
  web_search_tool_type: 'text_and_image',
  truncation_policy: { mode: 'tokens', limit: 10000 },
  supports_parallel_tool_calls: true,
  supports_image_detail_original: false,
  context_window: 128000,
  max_context_window: 128000,
  effective_context_window_percent: 95,
  experimental_supported_tools: [],
  input_modalities: ['text'],
  supports_search_tool: false,
  use_responses_lite: true,
  tool_mode: 'code_mode_only',
  multi_agent_version: 'v2',
});

const METADATA_PROFILES = Object.freeze({
  generic: {},
  openai: {
    input_modalities: ['text', 'image'],
    supports_image_detail_original: true,
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
      { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
    ],
  },
  deepseek: {
    support_verbosity: false,
    default_verbosity: null,
  },
  muse: {
    input_modalities: ['text', 'image'],
    supports_image_detail_original: true,
  },
  zai: {},
});

const DISCOVERY_INTERNAL_FIELDS = new Set([
  'id',
  'object',
  'owned_by',
  'created',
  'provider_id',
  'provider_label',
  'upstream_model',
]);

export function listMetadataProfiles() {
  return Object.keys(METADATA_PROFILES);
}

export function isValidMetadataProfile(name) {
  return typeof name === 'string' && Object.hasOwn(METADATA_PROFILES, name);
}

export function inferMetadataProfile(provider = {}) {
  const explicit = String(provider.metadata_profile || '').trim();
  if (explicit) {
    if (!isValidMetadataProfile(explicit)) {
      throw new Error(
        `Provider ${provider.id || '(unknown)'} metadata_profile 无效：${explicit}；可选 ${listMetadataProfiles().join('、')}`,
      );
    }
    return explicit;
  }
  switch (provider.compat_profile) {
    case 'openai':
      return 'openai';
    case 'deepseek':
      return 'deepseek';
    case 'muse':
      return 'muse';
    default:
      // openai-auto 等混合兼容 profile 不应推断模型能力。
      return 'generic';
  }
}

export function resolveModelMetadataSpec(provider = {}, modelName, staticSpec = {}) {
  const normalizedName = String(modelName || '').trim();
  let override = {};
  const overrides = provider.model_overrides || {};
  const exact = overrides[normalizedName] || overrides[`${provider.namespace || provider.id}/${normalizedName}`];
  if (exact && typeof exact === 'object') {
    override = exact;
  } else {
    for (const [pattern, value] of Object.entries(overrides)) {
      if (
        matchWildcard(pattern, normalizedName) ||
        matchWildcard(pattern, `${provider.namespace || provider.id}/${normalizedName}`)
      ) {
        if (value && typeof value === 'object') override = value;
        break;
      }
    }
  }
  return { ...override, ...(staticSpec || {}) };
}

export function hasRequiredInstructions(model) {
  const base = typeof model?.base_instructions === 'string' ? model.base_instructions.trim() : '';
  const template = typeof model?.model_messages?.instructions_template === 'string'
    ? model.model_messages.instructions_template.trim()
    : '';
  return Boolean(base || template);
}

export function buildCatalogModel({
  id,
  modelName,
  provider = {},
  source = {},
  staticSpec = {},
  priority = 1,
  displayName,
} = {}) {
  const publicId = String(id || '').trim();
  const upstreamName = String(modelName || source?.upstream_model || '').trim();
  if (!publicId) throw new Error('模型目录项缺少 id');
  if (!upstreamName) throw new Error(`模型 ${publicId} 缺少 upstream model`);

  const spec = resolveModelMetadataSpec(provider, upstreamName, staticSpec);
  const profileName = String(spec.metadata_profile || '').trim() || inferMetadataProfile(provider);
  if (!isValidMetadataProfile(profileName)) {
    throw new Error(
      `模型 ${publicId} metadata_profile 无效：${profileName}；可选 ${listMetadataProfiles().join('、')}`,
    );
  }

  const sourceMetadata = extractDiscoveryMetadata(source);
  const explicitMetadata = normalizeMetadataObject(spec.metadata || spec.model_metadata, publicId);
  const merged = mergeMetadata(
    BASE_METADATA,
    METADATA_PROFILES[profileName],
    sourceMetadata,
    explicitMetadata,
  );

  merged.slug = publicId;
  merged.display_name = String(
    displayName ||
    spec.display_name ||
    sourceMetadata.display_name ||
    `${provider.display_name || provider.id || 'Provider'} · ${upstreamName}`,
  );
  merged.description = spec.description ?? sourceMetadata.description ?? merged.description;
  merged.priority = priority;

  // Codex 0.153.1+ 会拒绝整份目录，只要任意模型同时缺少这两个字段。
  // 只有上游/显式 metadata 都没有提供指令时才注入通用 fallback，避免覆盖原生模板。
  if (!hasRequiredInstructions(merged)) {
    merged.base_instructions = GENERIC_BASE_INSTRUCTIONS;
  }
  return merged;
}

export function extractDiscoveryMetadata(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (DISCOVERY_INTERNAL_FIELDS.has(key)) continue;
    result[key] = cloneValue(value);
  }
  return result;
}

function normalizeMetadataObject(value, modelId) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`模型 ${modelId} metadata 必须是对象`);
  }
  return value;
}

function mergeMetadata(...sources) {
  const result = {};
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const [key, value] of Object.entries(source)) {
      if (key === 'model_messages' && isPlainObject(result.model_messages) && isPlainObject(value)) {
        result.model_messages = { ...result.model_messages, ...cloneValue(value) };
      } else {
        result[key] = cloneValue(value);
      }
    }
  }
  return result;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  }
  return value;
}
