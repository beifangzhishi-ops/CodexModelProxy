// Codex /v1/models 目录编排层。
// Provider Registry 决定模型集合，model-metadata.mjs 决定单个模型的 metadata。

import { buildCatalogModel } from './model-metadata.mjs';
import { resolveModelSelection } from './model-resolver.mjs';

export async function sendModelList(res, registry, sendJson) {
  const dynamicModels = await registry.discoverAll();
  const publicSlugs = visiblePublicSlugs(registry);
  const publicCatalog = publicSlugs.map((slug, index) => {
    const selection = resolveModelSelection(slug, registry);
    return buildCatalogForSelection(slug, selection, registry, index + 1);
  });
  const staticData = publicSlugs.map((slug) => ({
    id: slug,
    object: 'model',
    owned_by: 'unified',
  }));

  const dynamicCatalog = dynamicModels.map((model, index) => {
    const provider = registry.getProvider(model.provider_id);
    if (!provider) throw new Error(`动态模型 ${model.id} 指向未知 Provider ${model.provider_id}`);
    const staticSpec = registry.getConfiguredStaticModel(model.id)?.spec || {};
    const upstreamModel = String(model.upstream_model || model.id.slice(provider.model_prefix.length));
    const providerLabel = model.provider_label || provider.display_name || provider.id;
    const legacyTemplate = findLegacyCatalogTemplate(registry.config, model.id, upstreamModel);
    return buildCatalogModel({
      id: model.id,
      modelName: upstreamModel,
      provider,
      source: mergeCatalogSources(legacyTemplate, model),
      staticSpec,
      priority: publicCatalog.length + index + 1,
      displayName: `${providerLabel} · ${upstreamModel}`,
    });
  });

  const dynamicIds = new Set(dynamicModels.map((model) => model.id));
  const canonicalIds = registry.config.expose_canonical_models === true
    ? registry.knownCanonicalModels()
      .filter((slug) => !slug.startsWith('direct/'))
      .filter((slug) => !dynamicIds.has(slug))
      .filter((slug) => !publicSlugs.includes(slug))
    : [];
  const canonicalCatalog = canonicalIds.map((slug, index) => {
    const selection = resolveModelSelection(slug, registry);
    return buildCatalogForSelection(
      slug,
      selection,
      registry,
      publicCatalog.length + dynamicCatalog.length + index + 1,
      slug,
    );
  });
  const canonicalData = canonicalIds.map((slug) => ({
    id: slug,
    object: 'model',
    owned_by: 'unified',
  }));

  sendJson(res, 200, {
    object: 'list',
    models: [...publicCatalog, ...canonicalCatalog, ...dynamicCatalog],
    data: [...staticData, ...canonicalData, ...dynamicModels],
  });
}

// 旧 loadConfig()/测试仍可能读取顶层 models/catalog；这里从 Provider Registry 派生，
// 仅作为兼容视图，不参与新运行时的模型真相来源。
export function deriveLegacyViews(registry) {
  const slugs = visiblePublicSlugs(registry);
  const models = {};
  const catalogModels = [];
  for (const [index, slug] of slugs.entries()) {
    const selection = resolveModelSelection(slug, registry);
    if (!selection.ok) continue;
    const provider = registry.getProvider(selection.provider_id);
    const route = { ...selection.route };
    if (!route.api_key_env && provider?.api_key_env) route.api_key_env = provider.api_key_env;
    models[slug] = route;
    catalogModels.push(buildCatalogForSelection(slug, selection, registry, index + 1));
  }
  return { models, catalog: { models: catalogModels } };
}

export function visiblePublicSlugs(registry) {
  const candidates = [
    ...registry.visibleLegacySlugs(),
    ...registry.aliases.keys(),
  ];
  const seen = new Set();
  const visible = [];
  for (const slug of candidates) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    const selection = resolveModelSelection(slug, registry);
    if (selection.ok) visible.push(slug);
  }
  return visible;
}

// 兼容旧调用方：如果传入旧 baseCatalog/metadata_model_map，仍可作为迁移期 metadata 来源；
// 新 tracked 配置不再依赖它们。
export function buildProviderCatalogModels(dynamicModels, baseCatalog = [], priorityStart = 0, config = {}) {
  const templates = new Map(
    (Array.isArray(baseCatalog) ? baseCatalog : [])
      .filter((model) => model && typeof model.slug === 'string')
      .map((model) => [model.slug, model]),
  );
  return (Array.isArray(dynamicModels) ? dynamicModels : []).map((model, index) => {
    const providerId = model.provider_id || model.id?.split('/')[0] || 'provider';
    const configuredProvider = config.providers?.[providerId] || {};
    const provider = {
      id: providerId,
      namespace: String(configuredProvider.model_prefix || `${providerId}/`).replace(/\/+$/, ''),
      display_name: configuredProvider.display_name || model.provider_label || providerId,
      compat_profile: configuredProvider.compat_profile || 'passthrough',
      metadata_profile: configuredProvider.metadata_profile || 'generic',
      model_overrides: configuredProvider.model_overrides || {},
      ...configuredProvider,
    };
    const upstreamModel = model.upstream_model || String(model.id || '').slice(`${providerId}/`.length);
    const templateSlug = templates.has(upstreamModel)
      ? upstreamModel
      : config.metadata_model_map?.[model.id] || config.metadata_model_map?.[upstreamModel];
    const legacyTemplate = templates.get(templateSlug) || {};
    return buildCatalogModel({
      id: model.id,
      modelName: upstreamModel,
      provider,
      source: mergeCatalogSources(legacyTemplate, model),
      priority: priorityStart + index + 1,
      displayName: `${model.provider_label || provider.display_name || providerId} · ${upstreamModel}`,
    });
  });
}

function buildCatalogForSelection(id, selection, registry, priority, displayName) {
  if (!selection?.ok) {
    throw new Error(`无法为模型 ${id} 生成目录 metadata：${selection?.message || '路由解析失败'}`);
  }
  const provider = registry.getProvider(selection.provider_id);
  if (!provider) throw new Error(`模型 ${id} 指向未知 Provider ${selection.provider_id}`);
  const canonical = selection.canonicalModel;
  const modelName = canonical.startsWith(provider.model_prefix)
    ? canonical.slice(provider.model_prefix.length)
    : selection.route?.upstream_model || id;
  const staticSpec = registry.getConfiguredStaticModel(canonical)?.spec || {};
  const legacyTemplate = findLegacyCatalogTemplate(registry.config, id, modelName);
  return buildCatalogModel({
    id,
    modelName,
    provider,
    source: legacyTemplate,
    staticSpec,
    priority,
    displayName,
  });
}

function findLegacyCatalogTemplate(config, publicId, upstreamModel) {
  const models = Array.isArray(config?.catalog?.models) ? config.catalog.models : [];
  if (models.length === 0) return {};
  const templates = new Map(
    models
      .filter((model) => model && typeof model.slug === 'string')
      .map((model) => [model.slug, model]),
  );
  if (templates.has(publicId)) return templates.get(publicId);
  if (templates.has(upstreamModel)) return templates.get(upstreamModel);
  const mapped = config.metadata_model_map?.[publicId] || config.metadata_model_map?.[upstreamModel];
  return mapped && templates.has(mapped) ? templates.get(mapped) : {};
}

function mergeCatalogSources(legacyTemplate, discovered) {
  const legacy = legacyTemplate && typeof legacyTemplate === 'object' ? legacyTemplate : {};
  const live = discovered && typeof discovered === 'object' ? discovered : {};
  const merged = { ...legacy, ...live };
  if (legacy.model_messages && live.model_messages) {
    merged.model_messages = { ...legacy.model_messages, ...live.model_messages };
  }
  return merged;
}
