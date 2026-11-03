# CodexModelProxy (CMP)

一个面向 Codex 的本地多 Provider **Responses API** 代理。保留 ChatGPT 登录透传，并将 DeepSeek、Kimi、OpenCode、Z.AI 和可选 CPA 的请求分别路由到各自上游。

CMP 仅转发 Responses 请求、整理已知的历史字段格式，不提供 Chat Completions → Responses 的协议转换。**模型出现在目录中不意味着已通过真实多轮工具调用测试**。

## 当前工作方式

| Provider | 命名空间 | 上游地址 | 认证 | 模型目录 |
| --- | --- | --- | --- | --- |
| ChatGPT | `chatgpt/` | `https://chatgpt.com/backend-api/codex` | 透传当前 Codex 登录凭据 | 每次目录请求实时读取，无 CMP 缓存 |
| DeepSeek | `ds/` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | 上游 `/models`、60 秒缓存 |
| Kimi | `kimi/` | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` | 上游 `/models`、60 秒缓存；默认关闭 |
| OpenCode | `oc/` | `https://opencode.ai/zen/go/v1` | `OPENCODE_API_KEY` | 上游 `/models`、60 秒缓存 |
| Z.AI | `zai/` | `https://api.z.ai/api/v1` | `ZAI_API_KEY` | 上游 `/models`、60 秒缓存 |
| CPA | `cpa/` | 本机 `providers.local.json` 指定 | 独立 API Key | 上游 `/models`、60 秒缓存 |

* 无须维护固定的模型版本表。上游若返回 `display_name`、`context_window`、`input_modalities`、推理档位等信息，CMP 尽量保留并映射到 Codex 模型元数据；未提供的字段按 Codex 必需的最低格式补全，不暗示真实能力已验证。
* 第三方目录成功结果在内存中保留 60 秒；失败时沿用最近成功结果，30 秒内不重复尝试。Codex App Server 自己另有模型目录缓存，刷新到模型选择器存在延迟。
* GPT 目录查询携带当前请求的 ChatGPT OAuth Bearer、账号标识（如有）及 `client_version`，不会缓存登录态，也不会把 ChatGPT 凭据传给第三方。
* Kimi 使用开放平台 **按量 API**，不是 Kimi Code 会员接口；未配置密钥时不展示 Kimi 模型，也不阻止 CMP 其他路由启动。
* 每种 Provider 使用自己的真实 API 模型 ID，选择模型时在 Codex 显示 `provider/model`；旧版本号、旧代理别名不再是配置目录的一部分。

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

CMP 在项目根目录生成唯一的可编辑文件 `models.txt`（已忽略 Git，不随代码更新覆盖）。首次请求 `GET /v1/models` 并发现模型后生成文件，之后每次获取目录都会补充上游新增的模型 ID；对已经存在的行不做重写，不删除你写的注释和星标。

```text
# 在完整模型 ID 前加 *，显示在 Codex 下拉列表
* ds/deepseek-flash
* kimi/kimi-k2.7-code
  kimi/kimi-k2.7-code-highspeed
```

- 在行首添加 `* ` 表示显示，去掉表示隐藏；文件中的名称可以直接选中复制，不必重新输入模型 ID。
- CMP 仍然自动发现全部模型并允许按完整 ID 调用，**不在下拉框显示≠禁止请求**。只有实时发现成功的模型才会在下拉框显示。
- 默认只精选一个普通 DeepSeek Flash 和一个普通 Kimi Coding 模型，不会自动选中高速计费版本。后续新增的模型自动追加为未选中。
- 你手工编辑的行不会被刷新覆盖；如果当前所有精选模型都暂时不可用，为避免模型菜单空白，临时展示一个已发现的模型，原星标不变。
- 修改 `models.txt` 后，Codex 可能需要重新加载模型列表或重新打开桌面端。CMP 目录无须重启，新请求就会重新读取文件。

安装后桌面提供 **Codex-官方直连**、**Codex-CMP模式** 两个快捷方式，以及用记事本打开这份 `models.txt` 的 **CMP-模型精选** 快捷方式；快捷方式只负责打开文件/脚本，不另外生成模型配置。

### `.codex` 安全清理

`codex-switch/cleanup_codex.py` 是两台 Windows 电脑通用的手动清理程序，**默认只预览**；只有明确添加 `--apply` 才会删除文件，而且实际删除只允许当前用户的 `.codex`。

清理白名单：30 天以上的 `.tmp/plugins` 旧下载副本、`plugins-clone-*`、`bundled-marketplaces/*.staging-*` 旧安装暂存、旧 `.sandbox` 日志、弃用的静态模型目录文件，7 天以上的落单 `..codex-global-state.json.tmp-*`；另外清理旧版 CMD 配置归档、超量的配置快照（**保留最近两份**）。

**不会清理**现有 `config.toml`、官方/CMP 双模式文件、`auth.json`、`models_cache.json`、`.codex-global-state.json` 及其常规备份、`sessions/`、`archived_sessions/`、SQLite 及 WAL、`plugins/`、`skills/`、`packages/`、`cache/`、`generated_images/`。有运行中插件和市场缓存的目录不会整目录删除。

清理程序只能清理显式白名单中的路径，并检查软链接/目录归属；不能用它清理其他系统目录。运行前请先审查预览结果。该程序不会结束 Codex、CMP 或相关插件进程。

切换 Provider 或首次启用远端模型目录后，Codex App Server 可能需要完全重启，模型目录也会缓存一段时间。**维护代理时不得由 Agent 自行重启运行中的 CMP**；否则可能中断当前任务。

## 兼容策略与限制

* GPT 目标请求会处理外部 reasoning 引用、非法 item ID 和不兼容的搜索历史；DeepSeek/OpenCode 路由对部分 reasoning 和工具输出做格式整理。
* 历史整理只作用于本次请求，不修改 Codex 本地会话。真实跨厂商长会话切换尚不能保证无错；建议备用模型在相同项目的新会话中接力。
* Kimi、Z.AI 按 Responses 原生形态透传，不擅自转换工具协议。上游若不支持某请求字段或 `/responses/compact`，直接返回上游错误而不是静默改用其他模型。
* `/models` 不等价于 `/responses` 兼容性证明。CMP 过滤上游明确声明不支持 Responses 的模型；其他模型仍须通过实际工具调用验证。
* 代理访问令牌是**本地访问控制**，不是 CMP 账号。ChatGPT 登录凭据不得写入缓存、日志或第三方 API 请求。

## 模块

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
