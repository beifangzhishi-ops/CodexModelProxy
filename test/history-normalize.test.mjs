// 历史整理单元测试：直接验证按目标 reasoning 格式过滤的行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResponsesBody, REASONING_FORMATS } from '../history-normalize.mjs';

const GPT = REASONING_FORMATS.OPENAI_ENCRYPTED;
const DS = REASONING_FORMATS.DEEPSEEK_PLAINTEXT;
const PASSTHROUGH = REASONING_FORMATS.PASSTHROUGH;

const dsReasoning = {
  type: 'reasoning',
  content: [{ type: 'reasoning_text', text: 'ds-thought' }],
  encrypted_content: null,
};

const gptReasoning = {
  type: 'reasoning',
  encrypted_content: 'opaque-gpt',
  content: [],
};

const userMessage = {
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: 'hello' }],
};

test('GPT 目标只保留带有效 encrypted_content 的 reasoning', () => {
  const result = normalizeResponsesBody(
    { input: [dsReasoning, gptReasoning, userMessage] },
    GPT,
  );
  assert.deepEqual(result.body.input, [gptReasoning, userMessage]);
  assert.deepEqual(result.removedReasoningIndexes, [0]);
});

test('DS 目标只保留非空明文 content 的 reasoning', () => {
  const result = normalizeResponsesBody(
    { input: [gptReasoning, dsReasoning, userMessage] },
    DS,
  );
  assert.deepEqual(result.body.input, [dsReasoning, userMessage]);
  assert.deepEqual(result.removedReasoningIndexes, [0]);
});

test('passthrough 目标保留所有 reasoning', () => {
  const input = [dsReasoning, gptReasoning];
  const body = { input };
  const result = normalizeResponsesBody(body, PASSTHROUGH);
  assert.equal(result.body, body);
  assert.deepEqual(result.body.input, input);
  assert.deepEqual(result.removedReasoningIndexes, []);
});

test('畸形与不完整 reasoning 对 GPT 和 DS 均被移除', () => {
  const malformed = [
    { type: 'reasoning' },
    { type: 'reasoning', content: [] },
    { type: 'reasoning', encrypted_content: '' },
    { type: 'reasoning', content: 'not-an-array', encrypted_content: 'opaque' },
    {
      type: 'reasoning',
      content: [{ type: 'reasoning_text', text: 'both' }],
      encrypted_content: 'opaque',
    },
    userMessage,
  ];
  const gptResult = normalizeResponsesBody({ input: malformed }, GPT);
  assert.deepEqual(gptResult.body.input, [userMessage]);
  assert.deepEqual(gptResult.removedReasoningIndexes, [0, 1, 2, 3, 4]);

  const dsResult = normalizeResponsesBody({ input: malformed }, DS);
  assert.deepEqual(dsResult.body.input, [userMessage]);
  assert.deepEqual(dsResult.removedReasoningIndexes, [0, 1, 2, 3, 4]);
});

test('普通消息、工具调用、搜索与压缩项保持不变', () => {
  const preserved = [
    userMessage,
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'demo', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    { type: 'search_call', id: 'sc_1', query: 'x' },
    {
      type: 'search_result',
      id: 'sr_1',
      source: { id: 's1' },
      content: [{ type: 'output_text', text: 'result' }],
    },
    { type: 'compaction', encrypted_content: 'opaque-compact' },
    { type: 'item_reference', id: 'item_1' },
  ];
  const gptResult = normalizeResponsesBody({ input: [dsReasoning, ...preserved] }, GPT);
  assert.deepEqual(gptResult.body.input, preserved);
  const dsResult = normalizeResponsesBody({ input: [gptReasoning, ...preserved] }, DS);
  assert.deepEqual(dsResult.body.input, preserved);
});

test('字符串 input 与不含 reasoning 的 input 保持原引用', () => {
  const stringBody = { input: 'hello' };
  const stringResult = normalizeResponsesBody(stringBody, GPT);
  assert.equal(stringResult.body, stringBody);
  assert.deepEqual(stringResult.removedReasoningIndexes, []);

  const plainInput = [{ type: 'input_text', text: 'hello' }];
  const plainBody = { input: plainInput };
  const plainResult = normalizeResponsesBody(plainBody, DS);
  assert.equal(plainResult.body, plainBody);
  assert.deepEqual(plainResult.removedReasoningIndexes, []);
});

test('非对象请求体与非法 reasoning_format 均安全返回', () => {
  const nullResult = normalizeResponsesBody(null, GPT);
  assert.equal(nullResult.body, null);
  assert.deepEqual(nullResult.removedReasoningIndexes, []);

  const unknownFormat = normalizeResponsesBody(
    { input: [dsReasoning, gptReasoning] },
    'unknown',
  );
  assert.deepEqual(unknownFormat.body.input, [dsReasoning, gptReasoning]);
  assert.deepEqual(unknownFormat.removedReasoningIndexes, []);
});
