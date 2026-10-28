/**
 * 管理容器中终端 CLI 的安装和能力状态。
 * 通过注入的 Docker/进程驱动检查和安装 CLI，规范安全失败并响应取消；只准备镜像，不自动绑定凭据或改旧任务配置。
 * EN: Manages installation and capability state for terminal CLIs inside containers. Uses injected Docker/process drivers for cancellable checks/installations and sanitized failures, preparing images without rebinding credentials or existing runs.
 */
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { AgentTerminalProfile, AppError, invariant } from '../../contracts/src/index.js';
import { TerminalAppId, type TerminalCliInstallationPhase } from '../../contracts/src/terminal-control.js';
import type { DockerCommandOptions, DockerCommandResult, DockerTransport } from './docker-agent.js';
import { TerminalResourcePool } from './terminal-resources.js';
import type { TerminalCliCapability } from '../../contracts/src/terminal-runtime.js';
import type { Store } from '../../storage/src/index.js';
import { z } from 'zod';
import { terminalCliInstallFailure } from '../../contracts/src/cli-installation.js';
import { ANTIGRAVITY_VERSION, antigravityInstallStep } from './antigravity-install.js';

const ProbeRecord = z
  .object({
    id: z.string().uuid(),
    name: z.string().regex(/^elysia-cli-check-[a-f0-9-]{36}$/),
    owner: z.string().regex(/^[a-f0-9]{32}$/),
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
type ProbeRecord = z.infer<typeof ProbeRecord>;
type SharedProbe = {
  id: string;
  controller: AbortController;
  subscribers: Set<symbol>;
  promise: Promise<DockerCommandResult>;
};

const packages = {
  codex: { name: '@openai/codex', version: '0.162.1', executable: 'codex' },
  dsh: { name: '@deepseek-ai/dsh', version: '0.2.1-alpha.2', executable: 'dsh' },
  claude: { name: '@anthropic-ai/claude-code', version: '2.1.296', executable: 'claude' },
  gemini: { name: '@google/gemini-cli', version: '0.63.0', executable: 'gemini' },
  antigravity: { name: '', version: ANTIGRAVITY_VERSION, executable: 'agy' },
};
/**
 * 只接受完整的小写Docker SHA-256镜像ID，去除输出首尾空白后检查。
 * EN: Accepts only a complete lowercase Docker SHA-256 image ID after trimming surrounding output whitespace.
 */
const digest = (value: string) => /^sha256:[a-f0-9]{64}$/.test(value.trim());
/**
 * 命令成功还必须无超时且输出未截断，不能仅凭退出码接受不完整检测证据。
 * EN: A command is complete only with a zero exit code, no timeout, and no truncation; exit status alone is insufficient probe evidence.
 */
const complete = (result: DockerCommandResult) =>
  result.exitCode === 0 && !result.timedOut && !result.truncated;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9][a-zA-Z0-9.-]*)?$/;
/**
 * 从有界版本横幅中提取唯一语义版本；多匹配或格式异常返回undefined，避免把依赖版本误当CLI版本。
 * EN: Extracts one unique semantic version from a bounded banner; ambiguity or invalid syntax returns undefined instead of mistaking a dependency version for the CLI version.
 */
function detectedCliVersion(banner: string | undefined): string | undefined {
  if (!banner || banner.length > 200) return;
  const matches = [
    ...banner.matchAll(/(?:^|[ \t(])v?([0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9][a-zA-Z0-9.-]*)?)(?=$|[ \t)])/g),
  ];
  const version = matches.length === 1 ? matches[0][1] : undefined;
  return version && version.length <= 80 && VERSION.test(version) ? version : undefined;
}
/**
 * 仅在内存中分类有界构建输出，返回固定错误类别；不回显或持久化可能含敏感值的原始输出。
 * EN: Classifies bounded build output in memory and returns a fixed error category without echoing or persisting possibly sensitive raw output.
 */
function buildFailure(result: DockerCommandResult): AppError {
  /**
   * 只检查已经有界截取的输出，绝不返回或保存其中任何内容。
   * EN: Only inspect the already bounded capture; never return or persist any part of it.
   */
  const output = `${result.stderr.slice(0, 20000)}\n${result.stdout.slice(0, 20000)}`.slice(0, 20000);
  const code = result.timedOut
    ? 'TERMINAL_CLI_INSTALL_TIMEOUT'
    : /\b(?:ENOSPC|no space left on device|disk quota exceeded)\b/i.test(output)
      ? 'TERMINAL_CLI_INSTALL_STORAGE'
      : /\b(?:ETARGET|E404)\b|No matching version found|not in this registry/i.test(output)
        ? 'TERMINAL_CLI_INSTALL_PACKAGE_VERSION'
        : /\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN)\b|TLS handshake timeout|certificate signed by unknown authority/i.test(
              output,
            )
          ? 'TERMINAL_CLI_INSTALL_NETWORK'
          : /Cannot connect to the Docker daemon|error during connect|daemon is not running|failed to dial|rpc error: code = Unavailable/i.test(
                output,
              )
            ? 'TERMINAL_CLI_INSTALL_ENGINE'
            : 'TERMINAL_CLI_INSTALL';
  const failure = terminalCliInstallFailure(code);
  return new AppError(failure.code, failure.message);
}

export interface TerminalCliStatus {
  available: boolean;
  engineAvailable?: boolean;
  imageAvailable: boolean;
  installed: boolean | null;
  version?: string;
  imageId?: string;
  code?: string;
  message: string;
}
export interface TerminalCliInstallation {
  image: string;
  imageTag: string;
  version: string;
}
export interface TerminalResumeCapability {
  supported: boolean;
  reason: string;
  version?: string;
}

/**
 * 仅执行显式管理操作，不使用宿主CLI、凭据、工作区挂载或可变镜像复用。 管理 Docker 中 CLI 的检测、能力记录、安装和资源容量检查。
 * EN: Explicit management actions only: no host CLI, credentials, workspace mounts or mutable image reuse. Manages Docker CLI inspection, capability records, installation, and resource-capacity checks.
 */
export class DockerCliManager {
  private busy = false;
  private readonly probes = new Map<string, TerminalCliStatus>();
  private readonly resumeProbes = new Map<string, Promise<TerminalResumeCapability>>();
  private owner: string;
  private capacityProbe?: Promise<void>;
  private capacityCheckedAt = 0;
  private readonly resources: TerminalResourcePool;
  private readonly inFlight = new Map<string, SharedProbe>();
  private readonly probeRecords = new Map<string, ProbeRecord>();
  private reconciling?: Promise<void>;
  private closed = false;
  /**
   * 绑定数据目录归属和传输实现，恢复可证明归属的探测记录并保留其资源，等待清理核验。
   * EN: Binds data-directory ownership and transport, restoring only provably owned probe records and retaining their resources until cleanup is verified.
   */
  constructor(
    private directory: string,
    private options: { transport: DockerTransport; resources?: TerminalResourcePool; store?: Store },
  ) {
    this.owner = createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0, 32);
    this.resources = options.resources ?? new TerminalResourcePool();
    if (!options.resources) this.resources.configure(4, 4096);
    for (const row of options.store?.db
      .prepare("SELECT value FROM storage_meta WHERE key LIKE 'cli-probe:%'")
      .all() ?? []) {
      try {
        const record = ProbeRecord.parse(JSON.parse((row as { value: string }).value));
        if (record.owner !== this.owner || record.name !== `elysia-cli-check-${record.id}`) continue;
        this.probeRecords.set(record.id, record);
        this.resources.hold(record.id, '服务曾中断，离线检测容器尚未确认清理', 'probe');
      } catch {
        /**
         * 未知记录不能授权修改Docker资源。
         * EN: Unknown records do not authorize Docker mutations.
         */
      }
    }
  }
  /**
   * 统一Docker命令的本机工作目录，允许调用方覆盖超时、输出和取消选项，不经宿主shell。
   * EN: Centralizes the local working directory for Docker commands, allowing explicit timeout, output, and abort overrides without a host shell.
   */
  private command(args: string[], options: Partial<DockerCommandOptions> = {}) {
    return this.options.transport.run(args, { cwd: this.directory, ...options });
  }
  /**
   * 先更新内存归属记录，再保存小型持久元数据，供崩溃后核对并清理探测容器。
   * EN: Updates in-memory ownership and persists small metadata so probe containers can be identified and cleaned after a crash.
   */
  private saveProbe(record: ProbeRecord) {
    this.probeRecords.set(record.id, record);
    this.options.store?.db
      .prepare(
        'INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run('cli-probe:' + record.id, JSON.stringify(record));
  }
  /**
   * 按持久探测记录核对容器标签后清理；停止未确认时不能释放 held 资源。
   * EN: Validates container labels against persistent probe ownership before cleanup; unconfirmed stops retain held resources.
   */
  private async cleanupProbe(id: string) {
    const record = this.probeRecords.get(id);
    if (!record) return;
    const inspected = await this.command(['inspect', '--format', '{{json .Config.Labels}}', record.name], {
      timeoutMs: 12000,
      outputLimit: 4000,
    });
    if (!complete(inspected)) {
      invariant(
        !inspected.timedOut && !inspected.truncated && /No such (container|object)/i.test(inspected.stderr),
        'TERMINAL_CLI_CLEANUP',
        '离线检测容器尚未确认清理，请检查 Docker 后重新检测',
      );
    } else {
      let labels: Record<string, string>;
      try {
        labels = JSON.parse(inspected.stdout);
      } catch {
        throw new AppError('TERMINAL_CLI_CLEANUP', '无法确认离线检测容器归属，请检查 Docker');
      }
      invariant(
        labels?.['io.elysia.cli-manager'] === record.owner && labels?.['io.elysia.cli-probe'] === record.id,
        'TERMINAL_CLI_CLEANUP',
        '离线检测容器归属不匹配，未执行清理',
      );
      const removed = await this.command(['rm', '--force', record.name], {
        timeoutMs: 12000,
        outputLimit: 4000,
      });
      invariant(
        complete(removed) ||
          (!removed.timedOut && !removed.truncated && /No such (container|object)/i.test(removed.stderr)),
        'TERMINAL_CLI_CLEANUP',
        '离线检测容器尚未确认清理，请检查 Docker 后重新检测',
      );
    }
    this.probeRecords.delete(id);
    this.options.store?.db.prepare('DELETE FROM storage_meta WHERE key=?').run('cli-probe:' + id);
    this.resources.confirmStopped(id);
    this.resources.release(id);
  }
  /**
   * 合并并发恢复请求，先解决上次遗留的 held 探测，再开始新的 CLI 检查。
   * EN: Coalesces recovery requests and resolves probes left held by the previous process before starting a new CLI inspection.
   */
  private reconcileProbes() {
    if (this.reconciling) return this.reconciling;
    this.reconciling = (async () => {
      for (const item of this.resources
        .snapshot()
        .reservations.filter((item) => item.kind === 'probe' && item.held))
        await this.cleanupProbe(item.id);
    })().finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }
  /**
   * 相同固定镜像/命令检查共享短期离线容器。每个调用方只取消自己的订阅，最后一个 订阅者离开时才中止底层探测；无网络且只读，仍须单独核对清理结果才释放资源。
   * EN: Shares short-lived offline containers for identical pinned-image and command checks. A caller cancels only its subscription; the final subscriber aborts the probe. The container is read-only and offline, but cleanup still needs independent confirmation before resources are released.
   */
  private sharedProbe(
    key: string,
    imageId: string,
    executable: string,
    args: string[],
    signal?: AbortSignal,
    sponsorId?: string,
  ): Promise<DockerCommandResult> {
    invariant(!this.closed, 'TERMINAL_CLI_CLOSED', '终端检测服务正在退出，请稍后重试');
    signal?.throwIfAborted();
    let entry = this.inFlight.get(key);
    if (!entry) {
      const id = randomUUID(),
        controller = new AbortController();
      entry = {
        id,
        controller,
        subscribers: new Set(),
        promise: Promise.resolve()
          .then(async () => {
            const timer = setTimeout(
              () =>
                controller.abort(
                  new AppError('TERMINAL_CLI_PROBE_TIMEOUT', '离线检测等待或运行超时，请稍后重试'),
                ),
              30000,
            );
            let dispatched = false;
            try {
              await this.refreshResourceCapacity(controller.signal);
              await this.resources.acquireProbe(id, controller.signal, sponsorId);
              controller.signal.throwIfAborted();
              const record = { id, name: `elysia-cli-check-${id}`, owner: this.owner, imageId };
              this.saveProbe(record);
              dispatched = true;
              return await this.command(
                [
                  'run',
                  '--rm',
                  '--pull',
                  'never',
                  '--name',
                  record.name,
                  '--label',
                  `io.elysia.cli-manager=${this.owner}`,
                  '--label',
                  `io.elysia.cli-probe=${id}`,
                  '--network',
                  'none',
                  '--read-only',
                  '--tmpfs',
                  '/tmp:rw,noexec,nosuid,size=32m',
                  '--cap-drop',
                  'ALL',
                  '--security-opt',
                  'no-new-privileges',
                  '--pids-limit',
                  '64',
                  '--memory',
                  '256m',
                  '--cpus',
                  '1',
                  '--user',
                  '1000:1000',
                  '--env',
                  'HOME=/tmp',
                  '--entrypoint',
                  executable,
                  imageId,
                  ...args,
                ],
                {
                  signal: controller.signal,
                  timeoutMs: 20000,
                  outputLimit: args[0] === '--version' ? 4000 : 16000,
                },
              );
            } finally {
              clearTimeout(timer);
              if (dispatched) {
                try {
                  await this.cleanupProbe(id);
                } catch (error) {
                  this.resources.hold(id, '离线检测容器尚未确认停止，资源暂时保留', 'probe');
                  throw error;
                }
              } else this.resources.release(id);
            }
          })
          .finally(() => {
            if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
          }),
      };
      this.inFlight.set(key, entry);
    }
    this.resources.sponsorProbe(entry.id, sponsorId);
    const token = Symbol(),
      current = entry;
    current.subscribers.add(token);
    return new Promise((resolve, reject) => {
      let finished = false;
      /**
       * 移除此调用方的订阅和取消监听，不影响仍在等待同一探测的其他订阅者。
       * EN: Removes this caller's subscription and abort listener without affecting others awaiting the same probe.
       */
      const detach = () => {
        current.subscribers.delete(token);
        signal?.removeEventListener('abort', abort);
      };
      /**
       * 只结算本订阅一次；最后一个订阅者取消时才中止共享探测，保留其他订阅者的结果等待。
       * EN: Settles this subscription once; only the final subscriber's cancellation aborts the shared probe, preserving other subscribers' waits.
       */
      const abort = () => {
        if (finished) return;
        finished = true;
        detach();
        if (!current.subscribers.size) current.controller.abort(signal?.reason);
        reject(signal?.reason ?? new AppError('TERMINAL_CLI_CANCELLED', '检测已取消'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      current.promise.then(
        (value) => {
          if (!finished) {
            finished = true;
            detach();
            resolve(value);
          }
        },
        (error) => {
          if (!finished) {
            finished = true;
            detach();
            reject(error);
          }
        },
      );
      if (signal?.aborted) abort();
    });
  }
  /**
   * 拒绝新检测，中止当前共享探测，并等待所有探测完成各自的清理路径。
   * EN: Rejects new inspections, aborts shared probes, and waits for each probe to finish its cleanup path.
   */
  async dispose() {
    this.closed = true;
    for (const probe of this.inFlight.values())
      probe.controller.abort(new AppError('TERMINAL_CLI_CLOSED', '终端检测服务正在退出'));
    await Promise.allSettled([...this.inFlight.values()].map((probe) => probe.promise));
  }
  /**
   * 刷新 Docker 资源容量；短时间内复用上次检查和在途请求。
   * EN: Refreshes Docker capacity, briefly reusing a recent result or an in-flight request.
   */
  async refreshResourceCapacity(signal?: AbortSignal, force = false) {
    if (!this.options.resources) return;
    if (!force && Date.now() - this.capacityCheckedAt < 15000) return this.capacityProbe;
    if (this.capacityProbe) return this.capacityProbe;
    this.capacityProbe = (async () => {
      try {
        const result = await this.command(
          ['info', '--format', '{"os":{{json .OSType}},"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}}}'],
          { signal, timeoutMs: 8000, outputLimit: 1000 },
        );
        invariant(complete(result), 'DOCKER_UNAVAILABLE', 'Docker 资源检测未完成，请检查 Linux 引擎');
        const info = JSON.parse(result.stdout) as { os: string; cpus: number; memoryBytes: number };
        invariant(info.os === 'linux', 'DOCKER_PLATFORM', '终端需要 Docker Linux 容器模式');
        this.options.resources!.configure(info.cpus, info.memoryBytes / 1024 / 1024);
      } catch (error) {
        if (!signal?.aborted)
          this.options.resources!.unavailable(
            error instanceof AppError ? error.message : 'Docker 资源检测未完成',
          );
      } finally {
        if (!signal?.aborted) this.capacityCheckedAt = Date.now();
      }
    })().finally(() => {
      this.capacityProbe = undefined;
    });
    return this.capacityProbe;
  }
  /**
   * 返回静态能力声明，明确区分条件支持、未支持和未知用量；此视图不代表真实CLI已验证。
   * EN: Returns explicit capability declarations distinguishing conditional support, unsupported features, and unknown usage; the view is not proof that a real CLI was verified.
   */
  capabilityMatrix(): TerminalCliCapability[] {
    return TerminalAppId.options.map((appId) => ({
      appId,
      execution: {
        status: 'conditional',
        validation: 'fixed-image-required',
        realVerified: false,
        reason: '已有执行适配器；启动前仍需检测选定固定镜像、命令与连接配置',
      },
      planning: {
        status: 'unsupported',
        validation: 'unverified',
        realVerified: false,
        reason: '尚未验证固定 CLI 的规划协议与只读工作区约束，终端不能开启计划模式',
      },
      resume:
        appId === 'codex'
          ? {
              status: 'conditional',
              validation: 'fixed-image-required',
              realVerified: false,
              reason: '仅在固定镜像帮助确认所有续接参数，且同任务会话 seal 一致时允许显式续接',
            }
          : {
              status: 'unsupported',
              validation: 'unverified',
              realVerified: false,
              reason: '尚未核实该 CLI 的原会话续接协议，可显式开启新会话',
            },
      usage: {
        status: 'unknown',
        validation: 'unverified',
        realVerified: false,
        reason: '尚未核实固定版本的用量协议，未知用量不会记为零或推断费用',
      },
    }));
  }
  /**
   * 检查Docker服务端响应及Linux模式；失败返回可解释错误，不自动启动引擎或切换模式。
   * EN: Checks the Docker server response and Linux mode, raising an explanatory error without starting the engine or changing its mode.
   */
  private async engine(signal?: AbortSignal) {
    const result = await this.command(['version', '--format', '{{json .Server}}'], { signal });
    invariant(complete(result), 'DOCKER_UNAVAILABLE', 'Docker Linux 引擎未就绪，请启动 Docker Desktop');
    let server: { Os?: string; Version?: string };
    try {
      server = JSON.parse(result.stdout);
    } catch {
      throw new AppError('DOCKER_UNAVAILABLE', 'Docker 返回信息不完整，请检查 Docker Desktop');
    }
    invariant(server?.Os === 'linux', 'DOCKER_PLATFORM', 'CLI 管理需要 Docker Linux 容器模式');
  }
  /**
   * 只检查本地镜像并返回可核验的不可变摘要；命令失败或输出不完整时返回undefined，不自动拉取。
   * EN: Inspects a local image and returns a verifiable immutable digest; failed or incomplete output returns undefined and never triggers a pull.
   */
  private async image(image: string, signal?: AbortSignal) {
    const result = await this.command(['image', 'inspect', '--format', '{{.Id}}', image], { signal });
    return complete(result) && digest(result.stdout) ? result.stdout.trim() : undefined;
  }
  /**
   * 按不可变镜像摘要和可执行名称缓存版本探测，不把可变镜像标签作为能力缓存身份。 引擎/镜像/CLI 失败分别返回状态；该离线检查不验证外部模型凭据。
   * EN: Caches version probes by immutable image digest and executable name rather than a mutable profile tag. Engine, image, and CLI failures remain distinct; this offline inspection does not authenticate external model credentials.
   */
  async check(
    rawAppId: TerminalAppId,
    rawProfile: AgentTerminalProfile,
    signal?: AbortSignal,
    sponsorId?: string,
  ): Promise<TerminalCliStatus> {
    const appId = TerminalAppId.parse(rawAppId),
      profile = AgentTerminalProfile.parse(rawProfile);
    let imageAvailable = false,
      engineAvailable = false;
    try {
      invariant(!this.closed, 'TERMINAL_CLI_CLOSED', '终端检测服务正在退出，请稍后重试');
      signal?.throwIfAborted();
      await this.engine(signal);
      await this.reconcileProbes();
      signal?.throwIfAborted();
      engineAvailable = true;
      const imageId = await this.image(profile.image, signal);
      if (!imageId)
        return {
          available: false,
          engineAvailable,
          imageAvailable: false,
          installed: null,
          code: 'DOCKER_IMAGE_MISSING',
          message: '尚未安装该 CLI 镜像',
        };
      imageAvailable = true;
      const executable = profile.command[0];
      invariant(
        /^[A-Za-z0-9_./-]+$/.test(executable) && !executable.startsWith('-'),
        'TERMINAL_CLI_EXECUTABLE',
        '自定义 CLI 需要一个明确的可执行程序',
      );
      const probeKey = `${imageId}:${executable}`;
      const cached = this.probes.get(probeKey);
      if (cached) return { ...cached };
      const result = await this.sharedProbe(
        'version:' + probeKey,
        imageId,
        executable,
        ['--version'],
        signal,
        sponsorId,
      );
      if (!complete(result))
        return {
          available: false,
          engineAvailable,
          imageAvailable: true,
          installed: false,
          imageId,
          code: 'TERMINAL_CLI_UNAVAILABLE',
          message: '镜像中的 CLI 不可用或版本检测未完成',
        };
      const version = result.stdout.trim().split(/\r?\n/)[0];
      if (!version || version.length > 200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(version))
        return {
          available: false,
          engineAvailable,
          imageAvailable: true,
          installed: false,
          imageId,
          code: 'TERMINAL_CLI_VERSION',
          message: 'CLI 未返回可识别的版本信息',
        };
      const status: TerminalCliStatus = {
        available: true,
        engineAvailable,
        imageAvailable: true,
        installed: true,
        imageId,
        version,
        message: 'CLI 已安装',
      };
      if (this.probes.size >= 64) this.probes.delete(this.probes.keys().next().value!);
      this.probes.set(probeKey, status);
      return { ...status };
    } catch (error) {
      return {
        available: false,
        engineAvailable,
        imageAvailable,
        installed: null,
        code: error instanceof AppError ? error.code : 'TERMINAL_CLI_CHECK',
        message: error instanceof AppError ? error.message : 'CLI 检测未完成，请检查 Docker 后重试',
      };
    }
  }
  /**
   * 用户显式安装入口：使用固定版本构建派生镜像，受安装资源预约和取消信号约束。
   * EN: Explicit user installation entry point: builds a derived image from fixed versions under installation-resource reservations and cancellation.
   */
  async install(
    input: { appId: TerminalAppId; baseImage: string; version?: string },
    signal?: AbortSignal,
    onPhase?: (phase: TerminalCliInstallationPhase) => void,
  ): Promise<TerminalCliInstallation> {
    const appId = TerminalAppId.parse(input.appId);
    invariant(appId !== 'custom', 'TERMINAL_CLI_CUSTOM_INSTALL', '自定义 CLI 使用自行构建的镜像');
    invariant(!this.busy, 'TERMINAL_CLI_BUSY', '已有 CLI 安装正在进行，请等待完成');
    const item = packages[appId],
      version = input.version ?? item.version;
    invariant(
      VERSION.test(version) && version.length <= 80,
      'TERMINAL_CLI_VERSION',
      '请填写明确的 CLI 版本号',
    );
    invariant(
      /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,199}$/.test(input.baseImage),
      'TERMINAL_CLI_IMAGE',
      '基础镜像名称无效',
    );
    this.busy = true;
    const reservationId = `installation:${randomUUID()}`;
    try {
      onPhase?.('engine');
      await this.engine(signal);
      if (this.options.resources) {
        await this.refreshResourceCapacity(signal, true);
        onPhase?.('queued');
        await this.options.resources.acquireInstallation(reservationId, signal);
      }
      onPhase?.('base-image');
      const existing = await this.image(input.baseImage, signal);
      invariant(
        existing || /^elysia-agents:[0-9]+\.[0-9]+\.[0-9]+$/.test(input.baseImage),
        'DOCKER_IMAGE_MISSING',
        '基础镜像不存在，请先构建或导入；不会拉取自定义镜像',
      );
      /**
       * BuildKit可可靠解析带名称的本地镜像，裸配置ID可能被误当作注册表名称。 保留此内容寻址别名，使未来任务快照仍能使用原镜像ID。
       * EN: BuildKit resolves named local images reliably; a bare configuration ID may be treated as a registry name. Keep this content-addressed alias so future task snapshots can still use the original image ID.
       */
      let baseAlias: string | undefined;
      if (existing) {
        baseAlias = `elysia-managed/base:${existing.slice('sha256:'.length)}`;
        const previous = await this.image(baseAlias, signal);
        invariant(
          !previous || previous === existing,
          'TERMINAL_CLI_IMAGE',
          '受管基础镜像标记与镜像内容不一致，请检查 Docker',
        );
        if (!previous) {
          const tagged = await this.command(['image', 'tag', existing, baseAlias], { signal });
          invariant(
            complete(tagged) && (await this.image(baseAlias, signal)) === existing,
            'TERMINAL_CLI_IMAGE',
            '无法固定基础镜像内容，请检查 Docker',
          );
        }
      }
      const imageTag = `elysia-managed/${appId}:${randomUUID()}`;
      const prelude = existing
        ? `FROM ${baseAlias}\nUSER root\n`
        : 'FROM node:24-bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends bash git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*\n';
      const install = existing
        ? appId === 'antigravity'
          ? []
          : [`${item.name}@${version}`]
        : [
            `${packages.codex.name}@${appId === 'codex' ? version : packages.codex.version}`,
            `${packages.dsh.name}@${appId === 'dsh' ? version : packages.dsh.version}`,
            ...(['codex', 'dsh', 'antigravity'].includes(appId) ? [] : [`${item.name}@${version}`]),
          ];
      const npmStep = install.length
        ? `RUN npm install --global ${install.map((specifier) => JSON.stringify(specifier)).join(' ')} && npm cache clean --force\n`
        : '';
      const binaryStep = appId === 'antigravity' ? antigravityInstallStep(version) : '';
      const dockerfile = `${prelude}${npmStep}${binaryStep}RUN mkdir -p /home/agent /workspace && chown node:node /home/agent /workspace\nLABEL io.elysia.cli-manager=${JSON.stringify(this.owner)} io.elysia.cli=${JSON.stringify(appId)} io.elysia.cli-version=${JSON.stringify(version)}\nUSER 1000:1000\nWORKDIR /workspace\nENV HOME=/home/agent CODEX_HOME=/home/agent/.codex DSH_HOME=/home/agent/.dsh\nCMD [${JSON.stringify(item.executable)}, "--version"]\n`;
      /**
       * 只通过stdin发送Dockerfile，不把项目文件或凭据作为构建上下文。
       * EN: A Dockerfile-only stdin build sends no project files or credentials as context.
       */
      onPhase?.('build');
      const result = await this.command(['build', '--pull=false', '--tag', imageTag, '-'], {
        signal,
        input: dockerfile,
        timeoutMs: 600000,
        outputLimit: 20000,
      });
      if (result.exitCode !== 0 || result.timedOut) throw buildFailure(result);
      signal?.throwIfAborted();
      onPhase?.('verify');
      const image = await this.image(imageTag, signal);
      invariant(image, 'TERMINAL_CLI_VERIFY', '构建完成后无法确认镜像，请重新检测');
      this.options.resources?.release(reservationId);
      const verified = await this.check(
        appId,
        AgentTerminalProfile.parse({
          id: randomUUID(),
          label: item.executable,
          agent: appId,
          image,
          command: [item.executable],
          protocol: 'text',
          environment: [],
        }),
        signal,
      );
      signal?.throwIfAborted();
      invariant(
        verified.available && verified.installed,
        verified.code ?? 'TERMINAL_CLI_INSTALL',
        verified.message,
      );
      const actualVersion = detectedCliVersion(verified.version);
      invariant(actualVersion, 'TERMINAL_CLI_VERSION', '安装后的 CLI 未返回可确定的版本号，请重新检测或安装');
      if (actualVersion !== version) {
        const details = { actualVersion, requestedVersion: version };
        const failure = terminalCliInstallFailure('TERMINAL_CLI_VERSION_MISMATCH', details);
        throw new AppError(failure.code, failure.message, false, details);
      }
      onPhase?.('complete');
      return { image, imageTag, version: actualVersion };
    } finally {
      this.options.resources?.release(reservationId);
      this.busy = false;
    }
  }
  /**
   * 离线探测任务固定镜像，不探测宿主CLI或模板中的可变标签。 检查固定镜像的实际 CLI 帮助和版本后判断 resume 支持，不仅依据代理名称推测参数。
   * EN: Probe the exact task image offline, never a host CLI or the mutable profile tag. Checks actual help and version output from the pinned image before deciding resume support, rather than guessing flags from the agent name.
   */
  async resumeCapability(profile: AgentTerminalProfile, imageId: string): Promise<TerminalResumeCapability> {
    if (profile.agent !== 'codex' || profile.protocol !== 'codex-jsonl')
      return { supported: false, reason: '当前 CLI 尚未验证原会话续接；可显式开启新会话' };
    const flags = new Set([
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--ignore-user-config',
    ]);
    if (
      profile.command[0] !== 'codex' ||
      profile.command[1] !== 'exec' ||
      profile.command.at(-1) !== '-' ||
      !profile.command.includes('--json') ||
      profile.command.slice(2, -1).some((flag) => !flags.has(flag))
    )
      return { supported: false, reason: '当前 Codex 命令不支持安全转换为指定会话续接；可开启新会话' };
    invariant(digest(imageId), 'TERMINAL_CLI_IMAGE', '续接需要固定的实际镜像内容');
    const key = `${imageId}:${JSON.stringify(profile.command)}`;
    const existing = this.resumeProbes.get(key);
    if (existing) return existing;
    const promise = this.probeResume(profile, imageId).catch((error) => {
      this.resumeProbes.delete(key);
      throw error;
    });
    if (this.resumeProbes.size >= 64) this.resumeProbes.delete(this.resumeProbes.keys().next().value!);
    this.resumeProbes.set(key, promise);
    const result = await promise;
    if (!result.version) this.resumeProbes.delete(key);
    return result;
  }
  /**
   * 先验证固定Codex镜像可执行，再离线读取resume帮助并逐项确认冻结命令需要的参数，形成续接能力证据。
   * EN: Verifies the pinned Codex image, reads resume help offline, and checks every flag required by the frozen command to establish continuation capability.
   */
  private async probeResume(
    profile: AgentTerminalProfile,
    imageId: string,
  ): Promise<TerminalResumeCapability> {
    const status = await this.check('codex', { ...profile, image: imageId });
    if (!status.available) return { supported: false, reason: status.message };
    const result = await this.sharedProbe('resume-help:' + imageId, imageId, 'codex', [
      'exec',
      'resume',
      '--help',
    ]);
    const supported =
      complete(result) &&
      /codex exec resume/.test(result.stdout) &&
      /SESSION_ID/.test(result.stdout) &&
      /PROMPT/.test(result.stdout) &&
      profile.command.slice(2, -1).every((flag) => result.stdout.includes(flag));
    return {
      supported,
      ...(complete(result) ? { version: status.version } : {}),
      reason: supported
        ? '当前镜像已验证 Codex 指定会话续接命令'
        : '当前镜像的 Codex 帮助未确认所需续接参数；可开启新会话',
    };
  }
}
