# CodexModelProxy (CMP)

一个面向 Codex 的本地多 Provider **Responses API** 代理。保留 ChatGPT 登录透传，并将 DeepSeek、Kimi、OpenCode、Z.AI 和可选 CPA 的请求分别路由到各自上游。

CMP 仅转发 Responses 请求、整理已知的历史字段格式，不提供 Chat Completions → Responses 的协议转换。**模型出现在目录中不意味着已通过真实多轮工具调用测试**。

## 当前工作方式

| Provider | 命名空间 | 上游地址 | 认证 | 模型目录 |
| --- | --- | --- | --- | --- |
| ChatGPT | `gpt-*`（透传原始模型 ID） | `https://chatgpt.com/backend-api/codex` | 透传当前 Codex 登录凭据 | 固定可选项始终保留；带凭据时实时补充官方目录，不缓存登录态 |
| DeepSeek | `ds/` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | 上游 `/models`、60 秒缓存 |
| Kimi | `kimi/` | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` | 上游 `/models`、60 秒缓存；默认关闭 |
| OpenCode | `oc/` | `https://opencode.ai/zen/go/v1` | `OPENCODE_API_KEY` | 上游 `/models`、60 秒缓存 |
| Z.AI | `zai/` | `https://api.z.ai/api/v1` | `ZAI_API_KEY` | 上游 `/models`、60 秒缓存 |
| CPA | `cpa/` | 本机 `providers.local.json` 指定 | 独立 API Key | 上游 `/models`、60 秒缓存 |

* ChatGPT 透传模型由 `proxy-config.json` 中 `providers.chatgpt.models` 的固定可选项保底（当前八个 GPT 型号）；第三方模型不固定版本号。上游的 `display_name`、`context_window` 等元数据按原样映射，缺失字段仅为 Codex 目录格式补全，不代表真实能力已经验证。
* 第三方模型目录成功结果在内存中保留 60 秒。超时、429、5xx 等临时故障沿用最近成功的模型目录，失败后 30 秒内不重复尝试，且不删除精选行。上游 `/models` 返回 401/402/403 时清除该 Provider 的旧缓存，并从 `models.txt` 删除该 Provider 的模型和星标；完整模型目录成功刷新却不再包含的型号，也从精选文件删除。恢复后重新发现的型号作为未选中条目追加。Codex App Server 另有模型目录缓存，菜单更新可能延迟。
* GPT 固定项在目录请求没有登录信息时仍保留；当请求携带 ChatGPT OAuth Bearer、账号标识（如有）和 `client_version` 时，还会实时补充官方模型和元数据，不缓存登录态，也不会把凭据传给第三方。裸 `gpt-*` 请求的模型 ID 和登录凭据会透传至 ChatGPT 官方后端。
* Kimi 使用开放平台 **按量 API**，不是 Kimi Code 会员接口；未配置密钥时不展示 Kimi 模型，也不阻止 CMP 其他路由启动。
* 第三方 Provider 使用真实 API 模型 ID，在 Codex 显示 `provider/model`；ChatGPT 透传模型沿用原始 `gpt-*` ID，不添加命名空间前缀。精选列表不能限制 GPT 请求路由。

## 配置与启动

1. `proxy-config.json` 是可提交的 Provider 行为配置和统一路由规则。
2. `providers.local.json`（参考 `providers.local.json.example`）用于本机覆盖 Provider URL、启用开关、CPA 地址及 Key 等配置，已被 Git 忽略。启用 Kimi 时在这里将 `kimi.enabled` 改为 `true`。
3. 密钥可通过进程环境变量或 `proxy-secrets.env` 提供，所有真实 Key 只保存在本机，不提交到仓库。配置 Kimi 使用 `MOONSHOT_API_KEY`。
4. `proxy-local.env` 管理本地监听、系统代理、访问令牌等选项。客户端访问本地服务地址 `http://127.0.0.1:8787/v1`。
5. 运行 `start-proxy.cmd` 启动服务；`GET /healthz` 检查服务，`GET /v1/models` 查询动态目录。请求 Responses 时使用 `POST /v1/responses`，压缩使用 `POST /v1/responses/compact`。

### Codex 接入

Codex 只保留两种配置：**官方直连**和 **CMP**。安装脚本 `codex-switch/install.py` 在每台电脑本地生成 `.codex/config_official.toml`、`.codex/config_cmp.toml` 和两个可双击的 CMD。两种配置复用一个经过验证的 `switch_config.ps1`，不会编辑登录凭据、MCP 或插件；旧切换脚本归档至 `.codex/backup-switch`。

**官方直连与 CMP 完全独立。** 即使 CMP 没启动、模型同步失败或者代理出现 500/502，双击 `官方直连.cmd` 也无需连接 CMP 就能把 Codex 配置恢复到 OpenAI 官方后端。切换脚本只改本地 Codex 配置，绝不自动重启 CMP 或关闭 Codex。

### 精选模型文件

CMP 在项目根目录生成每台机器自己的第三方模型精选文件 `models.txt`（已忽略 Git，代码更新不会覆盖）。首次发现模型后生成文件，新发现的第三方模型默认追加为未选中；用户的其他注释和星标保留。已经由上游 401/402/403 或完整目录成功刷新确认失效的模型会自动删除对应行，恢复后重新作为未选中候选加入。GPT 透传模型始终单独列出，不进入精选文件。

```text
# 仅第三方模型：在完整模型 ID 前加 *，显示在 Codex 下拉列表
* ds/deepseek-flash
* kimi/kimi-k2.7-code
  kimi/kimi-k2.7-code-highspeed
```

- 第三方模型行首加 `* ` 表示显示，去掉表示隐藏。GPT 透传模型不受星标控制，始终作为独立的可选模型显示。
- CMP 自动发现第三方模型并允许按完整 ID 路由；**从下拉框隐藏不等于禁止请求**。第三方模型需要实时发现成功才会加入精选候选；GPT 固定项无需依赖目录发现，账号权限仍由官方后端决定。
- 默认只精选一个普通 DeepSeek Flash 和一个普通 Kimi Coding 模型，不会自动选中高速计费版本。后续新增的模型自动追加为未选中。
- 已确认失效的第三方模型直接从 `models.txt` 移除（连同旧星标），而不是仅从菜单隐藏；其后恢复时会作为未选中项重新追加。超时、429、5xx 等临时错误不删除精选项；其他有效的手工星标保持不变。若当前没有精选模型在线，会临时展示一个已发现的第三方模型。固定 GPT 透传项不受此逻辑影响。
- 修改 `models.txt` 后，Codex 可能需要重新加载模型列表或重新打开桌面端。CMP 目录无须重启，新请求就会重新读取文件。

安装后在 **CMP 项目根目录** 提供 **Codex-官方直连**、**Codex-CMP模式** 两个快捷方式，以及用记事本打开这份 `models.txt` 的 **CMP-模型精选** 快捷方式。桌面不创建快捷方式；快捷方式只负责打开文件/脚本，不另外生成模型配置。这三个本机生成的 `.lnk` 文件不提交 Git。

### Tidying the .codex top-level directory

Run `codex-switch/tidy_root.py` to **preview** retired files directly under the current user's `.codex` directory. Add `--apply` only when ready to make changes.

- Move obsolete model-list JSON, old switcher backups, superseded configuration snapshots, and retired document copies into `backup-switch/root-archive-YYYYMMDD/`, without discarding recovery material.
- Delete only abandoned `..codex-global-state.json*.tmp-*` files older than seven days.
- Never recursively clean `.tmp/`, `cache/`, `plugins/`, `sessions/`, `archived_sessions/` or other folders just to save space.
- Preserve active `config.toml`, both official/CMP profiles and CMD switchers, `auth.json`, `models_cache.json`, `hooks.json`, hook scripts, SQLite files, and current state.
- Both operations are independent of the running CMP service and do not restart Codex.

Codex may need to be reopened after configuration changes; CMP must not be automatically restarted.

## 兼容策略与限制

* GPT 目标请求会处理外部 reasoning 引用、非法 item ID 和不兼容的搜索历史；DeepSeek/OpenCode 路由对部分 reasoning 和工具输出做格式整理。
* 历史整理只作用于本次请求，不修改 Codex 本地会话。真实跨厂商长会话切换尚不能保证无错；建议备用模型在相同项目的新会话中接力。
* Kimi、Z.AI 按 Responses 原生形态透传，不擅自转换工具协议。上游若不支持某请求字段或 `/responses/compact`，直接返回上游错误而不是静默改用其他模型。
* `/models` 不等价于 `/responses` 兼容性证明。CMP 过滤上游明确声明不支持 Responses 的模型；其他模型仍须通过实际工具调用验证。
* 代理访问令牌是**本地访问控制**，不是 CMP 账号。ChatGPT 登录凭据不得写入缓存、日志或第三方 API 请求。

## 模块

### Codex 原生非 Responses 接口

CMP 的对话协议仍为原生 Responses API，不提供 Chat Completions 转换。Codex 内置功能还会以同一个 `base_url` 请求其他接口；CMP 对以下已核对的 ChatGPT 原生接口实行**固定路径白名单、登录凭据透传、请求体/响应体原样传输**，不进行模型路由或 JSON 协议转换：

| 请求 | 功能 |
| --- | --- |
| `POST /v1/images/generations` | 内置 ImgGen 生图 |
| `POST /v1/images/edits` | 内置 ImgGen 修图 |
| `POST /v1/alpha/search` | Codex 独立搜索 |
| `POST /v1/memories/trace_summarize` | Codex 记忆摘要 |
| `POST /v1/realtime/calls` | Codex Realtime 通话创建 |

这些接口仅转发给启用中的 `chatgpt` 登录透传 Provider；保留原始 Content-Type、OAuth 与账号头，不把本地访问令牌传给上游，也不向第三方 Provider 分流。模型 `gpt-reserve`（Luna Reserve）属于原有 `gpt-*` 官方透传路由；`codex-auto-review` 属于 Codex 官方审查专用 ID，也直接透传 ChatGPT 后端。不要求这两个 ID 出现在精选文件。原生 WebSocket Upgrade **尚未实现**，不能把 HTTP Responses 转发视作 WebSocket 兼容保证。

所有新增接口的测试使用本机 mock HTTP 服务，不请求真实图像生成 API，也不消耗生成额度。

### 模块文件

| 文件 | 职责 |
| --- | --- |
| `server.mjs` | HTTP 服务、请求授权、Responses 转发 |
| `provider-registry.mjs` | Provider 设置、认证隔离、路由登记 |
| `model-discovery.mjs` | 实时/缓存模型发现与元数据转换 |
| `model-catalog.mjs`、`model-metadata.mjs` | Codex 模型目录组织与能力字段 |
| `model-resolver.mjs` | 模型命名空间解析、路由参数 |
| `model-selection.mjs`、`models.txt` | 根据真实发现结果追加模型名，并管理 Codex 下拉列表精选 |
| `codex-switch/` | 官方直连 / CMP 双模式 CMD 安装和回归测试 |
| `history-normalize.mjs`、`history-monitor.mjs` | 兼容字段整理、脱敏诊断 |
| `compact-forward.mjs`、`muse-tool-compat.mjs` | 压缩请求与 Muse 工具协议适配 |
| `test/` | 模拟上游的回归测试，不消耗真实模型额度 |

## 测试与维护

Node.js 24 可运行：在仓库根目录使用 `node --test --test-isolation=none test/*.test.mjs`。Windows 受限沙箱中将 `TEMP` 和 `TMP` 指向仓库内可写位置。更改模型目录和转发逻辑时应同时增加模拟上游测试。

提交和同步使用 `origin/master`，两台电脑应通过 Git 快进至同一提交。以项目 `AGENTS.md` 为工作规则。

## 自动发现的上下文元数据

- CMP 的 `/v1/models` 优先透传上游 `context_window`、`max_context_window`、`auto_compact_token_limit` 及其他 Codex 原生能力字段；同时支持发现响应的嵌套 `metadata`、`model_metadata` 和通用的 `context_length`。
- 不把 `max_input_tokens` 或输出 token 上限当作模型的总上下文窗口；没有可信窗口数据时，不再把所有模型写死成 128k，相关字段保持缺省。
- `max_context_window` 指允许配置覆盖的最大值，不等于 `context_window`。缺失时不会凭空赋值，非法或互相冲突的数值会被过滤。
- 不带 ChatGPT 登录凭据时，仍返回配置的 GPT 固定模型，但无法从官方获得实时容量信息；带有效 OAuth/账号标识时尝试官方 `/models`，失败仅安全记录 HTTP 状态码或网络代码。
- Codex App Server 与运行中会话有独立模型目录和上下文缓存。修改代码后须由用户安排 CMP 重新加载，并在 Codex 新会话验证；本项目不会自动重启服务。
