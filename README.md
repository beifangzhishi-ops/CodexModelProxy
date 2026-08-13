# CodexModelProxy 通用中转服务（Windows）

本目录是一个零依赖的 Node.js 本地中转服务，让 Codex 通过一个本地地址同时使用多个上游模型（OpenCode、DeepSeek 等），统一使用 Responses 协议，不转换协议。

项目只面向 Windows 本机使用，适配多台机器通过 Git 仓库同步更新：通用配置提交到仓库，密钥与本机差异（代理地址、端口等）放在各自机器上、不提交。

## 为什么用别名

Codex 的模型下拉列表只展示 GPT 系列模型，第三方模型（如 DeepSeek）无法直接出现在下拉列表。因此代理把第三方模型注册为 `gpt-5.6-*` 形状的别名 slug（如 `gpt-5.6-terra`、`gpt-5.6-sol`），同时在模型目录里把 `display_name` 设为原名或用户自定义名。下拉列表按 `display_name` 展示，所以能看到 `DeepSeek-V4-Pro`、`DSV4-Flash-Opencode` 等真实名称；请求体中的 `model` 字段仍使用别名 slug，代理转发时再替换成真实上游模型名。

| slug（请求/下拉选择用） | 显示名（下拉列表可见） | 上游 |
|---|---|---|
| `gpt-5.6-luna` | GPT-5.6 Luna | OpenCode `gpt-5.6-luna` |
| `gpt-5.6-terra` | DeepSeek-V4-Pro | DeepSeek `deepseek-v4-pro`（Responses API） |
| `gpt-5.6-sol` | DSV4-Flash-Opencode | OpenCode `deepseek-v4-flash` |

服务只做路由转发；不记录提示词、响应正文和 API 密钥；未知模型直接返回错误，不会访问上游。

## 图片上传

`models_unified.json` 中三个别名均声明 `input_modalities: ["text", "image"]` 与 `supports_image_detail_original: true`，因此桌面端允许上传图片；能否真正识别图片取决于上游模型是否支持图片输入。若某个上游不接受图片，请把对应别名的 `input_modalities` 改回 `["text"]`。

## 快速开始（每台机器各执行一次）

1. 安装 Node.js（本项目只用内置模块，无需安装任何依赖）。
2. 把仓库克隆到本机任意目录。
3. 复制 `proxy-secrets.env.example` 为 `proxy-secrets.env`，填写 `OPENCODE_API_KEY` 与 `DEEPSEEK_API_KEY`。该文件已被 Git 忽略，不会提交，两台机器各自填各自的密钥。
4. 若上游需要走代理（OpenCode 有区域限制，一般需要本机代理），复制 `proxy-local.env.example` 为 `proxy-local.env`，按本机代理端口修改 `PROXY_URL`；不需要代理时把值留空。
5. 双击或运行 `start-proxy.cmd` 启动中转。浏览器打开 `http://127.0.0.1:8787/healthz`，应返回 `{"status":"ok"}`。
6. 按下方“Codex 配置字段教程”修改本机 Codex 全局配置。
7. 重新加载 Codex 配置与模型目录。

以后更新：`git pull` 后先运行 `stop-proxy.cmd`，再运行 `start-proxy.cmd`。

> 注意：代理本身就是 Codex 正在使用的通信通道。如果当前 Codex 正通过本中转（`base_url` 指向本代理），运行 `stop-proxy.cmd` 会让正在进行的会话立即断连。停止或重启代理前，请先切换到直连配置（例如 Codex 全局配置目录中的 OpenCode 直连或 DeepSeek 直连），操作完成后再切回统一中转。

## Codex 配置字段教程

在 Codex 全局配置目录（通常是 `%USERPROFILE%\.codex`）的 `config.toml` 中配置以下字段（以统一中转配置为例）：

```toml
model_provider = "OpenAI"
model = "gpt-5.6-luna"
model_reasoning_effort = "high"
preferred_auth_method = "apikey"
forced_login_method = "api"
model_catalog_json = "C:/你的克隆目录/CodexModelProxy/models_unified.json"

[model_providers.OpenAI]
name = "unified"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
experimental_bearer_token = "local-codex-proxy"
```

顶层字段：

- `model_provider = "OpenAI"`：固定使用 OpenAI 兼容提供方。
- `model`：默认模型 slug，可选 `gpt-5.6-luna` / `gpt-5.6-terra` / `gpt-5.6-sol`。
- `model_reasoning_effort`：推理强度，按模型支持范围填 `low` / `medium` / `high` / `xhigh` / `max`。
- `preferred_auth_method = "apikey"`：固定。
- `forced_login_method = "api"`：固定。
- `model_catalog_json`：必须指向本机克隆目录下 `models_unified.json` 的绝对路径。

`[model_providers.OpenAI]` 区段：

- `name`：任意，如 `unified`。
- `base_url`：`http://127.0.0.1:8787/v1`；若通过 `proxy-local.env` 修改了 `PORT`，这里要同步修改端口。
- `wire_api = "responses"`：固定。
- `experimental_bearer_token`：可选访问令牌。只有启用代理端 `PROXY_ACCESS_TOKEN`（见“安全说明”）时才需要与此处保持一致；未启用时该项不影响正常使用。

切换不同配置的脚本属于个人 Codex 目录，不在本仓库范围内，这里只说明需要配置哪些字段。

## 命令速查

```text
start-proxy.cmd       启动中转（后台运行，日志写入 proxy.log / proxy.err.log）
stop-proxy.cmd        停止中转（按 pid，回退按端口）
```

CLI 单独指定模型（不改全局配置）：

```text
codex exec -m gpt-5.6-luna "提示词"
codex exec -m gpt-5.6-terra "提示词"
codex exec -m gpt-5.6-sol "提示词"
```

## 文件说明

| 文件 | 作用 |
|---|---|
| `server.mjs` | 中转服务主程序，零依赖 |
| `proxy-config.json` | 通用配置：监听地址、端口与模型路由（提交到仓库） |
| `proxy-secrets.env.example` | 密钥模板；复制为 `proxy-secrets.env` 填写，后者不提交 |
| `proxy-local.env.example` | 本机差异模板；复制为 `proxy-local.env` 填写，后者不提交 |
| `models_unified.json` | Codex 统一模型目录 |
| `test/proxy.test.mjs` | 自动测试（内存 mock 上游，不消耗真实额度） |

## 代理设置

上游请求可走 HTTP 代理。OpenCode 会对直连出口做区域限制（返回 403 "This model is not available in your region."），一般需要走本机代理（例如 FlClash 默认端口 7890）。在 `proxy-local.env` 中设置：

```text
PROXY_URL=http://127.0.0.1:7890
```

不需要代理时把值留空或删除该行。服务端也支持直接用进程环境变量 `PROXY_URL` / `HOST` / `PORT` 覆盖。

## 测试

```text
node --test test\proxy.test.mjs
```

测试覆盖健康检查、模型列表、双模型路由、未知模型拦截、SSE 流式透传、访问令牌校验与密钥解析。

## 故障排查

- 启动失败提示缺少密钥：检查 `proxy-secrets.env` 中的变量名和值。
- 停止代理后 Codex 立即断连：这是预期行为，代理就是 Codex 的通道；更新代码或重启代理前，先切换到直连配置，完成后再切回。
- 端口被占用：在 `proxy-local.env` 中修改 `PORT`，并同步修改 Codex 配置 `base_url` 的端口。
- OpenCode 返回 403 区域限制：确认 `proxy-local.env` 已配置 `PROXY_URL` 且本机代理正在运行。
- 模型列表不对：确认 `model_catalog_json` 指向本机克隆目录的 `models_unified.json`，并重新加载 Codex 配置。

## 安全说明

- 真实 API 密钥只存放在 `proxy-secrets.env`，不会进入仓库、配置文件或日志；本机差异存于 `proxy-local.env`，同样不会提交。
- 服务默认只监听 `127.0.0.1`，请勿改为 `0.0.0.0`。
- 可选访问令牌：设置环境变量 `PROXY_ACCESS_TOKEN`（可写在 `proxy-local.env`）后，`/v1/responses` 与 `/v1/models` 必须携带 `Authorization: Bearer <令牌>`，`/healthz` 始终不校验；未设置时维持不校验。仅当需要跨机器远程访问代理时才启用，并同步在 Codex 配置的 `experimental_bearer_token` 填同一令牌。
