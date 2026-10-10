import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { AgentTerminalProfile, AppError, invariant } from '../../contracts/src/index.js';
import { TerminalAppId, type TerminalCliInstallationPhase } from '../../contracts/src/terminal-control.js';
import type { DockerCommandOptions, DockerCommandResult, DockerTransport } from './docker-agent.js';
import { TerminalResourcePool } from './terminal-resources.js';
import type { TerminalCliCapability } from '../../contracts/src/terminal-runtime.js';
import type { Store } from '../../storage/src/index.js';
import { z } from 'zod';

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
};
const digest = (value: string) => /^sha256:[a-f0-9]{64}$/.test(value.trim());
const complete = (result: DockerCommandResult) =>
  result.exitCode === 0 && !result.timedOut && !result.truncated;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9][a-zA-Z0-9.-]*)?$/;

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

/** Explicit management actions only: no host CLI, credentials, workspace mounts or mutable image reuse. */
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
        /* Unknown records do not authorize Docker mutations. */
      }
    }
  }
  private command(args: string[], options: Partial<DockerCommandOptions> = {}) {
    return this.options.transport.run(args, { cwd: this.directory, ...options });
  }
  private saveProbe(record: ProbeRecord) {
    this.probeRecords.set(record.id, record);
    this.options.store?.db
      .prepare(
        'INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run('cli-probe:' + record.id, JSON.stringify(record));
  }
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
      const detach = () => {
        current.subscribers.delete(token);
        signal?.removeEventListener('abort', abort);
      };
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
  async dispose() {
    this.closed = true;
    for (const probe of this.inFlight.values())
      probe.controller.abort(new AppError('TERMINAL_CLI_CLOSED', '终端检测服务正在退出'));
    await Promise.allSettled([...this.inFlight.values()].map((probe) => probe.promise));
  }
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
  capabilityMatrix(): TerminalCliCapability[] {
    return (['codex', 'dsh', 'claude', 'gemini', 'custom'] as const).map((appId) => ({
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
  private async image(image: string, signal?: AbortSignal) {
    const result = await this.command(['image', 'inspect', '--format', '{{.Id}}', image], { signal });
    return complete(result) && digest(result.stdout) ? result.stdout.trim() : undefined;
  }
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
      const version = result.stdout.trim().split(/\r?\n/)[0]?.slice(0, 200);
      if (!version || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(version))
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
      // BuildKit resolves named local images reliably; a bare configuration ID may be treated as a registry name.
      // Keep this content-addressed alias so future task snapshots can still use the original image ID.
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
        ? [`${item.name}@${version}`]
        : [
            `${packages.codex.name}@${appId === 'codex' ? version : packages.codex.version}`,
            `${packages.dsh.name}@${appId === 'dsh' ? version : packages.dsh.version}`,
            ...(['codex', 'dsh'].includes(appId) ? [] : [`${item.name}@${version}`]),
          ];
      const dockerfile = `${prelude}RUN npm install --global ${install.map((specifier) => JSON.stringify(specifier)).join(' ')} && npm cache clean --force && mkdir -p /home/agent /workspace && chown node:node /home/agent /workspace\nLABEL io.elysia.cli-manager=${JSON.stringify(this.owner)} io.elysia.cli=${JSON.stringify(appId)} io.elysia.cli-version=${JSON.stringify(version)}\nUSER 1000:1000\nWORKDIR /workspace\nENV HOME=/home/agent CODEX_HOME=/home/agent/.codex DSH_HOME=/home/agent/.dsh\nCMD [${JSON.stringify(item.executable)}, "--version"]\n`;
      // A Dockerfile-only stdin build sends no project files or credentials as context.
      onPhase?.('build');
      const result = await this.command(['build', '--pull=false', '--tag', imageTag, '-'], {
        signal,
        input: dockerfile,
        timeoutMs: 600000,
        outputLimit: 20000,
      });
      invariant(
        result.exitCode === 0 && !result.timedOut,
        'TERMINAL_CLI_INSTALL',
        'CLI 镜像安装未完成，请检查 Docker 和网络后重试',
      );
      signal?.throwIfAborted();
      onPhase?.('verify');
      const image = await this.image(imageTag, signal);
      invariant(image, 'TERMINAL_CLI_INSTALL', '构建完成后无法确认镜像，请重新检测');
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
      onPhase?.('complete');
      return { image, imageTag, version };
    } finally {
      this.options.resources?.release(reservationId);
      this.busy = false;
    }
  }
  /** Probe the exact task image offline, never a host CLI or the mutable profile tag. */
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
