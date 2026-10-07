# Elysia

本机多 Agent 工作台。Code 与 Work 共用任务约定、权限、预算、事件和产物内核，接入 OpenAI Responses 与 DeepSeek Chat。

当前是 **v0.4.1-preview.1 本地预览版**。本轮从 v0.4.0-preview.1 优化界面：重排工作台首页，统一任务详情、代理预览和模型设置，改善文字对比度、小窗口适配与键盘操作。既有订阅调用和文件夹项目继续沿用；两家 API 和完整多代理、缓存验收仍待完成，未发布稳定版。范围、进度与验收结论以 [执行文档](docs/EXECUTION.md) 为准。

## 启动

需要 Node.js 24.15 或更高的 24 LTS，以及 pnpm 11。**双击根目录 `Start-Elysia.vbs` 即可打开 Elysia 独立桌面窗口**。工作台及代理预览均在独立窗口中；ChatGPT 登录按官方要求在系统浏览器中完成授权后返回。`Start-Elysia.cmd` 是保留终端输出的备用入口。

首次启动自动安装锁定依赖、构建并迁移数据库；以后仅在源代码变化时重新构建。首次下载 Electron 需要网络。关闭窗口会安全停止本轮服务；重复启动会聚焦已有窗口。启动错误会显示对话框，日志在 `.elysia-runtime/launcher.log` 和 `desktop.log`。

需要桌面快捷方式时，执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1`。它创建桌面的 `Elysia.lnk`，指向本项目入口；移动项目后需重新创建。桌面进程异常日志另存 `.elysia-runtime/desktop-launch.log`。

```powershell
pnpm start                 # 同一个独立桌面入口
# 可选：指定首选端口，0 表示始终使用动态端口
$env:ELYSIA_PORT = '4318'
pnpm start
```

服务仅绑定 `127.0.0.1`，首选端口 `4317`；被占用时由系统原子分配空闲端口，不结束占用进程。桌面窗口自动取得实际端口与一次性引导令牌，右上角显示当前端口。无需手工复制链接。若同一数据目录已有旧的命令行服务，先执行 `pnpm stop`，再打开桌面窗口。

`pnpm dev` 也使用独立桌面窗口，React/CSS 修改通过 Vite 热更新；开发前端首选 `5173`，占用时自动递增，API 代理使用后端实际端口。修改后端源码后重启窗口。`pnpm start:server` 保留无桌面服务入口，向终端打印有效期 15 分钟的一次性引导链接；它不会打开浏览器。

下载网络不能访问 GitHub 时，可在启动终端设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后重试；安装器仍校验锁定 Electron 包内的校验和。密钥和镜像设置均不会自动写入项目文件。

## 代理工作预览

进入任务，点击顶部“打开预览”，或在任务列表、代理责任树点击“查看工作预览”。下拉选择总代理、子代理或更深层代理，分别查看其独立工作区。

- **页面**：在窗口内渲染 HTML、Markdown 和图片；HTML 支持本地 CSS、JavaScript、模块和资源，可切换桌面 / 手机视口，或展开面板。
- **更改**：Code 对比该代理的 Git 基线，显示新增、修改和删除；包含未跟踪文件，不改动 Git 暂存区。Work 文件按该任务新建文件显示。
- **源文件**：搜索和选择工作区文件，查看源码及纯文本。
- **代理动态**：只显示选中代理的流式输出、会话、工具结果和产物，状态随任务事件更新。

文件与本地样式每约 1.5 秒检查一次，修改后重新加载页面；可关闭自动更新或手动刷新。Git 忽略的常见 `dist/`、`build/`、`out/`、`apps/web/dist/`、`public/` 静态入口也能选择。React/Vite 等源码需先在代理工作区构建，再选择构建后的 HTML；预览不自动安装项目依赖或运行开发命令。需要独立后端或外部 API 的动态应用暂不完整支持。

HTML 在无 Node 权限的沙箱内运行，只加载当前预览目录的本地资源，不能读工作台会话、访问外网或打开外部窗口。源码上限 1 MiB、图片和单个页面资源上限 12 MiB、文件列表上限 1,500 项；符号链接、junction、`.git`、`.env*` 和常见私钥文件不开放预览。

## 打开本机文件夹

点击项目旁的 **＋ → 选择本机文件夹**，目录名自动成为项目名，并显示目录内容和 Git 检测结果。也可以粘贴绝对路径后点击“读取目录”。同一真实路径再次打开会进入已有项目。

普通目录可直接使用 Work；Code 需选择有提交记录的 Git 根目录。仓库子目录可独立作为 Work 项目使用。项目引用原目录，代理可读取其中资料；Work 的结果写入独立任务目录，Code 继续使用基线 worktree。选择 Git 目录后也可改用 Work 读取未提交资料。

选择项目后，点击首页 **当前项目 → 浏览项目文件** 可浏览文件夹与文本文件，支持刷新读取最新内容。文本预览上限为 1 MiB；目录列表最多显示 300 项，不开放链接越界、`.git`、`.env`、依赖和本地测试目录。

## 工作台界面

首页可直接打开本机文件夹、切换项目、查看已验证模型和最近任务。输入目标后点击 **继续** 或按 **Ctrl + Enter**（macOS 为 **⌘ + Enter**），进入协作设置；任务不会因快捷键直接开始执行。点击示例任务会填入可编辑的目标。

左上角按钮可收起侧栏，为任务和预览留出更多空间。任务右侧可切换任务、代理、产物和用量；完成后底部提供 **查看产物**。预览支持选择各代理、页面/更改/源文件/动态切换及展开查看；窄窗口会优先显示预览内容。

弹窗支持 Tab / Shift + Tab 循环导航、Esc 关闭与关闭后焦点恢复；模型配置有未保存更改时，会提示继续编辑或舍弃。界面随窗口调整布局，并遵循系统减少动态效果的设置。

## 配置模型与创建任务

### 使用 ChatGPT 订阅

1. 打开 **模型与设置 → 连接 ChatGPT 订阅**，或 **＋ 新增 → ChatGPT 订阅**。
2. 默认选择 **复用本机 Codex 登录**。已在 Codex 中使用 ChatGPT 登录时，无需重复授权。应用自动寻找 PATH 或 Windows Codex 桌面版附带的 CLI；要求 **0.160.0 或更新版本**。未找到时安装或更新 Codex，也可用 `ELYSIA_CODEX_BINARY` 指定真实可执行文件。
3. 也可选择 **在 Elysia 中独立登录**，使用官方网页登录或设备码登录。登录时打开系统授权页，完成后回到独立工作台；取消登录会停止当前授权等待。此模式的退出只影响 Elysia 的独立 Codex 环境。
4. 等待“运行时、已登录、可选模型”三项连接状态，选择模型与思考强度，点击 **保存配置 → 验证实际调用**。检查会使用一次订阅请求，成功后显示返回文本与实际 Token。
5. 创建任务时选择这份已验证配置。可在设置页查看额度和重置时间，也可打开 ChatGPT 管理订阅。

默认接入使用 [官方 Codex App Server](https://learn.chatgpt.com/docs/app-server)，认证、刷新与网络调用交给官方运行时。Elysia 不读取或复制 Codex 的 `auth.json`，不改写用户 `config.toml`。子进程启用官方系统代理支持，修复本机已登录但独立通道连接超时的问题；未登录、模型目录和实际调用失败分别显示。登录环境是绑定来源，外部切换账号后需重新连接和验证；官方账号接口不提供工作区 ID，同邮箱切换工作区需人工重新验证。

Codex 订阅每次返回一个结构化模型步骤；工具调用仍交给 Elysia 的权限、预算与检查点内核。官方运行时关闭环境访问、MCP、插件、原生命令、浏览器及多代理能力；Elysia 的每个子代理仍使用独立工作区和历史。文本在模型步骤完成后显示，工具与文件预览照常更新。该通道不重放 Responses 原生推理项，缓存效果以返回 usage 为准。

“输出预算预估”用于准入和实际结算，不能保证单次输出的硬上限；Codex 上下文额外保守预留运行时指令和 JSON 编码开销。订阅金额保持未知，不套用 API 价格，也不自动转用 API Key 计费。额度不足暂停任务，在额度恢复并验证后手动恢复。

旧版 **ChatGPT 直接授权**（SIWC）保留为兼容选项，旧凭据仍存于系统加密的 `credentials/chatgpt.bin`。原来的发现端点 HTTP 403 问题不再阻挡默认 Codex 接入。独立 Codex 登录凭据由官方运行时保存在数据目录 `codex-home/` 或其所选凭据存储中；Elysia 不承诺该官方存储一定使用系统加密。2026-10-07 已实测复用本机 ChatGPT Pro 登录、实际模型调用、额度查询，以及 3 次模型请求完成文件写入、产物登记和核验；独立网页/设备码交互通过协议验证，尚未由真人重复登录验收。

### 使用 API Key

在 **＋ 新增** 中选择 OpenAI API、DeepSeek 或自定义服务，填写协议、Base URL 和模型。凭据可直接在桌面页输入并由系统加密保存，也可继续使用环境变量。保存后可读取服务商模型目录，目录不可用时手动输入模型 ID。每份配置可复制和删除；保存变更会清除验证状态。

环境变量模式可以用以下方式避免明文输入出现在命令历史中：

```powershell
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'OpenAI API Key' -AsSecureString)).Password
$env:DEEPSEEK_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'DeepSeek API Key' -AsSecureString)).Password
pnpm start
```

运行中的服务不会读取其他终端中新设的环境变量。配置密钥后需停止服务，再从具有这些环境变量的终端启动。

1. 打开本机文件夹作为项目。Code 项目须有 Git commit；选择基线 ref 后保存具体 commit。Work 项目直接使用资料目录，已登记 Git 根目录及基线的项目也可运行混合 Code 子任务。
2. 在“模型与设置”中保存账号可用的模型配置，点击“验证实际调用”。预算、速率、缓存与价格在高级配置中。初始模型 ID 是可编辑示例，不能代表账号可用性。
3. 输入目标，选择总代理、可写目录、命令和网页权限，以及请求/Token/并发上限。项目目录会自动传给代理，可选填重点资料路径。每个任务使用独立目录；相对文件路径以该任务目录为基准，资料使用项目内绝对路径。
4. 总代理集中澄清关键问题，提出约定和计划。接受具体计划版本后执行；补充需求在工具消息配对闭合后应用，撤销旧计划授权并重新规划。已完成产物保留。
5. 在右栏查看任务依赖、代理责任树、基线、产物、diff、请求清单与使用量。对于不确定副作用，先检查本机证据再提交核验决定；恢复不会盲目重做。

Code 不复制主目录未提交内容，不自动 push 或合并主分支。集成在总代理自己的 worktree 进行。命令通过明确 program/args 启动；Windows 的 shell 内置命令需要显式使用 `cmd.exe` 或 `powershell.exe`。子进程使用环境变量白名单；任意命令仍以当前系统用户权限执行，目录分离并非 OS 沙箱。

网页仅访问明确授权的 URL；重定向的每个目标也需授权。拒绝本机、私网、保留地址及非标准端口，连接固定到经过检查的 DNS 地址。网页和文件保留不可信来源标记。

产物验收核对验收项覆盖、文件哈希、已登记的不可变对象、命令退出状态和必需子任务。自然语言结论的语义正确性仍需用户复核，不能把引用完整性当成内容正确性的保证。

## 存储、停止与备份

默认目录为 `%LOCALAPPDATA%/Elysia/`，包括 `state.db`、`objects/`、`workspaces/`、`logs/`、加密的 `credentials/` 和可选的 `codex-home/`。通过 `ELYSIA_DATA_DIR` 修改。API Key 在环境变量或系统加密的 `credentials/api-keys.bin` 中，数据库仅保存引用；页面提交密钥后清空输入，不回读密钥。更换密钥生成新引用，已有任务继续使用原引用；删除配置不删除任务或其凭据。每个数据目录只允许一个服务实例。

关闭桌面窗口，或在使用相同数据目录的终端执行 `pnpm stop`，请求停止接单、保留检查点、回收已登记进程并关闭数据库。无桌面模式也可用 `Ctrl+C`。暂停/取消也会中断在途请求；供应商可能已产生费用。未返回使用量的调用保持待核验和预算预留。

升级迁移、备份和恢复前停止服务。维护命令会取得独占锁。

```powershell
pnpm backup                          # 默认保存到数据目录的 backups/时间戳
pnpm backup D:\ElysiaBackups\snapshot
pnpm restore D:\ElysiaBackups\snapshot
pnpm db:migrate                      # 幂等 schema v2
```

备份包括数据库与内容对象。API Key 和订阅凭据不进入历史备份；更换数据目录或系统用户后应重新保存密钥或登录。Code worktree、Work 工作目录和流式中断日志保留在原数据目录，不随备份搬迁；恢复历史和已登记产物不依赖工作区，但继续未完成任务需要原工作区及原凭据引用。恢复前的数据被移入 `backups/before-restore-*`，不会直接删除。首次启动将 schema v1 无损升级为 v2，旧应用将拒绝读取，避免把新的订阅配置误当作 API Key。升级前执行 `pnpm backup` 会保留原 schema；v0.4 可恢复 v1 或 v2 备份，回退 v0.3 须使用升级前备份。

## 验证与工程入口

```powershell
pnpm typecheck
pnpm build
pnpm verify:local
```

`verify:local` 执行被忽略的 `.local-tests/verify.ts`，产物写入 `.local-qa/`。本机保留了本次核心用例与结果；新检出目录不包含测试材料，命令会以错误退出而不会跳过。按执行文档第十一节重新准备本地验收材料。协议夹具和合成执行器使用量不能替代真实模型、缓存、账号并发和厂商续接验收。

前端位于 `apps/web/`，API/SSE、Codex 连接与凭据服务在 `apps/server/`；内核、工具、模型协议、上下文、共享 contracts 与 SQLite 分属 `packages/`。Prompt 位于 `prompts/`。配置重构参考 [CC Switch](https://github.com/farion1231/cc-switch) 的账号与提供商分离，以及 [Windows CodexPlusPlus](https://github.com/qqheling/codexplusplus) 的提供商实体与预设设计；没有接管或改写这些应用的配置文件。

实现协议于 2026-10-07 核对 [OpenAI Function calling](https://developers.openai.com/api/docs/guides/function-calling)、[OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) 与 [DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)。缓存参数按模型配置，只展示实际返回的 usage；未知价格与缺失字段保持未知。
