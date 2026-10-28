# Antigravity 与 Claude Code 接入

## 终端任务

Elysia v1.23.0 在 Agent 终端中加入 Antigravity CLI，并补齐 Claude Code 的命令和输出处理。两者使用独立 Docker 任务目录，沿用现有的权限、超时、停止核验和人工验收流程。

| 应用 | 命令 | 默认安装版本 | 连接协议 | 凭据环境变量 |
| --- | --- | --- | --- | --- |
| Antigravity CLI | `agy` | 1.4.7 | Gemini API | `GEMINI_API_KEY` |
| Claude Code | `claude` | 2.1.296 | Anthropic Messages | `ANTHROPIC_API_KEY` |

1. 启动 Docker Desktop 的 Linux 引擎，打开“Agent 终端 → 终端管理 → 应用”。
2. 显示所需应用，点击“安装”，完成后应用已安装镜像。Antigravity 从官方固定版本下载适合容器架构的发布包，核对 SHA-256，再检测实际 CLI 版本。版本不一致时不能应用镜像。
3. 在“API 连接”中填写相应协议、端点、模型 ID 和凭据，再绑定到应用或项目。也可仅使用模板列出的服务进程环境变量。
4. 新建项目任务，选择该应用及连接。执行结束后查看公开输出和文件差异，再确认交付。

Antigravity 的 API Key 模式需要在任务私有 HOME 中设置 `modelProvider: gemini`；Elysia 会自动生成这个无密钥配置。自定义兼容端点通过 `GOOGLE_GEMINI_BASE_URL` 注入，任务只使用创建时冻结的模型和连接。此配置依据 [Antigravity 认证说明](https://antigravity.google/docs/install/)。

Antigravity 使用 JSONL 标准输入和结构化输出。界面只展示公开回复和简短工具活动，错误结果不能作为成功交付；不会保存思考正文和工具原始输出。协议依据 [官方非交互模式](https://antigravity.google/docs/cli/headless/)。固定发布包与摘要见 [1.4.7 发布资产](https://github.com/google-antigravity/antigravity-cli/releases/expanded_assets/1.4.7)。

Claude 使用 `-p` 和 `stream-json` 输出。运行时、模板编辑器和应用目录使用同一默认命令。最终结果与上一条回复相同时只展示一次；不同的最终结果仍会保留。已有任务继续使用各自的冻结配置。

原会话续接、计划模式和费用统计保持原有能力边界。Antigravity 与 Claude 暂不支持经 Elysia 核验的原会话续接；内部用量仍显示未知。这里接入的是 CLI 的 API Key 模式，不复用宿主 Google 或 Claude 订阅登录，也不自动控制 IDE 窗口。

## 本机能力导入

打开“工具与偏好 → 本机能力 → 同步本机 Agent”，选择 Antigravity 或 Claude Code。可使用默认全局目录，也可填写项目根目录；扫描后选择需要导入的条目。

| 来源 | 可识别的资料 |
| --- | --- |
| Antigravity 全局目录 | `~/.gemini/GEMINI.md`、`AGENTS.md`；`~/.gemini/config/` 中的技能、规则和 `mcp_config.json`；`antigravity-cli/skills/` 与旧 `antigravity/skills/` |
| Antigravity 项目目录 | `.agents/skills/`、兼容的 `.agent/skills/`、规则目录、`GEMINI.md`、`AGENTS.md` 和 `.agents/mcp_config.json` |
| Claude 全局目录 | `~/.claude/` 中的技能、规则、记忆与公开对话正文；扫描用户目录时可读取 `.claude.json` 的 MCP 配置 |
| Claude 项目目录 | `.claude/skills/`、`.claude/rules/`、`CLAUDE.md`、`CLAUDE.local.md`、`AGENTS.md`、`.mcp.json` 和 `.claude/settings.json` 中的 MCP 描述 |

规则正文作为记忆资料保存，保留来源与原有 frontmatter。Elysia 不会自动复现原工具的路径匹配、手动触发或规则优先级；选择项目能力时应核对适用范围。技能目录包含 `SKILL.md` 和允许读取的参考文件，仍按需加载。

MCP 导入后默认关闭。配置只保留安全连接字段及凭据的环境变量名称；明文密钥、认证 URL 或不支持的配置会标为需要补充。扫描不会运行 MCP 命令，不读取登录凭据，不修改来源文件。链接、目录范围、读取容量和取消检查继续生效。

目录约定参考 [Antigravity Skills](https://antigravity.google/docs/skills/)、[Rules](https://antigravity.google/docs/rules/)、[MCP](https://antigravity.google/docs/mcp/) 和 [Claude 记忆与规则](https://code.claude.com/docs/en/memory)。

## 升级与验证范围

旧五应用配置在读取时补充隐藏的 Antigravity 入口，保留原默认应用、连接及修订。用户启用后才保存新配置和模板。升级不启动任务，也不修改已有任务的冻结信息；旧版本不能读取新增的 Antigravity 任务类型，回退应使用升级前的数据备份。

本轮完成隔离数据下的配置兼容、安装校验、任务执行协议、失败与取消、导入和界面验证。验证没有调用真实模型。本机 Docker Linux 引擎未运行，固定镜像构建及真实供应商执行尚待实机验收，界面继续标为“有条件支持”。启动引擎、配置有效凭据并完成一次实际任务后，才能补充这部分验收结论。
