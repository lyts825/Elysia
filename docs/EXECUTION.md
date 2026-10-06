# Elysia 首版执行文档

文档版本：0.1.0　日期：2026-10-07　产品目标：v0.1.0

当前为施工规格，产品尚未实现。建设一个供个人在本机使用的多 Agent 工作台：用户指定总代理，接入不同厂商的模型，同一模型可创建多个实例，子代理可继续委派。Code 与 Work 共用任务、上下文、权限和预算内核。

本轮版本变化为“无项目基线 → 文档 0.1.0”；产品 v0.1.0 仅在第十一节验收通过后发布。本文是首版施工与验收的单一依据，进度更新在第十节。

## 一 首版范围

| 必须交付 | 首版边界 |
| --- | --- |
| 需求到交付 | 澄清需求、任务约定、计划、执行、验证、产物交付；支持中途补充需求 |
| 多模型协作 | OpenAI Responses 与 DeepSeek Chat 两个原生适配器；模型 ID、端点和额度可配置 |
| 代理管理 | 指定总代理模型；同模型独立多实例；有限深度的递归委派；任务依赖与并发限制 |
| Code | 本地 Git 项目、独立 worktree、文件修改、命令执行、差异检查、验证结果 |
| Work | 本地 TXT、Markdown、JSON、CSV 和指定网页资料，生成 Markdown 报告及附件 |
| 可靠性 | 事件持久化、消息边界检查点、取消、有限重试、进程重启后的恢复与结果核验 |
| 缓存 | 稳定前缀、资料快照、厂商缓存配置、实际使用量、请求差异及成本观测 |
| 本机界面 | 项目与设置、对话与计划、任务图与代理树、产物与差异、用量与缓存 |

后续版本再接 Codex App Server、Claude Agent SDK、DSH SDK，以及本地推理服务、MCP、办公文档渲染、浏览器操作和自动搜索。首版保留执行器接口，交付原生执行器；云端、多用户、插件市场、语义答案缓存和自动缓存保温不纳入首版。

有界递归和基础恢复提前纳入首版，以覆盖最初需求。复杂恢复、自动模型路由与缓存调度优化后置。首版支持项目内混合 Code 和 Work 子任务，根任务的模式只决定默认能力包。

## 二 架构与模块职责

```mermaid
flowchart TB
    UI[本机工作台] <--> API[本地 API 与 SSE 事件流]
    API <--> CO[总代理会话]
    CO <--> K[调度内核\n任务依赖 权限 预算 验收]
    K <--> DB[(SQLite\n状态 事件 检查点 账本)]
    K --> EX[执行器接口]
    EX --> N[原生 Agent Loop]
    N --> CC[Prompt 与 Context Compiler]
    CC --> PA[OpenAI 与 DeepSeek 适配器]
    PA --> LLM[模型服务]
    N --> TG[工具网关]
    TG --> WS[worktree 与 Work 目录]
    WS --> AS[版本化资料和产物库]
    AS --> CC
    N --> DB
    DB --> API
    CP[缓存能力配置与使用量观测] -.-> CC
    CP -.-> PA
    EX -.-> FUT[后续外部运行时适配器]
```

总代理提出问题、计划和分派决策，内核校验后落地。模型不能直接修改状态库、授予权限或增加预算。工具只通过工具网关执行。控制状态和事件在同一个数据库事务中提交，避免聊天显示与真实状态分离。

| 模块 | 责任与禁止跨越的边界 |
| --- | --- |
| contracts | Zod Schema、状态枚举、命令与事件协议；供前后端共用 |
| kernel | 任务依赖图、原子准入、租约、预算、权限、取消和验收；不依赖具体模型 SDK |
| runtime | Agent Loop、委派与等待、重试、结果提交；不直接访问模型厂商 HTTP 接口 |
| context | Prompt 组合、资料选择、历史投影、压缩、请求清单；不执行工具 |
| providers | 请求编译、流式解析、原生内容、缓存参数、使用量归一化 |
| tools | 文件、命令、网页、产物与工作区；每次调用检查权限和参数 |
| storage | SQLite 迁移与事务、事件、资料和产物引用；原始大内容存文件 |
| web | 展示、输入、操作请求；不持有厂商密钥，不自行推断完成状态 |

参考 DSH 的插件生命周期与事件投影、Pi 的消息转换与工具结果排序、Codex 的结构化执行事件。首版采用少量静态注册模块，统一提供初始化和释放接口；运行中的插件热更后置。相关依据见第十二节。

## 三 技术栈与工程布局

采用 Node.js 24 LTS、pnpm 11、TypeScript、React、Vite、Fastify、Zod。SQLite 通过 Node 内置 `node:sqlite` 使用；存储操作封装在独立模块，短事务同步完成，大文件处理放在事务外。M0 锁定实际通过构建的依赖版本与锁文件，不使用浮动版本作为交付依据。

原生模型适配器分别处理两家的请求和流式协议；可复用官方 SDK。Pi 的模型库可以在以后替换适配器内部实现，业务代码只依赖平台接口。

```text
apps/web/                 工作台
apps/server/              API、SSE、启动与恢复
packages/contracts/      Schema 与事件协议
packages/kernel/         调度、状态机、权限、预算
packages/runtime/        原生执行循环与执行器接口
packages/context/        Prompt、上下文与缓存清单
packages/providers/      OpenAI、DeepSeek、能力配置
packages/tools/          文件、进程、网页与产物工具
packages/storage/        数据库、迁移与文件对象库
prompts/                 平台规则、角色、模式、任务模板
docs/EXECUTION.md        施工规格、进度与验收结论
.local-tests/            本地验证脚本与样例，忽略跟踪
.local-qa/               测试结果与截图，忽略跟踪
```

Windows 的运行数据默认放在 `%LOCALAPPDATA%/Elysia/`，可用 `ELYSIA_DATA_DIR` 修改，目录内分为 `state.db`、`objects/`、`workspaces/`、`logs/`。Code worktree 和 Work 产物保留至用户明确清理。API Key 从服务端环境变量读取，数据库只存环境变量名称；密钥、运行数据、测试材料和构建产物不进入 Git。

## 四 需求流程与数据模型

流程为：输入需求 → 澄清关键缺口 → 保存 TaskContract → 生成 Plan → 开始执行 → 验收 → 交付。用户已经明确授权自动执行时复用授权；否则在展示计划后提供一次“开始执行”。低风险细节采用可见假设，不反复询问。任何计划修改均不能扩大已有权限或预算。

TaskContract 必须包含：`objective`、`scope`、`nonGoals`、`inputs`、`deliverables`、`acceptanceCriteria`、`constraints`、`mode`、`permissionProfile`、`budget`、`assumptions`。验收项必须对应可检查的文件、差异、命令结果或有来源的结论。

Plan 必须包含：`version`、`contractVersion`、任务列表、依赖、角色与模型绑定、预期产物、验收项、共享资料快照。每个子任务继承根约束，可增加限制；任务目标可以细分。补充需求形成新版本，在安全检查点判定哪些任务继续、重做或取消。

| 表或实体 | 最少字段及约束 |
| --- | --- |
| projects | id、name、mode、workspaceRoot、configVersion |
| runs | id、projectId、contract、plan、status、coordinatorAgentId、limits |
| tasks | id、runId、parentTaskId、spec、status、revision；依赖放 task_edges，禁止跨 run |
| agents | id、runId、parentAgentId、profileVersion、providerBinding、sessionId、status |
| attempts | id、taskId、agentId、sequence、status、lease、checkpointRef、error；同任务最多一个活跃 attempt |
| events | runId、单调 seq、eventId、type、taskId、attemptId、payloadRef、occurredAt；eventId 唯一 |
| messages | sessionId、ordinal、role、contentRef、providerNativeRef；保存已完成消息与工具调用配对 |
| snapshots 与 artifacts | id、runId、内容哈希、路径或来源、版本、依赖、验收状态 |
| requests 与 usage | requestId、attemptId、contextManifest、usage、priceVersion、cost、settlementStatus |
| tool_operations | operationId、attemptId、toolCallId、intent、status、resultRef；持久记录副作用结果 |
| checkpoints 与 decisions | 任务版本、会话位置、待处理工具、等待关系、授权或验收决定及其来源 |

任务状态：`DRAFT → READY → RUNNING → VERIFYING → DONE`；运行中可进入 `WAITING`，等待结束返回 READY；执行失败进入 FAILED，允许新 attempt 重试；取消进入 CANCELLED。WAITING 必须带原因，如子任务、用户输入、权限或限流。

Agent 父子关系表示委派责任，任务依赖图表示执行顺序，二者独立。数据库启用外键、WAL 和有界 busy timeout；状态修改携带 revision，过期修改返回冲突。事件回放只重建视图，不能再次执行工具。

## 五 调度和执行循环

总代理与子代理均运行相同循环，区别在角色、权限和任务输入。总体执行方式如下。

1. 内核选择依赖已满足的 READY 任务，在事务中获得执行租约。首次执行或失败重试创建 attempt；从等待恢复时复用原 attempt 和会话。
2. 读取任务约定、有效授权和检查点；Context Compiler 生成确定性请求及清单。
3. 检查根任务和全部祖先预算，预留调用额度；取得模型调用槽位，再发出请求。
4. 收集完整工具调用，校验 Schema、工具权限和调用配对后执行；中途流式参数不能直接执行。
5. 持久化消息、工具结果、使用量和检查点；决定继续、等待、提交验收或失败。
6. 待验收任务核对必需子任务及产物证据；满足验收项才进入 DONE，否则附原因返回执行。

| 机制 | 首版施工要求 |
| --- | --- |
| 多实例 | 模型配置可共享；实例 ID、会话、工具操作和工作目录独立，不能复用其他实例的私有历史 |
| 递归委派 | `spawn_task` 由内核创建任务和 Agent；检查深度、数量、权限与预算；连同父子等待关系检查依赖环 |
| 等待 | `join_tasks` 持久化等待集合后释放调用槽；未完成的必需子任务阻止父任务验收 |
| 限流 | 全局、厂商账号、实例分别限流；同账号多开仍共用 RPM、TPM 等额度 |
| 预算 | 每次实际发起调用分配 requestId，重试保留逻辑关联；调用前沿祖先路径原子预留，每个 requestId 只结算一次 |
| 重试 | 429、临时网络或服务错误最多自动重试 2 次，遵守 Retry-After 并退避；鉴权和参数错误直接暴露 |
| 模型切换 | 首版使用显式模型绑定；更换模型创建新 attempt，通过任务交接包继续，保留旧会话 |
| 取消与暂停 | 取消向后代传播，停止排队与在途请求；暂停在安全边界保留检查点；清理租约和进程句柄 |
| 验收 | Code 优先命令结果、diff 和文件证据，Work 核对范围、来源及产物；审查 Agent 只能提供意见 |

初始保护参数：根 Agent 深度为 0，最大深度 2；每 run 最多创建 12 个 Agent；全局模型并发 4、每账号 2；并发工具 4；每 Agent 最多 20 步、每 run 最多 80 次模型请求；run 最长 30 分钟。参数可配置，属于施工默认值，不是性能承诺。达到上限时返回可恢复的停止原因，不能无限拆分或重试。

货币预算只在模型价格和调用上界已知时启用准入拦截；无价格信息时使用调用数和 token 限制。缓存写入费、输出及推理 token 按厂商语义计费，不能双算。用量未返回的调用保留预留并标记待核验，不按零费用结算。中断在途请求仍可能产生费用，客户端限额不等于供应商账单的绝对上限。

恢复时先取得单实例服务锁，再核验过期租约。未结算的流式消息作为中断记录保留，不伪装成完整消息；已成功工具结果直接复用。对 `intent` 已写入而结果缺失的副作用操作，先核验文件哈希、进程状态等证据；无法判断时等待核验，不盲目重做。停止前先记录状态、停止接单、回收执行进程，最后关闭数据库。

## 六 Prompt 和 Context 施工要求

Prompt 采用“平台规则 + 模式 + 角色 + 工具能力包 + 按需 Skill + 任务模板”组合。首版只提供 coordinator、worker、reviewer 三种角色，角色配置包含职责、工具、委派能力和完成条件。配置版本进入每次请求清单，运行中不自动切换模板。

| 角色 | 必须输出或调用 |
| --- | --- |
| coordinator | 汇总需要用户回答的问题；生成 TaskContract 和 Plan；分派；核对验收项；整理交付 |
| worker | 目标、产物引用、实际验证、未完成事项；必要时通过 spawn_task 和 join_tasks 继续拆解 |
| reviewer | 按验收项输出通过、失败或证据不足及对应引用；默认只读，不自行更改产物 |

编译流程为：事件和快照 → 选择相关上下文 → 按固定顺序投影 → 厂商协议编译 → 请求。工作台进度、完整日志、运行时间和随机 ID 不自动进入公共前缀。网页、文件与工具输出保留来源和信任标记，不提升为平台指令。

```text
P0  稳定平台规则和工具 Schema
P1  稳定模式、角色和能力配置
P2  已确认项目约定、相关资料快照
T   当前任务、实例工作区和必要动态信息
H   本实例按规则追加的消息与工具结果
```

上述是逻辑顺序，适配器负责实际的 system、developer、tools、messages 布局。模型不支持的角色或工具特性必须有明确映射或拒绝原因。提供两个初始能力包：Code 的文件和命令工具、Work 的资料和产物工具；仅在任务阶段边界调整工具集。

上下文预算按具体模型配置：预留输出和工具结果空间，输入到达有效上限的 75% 时准备压缩，这是首版阈值。保留平台规则、有效约束、当前任务、未解决问题、产物引用和最近完整交互；已结束阶段生成版本化摘要。摘要不能替代尚未闭合的工具调用和结果，压缩前保存检查点及原始内容引用。

子代理使用定向交接包：任务与验收项、相关约束、只读快照、可访问产物、预算和权限。公共记忆仅在验收后更新；资料更新创建新快照并在检查点核对影响。厂商原生推理块、签名和续接标识按适配器规则保存和重放，跨模型仅交接公开结论、证据、产物与待办。

## 七 缓存和使用量

缓存分为本地资料复用、厂商 Prompt 缓存、运行时会话续接。三者分别记录；不同模型和服务商之间不承诺共享 KV 缓存。首版优化原生模型请求，外部运行时未来接入时按可观测能力展示。

1. 工具定义、属性顺序、资料顺序和 Prompt 文本确定性生成。公共资料快照不可原地修改；真实约束变化立即生效并形成新版本。
2. 同模型、同工具包、同角色和同资料快照的 Agent 共享前缀；不同任务和实例信息位于后部。同一任务继续使用原模型和会话。
3. 并发工具按实际完成顺序更新界面，写入模型上下文时按原调用顺序排列；超时和失败也产生配对结果。
4. 每次记录 `providerBinding`、实际模型、端点、账号作用域引用、编译器版本、Prompt/工具/快照哈希、分段前缀哈希和缓存参数。只有在厂商协议支持时映射为缓存键；哈希本身不创建缓存。
5. 能力表记录缓存模式、最小长度、有效期、断点支持、用量字段及价格版本；未知能力不得套用另一厂商参数。OpenAI 缓存参数按实际模型配置；DeepSeek 采用其自动缓存机制。
6. 并发冷启动按真实请求观测，不假设首个请求必然预热所有兄弟任务。首版不额外发保温请求；先测量重复前缀、分叉前缀和 TTL 后的行为。
7. 只读工具结果缓存键包含工具版本、规范化参数、资料版本和权限作用域。文件读取以内容版本失效，网页记录来源与抓取时间；命令、写入和其他副作用不使用结果缓存。

统一 usage 结构包括 `inputTotal`、`cacheRead`、`cacheWrite`、`uncachedInput`、`outputTotal`、`reasoning`、`cost`、`ttftMs`、`rawUsage`。适配器注明各项是否已包含在总量中，缺失值为 null。展示每厂商 token 命中比例、缓存读写费用、首字延迟、总成本和每个验收通过任务的成本。

缓存验收核对实际 usage 与请求清单，不规定未经基线测量的命中率目标。请求差异可以说明结构变化；供应商未提供原因时，失效原因只能标记为推测。

## 八 工具和工作区

| 工具集合 | 首版要求 |
| --- | --- |
| list/read/search | 项目内文件浏览和搜索；结果带来源与内容哈希，大结果存对象库后返回截取和引用 |
| write/apply_patch | 检查目标范围和预期原文哈希；先记录操作 intent，再原子写入并记录结果 |
| exec | 明确 program、args、cwd、timeout、输出上限；由服务端授权后启动子进程，清理整棵已登记进程树 |
| fetch_url | 读取用户或任务授权的 URL；设置超时、大小及重定向限制；每次跳转重新检查目标，防止越权访问本机服务 |
| artifact | 注册产物、版本、来源和验证证据；先写临时文件，再完成对象发布和数据库登记 |
| orchestration | clarify、propose_plan、spawn_task、join_tasks、submit_result，由内核验证和执行 |

路径检查使用规范化绝对路径及实际路径解析，处理 `..`、符号链接和 Windows junction。授权分为项目内只读、指定目录写入、命令执行和网络访问；每次执行均检查当前有效授权。执行子进程采用环境变量白名单，不传入模型密钥。

Code 从明确选定的 commit 创建 worktree，界面展示基线；不自动复制主目录未提交改动，不 stash/reset 用户工作。每个写入任务拥有独立 worktree；集成任务在单独集成 worktree 收集变更、处理冲突、执行验证，并交付 diff。发布、push 和主分支合并不自动执行。Work 每个任务独立目录，验收通过后注册版本化产物。

首版是受用户授权的本机执行，任意命令按当前系统用户权限运行；目录分离与工具检查不构成完整 OS 沙箱。需要隔离不可信命令时保留 SandboxBackend 接口，增加真实系统隔离后再声明该能力。

## 九 接口与界面

`ProviderAdapter` 提供 `capabilities`、`compile(context)` 和 `stream(request, signal)`；输出统一的文本增量、完整工具调用、使用量、完成或错误事件，并保留必要原生字段。`ExecutorAdapter` 提供 `start`、`interrupt`、`resume`、`dispose` 和能力声明；首版只实现 NativeExecutor。

本地 HTTP API 使用 `/api` 前缀，所有修改请求包含 `commandId`，已处理的 ID 返回原结果。涉及已有对象时携带 `expectedRevision`。错误返回 `code`、`message`、`retryable`、`details`。初版入口如下。

| 接口 | 行为 |
| --- | --- |
| POST /projects；GET /projects | 注册本机项目、获取项目列表 |
| PUT /providers/:id；POST /providers/:id/check | 保存端点、模型、密钥环境变量引用和能力配置；显式连通性验证 |
| POST /runs；GET /runs/:id | 创建需求会话；读取约定、计划、任务和使用量快照 |
| POST /runs/:id/messages | 用户回复或补充需求，进入持久收件箱，在安全边界处理 |
| POST /runs/:id/plan/accept | 接受具体计划版本和执行范围；已有有效授权可由内核直接启动 |
| POST /runs/:id/actions | start、pause、resume、cancel；支持 taskId 范围，返回操作状态 |
| POST /runs/:id/decisions | 提交权限或待核验结果的用户决定，绑定具体请求及版本 |
| GET /runs/:id/events?after=seq | SSE 增量事件，支持断线续接与序号去重 |
| GET /artifacts/:id | 校验访问范围后读取产物；文件必须从已登记引用解析 |

事件至少包括 `run.updated`、`plan.proposed`、`task.updated`、`agent.started`、`message.delta`、`message.completed`、`tool.started`、`tool.completed`、`decision.required`、`artifact.created`、`usage.updated`、`error`。持久事件带 runId 和 seq；文本增量是临时帧，重连以已落盘消息和状态快照恢复，不能把临时帧当检查点。

界面采用左侧项目与历史、中间对话和计划、右侧任务/代理/产物/用量详情。最小操作包括选择模式与总代理、编辑约定、查看并开始计划、回答合并后的问题、暂停/恢复/取消、检查 diff 和打开产物。任务依赖图和代理树分开显示，提供列表回退视图。

服务仅绑定 `127.0.0.1`。开发时 Vite 代理 `/api`，交付时由本地服务托管构建后的前端。启动器创建一次性浏览器引导令牌，换取本机会话；校验 Host、Origin 和修改请求凭据，禁止通配 CORS。API Key 不发送到前端。端口占用时报告错误并允许显式换端口，不结束未知进程。

## 十 施工顺序与操作入口

当前 M0 至 M6 均为待开始。各阶段的“负责人”是施工职责，可由同一开发者顺序承担，不表示已经创建或委派 Agent。完成一阶段后更新此处状态及验证结论，再进入依赖它的阶段。

| 阶段 | 优先级与依赖 | 负责人 | 施工内容与退出条件 |
| --- | --- | --- | --- |
| M0 工程基座 | P0，无 | 工程 | 创建 workspace、Schema、迁移、服务锁和空界面；开发启动、构建、重启、数据目录检查通过 |
| M1 单 Agent | P0，M0 | 运行时 | 两家适配器、Prompt 编译、流式工具循环、usage；各完成一次真实工具调用并正确记录结果 |
| M2 协作内核 | P0，M1 | 内核 | TaskContract、Plan、状态机、DAG、多实例、递归、join、预算；同模型多开和跨模型委派通过 |
| M3 Code 和 Work | P0，M2 | 工具与产品 | 工作区、工具授权、完整界面与产物验收；两类端到端任务可交付 |
| M4 可靠性 | P0，M3 | 内核 | 中断、取消、重试、恢复与副作用核验；断网、进程中止和等待恢复用例通过 |
| M5 缓存观测 | P0，M4 | 上下文 | 前缀指纹、能力配置、使用量对照、成本界面；完成缓存基线并解释请求结构变化 |
| M6 发布验收 | P0，M5 | 集成与验收 | 执行第十一节，修复阻塞问题、清理无用临时产物、提交并标记产品版本 |

持久化、权限和稳定序列化从 M0/M1 建立，M4/M5 是完善和专项验收阶段。M1 前需要用户配置两家服务可用的 API Key 和模型 ID；无凭据时可推进本地逻辑，真实接入验收保持未通过。

M0 必须提供以下命令；当前文档基线尚不包含这些脚本。

```powershell
pnpm install --frozen-lockfile   # 首次建工程时先生成并提交锁文件
pnpm db:migrate                 # 幂等迁移，升级前停止服务并备份数据库与对象库
pnpm dev                        # 启动本机开发服务和界面
pnpm typecheck                  # 类型与跨包协议检查
pnpm build                      # 构建前后端
pnpm verify:local               # 本机最小核心验证，材料放 .local-tests 和 .local-qa
pnpm start                      # 启动构建后的本机服务
```

运行配置至少提供 `ELYSIA_DATA_DIR`、`ELYSIA_PORT`、`OPENAI_API_KEY`、`DEEPSEEK_API_KEY`；模型 ID、厂商 base URL、上下文上限、输出上限、价格与能力配置由设置页保存。`.env.example` 仅包含变量名与非敏感示例，真实值通过服务端环境注入。模型配置变更先做显式连通性检查，再用于新任务。

数据库迁移必须带 schema 版本。首版优先向前迁移，失败时停止启动并提供错误；回退旧应用须恢复相容备份，不直接用旧版读取新版数据库。首次安装、备份恢复和停止服务的入口随 M0 提供，并在 M6 复核。

## 十一 最小验收集

测试脚本、样例仓库、录制请求和截图统一放入被忽略的本地目录；Git 保留以下验收步骤及简短结论。`package.json` 的 `verify:local` 调用本地脚本，专用测试代码与断言不入库。新检出目录按本表准备本地用例；材料缺失时必须报告，不能跳过后返回通过。

| 编号 | 操作与合格条件 |
| --- | --- |
| A1 需求闭环 | 输入存在关键歧义的任务；总代理集中提问，形成有边界和可检查验收项的约定与计划；授权范围正确继承 |
| A2 异构与多开 | 同时运行两家模型，并启动同模型两个实例；任务、消息和工作区不串用；账号并发限制生效 |
| A3 递归与等待 | 子代理创建孙代理、等待后继续；并发设为 1 仍能完成；超深度、任务上限和依赖环被拒绝 |
| A4 Code | 在临时 Git 仓库完成含并行子任务的修改；产物有 diff 和验证证据，主目录已有内容保持完整 |
| A5 Work | 对给定资料生成 Markdown 报告；结论有来源，附件可读取，未覆盖内容显式列出 |
| A6 恢复与副作用 | 分别在模型流中、工具完成后和结果落盘前停止服务；恢复状态正确，不重复已确认的写入；不确定操作进入核验 |
| A7 预算与取消 | 多代理同时接近额度；原子准入不重复占额，usage 按 requestId 去重；取消后代和执行进程，保留已发生费用 |
| A8 上下文与缓存 | 同输入编译得到一致前缀；改变工具或资料产生可追溯变化；压缩保留约束和工具配对；记录两家真实重复调用 usage |
| A9 权限与本机入口 | 越界路径、junction、未授权工具和非法 Origin 请求被拒绝；子进程及前端看不到模型密钥 |
| A10 交付 | 从锁文件安装、迁移、构建、启动成功；事件断线续接无重复状态；备份恢复后能读取历史和产物 |

产品发布条件：A1 至 A10 全部通过，真实模型验收和缓存观测有记录，无未解决的数据完整性问题。供应商缓存未命中但参数和记录正确时，报告实际结果，不伪造命中率；实现错误或指标错误必须修复。权限、预算、验收状态不可由模型自报绕过。

## 十二 版本管理与参考依据

工程版本以根 `package.json` 为准，各包采用统一版本；完成 M6 后创建 `v0.1.0` 标签。施工中使用普通提交。本文版本单独维护，本轮文档标签为 `docs-v0.1.0`，不代表产品发布。正式文档、代码、配置和资源入 Git；本机数据、测试材料、缓存与密钥按精确路径排除。

交付前核对差异、链接和版本，删除本次产生且已无用途的临时文件；产物、用户文件和仍用于验收的本地材料保留。版本记录只写日期、范围、验证结论和对应标签，提交通过标签定位。

| 日期 | 文档版本 | 范围 | 验证结论 | 定位 |
| --- | --- | --- | --- | --- |
| 2026-10-07 | 0.1.0 | 首版架构、接口、施工与验收规格 | 文档结构与范围校核；产品验证待 M0 至 M6 | docs-v0.1.0 |

| 参考 | 采用的设计依据 |
| --- | --- |
| [DeepSeek Harness 架构](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/architecture.md) | 生命周期、事件记录与上下文投影；首版不耦合其完整插件树 |
| [Pi Agent](https://github.com/earendil-works/pi/blob/ae92585d3b3e5f1e4b123d14a34314d826d8d9f5/packages/agent/README.md) | 内部消息转换；并发完成事件与持久工具结果顺序分离 |
| [Codex App Server](https://learn.chatgpt.com/docs/app-server) | 结构化会话、执行、流式事件和中断协议，供后续外部执行器接入 |
| [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) | 完整外部运行时的会话、工具、Hooks 与权限边界 |
| [OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) | 按模型能力配置缓存，使用服务返回的 usage 观测 |
| [DeepSeek Context caching](https://api-docs.deepseek.com/guides/kv_cache/) | 完整持久前缀匹配、自动缓存及实际命中字段 |

接入阶段固定依赖和协议版本，按实际模型复核能力；参考项目的新版本不自动改变本规格。
