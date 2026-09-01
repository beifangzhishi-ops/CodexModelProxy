# CodexModelProxy 多模型纯 Responses 中转（Windows）

本目录是一个零依赖的 Node.js 本地中转服务，让 Codex 通过一个本地地址使用 ChatGPT、OpenCode、DeepSeek、Z.AI 及可选 CPA Provider。Provider Registry 统一管理上游 URL、认证、网络策略、静态模型和动态模型发现；代理替换模型名、处理鉴权，并在发送前按目标模型整理 reasoning、网页搜索历史和指定的工具输出格式，其余请求与响应原样转发。

项目只面向 Windows 本机使用，通过 Git 仓库在多个机器间同步更新：通用配置提交到仓库，密钥与本机差异（监听端口、访问令牌等）放在各自机器上、不提交。上游默认动态使用当前用户的 Windows 手动系统代理，无需在项目中重复填写 FlClash 端口。

## 模型映射

Codex App Server 从当前 Provider 的 `/models` 动态读取完整模型目录，下拉列表按 `display_name` 展示，因此第三方模型不需要伪装成 `gpt-5.x` 别名。OpenCode 与直连 DeepSeek 的上游模型名相同，用 `-direct` 后缀区分直连通道。

| slug（请求与配置用） | 显示名（下拉列表可见） | 认证 | 实际上游 |
|---|---|---|---|
| `gpt-5.6-sol` | GPT-5.6 Sol · ChatGPT | ChatGPT 登录透传 | ChatGPT `gpt-5.6-sol` |
| `gpt-5.6-terra` | GPT-5.6 Terra · ChatGPT | ChatGPT 登录透传 | ChatGPT `gpt-5.6-terra` |
| `gpt-5.6-luna` | GPT-5.6 Luna · ChatGPT | ChatGPT 登录透传 | ChatGPT `gpt-5.6-luna` |
| `deepseek-v4-flash` | OC · DSV4 Flash | `OPENCODE_API_KEY` | OpenCode GO `deepseek-v4-flash` |
| `deepseek-v4-pro` | OC · DSV4 Pro | `OPENCODE_API_KEY` | OpenCode GO `deepseek-v4-pro` |
| `deepseek-v4-flash-direct` | DS · V4 Flash · 直连 | `DEEPSEEK_API_KEY` | DeepSeek `deepseek-v4-flash` |
| `deepseek-v4-pro-direct` | DS · V4 Pro · 直连 | `DEEPSEEK_API_KEY` | DeepSeek `deepseek-v4-pro` |
| `muse-spark-1.2-contributor` | OC · Muse Spark 1.2 Contributor | `OPENCODE_API_KEY` | OpenCode GO `muse-spark-1.2-contributor` |
| `glm-5.3` | ZAI · GLM-5.3 | `ZAI_API_KEY` | Z.AI `glm-5.3` |
| `glm-5.3-flash` | ZAI · GLM-5.3-Flash | `ZAI_API_KEY` | Z.AI `glm-5.3-flash` |

默认模型为 `deepseek-v4-flash`（OC · DSV4 Flash）。CMP 从启用 `discover_models` 的 Provider `/models` 动态同步模型，在自己的 `/v1/models` 中补成完整 Codex 模型元数据并加上 Provider 命名空间；旧模型 slug 仍通过 aliases 兼容。DeepSeek 的两条直连通道使用 `-direct` 后缀，旧的 `direct/` 请求前缀仍可用但不会出现在目录中。

Muse Spark 1.2 Contributor 仅作可选模型：需要 GO workspace 开启数据训练授权，且本机代理出口在美国；思考档位支持 `minimal/low/medium/high/xhigh`，默认 `high`；支持图片输入。

GLM-5.3 / GLM-5.3-Flash 使用 Z.AI 的 GLM Coding Plan 专用 Responses 端点，走完整直通：reasoning、网页搜索历史、工具输出与工具定义均不改写。GLM-5.3 按官方能力仅声明文本输入，GLM-5.3-Flash 为原生多模态（文本/图片）且在 Coding Plan 中点数消耗为 GLM-5.3 的约 1/3。

## 转发行为

- 只处理 `POST /v1/responses`、`POST /v1/responses/compact` 与 `GET /v1/models`；普通请求追加 `/responses`，压缩请求追加 `/responses/compact`。
- 请求体除 `model` 替换为实际上游模型名外，还会按目标模型的 reasoning 格式整理推理历史；JSON 与 SSE 响应状态、响应头和正文原样返回。
- 跨 GPT/DeepSeek 切换时保留所有项目及顺序，只整理冲突字段：GPT 路由把输入项 `id` 中连续非法字符替换为 `_`，并按项目类型补齐所需前缀（message `msg_`、reasoning `rs_`、function call `fc_`、custom tool call `ctc_` 及其输出前缀）；错误前缀前会添加正确前缀并保留完整原 ID，避免来源不同的项目发生碰撞。GPT 路由还会把 reasoning 的非空或格式不兼容 `content` 改为 `[]`；若发现 OC/DS 使用的“UUID + 分段号”外部引用误放在 `encrypted_content`，仅将该字段改为 `null`，正常 GPT 密文继续保留。OpenCode 与直连 DeepSeek 路由把已有的 `encrypted_content` 改为 `null`，保留明文 `content`。整理只影响本次上游请求，不修改 Codex 原会话，也不修改工具配对使用的 `call_id`。
- 跨模型切换时同步整理网页搜索记录：GPT 路由只保留 `id` 以 `ws` 开头的 `web_search_call`，DS/Codex 风格的 `call_...` 搜索调用项从本次上游请求移除；助手消息中的搜索结论与引用不受影响。
- Z.AI 的 `glm-5.3` / `glm-5.3-flash` 路由使用 `reasoning_format: passthrough` 与 `tool_output_format: passthrough`：reasoning、`web_search_call`、工具输出、工具定义和请求正文完全原样转发，不做任何改写；若上游出现历史格式兼容错误，再按实际错误增加适配。
- 每条 Provider 模型可设置 `tool_output_format`：默认 `passthrough`；OC/直连 DeepSeek 模型使用 `json_string`，将 `function_call_output` 与 `custom_tool_call_output` 中的非字符串 `output` 完整 `JSON.stringify` 为文本，字符串保持不变。GPT 与 GLM 使用 `passthrough`，数组中的图片、`call_id`、项目顺序均保留；CPA 动态模型按 `openai-auto` 和模型覆盖规则选择兼容 profile。
- Muse 路由启用 `tool_schema_compat: muse` 做完整双向工具桥接：发送前把 `namespace` 子工具展平为 `<namespace>__<name>` 普通函数、把 `custom` 桥接为带必填 `input` 字符串参数的函数、把客户端执行的 `tool_search` 桥接为普通函数，普通 `web_search` 删除上游不接受的 `search_content_types`，并补齐所有函数 schema 的 `required`；工具名超过 64 字符或冲突时用截断前缀加短摘要的别名。返回 Codex 前按同一请求级映射把 JSON/SSE 中的函数调用恢复为 namespace/custom/tool_search 原生形态。映射按请求独立，只影响本次请求，不影响其他路由。
- 除 Muse 路由的调用恢复外，不解析或转换 SSE 事件；工具输出只按上述路由规则处理，不尝试恢复跨供应商私有状态。
- 三个 GPT 路由把 Codex 的 ChatGPT 登录认证（`Authorization`）原样转发至 Backend API。
- OC 与直连 DeepSeek 路由丢弃传入的 ChatGPT `Authorization`，分别注入 `OPENCODE_API_KEY` 与 `DEEPSEEK_API_KEY`；ZAI 路由同样丢弃传入认证并注入 `ZAI_API_KEY`。
- `api_key` Provider 丢弃调用方的 `Authorization`、ChatGPT 账号头、Cookie 与 API Key 头，只注入该 Provider 自己的 key；`openai_passthrough` Provider 才透传调用方 Authorization。
- Provider 可以暂时设为 `enabled: false`：保留的 alias 请求会返回 503，但该 Provider 的旧 slug 和 canonical 模型不会出现在 `/v1/models`；重新启用后无需修改 alias。
- 模型级 `api_key`、`api_key_env`、兼容 profile、网络策略和 timeout 会在启动时校验；模型 key 的选择顺序是显式 `api_key`、模型级环境变量/密钥文件、Provider 默认 key。
- 未知静态模型、缺少登录认证、缺少上游密钥时不访问上游，直接返回错误；动态 Provider 的任意非空 canonical 模型由对应上游判断是否存在。
- 日志记录 provider、模型、上游主机、状态码与耗时，不记录提示词、响应正文、请求头与 API 密钥。
- 上游返回 4xx/5xx 时，代理额外写一条脱敏诊断日志：提取错误 `message`/`code`/provider 原始消息，统计请求输入类型、工具类型和孤立调用数；不记录提示词、工具参数或密钥。
- 历史监控默认关闭；设置 `HISTORY_MONITOR=1` 后，按请求关联 ID 记录清洗前结构、清洗后结构和上游结果三类 JSONL 事件。监控只记录项目索引、类型、ID、字段存在性/长度、工具输出类型/字节数、调用配对统计和处理动作，不记录消息正文、reasoning 正文、密文、工具参数、工具输出、Base64、请求头或密钥。

## 图片上传

CMP 返回的 Codex 模型元数据优先使用 `models_unified.json` 中的精确模板和配置映射；没有模板的动态模型使用保守通用字段，不根据名字擅自声明图片或其他高级能力。`glm-5.3` 按官方能力仅声明 `["text"]`，`glm-5.3-flash` 原生支持 `["text","image"]`。

## 快速开始（每台机器各执行一次）

1. 安装 Node.js（本项目只用内置模块，无需安装任何依赖）。
2. 把仓库克隆到本机任意目录。
3. 复制 `proxy-secrets.env.example` 为 `proxy-secrets.env`，填写尚未迁移到 Provider 文件的密钥；该文件已被 Git 忽略，不会提交，各机器填各自的密钥。
4. 复制 `providers.local.json.example` 为 `providers.local.json`，在对应 Provider 对象中填写 `base_url` 和 `api_key`，并按需设置 `enabled`、`discover_models`、命名空间和网络策略。该文件已被 Git 忽略。
5. 复制 `proxy-local.env.example` 为 `proxy-local.env`；默认不设置 `PROXY_URL`，未列入 `DIRECT_MODELS` 的模型会动态使用当前用户的 Windows 手动系统代理。启用本地访问令牌时设置 `PROXY_ACCESS_TOKEN`；排查历史兼容问题时可临时加 `HISTORY_MONITOR=1`。
6. 双击或运行 `start-proxy.cmd` 启动中转。浏览器打开 `http://127.0.0.1:8787/healthz`，应返回 `{"status":"ok"}`。
7. 按下方“Codex 配置”准备三处文件并运行切换脚本。
8. 完全退出并重启 Codex App Server，使其改用 CMP 动态模型接口；以后打开模型选择器时会异步刷新。

以后更新：先执行 `git pull` 拉取最新代码，然后提醒用户手动重启中转（先运行 `stop-proxy.cmd`，再运行 `start-proxy.cmd`）；更新过程中不要自动重启服务，重启时机由用户决定。

> 注意：代理本身就是 Codex 正在使用的通信通道。如果当前 Codex 正通过本中转（`base_url` 指向本代理），停止或重启代理前，请先切换到直连配置，操作完成后再切回统一中转。

## CLIProxyAPI（CPA）

CPA 必须作为独立服务部署并由用户手动启动、停止，CodexModelProxy 只连接它，不负责进程管理、账号池管理或升级。推荐在 `providers.local.json` 中配置：

```json
{
  "providers": {
    "cpa": {
      "enabled": true,
      "base_url": "https://cpa-node.tail7c23f0.ts.net/v1",
      "api_key": "你的_CLIProxyAPI_服务端密钥",
      "auth_mode": "api_key",
      "protocol": "responses",
      "discover_models": true,
      "model_prefix": "cpa/",
      "compat_profile": "openai-auto",
      "network": "default"
    }
  }
}
```

- `base_url` 是包含 `/v1` 的 OpenAI 兼容根地址。当前测试链路使用 Tailscale Funnel 公网地址；CPA 的 `/models`、`/responses` 与 `/responses/compact` 都使用 CMP 的 Provider 网络策略。
- `cpa/<模型>` 解析为 CPA Provider 的模型名；任意非空模型都交给 CPA 最终判断。旧的 `direct/<模型>` 请求仍兼容，但不会出现在模型目录中。
- `discover_models=true` 时，`/v1/models` 会读取 CPA `/models`，使用成功缓存、失败冷却和 stale 数据保护；从未成功时只返回静态模型。
- CPA 的 compact 请求与普通请求一样只访问当前 CPA Provider。上游返回 4xx、5xx、网络错误或 timeout 时，原状态/响应直接返回调用方，不会切换其他模型或 Provider。
- CPA 请求只使用 CPA Provider 自己的 key，不会向 CPA 传递调用方的 ChatGPT 账号头、Cookie、`Authorization` 或 `X-Api-Key`。
- 旧的 `CPA_BASE_URL`、`CPA_API_KEY` 和 `CPA_MODELS_CACHE_TTL_SECONDS` 仍可用于迁移，但不再是主配置方式；显式进程环境变量优先于本地 Provider 文件。

### 动态模型接口与缓存

模型目录分三层传递：

1. 每个启用 `discover_models` 的 Provider 提供 `GET <base_url>/models`，返回当前认证账号可用的模型 ID。
2. CMP 的 `GET http://127.0.0.1:8787/v1/models` 请求这些 Provider 接口，为动态条目加对应命名空间并补齐 Codex `ModelInfo`；响应同时包含 OpenAI 兼容的 `data` 数组和 Codex 使用的完整 `models` 数组。
3. Codex App Server 请求当前 Provider 的 `/models?client_version=...`，因此本项目对应 CMP 的 `/v1/models`；返回结果进入 `model/list` RPC，模型选择器打开时先显示缓存，再异步原地刷新。

CMP 的 Provider 模型缓存仅在进程内存中，默认成功 TTL 60 秒、失败冷却 30 秒；过期后由下一次 `/v1/models` 请求触发刷新，并发刷新会合并为一次请求。刷新失败时保留最近一次成功结果，CMP 重启后该内存缓存消失。Codex App Server 的远端目录缓存位于 `%USERPROFILE%\.codex\models_cache.json`，默认有效期 5 分钟，并约每 4 分 30 秒后台刷新。Codex 配置不得设置 `model_catalog_json`，否则会改用权威静态目录并停止访问 CMP 的动态模型接口。

## 分支与更新流程

- 仓库只维护 `master`：所有代码、文档和部署更新提交并推送到 `origin/master`。
- 更新前先拉取 `master`，测试通过后提交并推送；不再使用独立的 `beta` 开发分支。

## Codex 配置

统一配置涉及三处文件：仓库内的 `proxy-secrets.env` 与 `proxy-local.env` 保存本机差异，`C:\Users\noha\.codex\config_unified.toml` 是 Codex 的备用统一配置模板。

1. `proxy-secrets.env`：填写 `OPENCODE_API_KEY`、`DEEPSEEK_API_KEY` 与 `ZAI_API_KEY`；启用 CPA 时取消 `CPA_API_KEY` 示例行的注释并填写密钥。
2. `proxy-local.env`：设置本机 `DIRECT_MODELS`、`HOST`、`PORT`；通常无需设置 `PROXY_URL`，只有固定代理或强制默认直连时才使用它。启用本地访问令牌时加 `PROXY_ACCESS_TOKEN=...`，其值必须与下方 `http_headers` 中的一致；CPA 的 URL、key 和动态发现设置放在 `providers.local.json`；历史排查开关见下方“可选历史监控”。
3. `config_unified.toml`（位于 `%USERPROFILE%\.codex`）：

```toml
model_provider = "OpenAI"
model = "deepseek-v4-flash"
model_reasoning_effort = "max"
forced_login_method = "chatgpt"

[model_providers.OpenAI]
name = "unified"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = true
http_headers = { "X-Proxy-Access-Token" = "你的访问令牌" }
```

说明：

- `model`：默认模型 slug，可选上表任意一行；默认 `deepseek-v4-flash`。
- `forced_login_method`：需要 Codex 使用 ChatGPT 账号登录、访问三个 GPT-5.6 路由时写 `"chatgpt"`，登录完成后才能正常调用 GPT 模型；不需要登录账号、只用 OC 与直连 DeepSeek 四个路由时写 `"api"`。当前统一配置面向含 GPT 的场景，模板保留 `"chatgpt"`。
- `requires_openai_auth = true`：让 Codex 使用 OpenAI 登录认证；三个 GPT 路由原样透传该认证，OC 与直连路由由代理替换为对应 API 密钥。
- `base_url`：若通过 `proxy-local.env` 修改了 `PORT`，这里要同步修改端口。
- `wire_api = "responses"`：Codex 自定义 Provider 目前唯一支持的协议。
- `http_headers`：`X-Proxy-Access-Token` 用于避免与 ChatGPT 的 `Authorization` 冲突，值必须与 `proxy-local.env` 中的 `PROXY_ACCESS_TOKEN` 一致；未启用访问令牌时删除该行。
- 不设置 `model_catalog_json`：让 App Server 使用当前 Provider 的 `/models` 动态目录；设置该项会切回静态模型管理器。

切换与生效：

1. 启动代理：运行 `start-proxy.cmd`，浏览器打开 `http://127.0.0.1:8787/healthz`，应返回 `{"status":"ok"}`。
2. 运行 `C:\Users\noha\.codex\config_unified.cmd`（个人目录的切换脚本，不在本仓库内）。
3. 脚本只把模板中的模型、认证和 `[model_providers.OpenAI]` 区段写入活动 `config.toml`，桌面端、插件、MCP、项目权限等其他配置保留。
4. 完全退出并重启 Codex App Server，让模型管理器从静态模式切换为 Provider 动态模式。
5. 打开模型选择器；它先显示 `%USERPROFILE%\.codex\models_cache.json` 中的缓存，再从 CMP 原地刷新。CPA 已启动时应同时看到 `cpa/<模型>`。

只修改 `config_unified.toml` 不会影响当前 Codex 配置；运行 `config_unified.cmd` 才会把模板写入活动 `config.toml`。切换失败时脚本不会替换当前 `config.toml`。

仓库内的 `config-templates/` 提供切换脚本示例：`switch_config.ps1`、`config_unified.toml`、`config_unified.cmd`。新机器把它们复制到 `%USERPROFILE%\.codex`，按本机修改访问令牌后即可运行；模板中的密钥均为占位符，不会携带任何真实凭据。

## 命令速查

```text
start-proxy.cmd       启动中转（后台运行，日志写入 proxy.log / proxy.err.log）
stop-proxy.cmd        停止中转（按 pid，回退按端口）
```

CLI 单独指定模型（不改全局配置）：

```text
codex exec -m gpt-5.6-sol "提示词"
codex exec -m deepseek-v4-flash "提示词"
codex exec -m deepseek-v4-flash-direct "提示词"
codex exec -m cpa/gpt-5.6-sol "提示词"
codex exec -m glm-5.3 "提示词"
codex exec -m glm-5.3-flash "提示词"
```

## 文件说明

| 文件 | 作用 |
|---|---|
| `server.mjs` | 中转服务主程序，零依赖 |
| `provider-registry.mjs` | Provider 配置合并、校验、认证解析、命名空间和旧路由迁移 |
| `model-discovery.mjs` | 通用 `/models` 同步、缓存、并发刷新、失败冷却、超时与大小限制 |
| `model-resolver.mjs` | canonical model、alias、旧 slug、`direct/` 和最终 route 解析 |
| `compatibility-profiles.mjs` | openai/deepseek/passthrough/muse profile 与模型覆盖规则 |
| `cpa-provider.mjs` | 旧 CPA 配置/目录 API 的兼容包装层 |
| `compact-forward.mjs` | `/responses/compact` 单次当前模型转发、历史整理和响应透传 |
| `system-proxy.mjs` | Windows 当前用户手动系统代理读取、规范化、2 秒缓存与并发刷新合并 |
| `proxy-agent.mjs` | 经 HTTP 或 HTTPS 代理建立上游 CONNECT 隧道 |
| `muse-tool-compat.mjs` | Muse 请求级双向工具桥接：namespace/custom/tool_search 展平、web_search 字段清理、名称别名与 JSON/SSE 调用恢复 |
| `proxy-config.json` | 可提交的行为配置：监听地址、Provider 默认值、aliases、兼容覆盖和旧模型路由迁移信息（提交到仓库） |
| `providers.local.json.example` | URL、key、启用状态、动态发现、命名空间和网络策略的脱敏示例；复制为被忽略的 `providers.local.json` |
| `history-normalize.mjs` | 按目标模型整理 reasoning、`web_search_call` 与工具输出历史（发送前处理，不修改原会话） |
| `history-monitor.mjs` | 可选的脱敏历史结构监控、关联 ID、调用配对统计和日志轮换 |
| `proxy-secrets.env.example` | 密钥模板；复制为 `proxy-secrets.env` 填写，后者不提交 |
| `proxy-local.env.example` | 本机差异模板；复制为 `proxy-local.env` 填写，后者不提交 |
| `models_unified.json` | CMP 内部基础模型元数据；用于生成静态目录并为动态模型补齐 Codex 字段 |
| `config-templates/` | Codex 配置切换脚本示例（脱敏模板，复制到 `%USERPROFILE%\.codex` 后按本机修改） |
| `test/proxy.test.mjs`、`test/provider-registry.test.mjs`、`test/model-discovery.test.mjs`、`test/model-resolver.test.mjs`、`test/compatibility-profile.test.mjs`、`test/cpa-provider.test.mjs`、`test/compact-forward.test.mjs`、`test/system-proxy.test.mjs`、`test/history-normalize.test.mjs`、`test/history-monitor.test.mjs`、`test/muse-tool-compat.test.mjs` | 自动测试（模拟注册表、临时目录与内存 mock 上游，不消耗真实额度） |

## 上游网络路径

Codex 始终先访问本地中转 `127.0.0.1:8787`；本节配置的是本地中转访问外部上游时是否经过代理。默认不设置 `PROXY_URL`，服务会读取当前登录用户 `Internet Settings` 中的 Windows 手动系统代理。FlClash 打开、关闭或改变系统代理端口后，新的上游请求最多约 2 秒后自动采用新设置，无需重启中转。

```text
DIRECT_MODELS=deepseek-v4-flash,deepseek-v4-pro,deepseek-v4-flash-direct,deepseek-v4-pro-direct
```

当前默认路径为：GPT、Muse、GLM 和 CPA 跟随 Provider 的默认网络策略，OC 模型按 `DIRECT_MODELS` 和全局代理规则选择，DeepSeek 直连 Provider 默认绕过代理。Muse 需要美区出口，不要把它加入 `DIRECT_MODELS`。动态 Provider 不加入静态白名单；将模型加入或移出 `DIRECT_MODELS` 后，重启本地中转即可生效，不需要修改 Codex 配置。白名单中的 slug 必须已能被 Registry 解析。

代理选择优先级如下：

1. 模型位于 `DIRECT_MODELS` 时始终直连。
2. 进程环境或 `proxy-local.env` 明确定义 `PROXY_URL` 时，非空值使用该固定代理，空值 `PROXY_URL=` 强制默认直连。
3. `proxy-config.json` 的 `proxy` 非空时使用该固定代理。
4. 以上均未配置时动态使用 Windows 手动系统代理；系统代理开关关闭时直连。

Windows 的单一 `host:port`、带 `http://` 或 `https://` 协议地址，以及 `http=...;https=...` 分协议格式均受支持。首次读取失败或启用状态下地址无效时，请求返回 502，不会静默绕过代理；已有有效缓存时刷新失败会暂用缓存并记录警告。首版不读取 PAC、WPAD 自动检测或 WinHTTP 设置，也不在非 Windows 系统上自动发现代理。

## 可选历史监控

监控默认关闭，不影响正常转发。需要排查偶发的历史兼容问题时，在启动中转的同一环境中设置：

```text
HISTORY_MONITOR=1
HISTORY_MONITOR_FILE=history-monitor.jsonl
```

`HISTORY_MONITOR_FILE` 可以是绝对路径或相对路径；相对路径默认位于项目目录。日志达到 10 MB 后轮换为同目录下的 `history-monitor.jsonl.1`，只保留一个备份。也可以用 `HISTORY_MONITOR_MAX_BYTES` 临时调整轮换阈值。写日志失败只产生警告，不会阻断上游请求。

监控完成后删除 `HISTORY_MONITOR` 或改为 `0`，再手动重启中转关闭它。日志文件已加入 Git 忽略，不会提交。

## 测试

```text
node --test --test-isolation=none test\history-normalize.test.mjs test\proxy.test.mjs test\compact-forward.test.mjs test\history-monitor.test.mjs test\system-proxy.test.mjs test\muse-tool-compat.test.mjs test\cpa-provider.test.mjs test\provider-registry.test.mjs test\model-discovery.test.mjs test\model-resolver.test.mjs test\compatibility-profile.test.mjs
```

测试覆盖健康检查、静态与动态 Provider 模型列表、旧 `direct/` 请求兼容、Provider 配置校验、别名循环与命名空间冲突、模型缓存/并发刷新/失败冷却/超时/大小限制、模型名与密钥隔离、请求体保真、JSON/SSE 原样透传、本地访问令牌、上游错误保持、未知模型拦截，GPT/DeepSeek reasoning 字段整理、Muse 跨类型输入项 ID 规范化、`web_search_call` 过滤、四条 DS 路由工具输出 JSON 文本化、Muse 工具展平/名称别名/JSON/SSE 调用恢复与原请求不可变、ZAI 直通保真、图片数组与调用配对保留，以及 compact 的 GPT/DeepSeek/CPA 单请求失败、400/401/429/5xx/timeout 和 history normalization。

## 已知限制

- OpenCode GO 的 `/responses` 兼容层返回字段较精简，标准多轮工具调用历史仍可能不被完整接受；四条 OC/直连 DeepSeek 路由只把非字符串工具输出序列化为 JSON 文本，不做其他工具协议转换或缓存。
- Muse Spark 1.2 Contributor 的 GO Responses 端点只接受普通 function 工具与去除了 `search_content_types` 的 `web_search`，并限制函数名不超过 64 字符；代理已按请求做完整双向桥接（namespace/custom/tool_search 展平与恢复）。依据为 GitHub codex-router PR #288/#482 与 opencodex issue #2442。思考档位仅 `minimal~xhigh`（`none`/`max` 返回 400）；需要数据训练授权与美区出口；流式以 `response.completed` 结束且不发 `[DONE]`，若 Codex 客户端出现收尾异常需单独评估。若 GO 后续原生支持这些工具，可移除 `tool_schema_compat` 恢复纯透传。
- Z.AI GLM-5.3 / GLM-5.3-Flash 首版为完整直通：reasoning、工具输出与工具定义不做改写；若上游拒绝 Codex 的某些历史格式，需按实际错误增加适配。官方未公开 `/responses/compact` 的支持情况，compact 错误会直接返回当前 Provider 的失败结果。GLM-5.3 仅声明文本输入，GLM-5.3-Flash 声明图文输入。
- DeepSeek 直连的 `/responses` 兼容性取决于上游实现；代理不降级到 Chat Completions。
- 历史整理只解决已知的 GPT/DeepSeek 历史格式兼容，不解决真正的上下文 token 超限；净化后若上游仍返回上下文长度错误，需要压缩或裁剪会话。
- App Server 首次切换到动态 Provider 模式需要完全重启；之后打开模型选择器会触发异步刷新，磁盘缓存最长约 5 分钟。
- 动态目录声明允许附加图片不代表实际上游一定能识图，最终仍以上游能力为准。

## 故障排查

- 启动失败提示缺少密钥：检查 `proxy-secrets.env` 中的变量名和值。
- 使用 `providers.local.json` 时启动失败提示缺少 URL 或 key：检查对应 Provider 对象是否填写完整，并确认 `auth_mode=api_key` 的 key 没有留空。
- 停止代理后 Codex 立即断连：这是预期行为，代理就是 Codex 的通道；更新代码或重启代理前，先切换到直连配置，完成后再切回。
- 端口被占用：在 `proxy-local.env` 中修改 `PORT`，并同步修改 Codex 配置 `base_url` 的端口。
- OpenCode 返回 403 区域限制：如果希望 OpenCode 走代理，请从 `DIRECT_MODELS` 删除对应的 OC 模型 slug，并确认 Windows 手动系统代理或显式 `PROXY_URL` 已启用且代理程序正在运行。
- GLM-5.3 返回 401：确认 `proxy-secrets.env` 中的 `ZAI_API_KEY` 是 Z.AI Coding Plan 专用的有效密钥（团队计划需用团队密钥）。
- 系统代理解析返回 502：确认 Windows“设置”中的手动代理已启用且地址有效；PAC、自动检测和 WinHTTP 设置不会被读取。需要临时绕过时在 `proxy-local.env` 写入空值 `PROXY_URL=` 并重启中转。
- 模型列表不对：确认 Codex 配置没有 `model_catalog_json`，然后检查 CMP `/v1/models` 的 `models` 数组；首次切换后完全退出并重启 App Server。仍显示旧内容时检查 `%USERPROFILE%\.codex\models_cache.json` 的时间，并确认启用动态发现的 Provider 服务可访问。
- GPT 模型返回 401：确认 Codex 已完成 ChatGPT 登录，且 `forced_login_method = "chatgpt"`、`requires_openai_auth = true`。
- 需要排查偶发历史错误：临时设置 `HISTORY_MONITOR=1` 并重启中转，再复现一次；检查 `history-monitor.jsonl` 中同一 `request_id` 的三类结构事件。排查完成后关闭开关并手动重启中转。

## 安全说明

- 真实 API 密钥只存放在被 Git 忽略的 `providers.local.json` 或 `proxy-secrets.env`，不会进入仓库或日志；本机差异存于 `proxy-local.env`，同样不会提交。
- 服务默认只监听 `127.0.0.1`，请勿改为 `0.0.0.0`。
- 可选访问令牌通过 `X-Proxy-Access-Token` 校验，`/healthz` 始终不校验；仅当需要跨机器远程访问代理时才启用，并同步在 Codex 配置的 `http_headers` 填同一令牌。




