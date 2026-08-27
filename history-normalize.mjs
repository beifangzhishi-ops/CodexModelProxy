// 跨 GPT/DeepSeek 历史整理：发送前按目标供应商的 reasoning 与网页搜索格式整理。
// 只影响本次上游请求，不修改 Codex 原会话；不记录推理正文。

export const REASONING_FORMATS = Object.freeze({
  OPENAI_ENCRYPTED: 'openai_encrypted',
  DEEPSEEK_PLAINTEXT: 'deepseek_plaintext',
  OPENROUTER_COMPATIBLE: 'openrouter_compatible',
  PASSTHROUGH: 'passthrough',
});

export const TOOL_OUTPUT_FORMATS = Object.freeze({
  PASSTHROUGH: 'passthrough',
  JSON_STRING: 'json_string',
});

const VALID_FORMATS = new Set(Object.values(REASONING_FORMATS));
const VALID_TOOL_OUTPUT_FORMATS = new Set(Object.values(TOOL_OUTPUT_FORMATS));

export function isValidReasoningFormat(value) {
  return VALID_FORMATS.has(value);
}

export function isValidToolOutputFormat(value) {
  return VALID_TOOL_OUTPUT_FORMATS.has(value);
}

export function normalizeResponsesBody(
  body,
  reasoningFormat,
  toolOutputFormat = TOOL_OUTPUT_FORMATS.PASSTHROUGH,
) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return emptyNormalizationResult(body);
  }
  if (!Array.isArray(body.input)) {
    return emptyNormalizationResult(body);
  }
  const removedReasoningIndexes = [];
  const removedWebSearchIndexes = [];
  const normalizedReasoningIndexes = [];
  const normalizedToolOutputIndexes = [];
  const reasoningChanges = [];
  const toolOutputChanges = [];
  const normalizedInput = [];
  for (let index = 0; index < body.input.length; index++) {
    const item = body.input[index];
    let normalizedItem = item;
    if (isReasoningItem(item)) {
      const reasoningResult = normalizeReasoningItem(item, reasoningFormat);
      if (reasoningResult.changed) {
        normalizedItem = reasoningResult.item;
        normalizedReasoningIndexes.push(index);
        reasoningChanges.push({ index, fields: reasoningResult.fields });
      }
    }
    if (isWebSearchCall(normalizedItem) && !keepWebSearchCall(normalizedItem, reasoningFormat)) {
      removedWebSearchIndexes.push(index);
      continue;
    }
    if (
      isToolOutputItem(normalizedItem) &&
      toolOutputFormat === TOOL_OUTPUT_FORMATS.JSON_STRING &&
      typeof normalizedItem.output !== 'string'
    ) {
      const serializedOutput = serializeToolOutput(normalizedItem.output);
      normalizedItem = { ...normalizedItem, output: serializedOutput };
      normalizedToolOutputIndexes.push(index);
      toolOutputChanges.push({
        index,
        type: normalizedItem.type,
        from: describeValue(item.output),
        to: 'string',
        bytes: Buffer.byteLength(serializedOutput, 'utf8'),
      });
    }
    normalizedInput.push(normalizedItem);
  }
  if (
    removedReasoningIndexes.length === 0 &&
    removedWebSearchIndexes.length === 0 &&
    normalizedReasoningIndexes.length === 0 &&
    normalizedToolOutputIndexes.length === 0
  ) {
    return emptyNormalizationResult(body);
  }
  return {
    body: { ...body, input: normalizedInput },
    removedReasoningIndexes,
    removedWebSearchIndexes,
    normalizedReasoningIndexes,
    normalizedToolOutputIndexes,
    reasoningChanges,
    toolOutputChanges,
  };
}

function emptyNormalizationResult(body) {
  return {
    body,
    removedReasoningIndexes: [],
    removedWebSearchIndexes: [],
    normalizedReasoningIndexes: [],
    normalizedToolOutputIndexes: [],
    reasoningChanges: [],
    toolOutputChanges: [],
  };
}

function isReasoningItem(item) {
  return !!item && typeof item === 'object' && item.type === 'reasoning';
}

function isWebSearchCall(item) {
  return !!item && typeof item === 'object' && item.type === 'web_search_call';
}

function isToolOutputItem(item) {
  return (
    !!item &&
    typeof item === 'object' &&
    (item.type === 'function_call_output' || item.type === 'custom_tool_call_output')
  );
}

function keepWebSearchCall(item, reasoningFormat) {
  // OpenRouter Responses 不接受 Codex 的 web_search_call 历史项；搜索结论仍保留在助手消息中。
  if (reasoningFormat === REASONING_FORMATS.OPENROUTER_COMPATIBLE) return false;
  // GPT 的 Responses 要求 web_search_call.id 以 ws 开头；
  // DS/Codex 风格的 call_... 搜索记录只在发往 GPT 时移除。
  if (reasoningFormat !== REASONING_FORMATS.OPENAI_ENCRYPTED) return true;
  return typeof item.id === 'string' && item.id.startsWith('ws');
}

function normalizeReasoningItem(item, reasoningFormat) {
  if (reasoningFormat === REASONING_FORMATS.PASSTHROUGH) {
    return { item, changed: false, fields: [] };
  }
  let normalizedItem = item;
  const fields = [];
  if (reasoningFormat === REASONING_FORMATS.OPENAI_ENCRYPTED) {
    const content = item.content;
    const contentConflicts =
      Object.prototype.hasOwnProperty.call(item, 'content') &&
      (!Array.isArray(content) || content.length > 0);
    if (contentConflicts) {
      normalizedItem = { ...normalizedItem, content: [] };
      fields.push('content');
    }
  }
  if (
    reasoningFormat === REASONING_FORMATS.DEEPSEEK_PLAINTEXT ||
    reasoningFormat === REASONING_FORMATS.OPENROUTER_COMPATIBLE
  ) {
    if (
      Object.prototype.hasOwnProperty.call(item, 'encrypted_content') &&
      item.encrypted_content !== null
    ) {
      normalizedItem = { ...normalizedItem, encrypted_content: null };
      fields.push('encrypted_content');
    }
  }
  return { item: normalizedItem, changed: fields.length > 0, fields };
}

function serializeToolOutput(output) {
  try {
    const serialized = JSON.stringify(output);
    return serialized === undefined ? String(output) : serialized;
  } catch {
    return String(output);
  }
}

function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
