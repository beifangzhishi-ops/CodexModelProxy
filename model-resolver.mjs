// 统一解析 provider/model、alias、旧模型名和旧 direct/ 请求。

import {
  applyCompatibilityProfile,
  getCompatibilityProfile,
  matchWildcard,
  resolveCompatibilityProfile,
} from './compatibility-profiles.mjs';

export function parseModelReference(model) {
  const value = typeof model === 'string' ? model.trim() : '';
  if (!value) return { kind: 'invalid', raw: model };
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) {
    return { kind: 'legacy', raw: value };
  }
  return {
    kind: 'canonical',
    raw: value,
    namespace: value.slice(0, slash),
    model: value.slice(slash + 1),
  };
}

export function resolveModelSelection(model, registry) {
  const reference = parseModelReference(model);
  if (reference.kind === 'invalid') return invalidModel(model);

  const aliasTarget = resolveAliasTarget(reference.raw, registry.aliases);
  if (aliasTarget.error) return invalidModel(reference.raw, aliasTarget.error);
  const canonicalReference = parseModelReference(aliasTarget.target || reference.raw);

  if (canonicalReference.kind === 'canonical') {
    if (canonicalReference.namespace === 'direct') {
      return resolveLegacyDirectReference(reference.raw, canonicalReference.model, registry);
    }
    const provider = registry.getProviderByNamespace(canonicalReference.namespace);
    if (!provider) return invalidModel(model, `未知 Provider 命名空间：${canonicalReference.namespace}`);
    if (!provider.enabled) {
      return {
        ok: false,
        status: 503,
        errorType: 'upstream_unavailable',
        message: provider.disabled_message || `Provider ${provider.id} 已禁用`,
      };
    }
    const canonical = `${provider.model_prefix}${canonicalReference.model}`;
    const staticModel = registry.getStaticModel(canonical);
    if (!staticModel && !provider.discover_models) {
      return invalidModel(model, `Provider ${provider.id} 未配置模型：${canonicalReference.model}`);
    }
    const modelSpec = {
      ...resolveProviderModelOverride(provider, canonicalReference.model),
      ...(staticModel?.spec || {}),
    };
    let route = buildProviderRoute({
      provider,
      modelName: canonicalReference.model,
      modelSpec,
      canonical,
      publicModel: reference.raw,
      registry,
    });
    if (reference.raw.startsWith('direct/')) route = { ...route, network: 'direct' };
    return {
      ok: true,
      provider: provider.id,
      provider_id: provider.id,
      routeSlug: reference.raw,
      canonicalModel: canonical,
      route,
    };
  }

  const legacyRoute = registry.legacyRoutes.get(reference.raw);
  if (legacyRoute) {
    const providerId = registry.legacyRouteProviders.get(reference.raw) || legacyRoute.provider_id || legacyRoute.provider || 'legacy';
    const provider = registry.getProvider(providerId);
    const canonical = provider
      ? `${provider.model_prefix}${String(legacyRoute.upstream_model || reference.raw).trim()}`
      : '';
    return {
      ok: true,
      provider: providerId,
      provider_id: providerId,
      routeSlug: reference.raw,
      canonicalModel: canonical,
      route: buildLegacyRoute(legacyRoute, provider, reference.raw, canonical),
    };
  }
  return invalidModel(model);
}

function resolveLegacyDirectReference(publicModel, modelName, registry) {
  const candidates = [...(registry.staticModels?.values() || [])]
    .filter(({ provider, modelName: configuredName, spec }) => provider.enabled && (
      configuredName === modelName || spec.upstream_model === modelName
    ));
  const selected = candidates.find(({ provider }) => provider.network === 'direct') || candidates[0];
  const dynamicProvider = selected?.provider || registry.listProviders().find(
    (provider) => provider.enabled && provider.network === 'direct' && provider.discover_models,
  );
  if (!dynamicProvider) return invalidModel(publicModel);
  const resolvedModelName = selected?.modelName || modelName;
  const canonical = `${dynamicProvider.model_prefix}${resolvedModelName}`;
  const route = buildProviderRoute({
    provider: dynamicProvider,
    modelName: resolvedModelName,
    modelSpec: selected?.spec || {},
    canonical,
    publicModel,
    registry,
  });
  return {
    ok: true,
    provider: dynamicProvider.id,
    provider_id: dynamicProvider.id,
    routeSlug: publicModel,
    canonicalModel: canonical,
    route: { ...route, network: 'direct' },
  };
}

function resolveProviderModelOverride(provider, modelName) {
  const overrides = provider?.model_overrides;
  if (!overrides || typeof overrides !== 'object') return {};
  const exact = overrides[modelName] || overrides[`${provider.namespace}/${modelName}`];
  if (exact !== undefined) return typeof exact === 'string' ? { upstream_model: exact } : { ...exact };
  for (const [pattern, value] of Object.entries(overrides)) {
    if (!matchWildcard(pattern, modelName) && !matchWildcard(pattern, `${provider.namespace}/${modelName}`)) {
      continue;
    }
    return typeof value === 'string' ? { upstream_model: value } : { ...(value || {}) };
  }
  return {};
}

export function buildProviderRoute({
  provider,
  modelName,
  modelSpec = {},
  canonical,
  publicModel,
  registry,
}) {
  const compatProfile = resolveCompatibilityProfile({
    provider,
    model: modelName,
    modelSpec,
    globalOverrides: registry.globalOverrides,
  });
  const profile = getCompatibilityProfile(compatProfile);
  const route = {
    provider_id: provider.id,
    provider: provider.id,
    public_model: publicModel,
    canonical_model: canonical,
    upstream_base_url: modelSpec.upstream_base_url || provider.base_url,
    upstream_model: modelSpec.upstream_model || modelName,
    auth_mode: modelSpec.auth_mode || provider.auth_mode,
    api_key: String(modelSpec.api_key || '').trim(),
    api_key_env: typeof modelSpec.api_key_env === 'string'
      ? modelSpec.api_key_env.trim()
      : '',
    provider_api_key: String(provider.api_key || '').trim(),
    network: modelSpec.network || provider.network,
    strip_client_credentials: modelSpec.strip_client_credentials === undefined
      ? provider.strip_client_credentials
      : Boolean(modelSpec.strip_client_credentials),
    metadata_slug: modelSpec.metadata_slug || modelSpec.template_slug || modelName,
    ...(modelSpec.upstream_timeout_ms !== undefined
      ? { upstream_timeout_ms: modelSpec.upstream_timeout_ms }
      : {}),
    ...(modelSpec.timeout_ms !== undefined ? { timeout_ms: modelSpec.timeout_ms } : {}),
    ...(modelSpec.reasoning_format ? { reasoning_format: modelSpec.reasoning_format } : {}),
    ...(modelSpec.tool_output_format ? { tool_output_format: modelSpec.tool_output_format } : {}),
    ...(modelSpec.tool_schema_compat ? { tool_schema_compat: modelSpec.tool_schema_compat } : {}),
  };
  return applyCompatibilityProfile(
    {
      ...route,
      reasoning_format: route.reasoning_format || profile.reasoning_format,
      tool_output_format: route.tool_output_format || profile.tool_output_format,
    },
    compatProfile,
  );
}

export function buildLegacyRoute(route, provider, publicModel, canonical) {
  const result = {
    ...route,
    provider_id: provider?.id || route.provider_id || route.provider || 'legacy',
    provider: provider?.id || route.provider || route.provider_id || 'legacy',
    public_model: publicModel,
    canonical_model: canonical,
    api_key: String(route.api_key || '').trim(),
    api_key_env: String(route.api_key_env || provider?.api_key_env || '').trim(),
    provider_api_key: String(provider?.api_key || '').trim(),
    network: route.network || provider?.network,
    strip_client_credentials: route.strip_client_credentials === undefined
      ? Boolean(provider?.strip_client_credentials)
      : Boolean(route.strip_client_credentials),
  };
  if (!result.reasoning_format) result.reasoning_format = 'passthrough';
  if (!result.tool_output_format) result.tool_output_format = 'passthrough';
  return result;
}

function resolveAliasTarget(model, aliases) {
  let current = model;
  const seen = new Set();
  while (aliases?.has(current)) {
    if (seen.has(current)) {
      return { error: `alias 循环：${[...seen, current].join(' -> ')}` };
    }
    seen.add(current);
    current = aliases.get(current);
  }
  return { target: current };
}

function invalidModel(model, detail = '') {
  return {
    ok: false,
    status: 400,
    errorType: 'invalid_request_error',
    message: detail ? `未知模型：${model}（${detail}）` : `未知模型：${model}`,
  };
}
