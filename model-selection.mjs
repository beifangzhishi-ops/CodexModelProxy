// Human-editable catalog visibility. The full discovered catalog remains routable.
// Only the starred entries are advertised in the Codex model picker.
import fs from 'node:fs';
import path from 'node:path';

const HEADER = [
  '# CMP 模型精选（UTF-8）',
  '# 在模型名前添加 * 表示显示在 Codex 下拉列表；去掉 * 表示隐藏。',
  '# 模型 ID 由上游自动发现并追加，可直接复制模型 ID；不要改写 ID 本身。',
  '# 此文件仅控制下拉列表；隐藏的模型仍能按完整 ID 调用。',
  '# 上游暂时不可用时不删除已有条目；只有实际发现的模型才会展示。',
  '',
].join('\n');

function parseEntry(line) {
  const match = /^\s*(\*)?\s*([^\s#]+)\s*(?:#.*)?$/.exec(line);
  return match ? { id: match[2], selected: Boolean(match[1]) } : null;
}

function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 255
    && !/[\r\n\t\0\s#]/u.test(id);
}

function initialFavorites(ids) {
  const choices = [];
  for (const prefix of ['ds/', 'kimi/']) {
    const providerModels = ids.filter((id) => id.startsWith(prefix));
    const preferred = prefix === 'ds/'
      ? providerModels.find((id) => /flash/i.test(id))
      : providerModels.find((id) => /code/i.test(id) && !/highspeed/i.test(id));
    if (preferred || providerModels[0]) choices.push(preferred || providerModels[0]);
  }
  if (choices.length === 0 && ids.length) choices.push(ids[0]);
  return new Set(choices);
}

export function syncModelSelection(filePath, discoveredModels, logger = console) {
  const ids = [...new Set(discoveredModels.map((model) => model?.id).filter(validId))];
  const discovered = new Set(ids);
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (text === undefined) {
    if (ids.length === 0) return new Set();
    const defaults = initialFavorites(ids);
    const content = HEADER + ids.map((id) => `${defaults.has(id) ? '* ' : '  '}${id}`).join('\n')
      + (ids.length ? '\n' : '');
    saveIfChanged(filePath, content);
    logger.info?.('[codex-proxy] Created editable model selection: ' + filePath);
    return defaults;
  }

  const existing = new Set();
  const selected = new Set();
  for (const line of text.split(/\r?\n/)) {
    const entry = parseEntry(line);
    if (!entry || !validId(entry.id)) continue;
    existing.add(entry.id);
    if (entry.selected) selected.add(entry.id);
  }
  const appended = ids.filter((id) => !existing.has(id));
  if (appended.length) {
    const suffix = (text.endsWith('\n') || text.length === 0 ? '' : '\n')
      + appended.map((id) => `  ${id}`).join('\n') + '\n';
    saveIfChanged(filePath, text + suffix);
  }
  // A temporarily unavailable provider may leave no selected model online.
  // Show one discoverable model rather than an empty model picker.
  if (selected.size > 0 && !ids.some((id) => selected.has(id)) && ids.length) {
    logger.warn?.('[codex-proxy] No starred models are currently discoverable; using one fallback entry');
    return new Set([ids[0]]);
  }
  if (selected.size === 0 && ids.length) {
    logger.warn?.('[codex-proxy] No models starred in models.txt; listing one fallback model');
    return new Set([ids[0]]);
  }
  return selected;
}

function saveIfChanged(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'w' });
    fs.renameSync(tmp, filePath);
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
