# CodexModelProxy 项目规则

## 工作边界

- 对话请求只支持 Responses API，不做 Chat Completions 协议转换。Codex 内置的 ImgGen、独立搜索、记忆摘要和 Realtime 创建请求可通过固定的原生 POST 白名单直通 ChatGPT 登录后端；绝不建立任意路径转发、向第三方泄露 ChatGPT OAuth，或把 HTTP 透传宣称成 WebSocket 兼容。
- `gpt-reserve` 按 `gpt-*` 原始模型 ID 透传；`codex-auto-review` 为 Codex 专有审查模型 ID，保持原始 ID 和 ChatGPT 凭据。不加入精选文件、也不把它们改写成普通聊天模型。
- **禁止 Agent 自行启动、停止或重启运行中的 CMP**，避免当前 Codex 会话断线。只允许静态检查和模拟上游的本地测试，真实部署由用户安排。
- CMP 只支持 Responses API；不得通过 Chat Completions 协议转换冒充 Responses 兼容性。
- GPT 登录凭据只能转发至 ChatGPT 官方后端；其他 Provider 必须使用各自独立 API Key，不得记录或泄露任何真实认证信息。
- GPT 透传固定可选模型来自 `proxy-config.json` 的 `providers.chatgpt.models`，始终独立于 `models.txt`；如有当前请求的登录凭据，则实时补充官方目录，不建立 CMP 端账号缓存。裸 `gpt-*` 请求必须保留原始模型 ID 和 ChatGPT 凭据，仅转发到官方后端。其他 Provider 使用短时缓存。
- 第三方 Provider 的 `/models` 返回 HTTP 401/402/403 时清空成功发现缓存，并在本次目录同步中从 `models.txt` 删除该 Provider 的旧模型行（含星标）；上游完整目录成功刷新但不再包含的型号也删除。恢复后重新发现的型号只作为未加星候选追加。超时、429、5xx 等临时失败保留最近成功目录及原精选条目。ChatGPT 固定透传不受第三方认证故障影响。
- 不在代码、测试、README、示例配置中保留已失效的固定模型名单、无用别名或旧迁移入口。若确需兼容旧客户端，先征得用户同意。
- 不为未知能力编造元数据；模型发现只证明出现在上游目录，不能代替 Responses 多轮工具测试。

## 代码与文档
- 进入项目先阅读 AGENTS.md 和 README.md；README 记录当前状态，AGENTS 记录规则。
- 优先使用 Provider Registry、Model Discovery 和 Model Catalog 现有模块；删除已废弃的平行实现，而非添加新兼容包装。
- 新增路由、认证和模型目录逻辑时，至少增加无计费的 mock HTTP 回归测试。
- 本地 `providers.local.json`、`proxy-secrets.env`、`proxy-local.env` 不进入 Git，也不得覆盖两台电脑各自的实际密钥。

## 更新与推送
- 先同步远端最新版本，再修改。
- 所有代码与文档更新统一提交并推送到 `origin/master`；不使用 `beta` 作为日常开发或部署分支。
- 修改后必须完整运行测试、检查 Git diff 和状态，推送后再让 6v/noha 都同步到同一个提交。
- 不得自行修改 Codex 的登录凭据、会话数据库或运行中缓存；`.codex` 清理由独立审查结论和必要授权控制。
- `models.txt` 仅管理本机第三方模型精选，禁止提交 Git。只保留未确认失效的候选：成功模型目录已移除的型号或 Provider 明确拒绝授权（401/402/403）的所有条目须从文件删除；临时故障和未验证状态不得删行。其他有效星标、注释原样保留，恢复型号重新追加为未选中。GPT 透传固定可选、不进入精选文件，误留的透传行需自动清理；请求路由不依赖精选星标。
- 官方直连 CMD 必须完全独立于 CMP 服务和目录，不能加入请求 CMP 的预检逻辑；切换脚本不得主动重启 CMP 或 Codex。
- 只维护 `codex-switch/` 下的一套切换程序，两台电脑生成相同的官方/CMP 双配置，归档多余旧模板后不可恢复旧活动入口。
- 官方直连、CMP 模式和模型精选三个快捷方式只放在 CMP 项目根目录，安装程序不得在桌面创建快捷方式；本机 `.lnk` 不提交 Git。
- Keep the .codex top-level tidy with codex-switch/tidy_root.py after preview. Archive old root-level configurations and model lists, delete only orphaned state-temp files older than 7 days, never prune current caches, sessions, authentication, or databases.
- 模型自动发现必须保留上游可验证的上下文长度和能力字段；任何未知窗口不得写死为统一假值。`context_window` 与 `max_context_window` 不能混用，其他 token 限额不得冒充总窗口。无登录凭据的 GPT 固定可选列表不是官方实时模型目录。
- 官方直连与 CMP 模式均使用内置小写 `openai` Provider。官方配置不得携带 `openai_base_url`；CMP 配置仅用顶层 `openai_base_url`，有本地访问令牌时使用经过校验的本地 URL 认证前缀，不能弱化原来的访问控制。切换器必须保持插件与 MCP 配置不变，并清理无效的 Provider 覆盖表；CMP 未实现 WebSocket 透传，必须明确回退 HTTP。
- CMP authentication URLs must follow the server-side token configuration, never an inherited Codex header; omit the auth segment when no token is configured.
