# Elysia

本机多 Agent 协作应用，用统一的项目与任务入口处理代码、资料和办公产物。原生入口接入 OpenAI Responses 与 DeepSeek Chat，Agent 终端入口管理 CLI 任务。

当前源码：**v1.23.43 本地版本**。更新内容集中在 [更新记录](CHANGELOG.md)，交付状态及未完成验收见 [项目状态与验收](docs/EXECUTION.md)。本地版本标签不代表已发布。

## 快速启动

源码运行需要 Node.js `>=24.15.0 <25` 和 pnpm 11。首次安装锁定依赖：

```powershell
pnpm install --frozen-lockfile
pnpm start
```

Windows 也可在安装依赖后双击 `Start-Elysia.vbs`；`Start-Elysia.cmd` 保留终端输出。开发模式使用 `pnpm dev`。

使用已构建的 Windows 便携包时，完整解压后运行 `Elysia.exe`。程序与数据分开保存；升级、端口、日志和快捷方式见 [启动说明](docs/usage.md#启动)。

## 开始使用

1. 在 **模型与设置** 中连接原生模型，或在 **Agent 终端 → 终端管理** 中配置 CLI。
2. 打开本机文件夹作为项目，填写目标、范围和交付项，再创建任务。也可直接开始独立对话。
3. 在任务中心处理回答、核验和暂停，在交付工作台查看证据、复核结果并导出文件。

完整流程见 [使用指南](docs/usage.md)。CLI 镜像、凭据和运行条件有各自的配置及验收要求，见 [Agent 终端](docs/AGENT_TERMINALS.md)。

## 文档导航

| 内容                                   | 入口                                                      |
| -------------------------------------- | --------------------------------------------------------- |
| 日常操作、模型连接、预览、备份与恢复   | [使用指南](docs/usage.md)                                 |
| 每个版本的变更                         | [更新记录](CHANGELOG.md)                                  |
| 当前状态、验证入口、已知限制和恢复条件 | [项目状态与验收](docs/EXECUTION.md)                       |
| 架构、内置插件、提示词和技能           | [架构与内置插件](docs/PLUGINS.md)                         |
| 终端安装、运行、诊断与续接             | [Agent 终端](docs/AGENT_TERMINALS.md)                     |
| Antigravity 与 Claude Code             | [接入说明](docs/AGENT_INTEGRATIONS.md)                    |
| 视觉与交互维护约定                     | [界面规范](docs/UI_DESIGN.md) · [品牌资产](docs/BRAND.md) |
| 截至 v1.23.42 的原始执行与验收记录     | [历史归档](docs/history/execution-through-v1.23.42.md)    |

## 开发与维护

```powershell
pnpm typecheck
pnpm build
pnpm verify:local
```

`verify:local` 需要本机的 `.local-tests/verify.ts`；新检出目录没有该材料时会明确失败。具体准备方法见 [验证入口与验收条件](docs/EXECUTION.md#验证入口与验收条件)。

| 目录                                      | 职责                                     |
| ----------------------------------------- | ---------------------------------------- |
| `apps/web`、`apps/server`、`apps/desktop` | 界面、API 服务与桌面入口                 |
| `packages`                                | 契约、存储、内核、运行时、工具和模型适配 |
| `prompts`、`skills`                       | 随任务加载的提示词与内置技能             |
| `assets`、`scripts`                       | 必要资源及构建、启动、维护入口           |
| `docs`                                    | 使用说明、维护规范、当前状态与历史归档   |

默认用户数据位于 `%LOCALAPPDATA%/Elysia`，可通过 `ELYSIA_DATA_DIR` 指定。备份与恢复前先停止服务；当前数据格式为 schema10，最低读取版本为 1.21.0。详见 [存储、停止与备份](docs/usage.md#存储停止与备份)。

`.local-tests/`、`.local-qa/` 和 `.tmp/` 是被 Git 忽略的本地材料目录。忽略状态不表示可以删除；清理前应核对用途与引用，保留可复验脚本、原始报告和必要截图。
