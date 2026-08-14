# CodexModelProxy 七模型纯 Responses 中转（Windows）

本目录是一个零依赖的 Node.js 本地中转服务，让 Codex 通过一个本地地址同时使用 7 个上游模型（ChatGPT × 3、OpenCode × 2、DeepSeek × 2）。所有上游统一走 `/responses` 协议；代理只替换模型名、处理鉴权，其余请求与响应原样转发，不做任何协议转换。

项目只面向 Windows 本机使用，通过 Git 仓库在多个机器间同步更新：通用配置提交到仓库，密钥与本机差异（代理地址、端口、访问令牌）放在各自机器上、不提交。

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

默认模型为 `deepseek-v4-flash`（OC · DSV4 Flash）。`gpt-5.4-mini`、`gpt-5.4-nano`、Gemini、MiMo 均不进入目录。

## 转发行为

- 只处理 `POST /v1/responses`、`POST /v1/responses/compact` 与 `GET /v1/models`；所有路由固定追加 `/responses`。
- 请求体除 `model` 替换为实际上游模型名外保持不变；JSON 与 SSE 响应状态、响应头和正文原样返回。
- 不解析或转换工具调用、推理内容、SSE 事件；上游返回什么就返回什么。
- 三个 GPT 路由把 Codex 的 ChatGPT 登录认证（`Authorization`）原样转发至 Backend API。
- OC 与直连 DeepSeek 路由丢弃传入的 ChatGPT `Authorization`，分别注入 `OPENCODE_API_KEY` 与 `DEEPSEEK_API_KEY`。
- 未知模型、缺少登录认证、缺少上游密钥时不访问上游，直接返回错误。
- 日志只记录模型与上游主机，不记录提示词、响应正文、请求头与 API 密钥。

## 图片上传

`models_unified.json` 中 7 个模型均声明 `input_modalities: ["text", "image"]` 与 `supports_image_detail_original: true`，因此桌面端允许上传图片；能否真正识别图片取决于上游模型是否支持图片输入。若某个上游不接受图片，把对应条目的 `input_modalities` 改回 `["text"]` 即可。

## 快速开始（每台机器各执行一次）

1. 安装 Node.js（本项目只用内置模块，无需安装任何依赖）。
2. 把仓库克隆到本机任意目录。
3. 复制 `proxy-secrets.env.example` 为 `proxy-secrets.env`，填写 `OPENCODE_API_KEY` 与 `DEEPSEEK_API_KEY`。该文件已被 Git 忽略，不会提交，各机器填各自的密钥。
4. 若上游需要走代理（OpenCode 有区域限制，一般需要本机代理），复制 `proxy-local.env.example` 为 `proxy-local.env`，按本机代理端口修改 `PROXY_URL`；不需要代理时把值留空。启用本地访问令牌时在此文件加 `PROXY_ACCESS_TOKEN=...`。
5. 双击或运行 `start-proxy.cmd` 启动中转。浏览器打开 `http://127.0.0.1:8787/healthz`，应返回 `{"status":"ok"}`。
6. 按下方“Codex 配置”修改本机 Codex 备用配置。
7. 重新加载 Codex 配置与模型目录（模型目录缓存到 App Server 重启后刷新）。

以后更新：先执行 `git pull` 拉取最新代码，然后提醒用户手动重启中转（先运行 `stop-proxy.cmd`，再运行 `start-proxy.cmd`）；更新过程中不要自动重启服务，重启时机由用户决定。

> 注意：代理本身就是 Codex 正在使用的通信通道。如果当前 Codex 正通过本中转（`base_url` 指向本代理），停止或重启代理前，请先切换到直连配置，操作完成后再切回统一中转。

## Codex 配置

在 Codex 全局配置目录（通常是 `%USERPROFILE%\.codex`）的备用配置 `config_unified.toml` 中配置以下字段（活动 `config.toml` 不修改）：

```toml
model_provider = "OpenAI"
model = "deepseek-v4-flash"
model_reasoning_effort = "max"
model_catalog_json = "C:/你的克隆目录/CodexModelProxy/models_unified.json"

[model_providers.OpenAI]
name = "unified"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = true
```

说明：

- `model`：默认模型 slug，可选上表任意一行；默认 `deepseek-v4-flash`。
- `requires_openai_auth = true`：三个 GPT 路由需要 Codex 使用 ChatGPT 登录认证；OC 与直连路由的登录认证由代理替换为对应 API 密钥。
- `base_url`：若通过 `proxy-local.env` 修改了 `PORT`，这里要同步修改端口。
- `wire_api = "responses"`：Codex 自定义 Provider 目前唯一支持的协议。
- 本地访问令牌：代理端使用 `X-Proxy-Access-Token` 请求头（避免与 ChatGPT 的 `Authorization` 冲突）。若在 `proxy-local.env` 启用了 `PROXY_ACCESS_TOKEN`，请在 Provider 区段加 `http_headers = { "X-Proxy-Access-Token" = "与代理端相同的令牌" }`；未启用时不需要该字段。

切换不同配置的脚本属于个人 Codex 目录，不在本仓库范围内。

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
```

## 文件说明

| 文件 | 作用 |
|---|---|
| `server.mjs` | 中转服务主程序，零依赖 |
| `compact-forward.mjs` | `/responses/compact` 转发与失败后备模型重试 |
| `proxy-config.json` | 通用配置：监听地址、端口、压缩后备模型与 7 条模型路由（提交到仓库） |
| `proxy-secrets.env.example` | 密钥模板；复制为 `proxy-secrets.env` 填写，后者不提交 |
| `proxy-local.env.example` | 本机差异模板；复制为 `proxy-local.env` 填写，后者不提交 |
| `models_unified.json` | Codex 统一模型目录（7 个模型） |
| `test/proxy.test.mjs`、`test/compact-fallback.test.mjs` | 自动测试（内存 mock 上游，不消耗真实额度） |

## 代理设置

上游请求可走 HTTP 代理。OpenCode 会对直连出口做区域限制（返回 403 "This model is not available in your region."），一般需要走本机代理（例如 FlClash 默认端口 7890）。在 `proxy-local.env` 中设置：

```text
PROXY_URL=http://127.0.0.1:7890
```

不需要代理时把值留空或删除该行。服务端也支持直接用进程环境变量 `PROXY_URL` / `HOST` / `PORT` / `PROXY_ACCESS_TOKEN` 覆盖。

## 测试

```text
node --test test\proxy.test.mjs test\compact-fallback.test.mjs
```

测试覆盖健康检查、模型列表、7 条路由、模型名与密钥隔离、请求体保真、JSON/SSE 原样透传、本地访问令牌、上游错误保持、日志脱敏、压缩后备与未知模型拦截。

## 已知限制

- OpenCode GO 的 `/responses` 兼容层返回字段较精简，标准多轮工具调用历史可能不被完整接受；代理只原样返回上游错误，不做转换或缓存。
- DeepSeek 直连的 `/responses` 兼容性取决于上游实现；代理不降级到 Chat Completions。
- 模型目录在 Codex App Server 启动时加载，改动后需重启 App Server 才会刷新下拉列表。
- 全部 7 个目录项允许附加图片，但实际模型不能原生识图时仍会按上游能力报错。

## 故障排查

- 启动失败提示缺少密钥：检查 `proxy-secrets.env` 中的变量名和值。
- 停止代理后 Codex 立即断连：这是预期行为，代理就是 Codex 的通道；更新代码或重启代理前，先切换到直连配置，完成后再切回。
- 端口被占用：在 `proxy-local.env` 中修改 `PORT`，并同步修改 Codex 配置 `base_url` 的端口。
- OpenCode 返回 403 区域限制：确认 `proxy-local.env` 已配置 `PROXY_URL` 且本机代理正在运行。
- 模型列表不对：确认 `model_catalog_json` 指向本机克隆目录的 `models_unified.json`，并重启 Codex App Server。
- GPT 模型返回 401：确认 Codex 已完成 ChatGPT 登录，且 `requires_openai_auth = true`。

## 安全说明

- 真实 API 密钥只存放在 `proxy-secrets.env`，不会进入仓库、配置文件或日志；本机差异存于 `proxy-local.env`，同样不会提交。
- 服务默认只监听 `127.0.0.1`，请勿改为 `0.0.0.0`。
- 可选访问令牌通过 `X-Proxy-Access-Token` 校验，`/healthz` 始终不校验；仅当需要跨机器远程访问代理时才启用，并同步在 Codex 配置的 `http_headers` 填同一令牌。
