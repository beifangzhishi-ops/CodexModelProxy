# CodexModelProxy 八模型纯 Responses 中转（Windows）

本目录是一个零依赖的 Node.js 本地中转服务，让 Codex 通过一个本地地址同时使用 8 个上游模型（ChatGPT × 3、OpenCode × 2、DeepSeek × 2、OpenRouter × 1）。所有上游统一走 `/responses` 协议；代理替换模型名、处理鉴权，并在发送前按目标模型整理 reasoning、网页搜索历史和指定的工具输出格式，其余请求与响应原样转发。

项目只面向 Windows 本机使用，通过 Git 仓库在多个机器间同步更新：通用配置提交到仓库，密钥与本机差异（监听端口、访问令牌等）放在各自机器上、不提交。上游默认动态使用当前用户的 Windows 手动系统代理，无需在项目中重复填写 FlClash 端口。

## 模型映射

Codex 的模型目录（`model_catalog_json`）支持任意 slug，下拉列表按 `display_name` 展示，因此第三方模型不再需要伪装成 `gpt-5.x` 别名。OpenCode 与直连 DeepSeek 的上游模型名相同，用 `-direct` 后缀区分直连通道。

| slug（请求与配置用） | 显示名（下拉列表可见） | 认证 | 实际上游 |
|---|---|---|---|
| `gpt-5.6-sol` | GPT-5.6 Sol · ChatGPT | ChatGPT 登录透传 | ChatGPT `gpt-5.6-sol` |
| `gpt-5.6-terra` | GPT-5.6 Terra · ChatGPT | ChatGPT 登录透传 | ChatGPT `gpt-5.6-terra` |
| `gpt-5.6-luna` | GPT-5.6 Luna · ChatGPT | ChatGPT 登录透传 | ChatGPT `gpt-5.6-luna` |
| `deepseek-v4-flash` | OC · DSV4 Flash | `OPENCODE_API_KEY` | OpenCode GO `deepseek-v4-flash` |
| `deepseek-v4-pro` | OC · DSV4 Pro | `OPENCODE_API_KEY` | OpenCode GO `deepseek-v4-pro` |
| `deepseek-v4-flash-direct` | DS · V4 Flash · 直连 | `DEEPSEEK_API_KEY` | DeepSeek `deepseek-v4-flash` |
| `deepseek-v4-pro-direct` | DS · V4 Pro · 直连 | `DEEPSEEK_API_KEY` | DeepSeek `deepseek-v4-pro` |
| `ox-alpha` | OR · Ox Alpha | `OPENROUTER_API_KEY` | OpenRouter `stealth/ox-alpha` |

默认模型为 `deepseek-v4-flash`（OC · DSV4 Flash）。Ox Alpha 是 OpenRouter 上的匿名预览模型，当前免费提供；`gpt-5.4-mini`、`gpt-5.4-nano`、Gemini、MiMo 均不进入目录。

## 转发行为

- 只处理 `POST /v1/responses`、`POST /v1/responses/compact` 与 `GET /v1/models`；所有路由固定追加 `/responses`。
- 请求体除 `model` 替换为实际上游模型名外，还会按目标模型的 reasoning 格式整理推理历史；JSON 与 SSE 响应状态、响应头和正文原样返回。
- 跨 GPT/DeepSeek 切换时保留所有 reasoning 项和项目顺序，只清空冲突字段：GPT 路由把非空或格式不兼容的 `content` 改为 `[]`；若发现 OC/DS 使用的“UUID + 分段号”外部引用误放在 `encrypted_content`，仅将该字段改为 `null`，正常 GPT 密文继续保留。OpenCode、直连 DeepSeek 与 OpenRouter 路由把已有的 `encrypted_content` 改为 `null`，保留明文 `content`。整理只影响本次上游请求，不修改 Codex 原会话，也不尝试恢复或伪造密文。
- 跨模型切换时同步整理网页搜索记录：GPT 路由只保留 `id` 以 `ws` 开头的 `web_search_call`，DS/Codex 风格的 `call_...` 搜索调用项从本次上游请求移除；助手消息中的搜索结论与引用不受影响。
- OpenRouter 路由清空 reasoning 的 `encrypted_content`，并移除 OpenRouter 不接受的 `web_search_call`；普通消息、函数调用和工具结果不改名。
- 每条路由可设置 `tool_output_format`：默认 `passthrough`；四条 OC/直连 DeepSeek 路由使用 `json_string`，将 `function_call_output` 与 `custom_tool_call_output` 中的非字符串 `output` 完整 `JSON.stringify` 为文本，字符串保持不变。GPT 与 Ox 使用 `passthrough`，数组中的图片、`call_id`、项目顺序均保留。
- 不解析或转换 SSE 事件；工具输出只按上述路由规则处理，不尝试恢复跨供应商私有状态。
- 三个 GPT 路由把 Codex 的 ChatGPT 登录认证（`Authorization`）原样转发至 Backend API。
- OC 与直连 DeepSeek 路由丢弃传入的 ChatGPT `Authorization`，分别注入 `OPENCODE_API_KEY` 与 `DEEPSEEK_API_KEY`。
- 未知模型、缺少登录认证、缺少上游密钥时不访问上游，直接返回错误。
- 日志只记录模型与上游主机，不记录提示词、响应正文、请求头与 API 密钥。
- 上游返回 4xx/5xx 时，代理额外写一条脱敏诊断日志：提取错误 `message`/`code`/provider 原始消息，统计请求输入类型、工具类型和孤立调用数；不记录提示词、工具参数或密钥。
- 历史监控默认关闭；设置 `HISTORY_MONITOR=1` 后，按请求关联 ID 记录清洗前结构、清洗后结构和上游结果三类 JSONL 事件。监控只记录项目索引、类型、ID、字段存在性/长度、工具输出类型/字节数、调用配对统计和处理动作，不记录消息正文、reasoning 正文、密文、工具参数、工具输出、Base64、请求头或密钥。

## 图片上传

`models_unified.json` 中 8 个模型均声明 `input_modalities: ["text", "image"]` 与 `supports_image_detail_original: true`，因此桌面端允许上传图片；能否真正识别图片取决于上游模型是否支持图片输入。若某个上游不接受图片，把对应条目的 `input_modalities` 改回 `["text"]` 即可。

## 快速开始（每台机器各执行一次）

1. 安装 Node.js（本项目只用内置模块，无需安装任何依赖）。
2. 把仓库克隆到本机任意目录。
3. 复制 `proxy-secrets.env.example` 为 `proxy-secrets.env`，填写 `OPENCODE_API_KEY`、`DEEPSEEK_API_KEY` 与 `OPENROUTER_API_KEY`。该文件已被 Git 忽略，不会提交，各机器填各自的密钥。
4. 复制 `proxy-local.env.example` 为 `proxy-local.env`；默认不设置 `PROXY_URL`，未列入 `DIRECT_MODELS` 的模型会动态使用当前用户的 Windows 手动系统代理。启用本地访问令牌时在此文件加 `PROXY_ACCESS_TOKEN=...`；排查历史兼容问题时可临时加 `HISTORY_MONITOR=1`。
5. 双击或运行 `start-proxy.cmd` 启动中转。浏览器打开 `http://127.0.0.1:8787/healthz`，应返回 `{"status":"ok"}`。
6. 按下方“Codex 配置”准备三处文件并运行切换脚本。
7. 重新加载 Codex 配置与模型目录（模型目录缓存到 App Server 重启后刷新）。

以后更新：先执行 `git pull` 拉取最新代码，然后提醒用户手动重启中转（先运行 `stop-proxy.cmd`，再运行 `start-proxy.cmd`）；更新过程中不要自动重启服务，重启时机由用户决定。

> 注意：代理本身就是 Codex 正在使用的通信通道。如果当前 Codex 正通过本中转（`base_url` 指向本代理），停止或重启代理前，请先切换到直连配置，操作完成后再切回统一中转。

## 分支与更新流程

- 所有代码与文档更新默认提交到 `beta` 分支并推送到 `origin/beta`，不直接推送 `origin/master`。
- 仅当用户明确指示合并时，才把 `beta` 合并到 `master` 并推送 `origin/master`。
- 未合并到 `master` 的更新以 `beta` 分支为准；需要试用时切换到 `beta` 分支部署。
- 2026-08-24 已从 `master` 当前头部重建 `beta`，后续更新继续在新 `beta` 上进行；原 `beta` 及其中未合并的 DeepSeek Pro `we_need` 推理风格提示完整保存在 `pro提示分叉`。

## Codex 配置

统一配置涉及三处文件：仓库内的 `proxy-secrets.env` 与 `proxy-local.env` 保存本机差异，`C:\Users\noha\.codex\config_unified.toml` 是 Codex 的备用统一配置模板。

1. `proxy-secrets.env`：填写 `OPENCODE_API_KEY`、`DEEPSEEK_API_KEY` 与 `OPENROUTER_API_KEY`，两个 OC 路由、两个直连 DeepSeek 路由和 Ox Alpha 路由分别使用它们。
2. `proxy-local.env`：设置本机 `DIRECT_MODELS`、`HOST`、`PORT`；通常无需设置 `PROXY_URL`，只有固定代理或强制默认直连时才使用它。启用本地访问令牌时加 `PROXY_ACCESS_TOKEN=...`，其值必须与下方 `http_headers` 中的一致；历史排查开关见下方“可选历史监控”。
3. `config_unified.toml`（位于 `%USERPROFILE%\.codex`）：

```toml
model_provider = "OpenAI"
model = "deepseek-v4-flash"
model_reasoning_effort = "max"
forced_login_method = "chatgpt"
model_catalog_json = "C:/你的克隆目录/CodexModelProxy/models_unified.json"

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

切换与生效：

1. 启动代理：运行 `start-proxy.cmd`，浏览器打开 `http://127.0.0.1:8787/healthz`，应返回 `{"status":"ok"}`。
2. 运行 `C:\Users\noha\.codex\config_unified.cmd`（个人目录的切换脚本，不在本仓库内）。
3. 脚本只把模板中的模型、认证和 `[model_providers.OpenAI]` 区段写入活动 `config.toml`，桌面端、插件、MCP、项目权限等其他配置保留。
4. 重启 Codex App Server 或重新加载配置，让启动时加载的模型目录刷新。
5. 下拉列表应正好显示 8 个模型，默认模型为 `deepseek-v4-flash`。

只修改 `config_unified.toml` 不会影响当前 Codex 配置；运行 `config_unified.cmd` 才会把模板写入活动 `config.toml`。切换失败时脚本不会替换当前 `config.toml`。

仓库内的 `config-templates/` 提供切换脚本示例：`switch_config.ps1`、`config_unified.toml`、`config_unified.cmd`。新机器把它们复制到 `%USERPROFILE%\.codex`，按本机修改模板中的 `model_catalog_json` 路径和访问令牌后即可运行；模板中的密钥均为占位符，不会携带任何真实凭据。

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
codex exec -m ox-alpha "提示词"
```

## 文件说明

| 文件 | 作用 |
|---|---|
| `server.mjs` | 中转服务主程序，零依赖 |
| `compact-forward.mjs` | `/responses/compact` 转发与失败后备模型重试 |
| `system-proxy.mjs` | Windows 当前用户手动系统代理读取、规范化、2 秒缓存与并发刷新合并 |
| `proxy-agent.mjs` | 经 HTTP 或 HTTPS 代理建立上游 CONNECT 隧道 |
| `proxy-config.json` | 通用配置：监听地址、端口、压缩后备模型与 8 条模型路由；每条路由声明 `reasoning_format` 与 `tool_output_format`（提交到仓库） |
| `history-normalize.mjs` | 按目标模型整理 reasoning、`web_search_call` 与工具输出历史（发送前处理，不修改原会话） |
| `history-monitor.mjs` | 可选的脱敏历史结构监控、关联 ID、调用配对统计和日志轮换 |
| `proxy-secrets.env.example` | 密钥模板；复制为 `proxy-secrets.env` 填写，后者不提交 |
| `proxy-local.env.example` | 本机差异模板；复制为 `proxy-local.env` 填写，后者不提交 |
| `models_unified.json` | Codex 统一模型目录（8 个模型） |
| `config-templates/` | Codex 配置切换脚本示例（脱敏模板，复制到 `%USERPROFILE%\.codex` 后按本机修改） |
| `test/proxy.test.mjs`、`test/compact-fallback.test.mjs`、`test/system-proxy.test.mjs`、`test/history-normalize.test.mjs`、`test/history-monitor.test.mjs` | 自动测试（模拟注册表、临时目录与内存 mock 上游，不消耗真实额度） |

## 上游网络路径

Codex 始终先访问本地中转 `127.0.0.1:8787`；本节配置的是本地中转访问外部上游时是否经过代理。默认不设置 `PROXY_URL`，服务会读取当前登录用户 `Internet Settings` 中的 Windows 手动系统代理。FlClash 打开、关闭或改变系统代理端口后，新的上游请求最多约 2 秒后自动采用新设置，无需重启中转。

```text
DIRECT_MODELS=deepseek-v4-flash,deepseek-v4-pro,deepseek-v4-flash-direct,deepseek-v4-pro-direct
```

当前默认路径为：GPT 三个模型和 Ox Alpha 跟随 Windows 系统代理，OC 两个模型和 DeepSeek 两个直连模型绕过代理。将模型 slug 加入或移出 `DIRECT_MODELS` 后，重启本地中转即可生效，不需要修改 Codex 配置或刷新模型目录。白名单中的 slug 必须是 `proxy-config.json` 中已有的模型。

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
node --test test\history-normalize.test.mjs test\proxy.test.mjs test\compact-fallback.test.mjs test\history-monitor.test.mjs test\system-proxy.test.mjs
```

测试覆盖健康检查、模型列表、8 条路由、模型名与密钥隔离、请求体保真、JSON/SSE 原样透传、本地访问令牌、上游错误保持、日志脱敏、压缩后备、未知模型拦截，GPT/DeepSeek/OpenRouter reasoning 字段清空、`web_search_call` 过滤、畸形推理项保留、四条 DS 路由工具输出 JSON 文本化、图片数组与调用配对保留，以及 Windows 系统代理格式、优先级、动态刷新、失败后备和历史监控。

## 已知限制

- OpenCode GO 的 `/responses` 兼容层返回字段较精简，标准多轮工具调用历史仍可能不被完整接受；四条 OC/直连 DeepSeek 路由只把非字符串工具输出序列化为 JSON 文本，不做其他工具协议转换或缓存。
- OpenRouter 上的 Ox Alpha 是匿名预览模型，免费资格、可用性和上游策略可能变化；当前使用 `stealth/ox-alpha`，并通过 `OPENROUTER_API_KEY` 认证。
- Ox Alpha 路由使用 `reasoning_format: openrouter_compatible`：跨供应商切换时把 `encrypted_content` 置为 `null`，并删除 `web_search_call`，不尝试恢复原供应商的私有思考状态。
- OpenRouter/Stealth 上游不接受 Codex 的 freeform custom 工具（`apply_patch`），因此 Ox Alpha 目录中 `apply_patch_tool_type` 置为 `null`，该模型改用 `exec_command` 完成文件操作；不把 custom 转成 function，以免客户端执行路径与上游协议错位。
- DeepSeek 直连的 `/responses` 兼容性取决于上游实现；代理不降级到 Chat Completions。
- 历史整理只解决已知的 GPT/DeepSeek/OpenRouter 历史格式兼容，不解决真正的上下文 token 超限；净化后若上游仍返回上下文长度错误，需要压缩或裁剪会话。
- 模型目录在 Codex App Server 启动时加载，改动后需重启 App Server 才会刷新下拉列表。
- 全部 8 个目录项允许附加图片，但实际模型不能原生识图时仍会按上游能力报错。

## 故障排查

- 启动失败提示缺少密钥：检查 `proxy-secrets.env` 中的变量名和值。
- 停止代理后 Codex 立即断连：这是预期行为，代理就是 Codex 的通道；更新代码或重启代理前，先切换到直连配置，完成后再切回。
- 端口被占用：在 `proxy-local.env` 中修改 `PORT`，并同步修改 Codex 配置 `base_url` 的端口。
- OpenCode 返回 403 区域限制：如果希望 OpenCode 走代理，请从 `DIRECT_MODELS` 删除对应的 OC 模型 slug，并确认 Windows 手动系统代理或显式 `PROXY_URL` 已启用且代理程序正在运行。
- 系统代理解析返回 502：确认 Windows“设置”中的手动代理已启用且地址有效；PAC、自动检测和 WinHTTP 设置不会被读取。需要临时绕过时在 `proxy-local.env` 写入空值 `PROXY_URL=` 并重启中转。
- 模型列表不对：确认 `model_catalog_json` 指向本机克隆目录的 `models_unified.json`，并重启 Codex App Server。
- GPT 模型返回 401：确认 Codex 已完成 ChatGPT 登录，且 `forced_login_method = "chatgpt"`、`requires_openai_auth = true`。
- 需要排查偶发历史错误：临时设置 `HISTORY_MONITOR=1` 并重启中转，再复现一次；检查 `history-monitor.jsonl` 中同一 `request_id` 的三类结构事件。排查完成后关闭开关并手动重启中转。

## 安全说明

- 真实 API 密钥只存放在 `proxy-secrets.env`，不会进入仓库、配置文件或日志；本机差异存于 `proxy-local.env`，同样不会提交。
- 服务默认只监听 `127.0.0.1`，请勿改为 `0.0.0.0`。
- 可选访问令牌通过 `X-Proxy-Access-Token` 校验，`/healthz` 始终不校验；仅当需要跨机器远程访问代理时才启用，并同步在 Codex 配置的 `http_headers` 填同一令牌。
