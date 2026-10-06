# Elysia

本机多 Agent 工作台。Code 与 Work 共用任务约定、权限、预算、事件和产物内核，接入 OpenAI Responses 与 DeepSeek Chat。

当前是 **v0.1.0 的本地构建，待真实模型验收**，尚未发布。范围、进度与验收结论以 [执行文档](docs/EXECUTION.md) 为准。

## 启动

需要 Node.js 24.15 或更高的 24 LTS，以及 pnpm 11。所有依赖使用精确版本和锁文件。

```powershell
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm build
pnpm start
```

使用终端打印的一次性引导链接打开工作台。令牌在 15 分钟内有效且只能使用一次；链接的 hash 在换取 HttpOnly 本机会话后会移除。重新启动服务会产生新令牌。服务绑定 `127.0.0.1`，默认端口 `4317`；端口被占用时停止启动，可通过 `$env:ELYSIA_PORT = '4318'` 显式更换，不结束未知进程。

开发使用 `pnpm dev`，浏览器入口为 `http://127.0.0.1:5173`，API 仍使用配置的服务端端口；首次启动后从终端引导链接进入。前后端开发进程由启动器一起停止。修改后端源码后重启开发服务。

## 配置模型与创建任务

在启动服务的 PowerShell 中设置环境变量，密钥不写进配置文件或数据库。可以用以下方式避免明文输入出现在命令历史中：

```powershell
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'OpenAI API Key' -AsSecureString)).Password
$env:DEEPSEEK_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'DeepSeek API Key' -AsSecureString)).Password
pnpm start
```

运行中的服务不会读取其他终端中新设的环境变量。配置密钥后需停止服务，再从具有这些环境变量的终端启动。

1. 注册本机项目。Code 项目须有 Git commit；选择基线 ref 后保存具体 commit。Work 项目指定资料目录，有 Git 基线的项目也可运行混合 Code 子任务。
2. 在“模型与设置”中填入账号可用的模型 ID、base URL、上下文和输出上限、账号额度以及已知的缓存能力和价格。初始模型 ID 是可编辑示例，不能代表账号可用性。保存配置后点击“验证已保存配置”，这会发起一次短请求。
3. 输入目标、资料路径、总代理、可写目录、命令和网页权限，以及请求/Token/并发上限。每个任务使用独立目录；相对文件路径以该任务目录为基准，资料使用项目内绝对路径。
4. 总代理集中澄清关键问题，提出约定和计划。接受具体计划版本后执行；补充需求在工具消息配对闭合后应用，撤销旧计划授权并重新规划。已完成产物保留。
5. 在右栏查看任务依赖、代理责任树、基线、产物、diff、请求清单与使用量。对于不确定副作用，先检查本机证据再提交核验决定；恢复不会盲目重做。

Code 不复制主目录未提交内容，不自动 push 或合并主分支。集成在总代理自己的 worktree 进行。命令通过明确 program/args 启动；Windows 的 shell 内置命令需要显式使用 `cmd.exe` 或 `powershell.exe`。子进程使用环境变量白名单；任意命令仍以当前系统用户权限执行，目录分离并非 OS 沙箱。

网页仅访问明确授权的 URL；重定向的每个目标也需授权。拒绝本机、私网、保留地址及非标准端口，连接固定到经过检查的 DNS 地址。网页和文件保留不可信来源标记。

产物验收核对验收项覆盖、文件哈希、已登记的不可变对象、命令退出状态和必需子任务。自然语言结论的语义正确性仍需用户复核，不能把引用完整性当成内容正确性的保证。

## 存储、停止与备份

默认目录为 `%LOCALAPPDATA%/Elysia/`，包括 `state.db`、`objects/`、`workspaces/` 和 `logs/`。通过 `ELYSIA_DATA_DIR` 修改。密钥仅存在于服务端环境，前端收到的是环境变量名和是否配置的布尔状态。每个数据目录只允许一个服务实例。

`Ctrl+C` 或在使用相同数据目录的终端执行 `pnpm stop`，请求停止接单、保留检查点、回收已登记进程并关闭数据库。暂停/取消也会中断在途请求；供应商可能已产生费用。未返回使用量的调用保持待核验和预算预留。

升级迁移、备份和恢复前停止服务。维护命令会取得独占锁。

```powershell
pnpm backup                          # 默认保存到数据目录的 backups/时间戳
pnpm backup D:\ElysiaBackups\snapshot
pnpm restore D:\ElysiaBackups\snapshot
pnpm db:migrate                      # 幂等 schema v1
```

备份包括数据库与内容对象。Code worktree、Work 工作目录和流式中断日志保留在原数据目录，不随备份搬迁；恢复历史和已登记产物不依赖工作区，但继续未完成任务需要原工作区。恢复前的数据被移入 `backups/before-restore-*`，不会直接删除。不要用旧应用读取更新的 schema，回退须恢复相容备份。

## 验证与工程入口

```powershell
pnpm typecheck
pnpm build
pnpm verify:local
```

`verify:local` 执行被忽略的 `.local-tests/verify.ts`，产物写入 `.local-qa/`。本机保留了本次核心用例与结果；新检出目录不包含测试材料，命令会以错误退出而不会跳过。按执行文档第十一节重新准备本地验收材料。协议夹具和合成执行器使用量不能替代真实模型、缓存、账号并发和厂商续接验收。

前端位于 `apps/web/`，API/SSE 与维护入口在 `apps/server/`；内核、工具、模型协议、上下文、共享 contracts 与 SQLite 分属 `packages/`。Prompt 位于 `prompts/`。没有引入云端服务、自动搜索、浏览器操作或后续外部执行器。

实现协议于 2026-10-07 核对 [OpenAI Function calling](https://developers.openai.com/api/docs/guides/function-calling)、[OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) 与 [DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)。缓存参数按模型配置，只展示实际返回的 usage；未知价格与缺失字段保持未知。
