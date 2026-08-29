import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareMuseRequest,
  restoreMuseJsonPayload,
  MuseSseRestoreTransform,
} from '../muse-tool-compat.mjs';

function webSearchTool() {
  return {
    type: 'web_search',
    search_content_types: ['text', 'image'],
    search_context_size: 'medium',
  };
}

test('web_search 删除 search_content_types，web_search_preview 与其他字段保持不变', () => {
  const body = {
    tools: [webSearchTool(), { ...webSearchTool(), type: 'web_search_preview' }],
  };
  const { body: prepared } = prepareMuseRequest(body);
  assert.equal(Object.prototype.hasOwnProperty.call(prepared.tools[0], 'search_content_types'), false);
  assert.equal(prepared.tools[0].search_context_size, 'medium');
  assert.deepEqual(prepared.tools[1].search_content_types, ['text', 'image']);
  assert.deepEqual(body.tools[0].search_content_types, ['text', 'image']);
});

test('additional_tools 中的工具声明同样展平并补齐 required', () => {
  const body = {
    input: [
      {
        type: 'additional_tools',
        tools: [
          {
            type: 'namespace',
            name: 'mcp',
            tools: [
              {
                type: 'function',
                name: 'read',
                inputSchema: {
                  type: 'object',
                  properties: { path: { type: 'string' }, offset: { type: 'integer' } },
                  required: ['path'],
                },
              },
            ],
          },
        ],
      },
    ],
  };
  const { body: prepared } = prepareMuseRequest(body);
  const tool = prepared.input[0].tools[0];
  assert.equal(tool.type, 'function');
  assert.equal(tool.name, 'mcp__read');
  assert.deepEqual(tool.parameters.required, ['path', 'offset']);
});

test('namespace 子工具超长名称截断为 64 字符内且确定性', () => {
  const longName = 'mcp__codex_apps__github__list_repository_pull_request_review_comments_for_branch';
  const tools = () => [
    {
      type: 'namespace',
      name: 'mcp',
      tools: [{ type: 'function', name: longName, inputSchema: { type: 'object' } }],
    },
  ];
  const first = prepareMuseRequest({ tools: tools() }).body.tools[0];
  const second = prepareMuseRequest({ tools: tools() }).body.tools[0];
  assert.ok(first.name.length <= 64);
  assert.ok(first.name.startsWith('mcp__mcp__'));
  assert.match(first.name, /_[0-9a-f]{12}$/);
  assert.equal(first.name, second.name);
});

test('展平名冲突时两个工具使用不同 wire 名且互不覆盖', () => {
  const tools = [
    { type: 'function', name: 'a__b', parameters: { type: 'object', properties: {}, required: [] } },
    {
      type: 'namespace',
      name: 'a',
      tools: [{ type: 'function', name: 'b', inputSchema: { type: 'object' } }],
    },
  ];
  const { body: prepared } = prepareMuseRequest({ tools });
  const names = prepared.tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, 2);
  assert.ok(names.includes('a__b'));
});

test('custom 声明与历史双向转换', () => {
  const body = {
    tools: [{ type: 'custom', name: 'apply_patch', description: 'raw patch' }],
    input: [
      {
        type: 'custom_tool_call',
        call_id: 'call_1',
        name: 'apply_patch',
        input: 'patch content',
      },
      { type: 'custom_tool_call_output', call_id: 'call_1', output: 'ok' },
    ],
  };
  const { body: prepared, ctx } = prepareMuseRequest(body);
  const declaration = prepared.tools[0];
  assert.equal(declaration.type, 'function');
  assert.equal(declaration.name, 'apply_patch');
  assert.deepEqual(declaration.parameters.required, ['input']);
  const call = prepared.input.find((item) => item.call_id === 'call_1' && item.type === 'function_call');
  assert.deepEqual(JSON.parse(call.arguments), { input: 'patch content' });
  assert.equal(prepared.input.find((item) => item.call_id === 'call_1' && item.type === 'function_call_output').output, 'ok');

  const restored = restoreMuseJsonPayload(
    {
      output: [{ type: 'function_call', name: 'apply_patch', call_id: 'call_2', arguments: '{"input":"new patch"}' }],
    },
    ctx,
  );
  assert.deepEqual(restored.output[0], {
    type: 'custom_tool_call',
    name: 'apply_patch',
    call_id: 'call_2',
    input: 'new patch',
  });
});

test('tool_search 声明、历史与 tool_choice 转换并恢复', () => {
  const body = {
    tools: [
      {
        type: 'tool_search',
        execution: 'client',
        description: 'search tools',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'integer' } },
          required: ['query'],
        },
      },
    ],
    tool_choice: { type: 'tool_search', execution: 'client' },
    input: [
      {
        type: 'tool_search_call',
        call_id: 'search_1',
        name: 'tool_search',
        arguments: { query: 'read file' },
      },
      { type: 'tool_search_output', call_id: 'search_1', output: '{"tools":[]}' },
    ],
  };
  const { body: prepared, ctx } = prepareMuseRequest(body);
  assert.equal(prepared.tools[0].type, 'function');
  assert.equal(prepared.tools[0].name, 'tool_search');
  assert.deepEqual(prepared.tools[0].parameters.required, ['query', 'limit']);
  assert.deepEqual(prepared.tool_choice, { type: 'function', name: 'tool_search' });
  const call = prepared.input.find((item) => item.call_id === 'search_1' && item.type === 'function_call');
  assert.deepEqual(JSON.parse(call.arguments), { query: 'read file' });

  const restored = restoreMuseJsonPayload(
    {
      output: [{ type: 'function_call', name: 'tool_search', call_id: 'search_2', arguments: '{"query":"read"}' }],
    },
    ctx,
  );
  assert.deepEqual(restored.output[0], {
    type: 'tool_search_call',
    execution: 'client',
    call_id: 'search_2',
    arguments: { query: 'read' },
  });
});

test('JSON 恢复 namespace 调用为原生 { name, namespace }', () => {
  const tools = [
    {
      type: 'namespace',
      name: 'mcp',
      tools: [{ type: 'function', name: 'read', inputSchema: { type: 'object' } }],
    },
  ];
  const { ctx } = prepareMuseRequest({ tools });
  const restored = restoreMuseJsonPayload(
    { output: [{ type: 'function_call', name: 'mcp__read', call_id: 'call_1', arguments: '{}' }] },
    ctx,
  );
  assert.equal(restored.output[0].type, 'function_call');
  assert.equal(restored.output[0].name, 'read');
  assert.equal(restored.output[0].namespace, 'mcp');
});

test('SSE 恢复 added/done 与 custom 参数增量', async () => {
  const body = {
    tools: [{ type: 'custom', name: 'apply_patch', description: 'raw patch' }],
  };
  const { ctx } = prepareMuseRequest(body);
  const blocks = [
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","name":"apply_patch","call_id":"call_1","arguments":""}}',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"{\\"input\\":\\"hel"}',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"lo\\"}"}',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","name":"apply_patch","call_id":"call_1","arguments":"{\\"input\\":\\"hello\\"}"}}',
  ];
  const output = await runSse(ctx, blocks);
  assert.ok(output.includes('response.output_item.added'));
  assert.ok(output.includes('response.custom_tool_call_input.delta'));
  assert.ok(output.includes('"delta":"hel"'));
  assert.ok(output.includes('"delta":"lo"'));
  assert.ok(output.includes('"type":"custom_tool_call"'));
  assert.ok(output.includes('"name":"apply_patch"'));
});

test('SSE completed 事件的 response.output 会恢复', async () => {
  const tools = [
    {
      type: 'namespace',
      name: 'mcp',
      tools: [{ type: 'function', name: 'read', inputSchema: { type: 'object' } }],
    },
  ];
  const { ctx } = prepareMuseRequest({ tools });
  const blocks = [
    'event: response.completed\ndata: {"type":"response.completed","response":{"output":[{"type":"function_call","name":"mcp__read","call_id":"call_1","arguments":"{}"}]}}',
  ];
  const output = await runSse(ctx, blocks);
  assert.ok(output.includes('"namespace":"mcp"'));
  assert.ok(output.includes('"name":"read"'));
});

test('畸形 JSON 与未知 SSE 块原样透传', () => {
  const { ctx } = prepareMuseRequest({ tools: [{ type: 'custom', name: 'apply_patch' }] });
  const payload = { output: 'not-an-array' };
  assert.equal(restoreMuseJsonPayload(payload, ctx), payload);
  const transform = new MuseSseRestoreTransform(ctx);
  const captured = [];
  transform.on('data', (chunk) => captured.push(chunk.toString('utf8')));
  transform.write('event: x\ndata: {not-json}\n\n');
  transform.end();
  assert.equal(captured.join(''), 'event: x\ndata: {not-json}\n\n');
});

test('并发请求的映射相互隔离', () => {
  const makeTools = (namespace) => [
    {
      type: 'namespace',
      name: namespace,
      tools: [{ type: 'function', name: 'read', inputSchema: { type: 'object' } }],
    },
  ];
  const a = prepareMuseRequest({ tools: makeTools('aaa') });
  const b = prepareMuseRequest({ tools: makeTools('bbb') });
  assert.equal(a.body.tools[0].name, 'aaa__read');
  assert.equal(b.body.tools[0].name, 'bbb__read');
});

async function runSse(ctx, blocks) {
  const transform = new MuseSseRestoreTransform(ctx);
  const chunks = [];
  transform.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    transform.on('end', resolve);
    transform.on('error', reject);
  });
  transform.write(blocks.join('\n\n'));
  transform.end();
  await done;
  return Buffer.concat(chunks).toString('utf8');
}
