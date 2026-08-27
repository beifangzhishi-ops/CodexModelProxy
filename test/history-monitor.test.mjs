// 历史监控测试：只使用临时目录，不写入项目运行日志。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createHistoryMonitor,
  summarizeResponsesBody,
} from '../history-monitor.mjs';

function makeTempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-history-monitor-'));
}

function removeTempDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

function readEvents(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const sensitiveBody = {
  model: 'deepseek-v4-flash',
  input: [
    {
      type: 'reasoning',
      id: 'rs_sensitive_id',
      content: [{ type: 'reasoning_text', text: 'REASONING_BODY_SHOULD_NOT_BE_LOGGED' }],
      encrypted_content: 'ENCRYPTED_CONTENT_SHOULD_NOT_BE_LOGGED',
    },
    {
      type: 'function_call',
      id: 'fc_sensitive_id',
      call_id: 'call_sensitive',
      name: 'view_image',
      arguments: '{"secret_tool_parameter":"TOOL_PARAMETER_SHOULD_NOT_BE_LOGGED"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call_sensitive',
      output: [{
        type: 'image',
        image_url: 'data:image/png;base64,IMAGE_BASE64_SHOULD_NOT_BE_LOGGED',
        data: 'IMAGE_DATA_SHOULD_NOT_BE_LOGGED',
      }],
    },
    {
      type: 'message',
      content: [{ type: 'input_text', text: 'MESSAGE_BODY_SHOULD_NOT_BE_LOGGED' }],
    },
  ],
  tools: [{ type: 'function', name: 'view_image' }],
};

test('监控默认关闭时不创建日志文件', () => {
  const directory = makeTempDirectory();
  try {
    const filePath = path.join(directory, 'monitor.jsonl');
    const monitor = createHistoryMonitor({
      env: { HISTORY_MONITOR: '0', HISTORY_MONITOR_FILE: filePath },
      logger: { warn() {} },
    });
    assert.equal(monitor.enabled, false);
    monitor.startRequest({
      endpoint: '/v1/responses',
      model: sensitiveBody.model,
      route: { upstream_model: 'deepseek-v4-flash' },
      network: 'direct',
      body: sensitiveBody,
    });
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    removeTempDirectory(directory);
  }
});

test('开启监控后记录三类脱敏事件并保持关联 ID', () => {
  const directory = makeTempDirectory();
  try {
    const filePath = path.join(directory, 'monitor.jsonl');
    const monitor = createHistoryMonitor({
      env: { HISTORY_MONITOR: '1', HISTORY_MONITOR_FILE: filePath },
      logger: { warn() {} },
    });
    const requestId = monitor.startRequest({
      endpoint: '/v1/responses',
      model: sensitiveBody.model,
      route: { upstream_model: 'deepseek-v4-flash' },
      network: 'direct',
      body: sensitiveBody,
    });
    monitor.recordNormalized({
      requestId,
      endpoint: '/v1/responses',
      model: sensitiveBody.model,
      upstreamModel: 'deepseek-v4-flash',
      network: 'direct',
      attempt: 1,
      body: sensitiveBody,
      actions: {
        normalized_reasoning_indexes: [0],
        normalized_tool_output_indexes: [2],
        reasoning_changes: [{
          index: 0,
          fields: ['encrypted_content'],
          text: 'ACTION_REASONING_BODY_SHOULD_NOT_BE_LOGGED',
        }],
        tool_output_changes: [{
          index: 2,
          type: 'function_call_output',
          from: 'array',
          to: 'string',
          bytes: 123,
          output: 'ACTION_TOOL_OUTPUT_SHOULD_NOT_BE_LOGGED',
        }],
        unsafe_body: 'ACTION_BODY_SHOULD_NOT_BE_LOGGED',
      },
    });
    monitor.recordResult({
      requestId,
      endpoint: '/v1/responses',
      model: sensitiveBody.model,
      upstreamModel: 'deepseek-v4-flash',
      network: 'direct',
      attempt: 1,
      status: 503,
      upstreamHost: 'mock.test',
      error: new Error('HTTP 503 data:image/png;base64,SHORT_IMAGE_DATA'),
    });

    const events = readEvents(filePath);
    assert.deepEqual(events.map((event) => event.event), [
      'request_before',
      'request_after',
      'upstream_result',
    ]);
    assert.ok(events.every((event) => event.request_id === requestId));
    assert.equal(events[0].history.items[0].reasoning.content.present, true);
    assert.equal(events[0].history.items[0].reasoning.content.length, 1);
    assert.equal(events[0].history.items[0].reasoning.encrypted_content.present, true);
    assert.equal(events[0].history.items[0].reasoning.encrypted_content.bytes, Buffer.byteLength('ENCRYPTED_CONTENT_SHOULD_NOT_BE_LOGGED'));
    assert.equal(events[0].history.items[2].output.kind, 'array');
    assert.equal(events[0].history.items[2].output.bytes, Buffer.byteLength(JSON.stringify(sensitiveBody.input[2].output)));
    assert.deepEqual(events[1].actions.reasoning_changes, [
      { index: 0, fields: ['encrypted_content'] },
    ]);
    assert.deepEqual(events[1].actions.tool_output_changes, [
      { index: 2, type: 'function_call_output', from: 'array', to: 'string', bytes: 123 },
    ]);
    assert.equal(events[2].status, 503);
    assert.match(events[2].error.message, /^HTTP 503 /);

    const raw = fs.readFileSync(filePath, 'utf8');
    for (const secret of [
      'REASONING_BODY_SHOULD_NOT_BE_LOGGED',
      'ENCRYPTED_CONTENT_SHOULD_NOT_BE_LOGGED',
      'TOOL_PARAMETER_SHOULD_NOT_BE_LOGGED',
      'MESSAGE_BODY_SHOULD_NOT_BE_LOGGED',
      'IMAGE_BASE64_SHOULD_NOT_BE_LOGGED',
      'IMAGE_DATA_SHOULD_NOT_BE_LOGGED',
      'ACTION_REASONING_BODY_SHOULD_NOT_BE_LOGGED',
      'ACTION_TOOL_OUTPUT_SHOULD_NOT_BE_LOGGED',
      'ACTION_BODY_SHOULD_NOT_BE_LOGGED',
      'SHORT_IMAGE_DATA',
    ]) {
      assert.equal(raw.includes(secret), false, `监控日志不应包含 ${secret}`);
    }
  } finally {
    removeTempDirectory(directory);
  }
});

test('监控日志达到上限时轮换为一个 .1 备份', () => {
  const directory = makeTempDirectory();
  try {
    const filePath = path.join(directory, 'monitor.jsonl');
    const backupPath = `${filePath}.1`;
    fs.writeFileSync(filePath, 'OLD_LOG_CONTENT', 'utf8');
    const monitor = createHistoryMonitor({
      env: { HISTORY_MONITOR: '1', HISTORY_MONITOR_FILE: filePath },
      logger: { warn() {} },
      maxBytes: 32,
    });
    const requestId = monitor.startRequest({
      endpoint: '/v1/responses',
      model: 'deepseek-v4-flash',
      route: { upstream_model: 'deepseek-v4-flash' },
      network: 'direct',
      body: { input: [] },
    });
    assert.ok(requestId);
    assert.equal(fs.readFileSync(backupPath, 'utf8'), 'OLD_LOG_CONTENT');
    assert.equal(readEvents(filePath)[0].event, 'request_before');
  } finally {
    removeTempDirectory(directory);
  }
});

test('监控摘要只保留结构信息', () => {
  const summary = summarizeResponsesBody(sensitiveBody);
  assert.equal(summary.input_count, 4);
  assert.equal(summary.input_types.reasoning, 1);
  assert.equal(summary.input_types.function_call_output, 1);
  assert.equal(summary.pairing.function_calls, 1);
  assert.equal(summary.pairing.function_call_outputs, 1);
  assert.equal(JSON.stringify(summary).includes('MESSAGE_BODY_SHOULD_NOT_BE_LOGGED'), false);
  assert.equal(JSON.stringify(summary).includes('IMAGE_BASE64_SHOULD_NOT_BE_LOGGED'), false);
});
