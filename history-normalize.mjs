// 跨 GPT/DeepSeek 历史整理：发送前按目标供应商的 reasoning 与网页搜索格式过滤。
// 只影响本次上游请求，不修改 Codex 原会话；不记录推理正文。

export const REASONING_FORMATS = Object.freeze({
  OPENAI_ENCRYPTED: 'openai_encrypted',
  DEEPSEEK_PLAINTEXT: 'deepseek_plaintext',
  PASSTHROUGH: 'passthrough',
});

const VALID_FORMATS = new Set(Object.values(REASONING_FORMATS));

export function isValidReasoningFormat(value) {
  return VALID_FORMATS.has(value);
}

export function normalizeResponsesBody(body, reasoningFormat) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { body, removedReasoningIndexes: [], removedWebSearchIndexes: [] };
  }
  if (!Array.isArray(body.input)) {
    return { body, removedReasoningIndexes: [], removedWebSearchIndexes: [] };
  }
  const removedReasoningIndexes = [];
  const removedWebSearchIndexes = [];
  const normalizedInput = [];
  for (let index = 0; index < body.input.length; index++) {
    const item = body.input[index];
    if (isReasoningItem(item) && !keepReasoning(item, reasoningFormat)) {
      removedReasoningIndexes.push(index);
      continue;
    }
    if (isWebSearchCall(item) && !keepWebSearchCall(item, reasoningFormat)) {
      removedWebSearchIndexes.push(index);
      continue;
    }
    normalizedInput.push(item);
  }
  if (removedReasoningIndexes.length === 0 && removedWebSearchIndexes.length === 0) {
    return { body, removedReasoningIndexes, removedWebSearchIndexes };
  }
  return {
    body: { ...body, input: normalizedInput },
    removedReasoningIndexes,
    removedWebSearchIndexes,
  };
}

function isReasoningItem(item) {
  return !!item && typeof item === 'object' && item.type === 'reasoning';
}

function isWebSearchCall(item) {
  return !!item && typeof item === 'object' && item.type === 'web_search_call';
}

function keepWebSearchCall(item, reasoningFormat) {
  // GPT 的 Responses 要求 web_search_call.id 以 ws 开头；
  // DS/Codex 风格的 call_... 搜索记录只在发往 GPT 时移除。
  if (reasoningFormat !== REASONING_FORMATS.OPENAI_ENCRYPTED) return true;
  return typeof item.id === 'string' && item.id.startsWith('ws');
}

function keepReasoning(item, reasoningFormat) {
  if (reasoningFormat === REASONING_FORMATS.PASSTHROUGH) return true;
  const hasEncrypted =
    typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0;
  const hasPlaintext = Array.isArray(item.content) && item.content.length > 0;
  if (reasoningFormat === REASONING_FORMATS.OPENAI_ENCRYPTED) {
    const contentEmpty =
      item.content === undefined ||
      item.content === null ||
      (Array.isArray(item.content) && item.content.length === 0);
    return hasEncrypted && contentEmpty;
  }
  if (reasoningFormat === REASONING_FORMATS.DEEPSEEK_PLAINTEXT) {
    return hasPlaintext && !hasEncrypted;
  }
  return true;
}
