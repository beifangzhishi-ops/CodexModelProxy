# CodexModelProxy 多 Provider Responses 中转（Windows）

CodexModelProxy（CMP）是一个零第三方依赖的 Node.js 本地中转服务，让 Codex App Server 通过一个 OpenAI-compatible Responses 地址使用 ChatGPT、OpenCode、DeepSeek、Z.AI，以及可选的 CLIProxyAPI（CPA）等 Provider。

CMP 只负责本机路由、认证隔离、网络策略、模型目录和必要的协议兼容。提示词、响应正文与 API key 不写入普通日志。项目默认仅监听 `127.0.0.1`，面向 Windows 桌面端使用。

## 当前架构

CMP 已从早期“静态模型表 + `models_unified.json`”迁移为 Provider-native 架构：

```text
Provider Registry
  ├─ base_url / auth / network
  ├─ static models（可选）
  └─ discover_models → Provider /models
              ↓
Model Catalog
  ├─ friendly aliases
  ├─ canonical provider/model
  └─ dynamic provider/model
              ↓
Metadata Resolver
  ├─ 上游原生 Codex metadata
  ├─ Provider metadata_profile
  ├─ model_overrides / explicit metadata
  └─ generic fallback
              ↓
Codex /v1/models
```

模型“是否存在”由 Provider Registry 与动态 `/models` 决定；模型“如何描述给 Codex”由独立 metadata 层决定。`models_unified.json` 已退出运行时并删除，不再作为模型目录或 metadata 真相源。

目录 metadata 的优先级是：

1. 通用安全默认值；
2. Provider 的 `metadata_profile`；
3. 动态 `/models` 返回的原生 metadata；
4. `model_overrides` / 静态模型显式 `metadata`。

Codex 0.153.1+ 要求每个模型至少带 `base_instructions` 或 `model_messages.instructions_template`。CMP 会保留上游原生指令；只有两者都缺失时才补通用 `base_instructions`，因此一个未知动态模型不会再导致整份模型目录解析失败。

当前 metadata profile：`generic`、`openai`、`deepseek`、`muse`、`zai`。`openai-auto` 是路由兼容策略，不等价于 OpenAI 模型能力；CPA 等混合模型 Provider 默认应使用保守 metadata，除非上游或模型 override 明确提供能力。

## Provider 配置

可提交的 Provider 默认值放在 `proxy-config.json`；本机 URL、key、是否启用动态发现等差异放在被 Git 忽略的 `providers.local.json`。

典型 Provider：

```json
{
  "providers": {
    "example": {
      "enabled": true,
      "base_url": "https://api.example.com/v1",
      "api_key_env": "EXAMPLE_API_KEY",
      "auth_mode": "api_key",
      "protocol": "responses",
      "discover_models": true,
      "model_prefix": "ex/",
      "compat_profile": "passthrough",
      "metadata_profile": "generic",
      "network": "default",
      "display_name": "EX"
    }
  }
}
```

主要字段：

- `base_url`：OpenAI-compatible API 根地址。
- `auth_mode`：`api_key`、`openai_passthrough` 或 `none`。
- `discover_models`：为 `true` 时从 `<base_url>/models` 动态发现模型。
- `model_prefix`：动态/canonical 模型命名空间，例如 `oc/`、`ds/`、`cpa/`。
- `compat_profile`：请求转发兼容策略，例如 `openai`、`deepseek`、`muse`、`passthrough`、`openai-auto`。
- `metadata_profile`：Codex 模型目录 metadata 策略，与 `compat_profile` 分离。
- `network`：`default`、`direct` 或 `system`。
- `models`：可选静态模型；主要用于稳定 friendly alias、特殊路由或模型级 metadata。
- `model_overrides`：按模型名/通配符覆盖路由或 metadata；不用于动态模型启停。

静态模型可以直接带 metadata：

```json
{
  "models": {
    "my-model": {
      "display_name": "My Model",
      "metadata_profile": "generic",
      "metadata": {
        "context_window": 200000,
        "input_modalities": ["text"]
      }
    }
  }
}
```

动态模型如果上游 `/models` 已返回 `context_window`、`input_modalities`、`model_messages`、`base_instructions` 等 Codex 字段，CMP 会优先保留这些值；没有的字段才由 profile/default 补齐。

## 当前静态 friendly 模型

`proxy-config.json` 当前保留以下 friendly alias；它们只用于稳定名称和少量显式能力，不再依赖另一份静态 catalog：

| slug | Provider | 实际模型 |
|---|---|---|
| `gpt-5.6-sol` | ChatGPT | `gpt-5.6-sol` |
| `gpt-5.6-terra` | ChatGPT | `gpt-5.6-terra` |
| `gpt-5.6-luna` | ChatGPT | `gpt-5.6-luna` |
| `deepseek-v4-flash` | OpenCode | `deepseek-v4-flash` |
| `deepseek-v4-pro` | OpenCode | `deepseek-v4-pro` |
| `deepseek-v4-flash-direct` | DeepSeek | `deepseek-v4-flash` |
| `deepseek-v4-pro-direct` | DeepSeek | `deepseek-v4-pro` |
| `muse-spark-1.2-contributor` | OpenCode | `muse-spark-1.2-contributor` |
| `glm-5.3` | Z.AI | `glm-5.3` |
| `glm-5.3-flash` | Z.AI | `glm-5.3-flash` |

`expose_canonical_models=false` 时，上述 friendly alias 与动态模型出现在模型选择器；静态 canonical 名称如 `chatgpt/...`、`oc/...`、`ds/...`、`zai/...` 仍可解析，但不会额外展示。动态发现的模型天然使用 Provider 前缀，例如 `cpa/gpt-5.6-sol`。

## 模型动态发现与缓存

启用 `discover_models=true` 后：

1. CMP 请求 Provider 的 `GET <base_url>/models`；
2. `model-discovery.mjs` 规范化模型 ID，并加 Provider 命名空间；
3. `model-catalog.mjs` 汇总 friendly/static/dynamic 模型；
4. `model-metadata.mjs` 为每个条目生成 Codex 可接受的 metadata；
5. `GET http://127.0.0.1:8787/v1/models` 同时返回 OpenAI-compatible `data` 和 Codex 使用的完整 `models`。

Provider discovery 默认成功缓存 60 秒、失败冷却 30 秒；刷新失败时保留最近一次成功结果。Codex App Server 自己还会在 `%USERPROFILE%\.codex\models_cache.json` 缓存远端目录。

Codex 配置不要设置 `model_catalog_json`，否则会使用权威静态目录并停止从 CMP 的 `/models` 动态刷新。

## Responses 转发

CMP 处理：

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/responses/compact`
- `GET /healthz`

普通 Responses 请求按最终 model resolver 结果选择 Provider 与上游模型。CMP 会：

- 替换请求中的 `model` 为实际上游模型；
- 按 `compat_profile` 整理已知不兼容的 reasoning、网页搜索历史和工具输出；
- `openai_passthrough` 原样使用调用方 OpenAI/ChatGPT 登录认证；
- `api_key` Provider 丢弃调用方 ChatGPT 凭据并注入自己的 key；
- 保持 JSON/SSE 上游状态与正文，除明确的兼容桥接外不重写响应内容。

Muse 仍使用请求级双向工具桥接；DeepSeek 系 profile 仍处理明文 reasoning 与 JSON 工具输出；Z.AI 默认 passthrough。`/responses/compact` 只访问当前解析出的 Provider/model，不做跨模型兜底。

## CLIProxyAPI（CPA）

CPA 是独立服务，CMP 不负责启动、停止、账号池或升级。推荐在 `providers.local.json` 配置：

```json
{
  "providers": {
    "cpa": {
      "enabled": true,
      "base_url": "https://your-cpa.example/v1",
      "api_key": "你的_CPA_服务端密钥",
      "auth_mode": "api_key",
      "protocol": "responses",
      "discover_models": true,
      "model_prefix": "cpa/",
      "compat_profile": "openai-auto",
      "metadata_profile": "generic",
      "network": "default",
      "display_name": "CPA"
    }
  }
}
```

CPA `/models` 返回什么，CMP 就以 `cpa/<模型>` 动态暴露什么。上游若同时提供 Codex metadata，会直接参与目录生成；只有缺失时才走 generic fallback。

旧 `CPA_BASE_URL`、`CPA_API_KEY` 等环境变量仍作为迁移兼容层，但新配置以 Provider 对象为主。

## Windows 上游网络

默认不设置 `PROXY_URL` 时，CMP 动态读取当前登录用户的 Windows 手动系统代理，并做短缓存。Provider `network=direct` 或 `DIRECT_MODELS` 中的模型绕过代理。

`proxy-local.env` 示例：

```text
HOST=127.0.0.1
PORT=8787
DIRECT_MODELS=deepseek-v4-flash-direct,deepseek-v4-pro-direct
```

代理选择优先级：

1. 模型在 `DIRECT_MODELS`：直连；
2. Provider/model `network=direct`：直连；
3. 显式 `PROXY_URL`：使用固定代理，空值表示强制直连；
4. `proxy-config.json` 中固定 `proxy`；
5. 否则使用当前用户 Windows 手动系统代理。

PAC/WPAD 与 WinHTTP 自动代理不是当前默认路径。

## 快速开始

1. 安装 Node.js。
2. 克隆仓库。
3. 复制 `proxy-secrets.env.example` 为 `proxy-secrets.env`，填写需要的 key。
4. 复制 `providers.local.json.example` 为 `providers.local.json`，填写本机 Provider URL/key/动态发现设置。
5. 复制 `proxy-local.env.example` 为 `proxy-local.env`，配置本机端口、直连模型和可选访问令牌。
6. 运行 `start-proxy.cmd`。
7. 打开 `http://127.0.0.1:8787/healthz`，应得到 `{"status":"ok"}`。
8. 切换 Codex 到 unified 配置，并完全退出后重新启动 Codex App Server。

CMP 更新后由用户决定何时重启。仓库规则禁止 agent 自行重启 CMP。

## Codex unified 配置

推荐：

```toml
model_provider = "OpenAI"
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
forced_login_method = "chatgpt"

[model_providers.OpenAI]
name = "unified"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = true
http_headers = { "X-Proxy-Access-Token" = "你的访问令牌" }
```

`name = "unified"` 可避免 Codex 把 CMP 当成真正的一方 OpenAI Provider 而启用一方专用 transport 行为。`model_provider` 仍可使用配置表 ID `OpenAI`。未启用本地访问令牌时删除 `http_headers` 行。

仓库 `config-templates/` 提供统一配置和切换脚本示例。切换脚本只应修改受管理的模型/Provider 配置，保留桌面端、插件、MCP、项目权限等其他 Codex 设置。

## Windows 计划任务

CMP 可在当前用户登录后自动启动。推荐以当前交互用户运行，而不是 `SYSTEM`，因为默认网络策略依赖当前用户的 WinINet 手动代理。

`start-proxy.cmd` 会先检查本地 `/healthz`；已有 CMP 正常运行时直接退出，不再启动第二实例。计划任务只负责启动 CMP，不负责启动/停止 Codex。

## 兼容层

新 tracked 配置以 `providers` + `aliases` 为运行时真相源。为避免旧测试/调用方立即断裂，`loadConfig()` 在必要时会从 Provider Registry 派生只读的 `config.models` / `config.catalog` 兼容视图；该视图不参与新运行时 Registry 构建。

旧调用方传入 `catalog` / `metadata_model_map` 时，`model-catalog.mjs` 仍可在迁移期把它们当作 metadata 来源。仓库自己的 `proxy-config.json` 已不再依赖这些字段。

## 文件说明

| 文件 | 作用 |
|---|---|
| `server.mjs` | HTTP 服务、Responses 转发与进程入口 |
| `provider-registry.mjs` | Provider 配置合并、认证、命名空间、静态模型与 discovery 注册 |
| `model-discovery.mjs` | Provider `/models` 同步、缓存、失败冷却、超时和大小限制 |
| `model-resolver.mjs` | alias、canonical、旧 slug 与最终 route 解析 |
| `model-catalog.mjs` | `/v1/models` 汇总、friendly/canonical/dynamic 目录编排及旧 catalog 迁移兼容 |
| `model-metadata.mjs` | Codex metadata profile、上游 metadata 合并、模型 override、instruction fallback |
| `compatibility-profiles.mjs` | Responses 转发兼容 profile |
| `compact-forward.mjs` | `/responses/compact` 当前模型转发 |
| `muse-tool-compat.mjs` | Muse namespace/custom/tool_search 双向桥接 |
| `history-normalize.mjs` | reasoning/web_search/tool output 历史整理 |
| `history-monitor.mjs` | 可选脱敏结构诊断 |
| `system-proxy.mjs` | Windows 当前用户手动代理读取 |
| `proxy-agent.mjs` | HTTPS CONNECT 代理隧道 |
| `proxy-config.json` | 可提交的 Provider 默认配置、friendly aliases 与兼容规则 |
| `providers.local.json.example` | 本机 Provider 配置模板 |
| `proxy-secrets.env.example` | 密钥模板 |
| `proxy-local.env.example` | 本机网络/端口模板 |
| `config-templates/` | Codex 配置切换模板 |
| `test/` | 零额度本地自动测试 |

## 测试

所有测试只使用内存 mock/临时目录，不应调用真实模型额度：

```text
node --test --test-isolation=none test\*.test.mjs
```

重点覆盖 Provider Registry、模型发现、alias/canonical 路由、动态 metadata、Codex 0.153.1 instruction schema、请求认证隔离、历史兼容、Muse 工具桥接、Windows 系统代理与 compact。

## 已知限制

- CMP 只实现 Responses 路径，不把上游自动降级为 Chat Completions。
- 动态模型只有上游明确返回能力或本地 profile/override 声明时，CMP 才应宣称高级能力；generic profile 是保守 fallback。
- ChatGPT/OpenAI 的完整一方 Codex backend 行为不等同于 OpenAI-compatible `/responses`；CMP unified Provider 不应仅靠 `name = "OpenAI"` 冒充一方后端。
- App Server 在 Provider/config 发生切换后，最稳妥的方式仍是完全退出并重新启动，以重建模型管理器。
- 请求体 `Content-Encoding` 压缩兼容与 `codex-auto-review` 裸模型路由属于独立问题，不由本次 metadata 架构迁移自动解决。

## 故障排查

模型选择器只剩内置 GPT 时，先检查：

1. `GET http://127.0.0.1:8787/v1/models` 是否返回完整 `models`；
2. 每个模型是否至少有 `base_instructions` 或 `model_messages.instructions_template`；
3. Codex `config.toml` 是否未设置 `model_catalog_json`；
4. 是否完全重启 App Server；
5. `%USERPROFILE%\.codex\models_cache.json` 是否成功生成/更新。

Codex 0.153.1 若遇到任意非法模型目录项，会拒绝整份目录并回退到内置模型，因此应优先检查 App Server 日志中的第一个 schema 错误，而不是只删除缓存。

## 安全与更新

- 真实 API key 只放在被 Git 忽略的 `providers.local.json`、`proxy-secrets.env` 或环境变量中。
- 服务默认监听 `127.0.0.1`；除非明确需要，不要暴露到 `0.0.0.0`。
- 可选本地令牌使用 `X-Proxy-Access-Token`，避免与 ChatGPT `Authorization` 冲突。
- 代码与文档更新统一提交并推送 `origin/master`。
- 更新 CMP 前如果 Codex 正通过 CMP 通信，先切回直连配置；代码更新完成后由用户手动选择重启时机。
