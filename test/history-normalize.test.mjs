// 历史整理单元测试：直接验证按目标 reasoning 格式过滤的行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeResponsesBody,
  REASONING_FORMATS,
  TOOL_OUTPUT_FORMATS,
} from '../history-normalize.mjs';

const GPT = REASONING_FORMATS.OPENAI_ENCRYPTED;
const DS = REASONING_FORMATS.DEEPSEEK_PLAINTEXT;
const OPENROUTER = REASONING_FORMATS.OPENROUTER_COMPATIBLE;
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

const foreignReasoningReference = {
  type: 'reasoning',
  id: 'rs_foreign_reference',
  content: null,
  encrypted_content: '01234567-89ab-cdef-0123-456789abcdef-0',
};

const museReasoning = {
  type: 'reasoning',
  id: 'rs_6a9293021ea061d200224fc9:rs_01a04c8e4ce57b009cecb10de9ea4803',
  content: null,
  encrypted_content: 'opaque-muse-state',
};

const userMessage = {
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: 'hello' }],
};

const dsWebSearch = {
  type: 'web_search_call',
  id: 'call_00_bXZiVEuheXGCpYHtDOCm5367',
  status: 'completed',
};

const gptWebSearch = {
  type: 'web_search_call',
  id: 'ws_67ccf18f64008190a39b619f4c8455ef',
  status: 'completed',
};

test('GPT 目标保留 reasoning 项，仅清空冲突的明文 content', () => {
  const body = { input: [dsReasoning, gptReasoning, userMessage] };
  const result = normalizeResponsesBody(
    body,
    GPT,
  );
  assert.deepEqual(result.body.input, [
    { ...dsReasoning, content: [] },
    gptReasoning,
    userMessage,
  ]);
  assert.deepEqual(result.removedReasoningIndexes, []);
  assert.deepEqual(result.normalizedReasoningIndexes, [0]);
  assert.deepEqual(result.reasoningChanges, [{ index: 0, fields: ['content'] }]);
  assert.deepEqual(body.input, [dsReasoning, gptReasoning, userMessage]);
  assert.notEqual(result.body, body);
  assert.notEqual(result.body.input[0], dsReasoning);
  assert.equal(result.body.input[1], gptReasoning);
});

test('GPT 目标仅清空 OC/DS 外部 reasoning 引用，保留项目和原请求', () => {
  const body = { input: [foreignReasoningReference, gptReasoning, userMessage] };
  const result = normalizeResponsesBody(body, GPT);

  assert.deepEqual(result.body.input, [
    { ...foreignReasoningReference, content: [], encrypted_content: null },
    gptReasoning,
    userMessage,
  ]);
  assert.deepEqual(result.normalizedReasoningIndexes, [0]);
  assert.deepEqual(result.reasoningChanges, [{
    index: 0,
    fields: ['content', 'encrypted_content'],
  }]);
  assert.deepEqual(body.input, [foreignReasoningReference, gptReasoning, userMessage]);
  assert.equal(result.body.input[0].id, foreignReasoningReference.id);
  assert.equal(result.body.input[1], gptReasoning);
});

test('Muse 切换到 GPT 时规范化复合 reasoning ID，保留密文和原请求', () => {
  const body = { input: [museReasoning, userMessage] };
  const result = normalizeResponsesBody(body, GPT);

  assert.deepEqual(result.body.input, [
    {
      ...museReasoning,
      id: 'rs_6a9293021ea061d200224fc9_rs_01a04c8e4ce57b009cecb10de9ea4803',
      content: [],
    },
    userMessage,
  ]);
  assert.deepEqual(result.normalizedReasoningIndexes, [0]);
  assert.deepEqual(result.reasoningChanges, [{ index: 0, fields: ['id', 'content'] }]);
  assert.equal(result.body.input[0].encrypted_content, museReasoning.encrypted_content);
  assert.equal(body.input[0], museReasoning);
});

test('DS 目标保留 reasoning 项，仅清空冲突的 encrypted_content', () => {
  const result = normalizeResponsesBody(
    { input: [gptReasoning, dsReasoning, userMessage] },
    DS,
  );
  assert.deepEqual(result.body.input, [
    { ...gptReasoning, encrypted_content: null },
    dsReasoning,
    userMessage,
  ]);
  assert.deepEqual(result.removedReasoningIndexes, []);
  assert.deepEqual(result.normalizedReasoningIndexes, [0]);
  assert.deepEqual(result.reasoningChanges, [{ index: 0, fields: ['encrypted_content'] }]);
});

test('passthrough 目标保留所有 reasoning', () => {
  const input = [dsReasoning, gptReasoning];
  const body = { input };
  const result = normalizeResponsesBody(body, PASSTHROUGH);
  assert.equal(result.body, body);
  assert.deepEqual(result.body.input, input);
  assert.deepEqual(result.removedReasoningIndexes, []);
});

test('畸形与不完整 reasoning 对 GPT 和 DS 均保留并按字段清空', () => {
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
  assert.deepEqual(gptResult.body.input, [
    { type: 'reasoning' },
    { type: 'reasoning', content: [] },
    { type: 'reasoning', encrypted_content: '' },
    { type: 'reasoning', content: [], encrypted_content: 'opaque' },
    { type: 'reasoning', content: [], encrypted_content: 'opaque' },
    userMessage,
  ]);
  assert.deepEqual(gptResult.removedReasoningIndexes, []);
  assert.deepEqual(gptResult.normalizedReasoningIndexes, [3, 4]);

  const dsResult = normalizeResponsesBody({ input: malformed }, DS);
  assert.deepEqual(dsResult.body.input, [
    { type: 'reasoning' },
    { type: 'reasoning', content: [] },
    { type: 'reasoning', encrypted_content: null },
    { type: 'reasoning', content: 'not-an-array', encrypted_content: null },
    {
      type: 'reasoning',
      content: [{ type: 'reasoning_text', text: 'both' }],
      encrypted_content: null,
    },
    userMessage,
  ]);
  assert.deepEqual(dsResult.removedReasoningIndexes, []);
  assert.deepEqual(dsResult.normalizedReasoningIndexes, [2, 3, 4]);
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
  assert.deepEqual(gptResult.body.input, [{ ...dsReasoning, content: [] }, ...preserved]);
  const dsResult = normalizeResponsesBody({ input: [gptReasoning, ...preserved] }, DS);
  assert.deepEqual(dsResult.body.input, [{ ...gptReasoning, encrypted_content: null }, ...preserved]);
});

test('json_string 将两个工具输出类型完整序列化，字符串保持不变', () => {
  const imageOutput = [
    {
      type: 'image',
      image_url: 'data:image/png;base64,fixture-image-data',
      detail: 'original',
    },
  ];
  const objectOutput = {
    width: 320,
    height: 240,
    pixels: [{ r: 1, g: 2, b: 3 }],
  };
  const input = [
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'view_image', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: imageOutput },
    { type: 'custom_tool_call_output', call_id: 'call_2', output: objectOutput },
    { type: 'function_call_output', call_id: 'call_3', output: 42 },
    { type: 'custom_tool_call_output', call_id: 'call_4', output: null },
    { type: 'function_call_output', call_id: 'call_5', output: 'already-text' },
  ];
  const body = { input };
  const result = normalizeResponsesBody(body, DS, TOOL_OUTPUT_FORMATS.JSON_STRING);

  assert.equal(result.body.input[0], input[0]);
  assert.equal(result.body.input[1].call_id, 'call_1');
  assert.deepEqual(JSON.parse(result.body.input[1].output), imageOutput);
  assert.deepEqual(JSON.parse(result.body.input[2].output), objectOutput);
  assert.equal(result.body.input[3].output, '42');
  assert.equal(result.body.input[4].output, 'null');
  assert.equal(result.body.input[5], input[5]);
  assert.deepEqual(result.normalizedToolOutputIndexes, [1, 2, 3, 4]);
  assert.deepEqual(result.toolOutputChanges, [
    { index: 1, type: 'function_call_output', from: 'array', to: 'string', bytes: Buffer.byteLength(JSON.stringify(imageOutput)) },
    { index: 2, type: 'custom_tool_call_output', from: 'object', to: 'string', bytes: Buffer.byteLength(JSON.stringify(objectOutput)) },
    { index: 3, type: 'function_call_output', from: 'number', to: 'string', bytes: 2 },
    { index: 4, type: 'custom_tool_call_output', from: 'null', to: 'string', bytes: 4 },
  ]);
  assert.equal(result.body.input[1].output.includes('fixture-image-data'), true);
  assert.deepEqual(body.input, input);
  assert.notEqual(result.body, body);
});

test('passthrough 工具输出和没有变化的请求保持原引用', () => {
  const output = [{ type: 'image', data: 'base64-fixture' }];
  const body = {
    input: [{ type: 'function_call_output', call_id: 'call_1', output }],
  };
  const result = normalizeResponsesBody(body, PASSTHROUGH, TOOL_OUTPUT_FORMATS.PASSTHROUGH);
  assert.equal(result.body, body);
  assert.equal(result.body.input[0].output, output);
  assert.deepEqual(result.normalizedToolOutputIndexes, []);
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
  assert.deepEqual(nullResult.removedWebSearchIndexes, []);

  const unknownFormat = normalizeResponsesBody(
    { input: [dsReasoning, gptReasoning] },
    'unknown',
  );
  assert.deepEqual(unknownFormat.body.input, [dsReasoning, gptReasoning]);
  assert.deepEqual(unknownFormat.removedReasoningIndexes, []);
  assert.deepEqual(unknownFormat.removedWebSearchIndexes, []);
});

test('GPT 目标删除非 ws 前缀的 web_search_call，保留 ws_ 记录', () => {
  const result = normalizeResponsesBody(
    { input: [dsWebSearch, gptWebSearch, userMessage] },
    GPT,
  );
  assert.deepEqual(result.body.input, [gptWebSearch, userMessage]);
  assert.deepEqual(result.removedWebSearchIndexes, [0]);
  assert.deepEqual(result.removedReasoningIndexes, []);
});

test('DS 与 passthrough 目标保留全部 web_search_call', () => {
  const input = [dsWebSearch, gptWebSearch];
  const dsBody = { input };
  const dsResult = normalizeResponsesBody(dsBody, DS);
  assert.equal(dsResult.body, dsBody);
  assert.deepEqual(dsResult.removedWebSearchIndexes, []);

  const passBody = { input };
  const passResult = normalizeResponsesBody(passBody, PASSTHROUGH);
  assert.equal(passResult.body, passBody);
  assert.deepEqual(passResult.removedWebSearchIndexes, []);
});

test('OpenRouter 清空 encrypted_content、移除 web_search_call，保留普通历史', () => {
  const body = {
    input: [gptReasoning, dsReasoning, dsWebSearch, gptWebSearch, userMessage],
  };
  const result = normalizeResponsesBody(body, OPENROUTER);
  assert.deepEqual(result.body.input, [
    { ...gptReasoning, encrypted_content: null },
    dsReasoning,
    userMessage,
  ]);
  assert.deepEqual(result.removedReasoningIndexes, []);
  assert.deepEqual(result.normalizedReasoningIndexes, [0]);
  assert.deepEqual(result.removedWebSearchIndexes, [2, 3]);
});
