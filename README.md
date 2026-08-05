# CodexModelProxy 本地中转服务

本目录是一个零依赖的 Node.js 本地中转服务，让 Codex 通过一个地址同时使用两个上游模型：

| Codex slug | 显示名 | 上游 |
|---|---|---|
| `gpt-5.6-luna` | DeepSeek-V4-Flash | DeepSeek（`deepseek-v4-flash`） |
| `gpt-5.6-sol` | ds flash opencode | OpenCode（`deepseek-v4-flash`） |

服务只做路由转发，不转换协议（统一使用 Responses API），不记录提示词、响应正文和 API 密钥；未知模型直接返回错误，不会访问上游。

## 快速开始

1. 确保已安装 Node.js（本项目使用内置模块，无需安装任何依赖）。
2. 在 `proxy-secrets.env` 中填写两个上游密钥（`OPENCODE_API_KEY`、`DEEPSEEK_API_KEY`）。该文件已被 Git 忽略，不会提交。
3. 双击或运行 `start-proxy.cmd` 启动中转，窗口会保持打开并显示日志；按 Ctrl+C 或运行 `stop-proxy.cmd` 停止。
4. 验证服务：浏览器打开 `http://127.0.0.1:8787/healthz` 应返回 `{"status":"ok"}`。
5. 在 `C:\Users\noha\.codex` 下运行 `config_unified.cmd`，把 Codex 全局配置切换到本中转。
6. 重新加载 Codex 扩展的配置与模型目录，模型列表将只显示 Luna 和 Terra。

## 命令速查

```text
start-proxy.cmd       启动中转（前台窗口，日志可见）
stop-proxy.cmd        停止中转（按 pid，回退按端口 8787）
config_unified.cmd    把全局配置切换到统一中转（位于 .codex 目录）
config_deepseek.cmd   回退到 DeepSeek 直连（保留）
config_opencode.cmd   回退到 OpenCode 直连（保留）
```

CLI 单独指定模型（不改全局配置）：

```text
codex exec -m gpt-5.6-luna "提示词"
codex exec -m gpt-5.6-sol "提示词"
```

## 文件说明

| 文件 | 作用 |
|---|---|
| `server.mjs` | 中转服务主程序，零依赖 |
| `proxy-config.json` | 监听地址、端口与模型路由 |
| `proxy-secrets.env` | 上游密钥，不提交到 Git |
| `models_unified.json` | Codex 统一模型目录，由全局配置用绝对路径引用 |
| `test/proxy.test.mjs` | 自动测试（使用内存 mock 上游，不消耗真实额度） |

## 代理设置

`proxy-config.json` 中的 `proxy` 字段指定上游请求要走的本地代理（默认 `http://127.0.0.1:7890`，与本机 FlClash 系统代理一致）。OpenCode 会对直连出口做区域限制（返回 403“This model is not available in your region.”），必须走本地代理才能正常使用；DeepSeek 走不走代理均可。若你的代理端口不同，修改该字段即可；不需要代理时删除该字段。

## 测试

```text
node --test test\proxy.test.mjs
```

测试覆盖健康检查、模型列表、双模型路由、未知模型拦截和 SSE 流式透传。

## 故障排查

- 启动失败提示缺少密钥：检查 `proxy-secrets.env` 中的变量名和值。
- 端口被占用：停止占用 8787 的进程，或修改 `proxy-config.json` 中的 `port`，并同步修改 `.codex\config_unified.toml` 中的 `base_url`。
- Codex 报连接错误：确认中转已启动（`/healthz` 可访问）；中转重启后无需重启扩展即可继续发送新请求。
- 模型列表不对：确认 `.codex\config_unified.toml` 的 `model_catalog_json` 指向本目录的 `models_unified.json`，并重新加载扩展配置。

## 安全说明

- 真实 API 密钥只存放在 `proxy-secrets.env`，不进入 `models_unified.json`、配置文件和日志。
- 服务只监听 `127.0.0.1`，请勿改成对外网卡地址。
- 切换回退请运行 `.codex` 下原有的 `config_deepseek.cmd` 或 `config_opencode.cmd`。
