# 验收包与本地交付

## 取得并运行验收包

从 v1.24.0 起，验收材料可独立打包。正式仓库保存运行器和交付检查，测试脚本、合成数据和报告保留在被忽略的本地目录。新检出目录需要同时取得对应版本的验收包；仅有 Git 源码无法运行包内用例。

本轮验收包需要 Windows x64、Node.js 24.15.0、pnpm 11 和 Git。源码目录安装锁定依赖后运行：

```powershell
pnpm install --frozen-lockfile
pnpm verify:local --bundle C:/delivery/acceptance-v1.24.0 --output .local-qa/release-check
pnpm verify:check --bundle C:/delivery/acceptance-v1.24.0 --report .local-qa/release-check/verification.json
```

包必须匹配当前应用版本、构建输入摘要、锁文件、Node 精确版本、操作系统和 CPU 架构。运行器先校验清单和每个文件的 SHA-256，再把缺失的材料复制到 `.local-tests/`。已有文件内容不同时，运行器拒绝覆盖并退出。报告目录也必须是新目录。

每次验收依次执行前后端类型检查、前后端生产构建及包内全部入口。非零退出、启动失败或超时均记为失败，后续入口不再执行。报告保留已执行项及各自日志；缺少任一必需项不能通过交付检查。验收结束时再次核对构建输入和材料，避免验证过程中内容改变。

可用 `node scripts/verification.mjs inspect --bundle 包目录` 只读核对清单。运行器也支持 `--root 源码目录`，用于对另一份干净源码副本复验。无参数的 `pnpm verify:local` 保留历史 `.local-tests/verify.ts` 入口；该入口没有生成交付报告，不能直接用于打包放行。

验收包包含可执行脚本，应由维护者提供并核对。摘要用于检测内容变化，不证明发布者身份。运行器设置 `ELYSIA_VERIFICATION_OFFLINE=1` 供脚本识别，但不提供网络沙箱；本轮包内夹具自行拒绝外网或注入合成服务，真实模型调用未执行。

## 制作验收包

维护者在 `.local-tests/` 内保存包规格，然后执行：

```powershell
pnpm verify:bundle --spec .local-tests/release-v1240/bundle-spec.json --output .local-qa/acceptance-v1.24.0
```

规格为 JSON 对象，包含以下字段：

| 字段                 | 含义与约束                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `files`              | 1 至 512 个文件路径，包括入口及其辅助材料。全部位于 `.local-tests/`，扩展名限定为 `ts`、`tsx`、`mjs`、`cjs` 或 `json`。 |
| `suites`             | 1 至 32 个入口，按数组顺序执行。每项含 `id`、`entry`、`timeoutMs`，可选 `args`。                                        |
| `suites[].id`        | 小写字母开头，可含数字和连字符，最多 64 字符。标识不能重复，也不能占用四个类型检查与构建步骤的名称。                    |
| `suites[].entry`     | 必须在 `files` 中，且为可执行脚本。TypeScript 入口通过本地 `tsx` 运行。                                                 |
| `suites[].timeoutMs` | 1,000 至 600,000 毫秒。Windows 超时会结束本次检查的子进程树。                                                           |
| `suites[].args`      | 最多 16 个字符串参数，每项最多 1,000 字符；直接传给进程，不经过 Shell 拼接。                                            |

包内文件总量上限为 64 MiB。制作与读取均拒绝路径越界、链接及大小写重复的文件名。构建输入或脚本变化后需要生成新包、重新验收；不能修改旧报告冒充新结果。保留原始失败报告和仍有用途的复验材料。

## 打包检查

Windows 打包命令必须取得匹配当前输入的完整通过报告：

```powershell
pnpm package:windows --verification-bundle C:/delivery/acceptance-v1.24.0 --verification-report .local-qa/release-check/verification.json
```

命令在构建前检查报告，生成便携目录前再次核对。缺少材料、内容摘要变化、版本不符、未执行完或存在失败时，命令退出且不放行正式输出。便携包的 `resources/app/distribution.json` 记录验收包摘要、构建输入摘要和验收时间，便于对应本地报告。

通过本地交付检查只说明包内列出的检查成功。真实模型质量、供应商费用与缓存、Docker 执行、安装升级、签名和公开发布仍按各自条件验收。本地报告不是签名证明，本地打包也不发布到外部平台。
