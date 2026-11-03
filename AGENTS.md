# CodexModelProxy 项目规则

## 工作边界
- **禁止 Agent 自行启动、停止或重启运行中的 CMP**，避免当前 Codex 会话断线。只允许静态检查和模拟上游的本地测试，真实部署由用户安排。
- CMP 只支持 Responses API；不得通过 Chat Completions 协议转换冒充 Responses 兼容性。
- GPT 登录凭据只能转发至 ChatGPT 官方后端；其他 Provider 必须使用各自独立 API Key，不得记录或泄露任何真实认证信息。
- GPT 透传固定可选模型来自 `proxy-config.json` 的 `providers.chatgpt.models`，始终独立于 `models.txt`；如有当前请求的登录凭据，则实时补充官方目录，不建立 CMP 端账号缓存。裸 `gpt-*` 请求必须保留原始模型 ID 和 ChatGPT 凭据，仅转发到官方后端。其他 Provider 使用短时缓存。
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
- `models.txt` 是每台电脑本地的第三方模型精选文件，可以人工编辑，不得提交 Git、不得在升级时覆盖星标；隐藏的第三方模型仍可按完整 ID 路由。GPT 固定透传模型始终可选、不加入星标精选，也不能因精选缺失而被拒绝。
- 官方直连 CMD 必须完全独立于 CMP 服务和目录，不能加入请求 CMP 的预检逻辑；切换脚本不得主动重启 CMP 或 Codex。
- 只维护 `codex-switch/` 下的一套切换程序，两台电脑生成相同的官方/CMP 双配置，归档多余旧模板后不可恢复旧活动入口。
- Keep the .codex top-level tidy with codex-switch/tidy_root.py after preview. Archive old root-level configurations and model lists, delete only orphaned state-temp files older than 7 days, never prune current caches, sessions, authentication, or databases.
