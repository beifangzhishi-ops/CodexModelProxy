// Muse Spark GO Responses 工具协议桥接。
//
// 上游只接受普通 function 工具与去除了 search_content_types 的 web_search 工具，
// 而 Codex 会发送 namespace / custom / tool_search 等原生形态，且 function 名称不能超过
// 64 字符。本模块做请求级双向桥接：发送前展平成普通 function，返回 Codex 前恢复原生形态。
// 映射按请求独立，不使用跨请求全局状态。
//
// 设计参考（非逐行移植）：
// https://github.com/duolahypercho/codex-router/pull/482 (MIT License)
// 以及 https://github.com/lidge-jun/opencodex 的 Muse web_search 兼容处理。

import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';

const NAMESPACE_DELIMITER = '__';
const MAX_WIRE_NAME_LENGTH = 64;
const CUSTOM_INPUT_PROPERTY = 'input';
const TOOL_SEARCH_FUNCTION_NAME = 'tool_search';
const HASH_SUFFIX_LENGTH = 12;

function nativeKey(namespace, name) {
  return `${namespace ?? ''}\u0000${name}`;
}

function hashIdentity(identity, attempt) {
  return createHash('sha256')
    .update(`${identity}\u0000${attempt}`)
    .digest('hex')
    .slice(0, HASH_SUFFIX_LENGTH);
}

function createMuseContext() {
  return {
    namespaces: new Map(),
    nativeToWire: new Map(),
    wireToNative: new Map(),
    usedNames: new Set(),
    plainNativeNames: new Set(),
    toolSearch: null,
    changed: false,
  };
}

function assignWireName(ctx, identity, baseName, native) {
  const existing = ctx.nativeToWire.get(identity);
  if (existing) return existing;
  let wire = baseName || 'tool';
  if (wire.length > MAX_WIRE_NAME_LENGTH || ctx.usedNames.has(wire)) {
    const stem = wire.slice(0, MAX_WIRE_NAME_LENGTH - HASH_SUFFIX_LENGTH - 1);
    let attempt = 0;
    do {
      wire = `${stem}_${hashIdentity(identity, attempt)}`;
      attempt += 1;
    } while (ctx.usedNames.has(wire));
  }
  ctx.usedNames.add(wire);
  ctx.nativeToWire.set(identity, wire);
  ctx.wireToNative.set(wire, native);
  return wire;
}

// Meta 上游要求 parameters.required 覆盖 properties 中每个 key。
// 只追加缺失 key、保留原有顺序；无需修改时返回原引用。
function ensureRequired(parameters) {
  if (
    !parameters ||
    typeof parameters !== 'object' ||
    typeof parameters.properties !== 'object' ||
    parameters.properties === null
  ) {
    return parameters;
  }
  const propertyKeys = Object.keys(parameters.properties);
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((key) => typeof key === 'string')
    : [];
  const requiredSet = new Set(required);
  const missing = propertyKeys.filter((key) => !requiredSet.has(key));
  if (missing.length === 0) return parameters;
  return { ...parameters, required: [...required, ...missing] };
}

function functionNameOf(tool) {
  if (typeof tool?.name === 'string' && tool.name) return tool.name;
  if (tool?.function && typeof tool.function.name === 'string' && tool.function.name) {
    return tool.function.name;
  }
  return '';
}

function prepareToolDeclarations(tools, ctx) {
  if (!Array.isArray(tools)) return tools;
  let changed = false;
  const output = [];
  for (const tool of tools) {
    if (tool && typeof tool === 'object' && tool.type === 'namespace' && Array.isArray(tool.tools)) {
      output.push(...prepareNamespaceChildren(tool, ctx));
      changed = true;
      continue;
    }
    const next = prepareOneTool(tool, ctx);
    if (next !== tool) changed = true;
    if (next !== null) output.push(next);
  }
  return changed ? output : tools;
}

function prepareNamespaceChildren(tool, ctx) {
  const namespace = typeof tool.name === 'string' ? tool.name : '';
  const names = new Set();
  const children = [];
  for (const child of tool.tools) {
    if (!child || typeof child !== 'object' || typeof child.name !== 'string' || !child.name) {
      continue;
    }
    names.add(child.name);
    const wire = assignWireName(
      ctx,
      nativeKey(namespace, child.name),
      `${namespace}${NAMESPACE_DELIMITER}${child.name}`,
      { kind: 'namespace', namespace, name: child.name },
    );
    const parameters = child.parameters ?? child.inputSchema;
    children.push({
      ...child,
      name: wire,
      ...(parameters === undefined ? {} : { parameters: ensureRequired(parameters) }),
    });
  }
  if (names.size > 0) ctx.namespaces.set(namespace, names);
  ctx.changed = true;
  return children;
}

function prepareOneTool(tool, ctx) {
  if (!tool || typeof tool !== 'object') return tool;

  if (tool.type === 'custom') {
    const nativeName = typeof tool.name === 'string' ? tool.name : '';
    const base = nativeName || 'custom_tool';
    const wire = assignWireName(ctx, `custom:${nativeName}`, base, {
      kind: 'custom',
      name: nativeName,
    });
    const description =
      typeof tool.description === 'string' && tool.description.trim()
        ? tool.description.trim()
        : undefined;
    ctx.changed = true;
    return {
      type: 'function',
      name: wire,
      ...(description === undefined ? {} : { description }),
      parameters: {
        type: 'object',
        properties: {
          [CUSTOM_INPUT_PROPERTY]: {
            type: 'string',
            description: 'The complete raw freeform input for this tool, preserved verbatim.',
          },
        },
        required: [CUSTOM_INPUT_PROPERTY],
        additionalProperties: false,
      },
    };
  }

  if (tool.type === 'tool_search') {
    if (tool.execution !== 'client') return null;
    if (ctx.toolSearch) return null;
    const wire = assignWireName(ctx, 'tool-search', TOOL_SEARCH_FUNCTION_NAME, {
      kind: 'tool-search',
    });
    ctx.toolSearch = { providerName: wire };
    const description = typeof tool.description === 'string' ? tool.description : undefined;
    ctx.changed = true;
    return {
      type: 'function',
      name: wire,
      ...(description === undefined ? {} : { description }),
      ...(tool.parameters === undefined ? {} : { parameters: ensureRequired(tool.parameters) }),
    };
  }

  if (tool.type === 'web_search') {
    if ('search_content_types' in tool) {
      const { search_content_types: _unsupported, ...rest } = tool;
      ctx.changed = true;
      return rest;
    }
    return tool;
  }

  if (tool.type === 'function') {
    const name = functionNameOf(tool);
    if (!name) return tool;
    ctx.plainNativeNames.add(name);
    const identity = nativeKey(undefined, name);
    const wire = assignWireName(ctx, identity, name, { kind: 'plain', name });
    let next = tool;
    if (wire !== name) {
      next =
        tool.function && typeof tool.function.name === 'string'
          ? { ...tool, function: { ...tool.function, name: wire } }
          : { ...tool, name: wire };
    }
    if (tool.parameters !== undefined) {
      const repaired = ensureRequired(tool.parameters);
      if (repaired !== tool.parameters) next = { ...next, parameters: repaired };
    }
    if (next !== tool) ctx.changed = true;
    return next;
  }

  return tool;
}

function prepareInput(input, ctx) {
  if (!Array.isArray(input)) return input;
  let changed = false;
  const output = [];
  for (const item of input) {
    const next = prepareInputItem(item, ctx);
    if (next !== item) changed = true;
    output.push(next);
  }
  return changed ? output : input;
}

function prepareInputItem(item, ctx) {
  if (!item || typeof item !== 'object') return item;

  if (item.type === 'additional_tools') {
    const tools = prepareToolDeclarations(item.tools, ctx);
    return tools === item.tools ? item : { ...item, tools };
  }

  if (item.type === 'function_call') {
    return rewriteFunctionCallInput(item, ctx);
  }

  if (item.type === 'custom_tool_call') {
    const nativeName = typeof item.name === 'string' ? item.name : '';
    const wire = ensureCustomWire(ctx, nativeName);
    const { type: _type, name: _name, input, ...rest } = item;
    ctx.changed = true;
    return {
      ...rest,
      type: 'function_call',
      name: wire,
      arguments: JSON.stringify({
        [CUSTOM_INPUT_PROPERTY]: typeof input === 'string' ? input : '',
      }),
    };
  }

  if (item.type === 'custom_tool_call_output') {
    const { type: _type, ...rest } = item;
    ctx.changed = true;
    return { ...rest, type: 'function_call_output' };
  }

  if (item.type === 'tool_search_call') {
    const relay = ensureToolSearchRelay(ctx);
    const { type: _type, name: _name, namespace: _namespace, arguments: args, ...rest } = item;
    const value = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    ctx.changed = true;
    return {
      ...rest,
      type: 'function_call',
      name: relay.providerName,
      arguments: JSON.stringify(value),
    };
  }

  if (item.type === 'tool_search_output') {
    const { type: _type, ...rest } = item;
    ctx.changed = true;
    return { ...rest, type: 'function_call_output' };
  }

  return item;
}

function rewriteFunctionCallInput(item, ctx) {
  const name = typeof item.name === 'string' ? item.name : '';
  if (!name) return item;
  if (typeof item.namespace === 'string' && item.namespace) {
    const wire = ctx.nativeToWire.get(nativeKey(item.namespace, name));
    if (wire && wire !== name) {
      const { namespace: _namespace, ...rest } = item;
      ctx.changed = true;
      return { ...rest, name: wire };
    }
    return item;
  }
  const wire = ctx.nativeToWire.get(nativeKey(undefined, name));
  if (wire && wire !== name) {
    ctx.changed = true;
    return { ...item, name: wire };
  }
  return item;
}

function ensureCustomWire(ctx, nativeName) {
  const identity = `custom:${nativeName}`;
  const existing = ctx.nativeToWire.get(identity);
  if (existing) return existing;
  const base = nativeName || 'custom_tool';
  const wire = assignWireName(ctx, identity, base, { kind: 'custom', name: nativeName });
  ctx.changed = true;
  return wire;
}

function ensureToolSearchRelay(ctx) {
  if (ctx.toolSearch) return ctx.toolSearch;
  const wire = assignWireName(ctx, 'tool-search', TOOL_SEARCH_FUNCTION_NAME, {
    kind: 'tool-search',
  });
  ctx.toolSearch = { providerName: wire };
  ctx.changed = true;
  return ctx.toolSearch;
}

function prepareToolChoice(choice, ctx) {
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return choice;
  if (choice.type === 'allowed_tools' && Array.isArray(choice.tools)) {
    let changed = false;
    const tools = choice.tools.map((reference) => {
      const next = prepareToolChoiceReference(reference, ctx);
      if (next !== reference) changed = true;
      return next;
    });
    return changed ? { ...choice, tools } : choice;
  }
  return prepareToolChoiceReference(choice, ctx);
}

function prepareToolChoiceReference(reference, ctx) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return reference;

  if (reference.type === 'tool_search') {
    const relay = ensureToolSearchRelay(ctx);
    const { type: _type, execution: _execution, ...rest } = reference;
    ctx.changed = true;
    return { ...rest, type: 'function', name: relay.providerName };
  }

  if (reference.type === 'custom') {
    const nativeName = typeof reference.name === 'string' ? reference.name : '';
    const wire = ensureCustomWire(ctx, nativeName);
    ctx.changed = true;
    return { type: 'function', name: wire };
  }

  if (reference.type === 'function') {
    const name = functionNameOf(reference);
    if (!name) return reference;
    if (typeof reference.namespace === 'string' && reference.namespace) {
      const wire = ctx.nativeToWire.get(nativeKey(reference.namespace, name));
      if (wire) {
        const { namespace: _namespace, ...rest } = reference;
        ctx.changed = true;
        return { ...rest, name: wire };
      }
      return reference;
    }
    const wire = ctx.nativeToWire.get(nativeKey(undefined, name));
    if (wire && wire !== name) {
      ctx.changed = true;
      return reference.function && typeof reference.function.name === 'string'
        ? { ...reference, function: { ...reference.function, name: wire } }
        : { ...reference, name: wire };
    }
  }

  return reference;
}

// 发送前入口：返回 { body, ctx }。body 与原对象分离，原请求不被修改。
export function prepareMuseRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { body, ctx: null };
  }
  const ctx = createMuseContext();
  const tools = prepareToolDeclarations(body.tools, ctx);
  const input = prepareInput(body.input, ctx);
  const toolChoice = prepareToolChoice(body.tool_choice, ctx);
  const next = { ...body };
  if (tools !== body.tools) next.tools = tools;
  if (input !== body.input) next.input = input;
  if (toolChoice !== body.tool_choice) next.tool_choice = toolChoice;
  return { body: next, ctx };
}

function coerceArguments(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function customInputFromArguments(value) {
  const text = coerceArguments(value);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.[CUSTOM_INPUT_PROPERTY] === 'string'
      ? parsed[CUSTOM_INPUT_PROPERTY]
      : undefined;
  } catch {
    return undefined;
  }
}

function toolSearchArgumentsFrom(value, allowPlaceholder) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return undefined;
  if (allowPlaceholder && value.trim() === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function restoreFunctionCallItem(item, ctx, { allowIncomplete = false } = {}) {
  if (!item || item.type !== 'function_call') return item;
  const name = typeof item.name === 'string' ? item.name : '';
  if (!name) return item;
  const native = ctx.wireToNative.get(name);
  if (!native) return item;

  if (native.kind === 'custom') {
    const input = customInputFromArguments(item.arguments);
    if (input === undefined && !allowIncomplete) return item;
    const {
      type: _type,
      name: _name,
      arguments: _arguments,
      encrypted_function_args: _encrypted,
      ...rest
    } = item;
    return {
      ...rest,
      type: 'custom_tool_call',
      name: native.name,
      ...(input === undefined ? {} : { input }),
    };
  }

  if (native.kind === 'tool-search') {
    const args = toolSearchArgumentsFrom(item.arguments, allowIncomplete);
    if (args === undefined) return item;
    const {
      type: _type,
      name: _name,
      namespace: _namespace,
      arguments: _arguments,
      encrypted_function_args: _encrypted,
      ...rest
    } = item;
    return { ...rest, type: 'tool_search_call', execution: 'client', arguments: args };
  }

  if (native.kind === 'namespace') {
    const { name: _name, namespace: _namespace, ...rest } = item;
    return {
      ...rest,
      type: 'function_call',
      name: native.name,
      namespace: native.namespace,
    };
  }

  if (native.kind === 'plain' && native.name !== name) {
    const { name: _name, ...rest } = item;
    return { ...rest, name: native.name };
  }

  return item;
}

function restoreOutputArray(output, ctx, allowIncomplete = false) {
  if (!Array.isArray(output)) return undefined;
  let changed = false;
  const restored = output.map((item) => {
    const next = restoreFunctionCallItem(item, ctx, { allowIncomplete });
    if (next !== item) changed = true;
    return next;
  });
  return changed ? restored : undefined;
}

const CUSTOM_TOOL_OPENING_LIMIT = 1024;
const JSON_ESCAPES = Object.freeze({
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
});

// 解码 function_call_arguments.delta 中的 JSON 包装内容，输出原生 custom input 片段。
// 前缀有界、每个字符只访问一次；未闭合的转义最多保留 6 个字符。
function decodeCustomDelta(state, fragment) {
  if (typeof fragment !== 'string' || state.invalid || state.closed) return undefined;
  let encoded = fragment;
  if (!state.opened) {
    state.opening += encoded;
    const opening = state.opening.match(/^\s*\{\s*"input"\s*:\s*"/);
    if (!opening) {
      if (state.opening.length > CUSTOM_TOOL_OPENING_LIMIT) {
        state.opening = '';
        state.invalid = true;
      }
      return undefined;
    }
    state.opened = true;
    encoded = state.opening.slice(opening[0].length);
    state.opening = '';
  }
  if (state.escape) {
    encoded = state.escape + encoded;
    state.escape = '';
  }
  const decoded = [];
  for (let index = 0; index < encoded.length; index += 1) {
    const character = encoded[index];
    if (character === '"') {
      state.closed = true;
      break;
    }
    if (character !== '\\') {
      if (character.charCodeAt(0) < 0x20) {
        state.invalid = true;
        break;
      }
      decoded.push(character);
      continue;
    }
    const escape = encoded[index + 1];
    if (escape === undefined) {
      state.escape = '\\';
      break;
    }
    if (escape === 'u') {
      const digits = encoded.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]*$/.test(digits)) {
        state.invalid = true;
        break;
      }
      if (digits.length < 4) {
        state.escape = encoded.slice(index);
        break;
      }
      decoded.push(String.fromCharCode(Number.parseInt(digits, 16)));
      index += 5;
      continue;
    }
    if (!(escape in JSON_ESCAPES)) {
      state.invalid = true;
      break;
    }
    decoded.push(JSON_ESCAPES[escape]);
    index += 1;
  }
  return decoded.length ? decoded.join('') : undefined;
}

// JSON 响应恢复：恢复 output 与 response.output 中的调用。无变化时返回原引用。
export function restoreMuseJsonPayload(payload, ctx) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  let next = payload;
  const output = restoreOutputArray(next.output, ctx);
  if (output) next = { ...next, output };
  const responseOutput = restoreOutputArray(next.response?.output, ctx);
  if (responseOutput) next = { ...next, response: { ...next.response, output: responseOutput } };
  return next;
}

// SSE 恢复：跨 chunk 解析完整事件块，恢复调用并重写事件类型行。
export class MuseSseRestoreTransform extends Transform {
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.buffer = '';
    this.customItemIds = new Set();
    this.customDeltaStates = new Map();
  }

  _transform(chunk, _encoding, callback) {
    this.buffer += chunk.toString('utf8');
    this.#emitCompleteEvents();
    callback();
  }

  _flush(callback) {
    if (this.buffer) {
      for (const piece of this.#rewriteBlock(this.buffer)) {
        this.push(piece.endsWith('\n\n') ? piece : `${piece}\n\n`);
      }
      this.buffer = '';
    }
    callback();
  }

  #emitCompleteEvents() {
    const blocks = this.buffer.split(/\r?\n\r?\n/);
    this.buffer = blocks.pop() || '';
    for (const block of blocks) {
      for (const piece of this.#rewriteBlock(block)) {
        this.push(piece.endsWith('\n\n') ? piece : `${piece}\n\n`);
      }
    }
  }

  #rewriteBlock(block) {
    const lines = block.split(/\r?\n/);
    const dataIndex = lines.findIndex((line) => line.startsWith('data:'));
    if (dataIndex === -1) return [block];
    const dataText = lines[dataIndex].slice(5).trimStart();
    if (!dataText || dataText === '[DONE]') return [block];
    let event;
    try {
      event = JSON.parse(dataText);
    } catch {
      return [block];
    }
    const originalType = typeof event?.type === 'string' ? event.type : '';
    let next = event;

    if (next?.type === 'response.output_item.added') {
      if (next.item?.type === 'function_call') {
        const restored = restoreFunctionCallItem(next.item, this.ctx, { allowIncomplete: true });
        if (restored?.type === 'custom_tool_call' && typeof restored.id === 'string') {
          this.customItemIds.add(restored.id);
          this.customDeltaStates.set(restored.id, {
            opening: '',
            opened: false,
            escape: '',
            closed: false,
            invalid: false,
          });
        }
        if (restored !== next.item) next = { ...next, item: restored };
      }
    } else if (next?.type === 'response.output_item.done') {
      if (next.item?.type === 'function_call') {
        const restored = restoreFunctionCallItem(next.item, this.ctx);
        if (typeof next.item.id === 'string') {
          this.customItemIds.delete(next.item.id);
          this.customDeltaStates.delete(next.item.id);
        }
        if (restored !== next.item) next = { ...next, item: restored };
      }
    } else if (
      next?.type === 'response.function_call_arguments.delta' &&
      typeof next.item_id === 'string' &&
      this.customItemIds.has(next.item_id)
    ) {
      let state = this.customDeltaStates.get(next.item_id);
      if (!state) {
        state = { opening: '', opened: false, escape: '', closed: false, invalid: false };
        this.customDeltaStates.set(next.item_id, state);
      }
      const delta = decodeCustomDelta(state, next.delta);
      if (delta === undefined) return [];
      next = {
        type: 'response.custom_tool_call_input.delta',
        item_id: next.item_id,
        output_index: next.output_index,
        delta,
      };
    } else if (
      next?.type === 'response.function_call_arguments.done' &&
      typeof next.item_id === 'string' &&
      this.customItemIds.has(next.item_id)
    ) {
      const input = customInputFromArguments(next.arguments);
      if (input === undefined) return [block];
      next = {
        type: 'response.custom_tool_call_input.done',
        item_id: next.item_id,
        output_index: next.output_index,
        input,
      };
    } else if (next?.type === 'response.completed') {
      const output = restoreOutputArray(next.response?.output, this.ctx);
      if (output) next = { ...next, response: { ...next.response, output } };
    }

    if (next === event) return [block];
    const rebuilt = [...lines];
    const eventLineIndex = rebuilt.findIndex((line) => line.startsWith('event:'));
    if (eventLineIndex !== -1 && typeof next?.type === 'string' && next.type !== originalType) {
      rebuilt[eventLineIndex] = `event: ${next.type}`;
    }
    rebuilt[dataIndex] = `data: ${JSON.stringify(next)}`;
    return [rebuilt.join('\n')];
  }
}
