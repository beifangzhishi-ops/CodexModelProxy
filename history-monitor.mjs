// 可选的 Responses 历史结构监控：只记录结构、长度和处理动作，不记录正文或密钥。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_HISTORY_MONITOR_FILE = 'history-monitor.jsonl';
export const DEFAULT_HISTORY_MONITOR_MAX_BYTES = 10 * 1024 * 1024;

export function createHistoryMonitor({
  env = process.env,
  baseDir = process.cwd(),
  logger = console,
  maxBytes,
} = {}) {
  const enabled = isEnabled(env.HISTORY_MONITOR);
  const configuredFile = String(env.HISTORY_MONITOR_FILE || '').trim();
  const filePath = path.isAbsolute(configuredFile)
    ? configuredFile
    : path.resolve(baseDir, configuredFile || DEFAULT_HISTORY_MONITOR_FILE);
  const limit = maxBytes || parsePositiveInteger(env.HISTORY_MONITOR_MAX_BYTES) || DEFAULT_HISTORY_MONITOR_MAX_BYTES;
  let warned = false;

  const writeEvent = (event) => {
    if (!enabled) return;
    try {
      const line = `${JSON.stringify({
        timestamp: new Date().toISOString(),
        ...event,
      })}\n`;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      rotateIfNeeded(filePath, Buffer.byteLength(line, 'utf8'), limit);
      fs.appendFileSync(filePath, line, 'utf8');
    } catch (err) {
      if (!warned) {
        warned = true;
        logger.warn(`[codex-proxy] 历史监控日志写入失败：${err.message}`);
      }
    }
  };

  return {
    enabled,
    filePath,
    startRequest({ endpoint, model, route, network, body }) {
      if (!enabled) return null;
      const requestId = randomUUID();
      writeEvent({
        event: 'request_before',
        request_id: requestId,
        endpoint,
        model,
        upstream_model: route?.upstream_model || '',
        network,
        body_bytes: jsonByteLength(body),
        history: summarizeResponsesBody(body),
      });
      return requestId;
    },
    recordNormalized({
      requestId,
      endpoint,
      model,
      upstreamModel,
      network,
      attempt,
      body,
      actions,
    }) {
      if (!enabled || !requestId) return;
      writeEvent({
        event: 'request_after',
        request_id: requestId,
        endpoint,
        model,
        upstream_model: upstreamModel || '',
        network,
        attempt,
        body_bytes: jsonByteLength(body),
        actions: summarizeActions(actions),
        history: summarizeResponsesBody(body),
      });
    },
    recordResult({
      requestId,
      endpoint,
      model,
      upstreamModel,
      network,
      attempt,
      status,
      upstreamHost,
      error,
    }) {
      if (!enabled || !requestId) return;
      writeEvent({
        event: 'upstream_result',
        request_id: requestId,
        endpoint,
        model,
        upstream_model: upstreamModel || '',
        network,
        attempt,
        status: status ?? null,
        upstream_host: upstreamHost || '',
        error: summarizeError(error),
      });
    },
  };
}

export function summarizeResponsesBody(body) {
  const input = Array.isArray(body?.input)
    ? body.input
    : typeof body?.input === 'string'
      ? [{ type: 'input_string' }]
      : [];
  const inputTypes = {};
  const callIds = new Set();
  const outputIds = new Set();
  const items = input.map((item, index) => {
    const summary = summarizeItem(item, index);
    bump(inputTypes, summary.type);
    if (typeof item?.call_id === 'string') {
      if (isToolOutputType(item.type)) outputIds.add(item.call_id);
      else callIds.add(item.call_id);
    }
    return summary;
  });
  const toolTypes = Array.isArray(body?.tools)
    ? body.tools.map((tool) => ({
      type: typeof tool?.type === 'string' ? tool.type : 'invalid_tool',
      name: typeof tool?.name === 'string' ? tool.name : '',
    }))
    : [];
  return {
    input_count: items.length,
    input_types: inputTypes,
    items,
    tools: toolTypes,
    pairing: {
      function_calls: [...callIds].length,
      function_call_outputs: [...outputIds].length,
      orphan_calls: [...callIds].filter((id) => !outputIds.has(id)).length,
      orphan_outputs: [...outputIds].filter((id) => !callIds.has(id)).length,
    },
  };
}

function summarizeItem(item, index) {
  const summary = {
    index,
    type: typeof item?.type === 'string' ? item.type : 'invalid_item',
  };
  if (typeof item?.id === 'string') summary.id = item.id;
  if (typeof item?.call_id === 'string') summary.call_id = item.call_id;
  if (summary.type === 'reasoning') {
    summary.reasoning = {
      content: summarizeContent(item.content),
      encrypted_content: {
        present: item.encrypted_content !== undefined && item.encrypted_content !== null,
        kind: describeValue(item.encrypted_content),
        length: typeof item.encrypted_content === 'string' ? item.encrypted_content.length : null,
        bytes: typeof item.encrypted_content === 'string'
          ? Buffer.byteLength(item.encrypted_content, 'utf8')
          : 0,
      },
    };
  }
  if (summary.type === 'message') summary.content = summarizeContent(item.content);
  if (isToolOutputType(summary.type)) {
    summary.output = {
      present: Object.prototype.hasOwnProperty.call(item, 'output'),
      kind: describeValue(item.output),
      array_length: Array.isArray(item.output) ? item.output.length : null,
      bytes: valueByteLength(item.output),
    };
  }
  return summary;
}

function summarizeContent(content) {
  if (content === undefined) return { present: false, kind: 'absent', length: null };
  if (content === null) return { present: true, kind: 'null', length: null };
  if (Array.isArray(content)) {
    return {
      present: true,
      kind: 'array',
      length: content.length,
      item_types: content.map((part) => typeof part?.type === 'string' ? part.type : 'invalid').slice(0, 32),
    };
  }
  if (typeof content === 'string') return { present: true, kind: 'string', length: content.length };
  return { present: true, kind: typeof content, length: null };
}

function summarizeError(error) {
  if (!error) return null;
  const raw = error instanceof Error ? error.message : String(error);
  return { message: redactText(raw) };
}

function redactText(value) {
  return String(value)
    .replace(/data:[^,\s]+,[^\s]*/gi, '[redacted-data]')
    .replace(/[A-Za-z0-9+/=_-]{80,}/g, '[redacted-token]')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

function summarizeActions(actions) {
  const source = actions && typeof actions === 'object' ? actions : {};
  return {
    removed_reasoning_indexes: summarizeIndexes(source.removed_reasoning_indexes),
    removed_web_search_indexes: summarizeIndexes(source.removed_web_search_indexes),
    normalized_item_id_indexes: summarizeIndexes(source.normalized_item_id_indexes),
    normalized_reasoning_indexes: summarizeIndexes(source.normalized_reasoning_indexes),
    normalized_tool_output_indexes: summarizeIndexes(source.normalized_tool_output_indexes),
    item_id_changes: Array.isArray(source.item_id_changes)
      ? source.item_id_changes
        .filter((change) => change && Number.isInteger(change.index))
        .map((change) => ({
          index: change.index,
          type: typeof change.type === 'string' ? change.type : '',
          actions: Array.isArray(change.actions)
            ? change.actions.filter((action) => action === 'characters' || action === 'prefix')
            : [],
        }))
      : [],
    reasoning_changes: Array.isArray(source.reasoning_changes)
      ? source.reasoning_changes
        .filter((change) => change && Number.isInteger(change.index))
        .map((change) => ({
          index: change.index,
          fields: Array.isArray(change.fields)
            ? change.fields.filter((field) => typeof field === 'string')
            : [],
        }))
      : [],
    tool_output_changes: Array.isArray(source.tool_output_changes)
      ? source.tool_output_changes
        .filter((change) => change && Number.isInteger(change.index))
        .map((change) => ({
          index: change.index,
          type: typeof change.type === 'string' ? change.type : '',
          from: typeof change.from === 'string' ? change.from : '',
          to: typeof change.to === 'string' ? change.to : '',
          bytes: Number.isInteger(change.bytes) && change.bytes >= 0 ? change.bytes : 0,
        }))
      : [],
  };
}

function summarizeIndexes(value) {
  return Array.isArray(value) ? value.filter((index) => Number.isInteger(index)) : [];
}

function rotateIfNeeded(filePath, incomingBytes, limit) {
  let currentBytes = 0;
  try {
    currentBytes = fs.statSync(filePath).size;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (currentBytes === 0 || currentBytes + incomingBytes <= limit) return;
  const backupPath = `${filePath}.1`;
  try {
    fs.unlinkSync(backupPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.renameSync(filePath, backupPath);
}

function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function parsePositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function isToolOutputType(type) {
  return type === 'function_call_output' || type === 'custom_tool_call_output';
}

function describeValue(value) {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function jsonByteLength(value) {
  if (value === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

function valueByteLength(value) {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  return jsonByteLength(value);
}
