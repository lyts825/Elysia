/** 管理 Docker 代理的执行、终端会话和状态投影。 */
import type { Store } from '../../storage/src/index.js';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  promises as fs,
} from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  AgentTerminalProfile,
  AppError,
  invariant,
  type Artifact,
  type Attempt,
  type Operation,
  type Project,
  type Run,
  type Task,
  type TerminalConnectionBinding,
} from '../../contracts/src/index.js';
import { Kernel } from '../../kernel/src/index.js';
import { terminalHarnessPrompt } from '../../context/src/harness.js';
import { hash, id, now, stable } from '../../storage/src/index.js';
import { cleanEnv, ToolGateway } from '../../tools/src/index.js';
import { DockerCliManager } from './cli-manager.js';
import { TerminalResourcePool } from './terminal-resources.js';
import {
  terminalResourceRequirement,
  type TerminalTaskRuntime,
  type TerminalRuntimePhase,
  type TerminalRuntimeSnapshot,
} from '../../contracts/src/terminal-runtime.js';
import { terminalConnectionConfiguration } from './terminal-connection.js';
import { TERMINAL_INBOX_MAX_PENDING, type InboxMessage } from '../../contracts/src/terminal-inbox.js';
import {
  codexResumeProfile,
  readTerminalSession,
  terminalSessionIdentity,
  writeTerminalSession,
  TerminalStateOwnerSchema,
  type TerminalContinuationMode,
  type TerminalSessionRecord,
  type TerminalSessionView,
  type TerminalMaintenanceSnapshot,
} from './terminal-session.js';
export type { TerminalSessionView, TerminalContinuationMode } from './terminal-session.js';

export interface DockerCommandOptions {
  cwd: string;
  input?: string;
  timeoutMs?: number;
  outputLimit?: number;
  signal?: AbortSignal;
  onStdout?: (text: string) => void;
}
export interface DockerCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}
/** Injectable argv transport. No host shell or inherited credential environment. */
export interface DockerTransport {
  run(args: string[], options: DockerCommandOptions): Promise<DockerCommandResult>;
}
/** 通过子进程执行 Docker 命令，传入明确参数和受控环境。 */
export class DockerCliTransport implements DockerTransport {
  constructor(private binary = 'docker') {}
  run(args: string[], options: DockerCommandOptions): Promise<DockerCommandResult> {
    return new Promise((resolve, reject) => {
      options.signal?.throwIfAborted();
      const child = spawn(this.binary, args, {
        cwd: options.cwd,
        env: cleanEnv(),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const decoder = new StringDecoder('utf8');
      let stdout = '',
        stderr = '',
        bytes = 0,
        truncated = false,
        timedOut = false;
      const record = (value: Buffer, target: 'stdout' | 'stderr') => {
        if (target === 'stdout') options.onStdout?.(decoder.write(value));
        const remaining = Math.max(0, (options.outputLimit ?? 20000) - bytes);
        bytes += value.length;
        const text = value.subarray(0, remaining).toString('utf8');
        if (target === 'stdout') stdout += text;
        else stderr += text;
        truncated ||= bytes > (options.outputLimit ?? 20000);
      };
      child.stdout.on('data', (value: Buffer) => record(value, 'stdout'));
      child.stderr.on('data', (value: Buffer) => record(value, 'stderr'));
      const abort = () => child.kill();
      const timer = setTimeout(() => {
        timedOut = true;
        abort();
      }, options.timeoutMs ?? 12000);
      options.signal?.addEventListener('abort', abort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      child.on('error', () => {
        cleanup();
        reject(
          new AppError('DOCKER_CLI_MISSING', '未找到 Docker CLI，请安装 Docker Desktop 并启动 Linux 引擎'),
        );
      });
      child.on('close', (exitCode) => {
        cleanup();
        const tail = decoder.end();
        if (tail) options.onStdout?.(tail);
        resolve({ exitCode, stdout, stderr, truncated, timedOut });
      });
      // A container that exits before consuming stdin must not crash the service.
      child.stdin.on('error', () => {});
      child.stdin.end(options.input ?? '');
    });
  }
}

export const defaultAgentCommand = (agent: AgentTerminalProfile['agent']): string[] => {
  if (agent === 'codex')
    return [
      'codex',
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--ignore-user-config',
      '-',
    ];
  if (agent === 'claude')
    return [
      'claude',
      '--bare',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--allowedTools',
      'Read,Edit,Write,Bash',
      '--permission-prompts',
      'none',
    ];
  if (agent === 'dsh') return ['dsh', '--profile', 'headless', '--json', '-'];
  if (agent === 'gemini')
    return [
      'gemini',
      '-p',
      'Complete the task supplied through standard input.',
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
    ];
  return [];
};

/** Persist only public text and coarse tool activity, never private thinking or raw vendor stderr. */
/** 将终端输出解析并投影为可展示的文本。 */
export class TerminalProjection {
  private pending = '';
  private redactionPending = '';
  private output = '';
  private bytes = 0;
  malformed = false;
  failed = false;
  completed = false;
  truncated = false;
  sessionId?: string;
  summary = '';
  constructor(
    private protocol: AgentTerminalProfile['protocol'],
    private limit: number,
    private secrets: string[] = [],
    private onText?: (text: string) => void,
  ) {}
  private append(text: string) {
    this.redactionPending += text;
    for (const secret of this.secrets.filter(Boolean))
      this.redactionPending = this.redactionPending.split(secret).join('[已隐藏]');
    const hold = Math.max(0, ...this.secrets.map((secret) => secret.length - 1));
    const boundary = Math.max(0, this.redactionPending.length - hold);
    this.emit(this.redactionPending.slice(0, boundary));
    this.redactionPending = this.redactionPending.slice(boundary);
  }
  private emit(text: string) {
    const remaining = Math.max(0, this.limit - this.bytes);
    const data = Buffer.from(text);
    this.bytes += data.length;
    const part = data.subarray(0, remaining).toString('utf8');
    this.output += part;
    this.truncated ||= data.length > remaining;
    if (part) this.onText?.(part);
  }
  write(text: string) {
    if (this.protocol === 'text') {
      this.append(text);
      return;
    }
    this.pending += text;
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      this.line(line);
    }
    if (Buffer.byteLength(this.pending) > 256000) {
      this.malformed = true;
      this.pending = '';
    }
  }
  private line(line: string) {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > 256000) {
      this.malformed = true;
      return;
    }
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      this.malformed = true;
      return;
    }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      this.malformed = true;
      return;
    }
    if (this.protocol === 'codex-jsonl') {
      if (event.type === 'thread.started' && typeof event.thread_id === 'string')
        this.sessionId = event.thread_id;
      if (event.type === 'turn.completed') this.completed = true;
      if (['error', 'turn.failed'].includes(event.type)) this.failed = true;
      if (
        event.type === 'item.completed' &&
        event.item?.type === 'agent_message' &&
        typeof event.item.text === 'string'
      ) {
        this.summary = event.item.text;
        this.append(event.item.text);
      } else if (
        event.type === 'item.completed' &&
        ['command_execution', 'file_change', 'mcp_tool_call'].includes(event.item?.type)
      )
        this.append(`[${event.item.type} · ${event.item.status ?? '已记录'}]\n`);
    } else if (this.protocol === 'claude-stream-json') {
      if (event.type === 'system' && typeof event.session_id === 'string') this.sessionId = event.session_id;
      if (event.type === 'assistant') {
        for (const part of event.message?.content ?? []) {
          if (part.type === 'text' && typeof part.text === 'string') this.append(part.text);
          else if (part.type === 'tool_use')
            this.append(`[tool · ${typeof part.name === 'string' ? part.name.slice(0, 100) : '已记录'}]\n`);
        }
      }
      if (event.type === 'result') {
        this.completed = event.subtype === 'success' && event.is_error !== true;
        this.failed ||= !this.completed;
        if (typeof event.result === 'string') {
          this.summary = event.result;
          this.append(event.result + '\n');
        }
      }
    } else if (this.protocol === 'gemini-stream-json') {
      if (event.type === 'init' && typeof event.session_id === 'string') this.sessionId = event.session_id;
      if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string')
        this.append(event.content);
      if (event.type === 'tool_use')
        this.append(
          `[tool · ${typeof event.tool_name === 'string' ? event.tool_name.slice(0, 100) : '已记录'}]\n`,
        );
      if (event.type === 'result') {
        this.completed = event.status === 'success';
        this.failed ||= !this.completed;
        this.summary = this.output + this.redactionPending;
      }
      if (event.type === 'error' && event.severity !== 'warning') this.failed = true;
    } else {
      if (event.type === 'session' && typeof event.sessionId === 'string') this.sessionId = event.sessionId;
      if (event.type === 'text' && typeof event.text === 'string') this.append(event.text);
      if (event.type === 'final' && typeof event.text === 'string') {
        this.completed = true;
        this.summary = event.text;
        this.append(event.text + '\n');
      }
      if (
        event.type === 'error' ||
        (event.type === 'status' && event.phase === 'turn_end' && event.reason !== 'completed')
      )
        this.failed = true;
      if (event.type === 'tool_call')
        this.append(`[tool · ${typeof event.tool === 'string' ? event.tool.slice(0, 100) : '已记录'}]\n`);
    }
  }
  finish() {
    if (this.protocol !== 'text' && this.pending.trim()) this.line(this.pending);
    this.pending = '';
    this.emit(this.redactionPending);
    this.redactionPending = '';
    if (this.protocol === 'text') {
      this.completed = !!this.output.trim();
      this.summary = this.output;
    }
    for (const secret of this.secrets.filter(Boolean))
      this.summary = this.summary.split(secret).join('[已隐藏]');
    if (
      this.sessionId &&
      (!/^[A-Za-z0-9_.:-]{1,200}$/.test(this.sessionId) ||
        this.secrets.some((secret) => secret && this.sessionId!.includes(secret)))
    )
      this.sessionId = undefined;
    this.summary = this.summary.slice(0, 8000);
    return this.output;
  }
}

type TerminalResult = {
  operationId: string;
  containerName: string;
  transcriptArtifactId: string;
  diffArtifactId: string | null;
  workspaceManifestArtifactId?: string;
  summary: string;
  exitCode: number | null;
  sessionId?: string;
  truncated: boolean;
};
const excludedDirectories = new Set([
  '.git',
  'node_modules',
  '.elysia-runtime',
  '.local-qa',
  '.local-tests',
  '.tmp',
  '.cache',
  '__pycache__',
]);
const excludedFile = (name: string) =>
  name === '.env' || (name.startsWith('.env.') && name !== '.env.example');
const SNAPSHOT_FILES = 5000,
  SNAPSHOT_BYTES = 256 * 1024 * 1024;
type ManifestFile = { path: string; size: number; hash: string };
type WorkspaceManifest = {
  version: 1;
  excludedDirectories: string[];
  excludesLocalEnvironment: true;
  files: ManifestFile[];
};
const manifest = (files: ManifestFile[]): WorkspaceManifest => ({
  version: 1,
  excludedDirectories: [...excludedDirectories].sort(),
  excludesLocalEnvironment: true,
  files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')),
});
const contained = (root: string, filename: string) => {
  const relative = path.relative(root, filename);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
};
export interface DockerAgentCheck {
  available: boolean;
  version?: string;
  imageAvailable?: boolean;
  imageId?: string;
  agentAvailable: boolean | null;
  stages: Record<
    'engine' | 'image' | 'cli' | 'configuration' | 'authentication',
    { status: 'ready' | 'failed' | 'unknown'; message: string; code?: string }
  >;
  missingEnvironment?: string[];
  code?: string;
  message: string;
}

/** External agent execution beside the native API loop; scheduling remains in NativeExecutor. */
/** 管理终端容器、会话、执行恢复和工作区交付状态。 */
export class DockerAgentService {
  private closed = false;
  private transport: DockerTransport;
  public cliManager: DockerCliManager;
  public readonly resources = new TerminalResourcePool();
  private maintenanceLocks = new Set<string>();
  private runtimeRevision = 0;
  private runtimeLast = '';
  private active = new Map<
    string,
    { task: Task; operation: Operation; stopping?: Promise<void>; creating?: boolean; created?: boolean }
  >();
  private owner: string;
  private environment: (names: string[]) => Record<string, string>;
  private resolveConnection?: (binding: TerminalConnectionBinding) => Promise<string>;
  constructor(
    public kernel: Kernel<Store>,
    public gateway: ToolGateway,
    options: {
      transport?: DockerTransport;
      environment?: (names: string[]) => Record<string, string>;
      resolveConnection?: (binding: TerminalConnectionBinding) => Promise<string>;
    } = {},
  ) {
    this.transport = options.transport ?? new DockerCliTransport();
    this.cliManager = new DockerCliManager(kernel.store.directory, {
      transport: this.transport,
      resources: this.resources,
      store: kernel.store,
    });
    this.resolveConnection = options.resolveConnection;
    this.environment =
      options.environment ??
      ((names) =>
        Object.fromEntries(
          names.filter((name) => !!process.env[name]).map((name) => [name, process.env[name]!]),
        ));
    this.owner = hash(path.resolve(kernel.store.directory)).slice(0, 32);
  }
  private get store() {
    return this.kernel.store;
  }
  private command(args: string[], options: Partial<DockerCommandOptions> = {}) {
    return this.transport.run(args, { cwd: this.store.directory, ...options });
  }
  refreshResourceCapacity(signal?: AbortSignal) {
    if (this.closed) return Promise.resolve();
    return this.cliManager.refreshResourceCapacity(signal);
  }
  capabilities() {
    return this.cliManager.capabilityMatrix();
  }
  /** Liveness comes from in-flight work and retained resource ownership, never a persisted UI phase. */
  hasActive(runId?: string) {
    if ([...this.active.values()].some((entry) => !runId || entry.task.runId === runId)) return true;
    return this.resources
      .snapshot()
      .reservations.some(
        (entry) =>
          (!runId && entry.kind !== 'task') ||
          (entry.held && (!runId || this.store.get<Task>('tasks', entry.id)?.runId === runId)),
      );
  }
  runtimeSnapshot(runId?: string): TerminalRuntimeSnapshot {
    const rows = this.store.db
      .prepare("SELECT value FROM storage_meta WHERE key LIKE 'terminal-runtime:%'")
      .all() as { value: string }[];
    const tasks = rows
      .map((row) => JSON.parse(row.value) as TerminalTaskRuntime)
      .filter((entry) => !!this.store.get('tasks', entry.taskId));
    const resources = this.resources.snapshot();
    resources.reservations = resources.reservations.map((entry) => {
      if (!entry.held || entry.kind !== 'task') return entry;
      const task = this.store.get<Task>('tasks', entry.id);
      if (!task) return entry;
      const run = this.store.get<Run>('runs', task.runId);
      if (!run) return entry;
      const uncertain = this.store
        .stateCandidates<Operation>('tool_operations', ['INTENT', 'UNCERTAIN'], { runId: run.id })
        .filter((op) => op.taskId === task.id && op.name === 'terminal_agent')
        .at(-1);
      const operationId =
        this.active.get(task.id)?.operation.id ?? tasks.find((item) => item.taskId === task.id)?.operationId;
      const known = operationId ? this.store.get<Operation>('tool_operations', operationId) : undefined;
      const operation =
        uncertain ??
        (known?.runId === run.id && known.taskId === task.id && known.name === 'terminal_agent'
          ? known
          : undefined);
      return {
        ...entry,
        owner: {
          runId: run.id,
          taskId: task.id,
          ...(operation ? { operationId: operation.id } : {}),
          runTitle: run.title || run.objective.slice(0, 240),
          taskTitle: task.spec.title,
          reason: operation
            ? '终端停止状态尚未确认；请核验原操作后释放资源'
            : '终端停止状态尚未确认；请打开原对话核验',
        },
      };
    });
    const serialized = stable({ tasks, resources });
    if (serialized !== this.runtimeLast) {
      this.runtimeLast = serialized;
      this.runtimeRevision++;
    }
    return {
      revision: this.runtimeRevision,
      tasks: tasks.filter((entry) => !runId || entry.runId === runId),
      resources,
    };
  }
  private runtimePhase(task: Task, phase: TerminalRuntimePhase, operationId?: string, activity = false) {
    const key = `terminal-runtime:${task.id}`;
    const row = this.store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(key) as
      | { value: string }
      | undefined;
    const previous = row ? (JSON.parse(row.value) as TerminalTaskRuntime) : undefined;
    const timestamp = Date.now();
    if (
      previous?.phase === phase &&
      previous.operationId === operationId &&
      (!activity || timestamp - (previous.lastPublicActivityAt ?? 0) < 500)
    )
      return;
    const record: TerminalTaskRuntime = {
      runId: task.runId,
      taskId: task.id,
      phase,
      operationId,
      phaseStartedAt:
        previous?.phase === phase && previous.operationId === operationId
          ? previous.phaseStartedAt
          : timestamp,
      lastPublicActivityAt: activity ? timestamp : previous?.lastPublicActivityAt,
      revision: (previous?.revision ?? 0) + 1,
    };
    this.store.db
      .prepare(
        'INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, stable(record));
    if (previous?.phase !== phase || previous.operationId !== operationId)
      this.kernel.event(task.runId, 'terminal.phase', record, task.id);
  }
  private async connectionConfiguration(profile: AgentTerminalProfile) {
    if (!profile.connection) return undefined;
    invariant(this.resolveConnection, 'TERMINAL_CREDENTIAL_UNAVAILABLE', '当前服务无法读取终端连接凭据');
    return terminalConnectionConfiguration(
      profile,
      profile.connection,
      await this.resolveConnection(profile.connection),
    );
  }
  private async workspaceManifest(directory: string, signal: AbortSignal): Promise<WorkspaceManifest> {
    const root = await fs.realpath(directory),
      files: ManifestFile[] = [];
    let bytes = 0,
      entries = 0;
    const visit = async (folder: string) => {
      for (const entry of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name, 'en'),
      )) {
        signal.throwIfAborted();
        if (excludedDirectories.has(entry.name) || excludedFile(entry.name)) continue;
        invariant(++entries <= 10000, 'TERMINAL_SNAPSHOT_LIMIT', '初始资料或工作区目录过多，请缩小项目范围');
        const filename = path.join(folder, entry.name),
          before = await fs.lstat(filename);
        invariant(
          !before.isSymbolicLink() && contained(root, await fs.realpath(filename)),
          'TERMINAL_SNAPSHOT_LINK',
          'Agent 终端快照不支持符号链接，请移除链接或使用 API 执行',
        );
        if (before.isDirectory()) {
          await visit(filename);
          continue;
        }
        invariant(before.isFile(), 'TERMINAL_SNAPSHOT_FILE', 'Agent 终端快照仅支持普通文件和目录');
        bytes += before.size;
        invariant(
          files.length < SNAPSHOT_FILES && bytes <= SNAPSHOT_BYTES,
          'TERMINAL_SNAPSHOT_LIMIT',
          'Agent 终端资料上限为 5000 文件、256 MiB，请缩小项目范围',
        );
        const digest = createHash('sha256');
        for await (const chunk of createReadStream(filename, { highWaterMark: 65536, signal }))
          digest.update(chunk);
        const after = await fs.lstat(filename);
        invariant(
          before.size === after.size &&
            before.mtimeMs === after.mtimeMs &&
            before.ctimeMs === after.ctimeMs &&
            before.ino === after.ino,
          'TERMINAL_SNAPSHOT_CHANGED',
          '项目文件正在变化，请等待保存完成后重试',
        );
        files.push({
          path: path.relative(root, filename).split(path.sep).join('/'),
          size: before.size,
          hash: digest.digest('hex'),
        });
      }
    };
    await visit(root);
    return manifest(files);
  }
  private workspaceManifestSync(directory: string): WorkspaceManifest {
    const files: ManifestFile[] = [];
    let bytes = 0,
      entries = 0;
    const visit = (folder: string) => {
      for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name, 'en'),
      )) {
        if (excludedDirectories.has(entry.name) || excludedFile(entry.name)) continue;
        invariant(++entries <= 10000, 'TERMINAL_SNAPSHOT_LIMIT', '工作区目录过多，请缩小项目范围');
        const filename = path.join(folder, entry.name),
          before = lstatSync(filename);
        invariant(
          !before.isSymbolicLink(),
          'TERMINAL_SNAPSHOT_LINK',
          '验收工作区包含符号链接，请使用实际文件',
        );
        if (before.isDirectory()) {
          visit(filename);
          continue;
        }
        invariant(before.isFile(), 'TERMINAL_SNAPSHOT_FILE', '验收工作区包含非普通文件');
        bytes += before.size;
        invariant(
          files.length < SNAPSHOT_FILES && bytes <= SNAPSHOT_BYTES,
          'TERMINAL_SNAPSHOT_LIMIT',
          'Agent 终端资料上限为 5000 文件、256 MiB，请缩小项目范围',
        );
        const descriptor = openSync(filename, 'r'),
          digest = createHash('sha256'),
          buffer = Buffer.allocUnsafe(65536);
        try {
          let length: number;
          while ((length = readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
            digest.update(buffer.subarray(0, length));
        } finally {
          closeSync(descriptor);
        }
        const after = lstatSync(filename);
        invariant(
          before.size === after.size &&
            before.mtimeMs === after.mtimeMs &&
            before.ctimeMs === after.ctimeMs &&
            before.ino === after.ino,
          'TERMINAL_SNAPSHOT_CHANGED',
          '工作区正在变化，请等待保存完成后重试',
        );
        files.push({
          path: path.relative(directory, filename).split(path.sep).join('/'),
          size: before.size,
          hash: digest.digest('hex'),
        });
      }
    };
    visit(directory);
    return manifest(files);
  }
  private async prepareInitialSnapshot(task: Task, signal: AbortSignal) {
    if (
      task.baseline ||
      this.store
        .all<Operation>('tool_operations', task.runId)
        .some((operation) => operation.taskId === task.id && operation.name === 'terminal_agent')
    )
      return;
    invariant(task.workspace, 'WORKSPACE_MISSING', '任务工作区不存在');
    const state = path.join(this.store.directory, 'terminal-preparation');
    await fs.mkdir(state, { recursive: true, mode: 0o700 });
    invariant(
      !(await fs.lstat(state)).isSymbolicLink() &&
        contained(await fs.realpath(this.store.directory), await fs.realpath(state)),
      'TERMINAL_STATE_SCOPE',
      '终端准备目录超出应用数据范围',
    );
    const marker = path.join(state, task.id + '.json');
    let prepared: { status: string } | undefined;
    try {
      prepared = JSON.parse(await fs.readFile(marker, 'utf8'));
    } catch (error: any) {
      if (error.code !== 'ENOENT')
        throw new AppError('TERMINAL_SNAPSHOT_INCOMPLETE', '上次初始资料快照未完成，请重新创建任务');
    }
    if (prepared) {
      invariant(
        prepared.status === 'ready',
        'TERMINAL_SNAPSHOT_INCOMPLETE',
        '上次初始资料快照未完成，请重新创建任务；不会使用部分资料',
      );
      return;
    }
    invariant(
      (await fs.readdir(task.workspace)).length === 0,
      'TERMINAL_SNAPSHOT_INCOMPLETE',
      '任务目录已有内容，无法覆盖初始快照；请保留文件并重新创建任务',
    );
    const run = this.store.require<Run>('runs', task.runId),
      project = this.store.require<Project>('projects', run.projectId!);
    const source = await fs.realpath(project.workspaceRoot),
      workspace = await fs.realpath(task.workspace),
      storage = await fs.realpath(this.store.directory);
    invariant(
      contained(storage, workspace) && !contained(source, workspace),
      'TERMINAL_SNAPSHOT_SCOPE',
      '任务目录与项目来源重叠，无法创建安全快照',
    );
    const staging = path.join(path.dirname(workspace), `.terminal-initial-${task.id}-${id()}`);
    invariant(contained(storage, staging), 'TERMINAL_SNAPSHOT_SCOPE', '快照准备目录超出本应用数据范围');
    await fs.writeFile(marker, stable({ status: 'building', staging }), { mode: 0o600 });
    await fs.mkdir(staging, { mode: 0o700 });
    let published = false;
    try {
      const initial = await this.workspaceManifest(source, signal);
      for (const file of initial.files) {
        signal.throwIfAborted();
        const sourceFile = path.join(source, file.path),
          target = path.join(staging, file.path);
        invariant(
          contained(source, await fs.realpath(sourceFile)) && contained(staging, target),
          'TERMINAL_SNAPSHOT_SCOPE',
          '快照文件超出项目目录',
        );
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(sourceFile, target);
      }
      const copied = await this.workspaceManifest(staging, signal),
        currentSource = await this.workspaceManifest(source, signal);
      invariant(
        stable(initial) === stable(copied) && stable(initial) === stable(currentSource),
        'TERMINAL_SNAPSHOT_CHANGED',
        '复制期间项目资料发生变化，请等待保存完成后重试',
      );
      signal.throwIfAborted();
      invariant(
        (await fs.readdir(workspace)).length === 0,
        'TERMINAL_SNAPSHOT_CHANGED',
        '准备期间任务目录已变化，请保留文件并重新创建任务',
      );
      await fs.rmdir(workspace);
      await fs.rename(staging, workspace);
      published = true;
      await fs.writeFile(marker, stable({ status: 'ready', manifest: initial }), { mode: 0o600 });
    } finally {
      if (!published) {
        await fs.rm(staging, { recursive: true, force: true });
        // A normal cancelled/failed copy leaves the untouched empty workspace.
        // Crash markers remain visible instead of accepting a partial snapshot.
        try {
          if ((await fs.readdir(workspace)).length === 0) await fs.rm(marker, { force: true });
        } catch {}
      }
    }
  }
  private workspaceSignature(task: Task, evidenceHash?: string) {
    invariant(task.workspace, 'WORKSPACE_MISSING', '任务工作区不存在');
    if (task.baseline) {
      const readGit = (args: string[]) => {
        try {
          return execFileSync('git', ['--no-optional-locks', '-C', task.workspace!, ...args], {
            env: cleanEnv(),
            windowsHide: true,
            timeout: 10000,
            maxBuffer: 300000,
          }).toString('utf8');
        } catch {
          throw new AppError('TERMINAL_WORKSPACE_CHECK', '无法读取工作区差异，请检查 Git 后重试');
        }
      };
      const staged = readGit([
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--cached',
        task.baseline,
        '--binary',
      ]);
      const unstaged = readGit(['diff', '--no-ext-diff', '--no-textconv', '--binary']);
      const untracked = readGit(['ls-files', '--others', '--exclude-standard', '-z']);
      invariant(
        !evidenceHash || (hash(staged) === evidenceHash && !unstaged && !untracked),
        'TERMINAL_WORKSPACE_CHANGED',
        '工作区已变化，当前文件与验收差异不一致，请重新核验',
      );
      return hash(stable([staged, unstaged, untracked]));
    }
    try {
      const actual = hash(stable(this.workspaceManifestSync(task.workspace)));
      invariant(
        !evidenceHash || actual === evidenceHash,
        'TERMINAL_WORKSPACE_CHANGED',
        '工作区文件已变化，当前内容与验收清单不一致，请重新核验',
      );
      return actual;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('TERMINAL_WORKSPACE_CHECK', '工作区正在变化，请等待文件写入完成后重试');
    }
  }
  /** 检查 Docker 引擎、镜像和 CLI 状态；可选配置和取消信号约束检测。 */
  async check(
    raw?: AgentTerminalProfile,
    signal?: AbortSignal,
    sponsorId?: string,
  ): Promise<DockerAgentCheck> {
    const profile = raw ? AgentTerminalProfile.parse(raw) : undefined;
    const stages: DockerAgentCheck['stages'] = {
      engine: { status: 'unknown', message: '尚未检测 Docker Linux 引擎' },
      image: { status: 'unknown', message: '尚未检测任务镜像' },
      cli: { status: 'unknown', message: '尚未检测 CLI 可执行程序' },
      configuration: { status: 'unknown', message: '尚未检查 API 配置与凭据' },
      authentication: { status: 'unknown', message: '未请求外部 API；真实认证在执行时确认' },
    };
    let agentAvailable: boolean | null = null,
      imageAvailable: boolean | undefined,
      version: string | undefined,
      imageId: string | undefined;
    try {
      invariant(!this.closed, 'TERMINAL_CLOSED', '终端服务正在退出，请稍后重试');
      if (profile) {
        const cli = await this.cliManager.check(
          profile.agent === 'gemini' ? 'gemini' : profile.agent,
          profile,
          signal,
          sponsorId,
        );
        imageAvailable = cli.imageAvailable;
        imageId = cli.imageId;
        version = cli.version;
        agentAvailable = cli.installed;
        stages.engine = {
          status: cli.engineAvailable ? 'ready' : 'failed',
          message: cli.engineAvailable ? 'Docker Linux 引擎已就绪' : cli.message,
          ...(cli.engineAvailable ? {} : { code: cli.code }),
        };
        stages.image = {
          status: cli.imageAvailable ? 'ready' : cli.engineAvailable ? 'failed' : 'unknown',
          message: cli.imageAvailable ? '任务镜像已固定并确认存在' : cli.message,
        };
        stages.cli = {
          status: cli.installed === true ? 'ready' : cli.installed === false ? 'failed' : 'unknown',
          message:
            cli.installed === true ? `CLI 已就绪${cli.version ? ' · ' + cli.version : ''}` : cli.message,
        };
        if (!cli.available)
          return {
            available: false,
            agentAvailable,
            imageAvailable,
            imageId,
            version,
            stages,
            code: cli.code,
            message: cli.message,
          };
        try {
          const configuration = await this.connectionConfiguration(profile);
          const values = configuration?.environment ?? this.environment(profile.environment);
          const missingEnvironment = configuration ? [] : profile.environment.filter((name) => !values[name]);
          invariant(
            !missingEnvironment.length,
            'TERMINAL_ENVIRONMENT_MISSING',
            `服务进程缺少环境变量：${missingEnvironment.join('、')}；配置后重启服务`,
          );
          invariant(
            Object.values(values).every((value) => !!value && !/[\r\n\0]/.test(value)),
            'TERMINAL_ENVIRONMENT',
            '终端环境变量无效，请检查配置',
          );
          stages.configuration = { status: 'ready', message: 'API 配置与本地凭据可读取' };
        } catch (error) {
          stages.configuration = {
            status: 'failed',
            message: error instanceof AppError ? error.message : 'API 配置检查未完成',
          };
          throw error;
        }
        return {
          available: true,
          agentAvailable,
          imageAvailable,
          imageId,
          version,
          stages,
          message: '镜像、CLI 和本地配置已就绪；真实 API 认证尚未验证',
        };
      }
      const probe = await this.command(['version', '--format', '{{json .Server}}'], { signal });
      if (
        probe.exitCode !== 0 ||
        probe.timedOut ||
        probe.truncated ||
        !probe.stdout.trim() ||
        probe.stdout.trim() === 'null'
      )
        throw new AppError('DOCKER_UNAVAILABLE', 'Docker Linux 引擎未就绪，请启动 Docker Desktop 后重试');
      const server = JSON.parse(probe.stdout);
      invariant(
        server && typeof server === 'object' && typeof server.Version === 'string',
        'DOCKER_UNAVAILABLE',
        'Docker 返回信息不完整，请检查 Docker Desktop',
      );
      invariant(server.Os === 'linux', 'DOCKER_PLATFORM', 'Agent 终端需要 Docker Linux 容器模式');
      stages.engine = { status: 'ready', message: 'Docker Linux 引擎已就绪' };
      return {
        available: true,
        version: server.Version,
        agentAvailable: null,
        stages,
        message: 'Docker 已就绪；请选择模板检查镜像、CLI 和 API 配置',
      };
    } catch (error) {
      return {
        available: false,
        agentAvailable,
        imageAvailable,
        imageId,
        version,
        stages:
          stages.engine.status === 'unknown'
            ? {
                ...stages,
                engine: {
                  status: 'failed',
                  message: error instanceof AppError ? error.message : 'Docker 检查失败',
                },
              }
            : stages,
        code: error instanceof AppError ? error.code : 'DOCKER_UNAVAILABLE',
        message:
          error instanceof AppError ? error.message : 'Docker 检查失败，请检查 Docker Desktop 和当前 context',
      };
    }
  }
  private labels(task: Task, operation: Operation) {
    return {
      'io.elysia.owner': this.owner,
      'io.elysia.run': task.runId,
      'io.elysia.task': task.id,
      'io.elysia.operation': operation.id,
    };
  }
  private async stopOwned(task: Task, operation: Operation) {
    const name = String(operation.args.containerName);
    invariant(
      /^elysia-agent-[a-f0-9-]{36}$/.test(name),
      'TERMINAL_CONTAINER_SCOPE',
      '终端容器名称无效，已停止操作',
    );
    const inspected = await this.command(['inspect', '--format', '{{json .Config.Labels}}', name]);
    if (inspected.exitCode !== 0) {
      if (/No such (object|container)/i.test(inspected.stderr)) {
        const entry = this.active.get(task.id);
        if (!entry?.creating && (entry?.created || operation.args.containerCreated === true))
          await this.markStateStopped(task, operation, true);
        this.resources.confirmStopped(task.id);
        if (!this.active.has(task.id)) this.resources.release(task.id);
        return;
      }
      throw new AppError('TERMINAL_STOP_FAILED', '无法核验容器是否停止，请检查 Docker 后再继续');
    }
    let labels: Record<string, string>;
    try {
      labels = JSON.parse(inspected.stdout);
    } catch {
      throw new AppError('TERMINAL_CONTAINER_SCOPE', '无法核验 Agent 容器所属关系');
    }
    invariant(
      Object.entries(this.labels(task, operation)).every(([key, value]) => labels[key] === value),
      'TERMINAL_CONTAINER_SCOPE',
      '容器不属于本任务，已停止操作',
    );
    const stopped = await this.command(['stop', '--timeout', '5', name], { timeoutMs: 10000 });
    invariant(
      stopped.exitCode === 0 && !stopped.timedOut,
      'TERMINAL_STOP_FAILED',
      'Agent 容器未确认停止，请检查 Docker 后再继续',
    );
    const removed = await this.command(['rm', name]);
    invariant(
      removed.exitCode === 0,
      'TERMINAL_STOP_FAILED',
      '容器已停止，但尚未清理；请检查 Docker 后再继续',
    );
    this.resources.confirmStopped(task.id);
    const entry = this.active.get(task.id);
    if (!entry?.creating && (entry?.created || operation.args.containerCreated === true))
      await this.markStateStopped(task, operation, true);
    if (!this.active.has(task.id)) this.resources.release(task.id);
  }
  private async markStateStopped(task: Task, operation: Operation, stopped: boolean) {
    const root = path.resolve(this.store.directory, 'terminal-state'),
      folder = path.join(root, operation.id),
      filename = path.join(folder, 'owner.json');
    let temporary: string | undefined;
    try {
      for (const item of [root, folder, filename])
        invariant(
          !(await fs.lstat(item)).isSymbolicLink() &&
            contained(await fs.realpath(this.store.directory), await fs.realpath(item)),
          'TERMINAL_STATE_SCOPE',
          '终端标记路径无效',
        );
      const marker = TerminalStateOwnerSchema.parse(JSON.parse(await fs.readFile(filename, 'utf8')));
      invariant(
        marker.owner === this.owner &&
          marker.runId === task.runId &&
          marker.taskId === task.id &&
          marker.operationId === operation.id,
        'TERMINAL_STATE_SCOPE',
        '终端标记不属于本次操作',
      );
      temporary = path.join(folder, `.owner-${id()}.tmp`);
      await fs.writeFile(temporary, stable({ ...marker, stopped }), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, filename);
    } catch {
      // A missing or unknown marker is retained conservatively and cannot authorize maintenance cleanup.
    } finally {
      if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
  /** 停止指定运行的活动终端；提供任务 ID 时覆盖该任务及后代。 */
  async interrupt(runId: string, taskId?: string) {
    const tasks = taskId
      ? new Set(this.kernel.descendants(this.store.require<Task>('tasks', taskId)).map((task) => task.id))
      : undefined;
    await Promise.all(
      [...this.active.values()]
        .filter((entry) => entry.task.runId === runId && (!tasks || tasks.has(entry.task.id)))
        .map((entry) => (entry.stopping ??= this.stopOwned(entry.task, entry.operation))),
    );
  }
  async dispose() {
    this.closed = true;
    await this.cliManager.dispose();
    await Promise.all(
      [...new Set([...this.active.values()].map((entry) => entry.task.runId))].map((runId) =>
        this.interrupt(runId),
      ),
    );
  }
  private async clearEnvironmentFile(operation: Pick<Operation, 'id'>) {
    invariant(/^[a-f0-9-]{36}$/.test(operation.id), 'TERMINAL_STATE_SCOPE', '终端状态路径无效');
    const root = path.resolve(this.store.directory, 'terminal-state'),
      folder = path.resolve(root, operation.id),
      envFile = path.join(folder, 'environment');
    invariant(contained(root, folder) && folder !== root, 'TERMINAL_STATE_SCOPE', '终端状态路径无效');
    try {
      invariant(
        !(await fs.lstat(root)).isSymbolicLink() &&
          contained(await fs.realpath(this.store.directory), await fs.realpath(root)) &&
          !(await fs.lstat(folder)).isSymbolicLink() &&
          !(await fs.lstat(envFile)).isSymbolicLink() &&
          contained(await fs.realpath(root), await fs.realpath(folder)),
        'TERMINAL_STATE_SCOPE',
        '终端状态目录出现链接，未清理未知文件',
      );
      await fs.rm(envFile, { force: true });
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  /** 启动时核查历史终端状态和已知环境文件，恢复或清理未完成操作。 */
  async recover() {
    // Known environment files need cleanup even after a terminal operation completed.
    // Enumerate actual folders and small SQL ownership metadata, not every historical body.
    const stateRoot = path.join(this.store.directory, 'terminal-state');
    let folders: string[] = [];
    try {
      folders = await fs.readdir(stateRoot);
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const key of folders) {
      if (!/^[a-f0-9-]{36}$/.test(key)) continue;
      const row = this.store.db
        .prepare(
          `SELECT id,run_id runId,json_extract(data,'$.readModel.name') name,
        json_extract(data,'$.readModel.taskId') taskId FROM tool_operations WHERE id=?`,
        )
        .get(key) as { id: string; runId: string; name: string | null; taskId: string | null } | undefined;
      if (!row) continue;
      if (!row.name)
        this.store.recovery.apply<Operation>('tool_operations', key, (operation) => {
          row.name = operation.name;
          row.taskId = operation.taskId;
          this.store.refreshReadProjection('tool_operations', operation);
        });
      if (row.name !== 'terminal_agent') continue;
      try {
        await this.clearEnvironmentFile(row);
      } catch (error: any) {
        if (error.code !== 'ENOENT')
          this.kernel.event(
            row.runId,
            'terminal.environment_cleanup_failed',
            { operationId: row.id, message: '已知终端临时环境文件尚未清理，请检查数据目录权限' },
            row.taskId ?? undefined,
          );
      }
    }
    for (const key of this.store.recovery.candidates('tool_operations', ['INTENT', 'UNCERTAIN'])) {
      let operation: Operation | undefined, task: Task | undefined, run: Run | undefined;
      this.store.recovery.apply<Operation>('tool_operations', key, (value) => {
        if (value.name !== 'terminal_agent' || !['INTENT', 'UNCERTAIN'].includes(value.status)) return;
        const owner = this.store.recovery.read<Task>('tasks', value.taskId);
        const ownerRun = this.store.recovery.read<Run>('runs', owner.runId);
        invariant(owner.runId === value.runId, 'RECOVERY_SCOPE', '恢复记录归属不一致');
        operation = value;
        task = owner;
        run = ownerRun;
      });
      if (!operation || !task || !run) continue;
      this.resources.hold(
        task.id,
        undefined,
        'task',
        run.execution?.kind === 'docker-agent' ? run.execution.profile.resourcePreset : undefined,
      );
      try {
        await this.stopOwned(task, operation);
      } catch {
        /* Keep uncertain state even when Docker is unavailable. */
      }
      const recoveredTask = task,
        recoveredOperation = operation;
      this.store.recovery.apply<Operation>('tool_operations', operation.id, (currentOperation) => {
        if (
          currentOperation.revision !== recoveredOperation.revision ||
          !['INTENT', 'UNCERTAIN'].includes(currentOperation.status)
        )
          return;
        this.store.put('tool_operations', {
          ...currentOperation,
          status: 'UNCERTAIN',
          error: '服务曾中断；终端副作用需要核验，不会自动重跑',
        });
        const current = this.store.recovery.read<Task>('tasks', recoveredTask.id);
        this.store.recovery.read('agents', current.agentId);
        if (!['DONE', 'CANCELLED'].includes(current.status))
          this.kernel.updateTask(current, 'WAITING', { waitReason: 'terminal_verification', waitingFor: [] });
        this.runtimePhase(current, 'verification', currentOperation.id);
      });
    }
    const rows = this.store.db
      .prepare("SELECT value FROM storage_meta WHERE key LIKE 'terminal-runtime:%'")
      .all() as { value: string }[];
    for (const row of rows) {
      const runtime = JSON.parse(row.value) as TerminalTaskRuntime;
      if (!['preparing', 'starting', 'running', 'finalizing'].includes(runtime.phase)) continue;
      let task: Task | undefined;
      this.store.recovery.apply<Task>('tasks', runtime.taskId, (value) => {
        task = value;
      });
      if (!task || this.active.has(task.id)) continue;
      const phase: TerminalRuntimePhase =
        task.waitReason === 'terminal_verification'
          ? 'verification'
          : task.waitReason === 'terminal_review'
            ? 'review'
            : task.waitReason === 'terminal_unavailable'
              ? 'unavailable'
              : 'stopped';
      this.runtimePhase(task, phase, runtime.operationId);
    }
  }
  private continuationState(
    runId: string,
    expectedRevision?: number,
    options: { allowExpired?: boolean; allowMaintenance?: boolean } = {},
  ) {
    invariant(!this.closed, 'TERMINAL_CLOSED', '终端服务正在退出，请稍后重试');
    invariant(
      options.allowMaintenance || !this.maintenanceLocks.has(runId),
      'TERMINAL_MAINTENANCE_BUSY',
      '会话维护正在进行，请稍后继续',
    );
    const run = this.store.require<Run>('runs', runId);
    invariant(
      expectedRevision === undefined || run.revision === expectedRevision,
      'REVISION_CONFLICT',
      '对话已更新，请刷新后再继续',
    );
    invariant(
      run.execution?.kind === 'docker-agent' &&
        run.kind === 'task' &&
        run.planMode === false &&
        !run.archived &&
        run.status === 'WAITING' &&
        run.reason === 'terminal_review',
      'TERMINAL_CONTINUATION_STATE',
      '当前终端任务不可继续',
    );
    const task = this.store.require<Task>('tasks', run.rootTaskId);
    const operations = this.store
      .all<Operation>('tool_operations', run.id)
      .filter((op) => op.taskId === task.id && op.name === 'terminal_agent');
    const operation = operations.at(-1);
    invariant(
      task.status === 'WAITING' &&
        task.waitReason === 'terminal_review' &&
        !this.active.has(task.id) &&
        operation?.status === 'DONE' &&
        operation.args.contractVersion === task.contractVersion &&
        !operations.some((op) => ['INTENT', 'UNCERTAIN'].includes(op.status)),
      'TERMINAL_CONTINUATION_STATE',
      '请先等待终端停止并核验所有未确认操作',
    );
    invariant(
      options.allowExpired || !run.startedAt || Date.now() - run.startedAt < run.limits.maxMinutes * 60000,
      'TIME_BUDGET',
      '运行时间达到上限，请创建新任务',
    );
    this.kernel.permissions(task);
    const profile = AgentTerminalProfile.parse(run.execution.profile);
    const identity = terminalSessionIdentity(run, task);
    const record = readTerminalSession(this.store, task.id);
    invariant(
      !record ||
        (record.runId === run.id &&
          record.taskId === task.id &&
          record.profileHash === identity.profileHash &&
          record.authorityHash === identity.authorityHash &&
          record.lastOperationId === operation.id &&
          !record.pending),
      'TERMINAL_SESSION_CHANGED',
      '终端会话绑定已变化，请创建新任务',
    );
    const imageId = record?.imageId ?? operation.args.imageId ?? profile.image;
    invariant(
      typeof imageId === 'string' && /^sha256:[a-f0-9]{64}$/.test(imageId),
      'TERMINAL_SESSION_IMAGE_UNKNOWN',
      '旧任务未记录实际镜像内容，请创建新任务后使用续接',
    );
    invariant(
      !operation.args.imageId || operation.args.imageId === imageId,
      'TERMINAL_SESSION_CHANGED',
      '会话镜像与最后操作记录不一致，请先核验',
    );
    return { run, task, operation, profile, record, imageId, identity };
  }
  /** Local consistency proof only; this method never probes Docker or resolves credentials. */
  maintenanceSnapshot(
    runId: string,
    expectedRevision: number,
    options: { requireConsistent?: boolean } = {},
  ): TerminalMaintenanceSnapshot {
    const state = this.continuationState(runId, expectedRevision, {
      allowExpired: true,
      allowMaintenance: true,
    });
    const record = state.record;
    invariant(
      state.profile.agent === 'codex' &&
        state.profile.protocol === 'codex-jsonl' &&
        record?.ready &&
        record.state,
      'TERMINAL_MAINTENANCE_UNSUPPORTED',
      '仅支持已可靠停止且有一致性记录的 Codex 会话',
    );
    const home = this.sessionHome(record);
    const relativePath = record.state.path;
    invariant(
      /^\.codex\/sessions\//.test(relativePath) &&
        !relativePath.split('/').some((part) => part === '..' || !part) &&
        relativePath.endsWith('.jsonl') &&
        !!record.sessionId &&
        path.basename(relativePath).includes(record.sessionId),
      'TERMINAL_SESSION_SCOPE',
      '会话文件路径不符合受管范围',
    );
    const rolloutPath = path.resolve(home, ...relativePath.split('/'));
    invariant(contained(home, rolloutPath), 'TERMINAL_SESSION_SCOPE', '会话文件超出受管范围');
    let exists = true,
      actualHash: string | null = null;
    try {
      for (let directory = rolloutPath; directory !== home; directory = path.dirname(directory)) {
        const stat = lstatSync(directory);
        invariant(
          !stat.isSymbolicLink() && contained(realpathSync(home), realpathSync(directory)),
          'TERMINAL_SESSION_SCOPE',
          '会话文件路径包含链接或超出受管目录',
        );
      }
      actualHash = this.rolloutHash(rolloutPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      exists = false;
    }
    let consistent = false;
    try {
      consistent = stable(this.sessionSeal(record)) === stable(record.state);
    } catch (error) {
      if (error instanceof AppError && error.code === 'TERMINAL_SESSION_SCOPE') throw error;
      // A missing or modified rollout can be repaired from the exact same reliable checkpoint.
    }
    invariant(
      options.requireConsistent === false || consistent,
      'TERMINAL_SESSION_CHANGED',
      '当前会话文件与可靠记录不一致',
    );
    invariant(
      typeof state.task.workspace === 'string' && !lstatSync(state.task.workspace).isSymbolicLink(),
      'TERMINAL_SESSION_SCOPE',
      '任务工作区不可维护',
    );
    return {
      run: state.run,
      task: state.task,
      operation: state.operation,
      record,
      home,
      workspace: state.task.workspace,
      imageId: state.imageId,
      rollout: { path: rolloutPath, relativePath, exists, hash: actualHash },
      consistent,
    };
  }
  withMaintenanceGuard<T>(
    runId: string,
    expectedRevision: number,
    callback: (snapshot: TerminalMaintenanceSnapshot) => T,
    options: { mutates?: boolean; requireConsistent?: boolean } = {},
  ): T {
    invariant(!this.maintenanceLocks.has(runId), 'TERMINAL_MAINTENANCE_BUSY', '会话维护正在进行');
    const before = this.maintenanceSnapshot(runId, expectedRevision, {
      requireConsistent: options.requireConsistent ?? !options.mutates,
    });
    this.maintenanceLocks.add(runId);
    try {
      return this.store.tx(() => {
        const result = callback(before);
        invariant(
          !(result && typeof (result as { then?: unknown }).then === 'function'),
          'TERMINAL_MAINTENANCE_ASYNC',
          '维护文件操作必须在同步保护范围内完成',
        );
        const after = this.maintenanceSnapshot(runId, expectedRevision, {
          requireConsistent: options.mutates ? true : options.requireConsistent,
        });
        invariant(
          stable(before.record) === stable(after.record) &&
            before.task.revision === after.task.revision &&
            before.operation.revision === after.operation.revision &&
            before.imageId === after.imageId,
          'TERMINAL_SESSION_CHANGED',
          '维护期间会话绑定已变化',
        );
        invariant(
          options.mutates ||
            (before.rollout.hash === after.rollout.hash && before.rollout.exists === after.rollout.exists),
          'TERMINAL_SESSION_CHANGED',
          '维护期间会话文件已变化',
        );
        if (options.mutates)
          writeTerminalSession(this.store, { ...after.record, revision: after.record.revision + 1 });
        return result;
      });
    } finally {
      this.maintenanceLocks.delete(runId);
    }
  }
  private sessionHome(record: TerminalSessionRecord, requireSession = false) {
    const source = this.store.require<Operation>('tool_operations', record.homeOperationId);
    invariant(
      source.runId === record.runId && source.taskId === record.taskId && source.name === 'terminal_agent',
      'TERMINAL_SESSION_SCOPE',
      '会话目录不属于当前任务',
    );
    const root = path.resolve(this.store.directory, 'terminal-state'),
      folder = path.join(root, record.homeOperationId),
      home = path.join(folder, 'home');
    for (const item of [root, folder, home])
      invariant(
        !lstatSync(item).isSymbolicLink() &&
          contained(realpathSync(this.store.directory), realpathSync(item)),
        'TERMINAL_SESSION_SCOPE',
        '会话目录出现链接或超出应用数据范围',
      );
    if (requireSession) {
      invariant(
        record.ready && record.state,
        'TERMINAL_SESSION_MISSING',
        '当前任务没有可靠的会话一致性记录；可开启新会话',
      );
      invariant(
        stable(this.sessionSeal(record)) === stable(record.state),
        'TERMINAL_SESSION_CHANGED',
        '会话文件与任务记录不一致，可能曾恢复备份或被修改；请开启新会话',
      );
    }
    return home;
  }
  /** Hash only the selected rollout; private CLI transcript content never enters the database or logs. */
  private sessionSeal(record: TerminalSessionRecord) {
    invariant(
      typeof record.sessionId === 'string' &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(record.sessionId),
      'TERMINAL_SESSION_MISSING',
      '当前任务没有可靠的 Codex 会话标识',
    );
    const home = this.sessionHome(record),
      codex = path.join(home, '.codex'),
      sessions = path.join(codex, 'sessions');
    for (const item of [codex, sessions])
      invariant(
        !lstatSync(item).isSymbolicLink() && contained(realpathSync(home), realpathSync(item)),
        'TERMINAL_SESSION_SCOPE',
        'Codex 会话目录无效',
      );
    let count = 0;
    const matches: string[] = [];
    const visit = (directory: string, depth: number) => {
      invariant(depth <= 5, 'TERMINAL_SESSION_SCOPE', 'Codex 会话目录层级异常');
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        invariant(++count <= 4000, 'TERMINAL_SESSION_SCOPE', 'Codex 会话文件过多，请创建新会话');
        const filename = path.join(directory, entry.name),
          stat = lstatSync(filename);
        invariant(
          !stat.isSymbolicLink() && contained(realpathSync(home), realpathSync(filename)),
          'TERMINAL_SESSION_SCOPE',
          'Codex 会话文件包含链接',
        );
        if (stat.isDirectory()) visit(filename, depth + 1);
        else if (
          stat.isFile() &&
          stat.size > 0 &&
          entry.name.endsWith('.jsonl') &&
          entry.name.includes(record.sessionId!)
        )
          matches.push(filename);
      }
    };
    visit(sessions, 0);
    invariant(matches.length === 1, 'TERMINAL_SESSION_MISSING', '未找到唯一的 Codex 会话文件；请开启新会话');
    const filename = matches[0];
    return {
      path: path.relative(home, filename).split(path.sep).join('/'),
      hash: this.rolloutHash(filename),
    };
  }
  private rolloutHash(filename: string) {
    const before = lstatSync(filename),
      descriptor = openSync(filename, 'r'),
      digest = createHash('sha256'),
      buffer = Buffer.allocUnsafe(65536);
    try {
      invariant(
        before.isFile() && !before.isSymbolicLink() && before.size <= 64 * 1024 * 1024,
        'TERMINAL_SESSION_LIMIT',
        '会话文件超出续接上限；请开启新会话',
      );
      let length: number,
        bytes = 0;
      while ((length = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
        bytes += length;
        invariant(bytes <= 64 * 1024 * 1024, 'TERMINAL_SESSION_LIMIT', '会话文件超出续接上限；请开启新会话');
        digest.update(buffer.subarray(0, length));
      }
    } finally {
      closeSync(descriptor);
    }
    const after = lstatSync(filename);
    invariant(
      before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        before.ino === after.ino,
      'TERMINAL_SESSION_CHANGED',
      '会话文件正在变化，请稍后重试',
    );
    return digest.digest('hex');
  }
  /** 读取续接能力并再次校验运行版本，生成终端会话可用性视图。 */
  async sessionView(runId: string): Promise<TerminalSessionView> {
    const revision = this.store.require<Run>('runs', runId).revision;
    try {
      const state = this.continuationState(runId);
      const capability = await this.cliManager.resumeCapability(state.profile, state.imageId);
      this.continuationState(runId, revision);
      const view: TerminalSessionView = {
        supported: capability.supported,
        canResume: false,
        canStartNew: true,
        reason: capability.reason,
        revision,
        lastOperationId: state.operation.id,
        sessionId: state.record?.sessionId,
      };
      if (capability.supported) {
        try {
          invariant(state.record, 'TERMINAL_SESSION_MISSING', '旧任务没有独立会话记录；可开启新会话');
          this.sessionHome(state.record, true);
          view.canResume = true;
        } catch (error) {
          view.reason = error instanceof AppError ? error.message : '会话目录已丢失；可开启新会话';
        }
      }
      return view;
    } catch (error) {
      return {
        supported: false,
        canResume: false,
        canStartNew: false,
        revision,
        reason: error instanceof AppError ? error.message : '终端会话检查未完成，请稍后重试',
      };
    }
  }
  /** 校验续接模式、文本、消息及版本，准备后续提交会话的操作。 */
  async prepareContinuation(
    runId: string,
    expectedRevision: number,
    mode: TerminalContinuationMode,
    text: string,
    inboxIds: string[] = [],
  ): Promise<() => Run> {
    invariant(
      ['resume', 'new-session'].includes(mode) &&
        typeof text === 'string' &&
        text.length <= 60000 &&
        Array.isArray(inboxIds) &&
        inboxIds.length <= TERMINAL_INBOX_MAX_PENDING &&
        inboxIds.every((inboxId) => typeof inboxId === 'string') &&
        new Set(inboxIds).size === inboxIds.length &&
        (text.trim().length > 0 || inboxIds.length > 0),
      'TERMINAL_CONTINUATION_INPUT',
      '请输入后续任务内容（最多 60000 字）或选择待处理消息（最多 100 条）',
    );
    const state = this.continuationState(runId, expectedRevision);
    for (const inboxId of inboxIds) {
      const message = this.store.require<InboxMessage>('inbox', inboxId);
      invariant(
        message.runId === runId && message.status === 'PENDING' && message.direction !== 'outgoing',
        'TERMINAL_INBOX_CHANGED',
        '所选待处理消息已变化或不属于当前终端，请刷新后重试',
      );
    }
    // Selection is a set; preserve durable arrival order so later corrections remain later.
    // The client lists newest first and may also collect checkbox clicks in arbitrary order.
    const selectedIds = new Set(inboxIds);
    const incoming = this.kernel.pendingTerminalInbox(runId).filter((message) => selectedIds.has(message.id));
    inboxIds = incoming.map((message) => message.id);
    const continuationText = [
      ...incoming.map((message) => this.kernel.terminalInboxText(message)),
      text.trim(),
    ]
      .filter(Boolean)
      .join('\n\n');
    invariant(
      Buffer.byteLength(continuationText, 'utf8') <= 1024 * 1024,
      'TERMINAL_INPUT_LIMIT',
      '续接消息合计超过 1 MiB，请减少所选消息后重试',
    );
    const inboxSnapshot = stable(incoming);
    const sessionSnapshot = stable(state.record ?? null);
    if (mode === 'resume') {
      const capability = await this.cliManager.resumeCapability(state.profile, state.imageId);
      invariant(capability.supported, 'TERMINAL_RESUME_UNSUPPORTED', capability.reason);
      invariant(state.record, 'TERMINAL_SESSION_MISSING', '旧任务没有可靠会话记录，请开启新会话');
      this.sessionHome(state.record, true);
    } else {
      const check = await this.check({ ...state.profile, image: state.imageId });
      invariant(check.available, check.code ?? 'TERMINAL_UNAVAILABLE', check.message);
    }
    return () =>
      this.store.tx(() => {
        const current = this.continuationState(runId, expectedRevision);
        invariant(
          current.task.revision === state.task.revision &&
            current.operation.id === state.operation.id &&
            current.operation.revision === state.operation.revision &&
            stable(current.record ?? null) === sessionSnapshot &&
            current.imageId === state.imageId &&
            stable(current.identity) === stable(state.identity),
          'TERMINAL_SESSION_CHANGED',
          '续接准备期间终端状态已变化，请刷新后重试',
        );
        invariant(
          stable(inboxIds.map((inboxId) => this.store.require<InboxMessage>('inbox', inboxId))) ===
            inboxSnapshot,
          'TERMINAL_INBOX_CHANGED',
          '续接准备期间所选消息已变化，请刷新后重试',
        );
        if (mode === 'resume') this.sessionHome(current.record!, true);
        const record: TerminalSessionRecord = current.record ?? {
          revision: 0,
          runId,
          taskId: current.task.id,
          ...current.identity,
          imageId: current.imageId,
          homeOperationId: current.operation.id,
          lastOperationId: current.operation.id,
          ready: false,
        };
        writeTerminalSession(this.store, {
          ...record,
          revision: record.revision + 1,
          pending: {
            requestId: id(),
            mode,
            text: continuationText,
            sourceOperationId: current.operation.id,
            ...(inboxIds.length ? { inboxIds } : {}),
          },
        });
        this.kernel.applyTerminalInbox(current.task, inboxIds);
        if (text.trim()) this.kernel.appendMessage(current.task, 'user', text.trim());
        this.kernel.updateTask(current.task, 'READY', {
          waitReason: undefined,
          waitingFor: [],
          result: undefined,
        });
        const next = this.kernel.updateRun(current.run, { status: 'READY', reason: undefined });
        this.kernel.event(
          runId,
          'terminal.continuation_requested',
          { mode, sourceOperationId: current.operation.id, inboxIds },
          current.task.id,
        );
        return next;
      });
  }
  async run(task: Task, signal: AbortSignal) {
    invariant(!this.closed, 'TERMINAL_CLOSED', '终端服务正在退出，请稍后重试');
    const alreadyReserved = this.resources.has(task.id);
    if (!alreadyReserved) {
      await this.refreshResourceCapacity(signal);
      signal.throwIfAborted();
      const run = this.store.require<Run>('runs', task.runId);
      if (
        !this.resources.tryAcquire(
          task.id,
          'task',
          run.execution?.kind === 'docker-agent' ? run.execution.profile.resourcePreset : undefined,
        )
      )
        return;
    }
    try {
      await this.runWithReservation(task, signal);
    } catch (error) {
      this.runtimePhase(task, 'unavailable');
      throw error;
    } finally {
      if (!alreadyReserved) this.resources.release(task.id);
    }
  }
  private async runWithReservation(task: Task, signal: AbortSignal) {
    invariant(!this.closed, 'TERMINAL_CLOSED', '终端服务正在退出，请稍后重试');
    invariant(
      !this.maintenanceLocks.has(task.runId),
      'TERMINAL_MAINTENANCE_BUSY',
      '会话维护正在进行，请稍后继续',
    );
    task = this.store.require<Task>('tasks', task.id);
    let run = this.store.require<Run>('runs', task.runId);
    invariant(run.execution?.kind === 'docker-agent', 'TERMINAL_EXECUTION', '当前任务不是 Agent 终端执行');
    const frozenProfile = AgentTerminalProfile.parse(run.execution.profile);
    const session = readTerminalSession(this.store, task.id);
    const pending = session?.pending;
    const identity = terminalSessionIdentity(run, task);
    invariant(
      !session ||
        (session.runId === run.id &&
          session.taskId === task.id &&
          session.profileHash === identity.profileHash &&
          session.authorityHash === identity.authorityHash),
      'TERMINAL_SESSION_CHANGED',
      '终端会话授权或模板已变化，请创建新任务',
    );
    const profile =
      pending?.mode === 'resume' ? codexResumeProfile(frozenProfile, session!.sessionId!) : frozenProfile;
    const permission = this.kernel.permissions(task);
    invariant(
      run.kind === 'task' &&
        run.planMode === false &&
        task.phase === 'executing' &&
        permission.read &&
        permission.write &&
        permission.exec &&
        permission.writePaths.length === 1 &&
        permission.writePaths[0] === '.',
      'TERMINAL_EXECUTION_SCOPE',
      'Agent 终端仅支持关闭计划模式并授权完整任务目录的读取、写入和执行',
    );
    const uncertain = this.store
      .all<Operation>('tool_operations', run.id)
      .find(
        (operation) =>
          operation.taskId === task.id &&
          operation.name === 'terminal_agent' &&
          ['INTENT', 'UNCERTAIN'].includes(operation.status),
      );
    if (uncertain) {
      this.kernel.wait(task, 'terminal_verification');
      return;
    }
    const completed = this.store
      .all<Operation>('tool_operations', run.id)
      .filter((operation) => operation.taskId === task.id && operation.name === 'terminal_agent')
      .at(-1);
    invariant(
      pending || completed?.status !== 'FAILED' || !completed.args.continuation,
      'TERMINAL_RETRY_STATE',
      '本次续接没有可安全重试的会话状态；请核验后创建新任务',
    );
    if (completed?.status === 'DONE' && completed.args.contractVersion === task.contractVersion && !pending) {
      this.kernel.updateTask(task, task.status, { result: { terminal: completed.result } });
      this.kernel.wait(this.store.require<Task>('tasks', task.id), 'terminal_review');
      return;
    }
    const source = pending
      ? this.store.require<Operation>('tool_operations', pending.sourceOperationId)
      : undefined;
    const continuation = completed?.args.continuation as
      | { requestId?: string; mode?: string; sourceOperationId?: string }
      | undefined;
    invariant(
      !pending ||
        (source?.status === 'DONE' &&
          source.runId === run.id &&
          source.taskId === task.id &&
          source.name === 'terminal_agent' &&
          source.args.contractVersion === task.contractVersion &&
          source.id === session!.lastOperationId &&
          (source.args.imageId ?? frozenProfile.image) === session!.imageId &&
          (completed?.id === source.id ||
            (completed?.status === 'FAILED' &&
              continuation?.requestId === pending.requestId &&
              continuation?.mode === pending.mode &&
              continuation?.sourceOperationId === source.id))),
      'TERMINAL_SESSION_CHANGED',
      '续接源操作已变化，请核验终端状态',
    );
    if (pending?.mode === 'resume') this.sessionHome(session!, true);
    this.runtimePhase(task, 'preparing');
    const check = await this.check({ ...profile, image: session?.imageId ?? profile.image }, signal, task.id);
    signal.throwIfAborted();
    task = this.store.require<Task>('tasks', task.id);
    if (task.status !== 'READY') return;
    invariant(!this.closed, 'TERMINAL_CLOSED', '终端服务正在退出，请稍后重试');
    invariant(
      !run.startedAt || Date.now() - run.startedAt < run.limits.maxMinutes * 60000,
      'TIME_BUDGET',
      '运行时间达到上限，请创建新任务',
    );
    if (!check.available) {
      this.store.tx(() => {
        this.kernel.updateTask(task, 'READY', {
          result: { terminal: { code: check.code, message: check.message } },
        });
        this.kernel.wait(this.store.require<Task>('tasks', task.id), 'terminal_unavailable');
        this.kernel.event(run.id, 'terminal.unavailable', check, task.id);
        this.runtimePhase(task, 'unavailable');
      });
      return;
    }
    // Resolve only the immutable reference selected at creation. A revoked key fails before claiming work.
    const configuration = await this.connectionConfiguration(profile);
    const values = configuration?.environment ?? this.environment(profile.environment);
    invariant(
      Object.values(values).every((value) => !!value && !/[\r\n\0]/.test(value)) &&
        (configuration || profile.environment.every((name) => !!values[name])),
      'TERMINAL_ENVIRONMENT',
      '终端环境变量缺失或包含无效换行，请检查配置',
    );
    invariant(!this.closed, 'TERMINAL_CLOSED', '终端服务正在退出，请稍后重试');
    const beforeClaim = this.store.require<Run>('runs', run.id);
    invariant(
      stable(terminalSessionIdentity(beforeClaim, this.store.require<Task>('tasks', task.id))) ===
        stable(identity),
      'TERMINAL_SESSION_CHANGED',
      '执行准备期间任务授权或模板已变化',
    );
    const attempt = this.kernel.claim(task.id);
    task = await this.gateway.prepare(this.store.require<Task>('tasks', task.id), signal);
    await this.prepareInitialSnapshot(task, signal);
    run = this.store.require<Run>('runs', task.runId);
    const operation: Operation = {
      id: id(),
      revision: 0,
      runId: run.id,
      taskId: task.id,
      attemptId: attempt.id,
      toolCallId: id(),
      name: 'terminal_agent',
      args: {
        profileId: profile.id,
        contractVersion: task.contractVersion,
        containerName: `elysia-agent-${id()}`,
        imageId: check.imageId,
        ...(pending?.inboxIds?.length ? { inboxIds: pending.inboxIds } : {}),
        ...(pending
          ? {
              continuation: {
                requestId: pending.requestId,
                mode: pending.mode,
                sourceOperationId: pending.sourceOperationId,
              },
            }
          : {}),
      },
      status: 'INTENT',
    };
    const entry = {
      task,
      operation,
      stopping: undefined as Promise<void> | undefined,
      creating: false,
      created: false,
    };
    const state = path.join(this.store.directory, 'terminal-state', operation.id);
    const homeOperationId = pending?.mode === 'resume' ? session!.homeOperationId : operation.id;
    const home = path.join(this.store.directory, 'terminal-state', homeOperationId, 'home');
    operation.args.homeOperationId = homeOperationId;
    const guard = path.join(state, 'git-hidden');
    const envFile = path.join(state, 'environment');
    const projection = new TerminalProjection(
      profile.protocol,
      profile.outputLimit,
      configuration?.secrets ?? Object.values(values),
      (text) => {
        this.runtimePhase(task, 'running', operation.id, true);
        this.kernel.event(
          run.id,
          'terminal.output',
          { operationId: operation.id, text },
          task.id,
          attempt.id,
        );
      },
    );
    this.store.tx(() => {
      const currentSession = readTerminalSession(this.store, task.id);
      invariant(
        stable(currentSession ?? null) === stable(session ?? null),
        'TERMINAL_SESSION_CHANGED',
        '执行准备期间会话状态已变化',
      );
      this.store.put('tool_operations', operation);
      invariant(check.imageId, 'TERMINAL_SESSION_IMAGE_UNKNOWN', '无法固定任务镜像内容');
      writeTerminalSession(this.store, {
        revision: (session?.revision ?? 0) + 1,
        runId: run.id,
        taskId: task.id,
        ...identity,
        imageId: check.imageId,
        homeOperationId,
        lastOperationId: operation.id,
        ready: false,
        ...(pending?.mode === 'resume' ? { sessionId: session!.sessionId } : {}),
      });
      this.kernel.event(
        run.id,
        'terminal.started',
        { operationId: operation.id, profileId: profile.id, agent: profile.agent },
        task.id,
        attempt.id,
      );
    });
    this.active.set(task.id, entry);
    const abort = () => {
      entry.stopping ??= this.stopOwned(task, operation);
      void entry.stopping.catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    let started = false;
    let ownedState = false;
    let terminalResult: TerminalResult | undefined;
    try {
      signal.throwIfAborted();
      invariant(!this.closed, 'TERMINAL_CLOSED', '终端服务正在退出，请稍后重试');
      const stateRoot = path.dirname(state);
      await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
      invariant(
        !(await fs.lstat(stateRoot)).isSymbolicLink() &&
          contained(await fs.realpath(this.store.directory), await fs.realpath(stateRoot)),
        'TERMINAL_STATE_SCOPE',
        '终端状态目录超出应用数据范围',
      );
      await fs.mkdir(state, { mode: 0o700 });
      ownedState = true;
      await fs.writeFile(
        path.join(state, 'owner.json'),
        stable({
          format: 'elysia-terminal-state-v1',
          owner: this.owner,
          runId: run.id,
          taskId: task.id,
          operationId: operation.id,
          homeOperationId,
          stopped: false,
        }),
        { mode: 0o600, flag: 'wx' },
      );
      if (pending?.mode !== 'resume') {
        await fs.mkdir(home, { mode: 0o700 });
        for (const file of configuration?.files ?? [])
          await fs.writeFile(path.join(home, file.path), file.content, { mode: 0o600, flag: 'wx' });
      } else this.sessionHome(session!, true);
      await fs.writeFile(guard, 'gitdir: /elysia-hidden-git\n', { mode: 0o600 });
      // The durable operation exists before any temporary credential file.
      await fs.writeFile(
        envFile,
        Object.entries(values)
          .map(([name, value]) => `${name}=${value}`)
          .join('\n'),
        {
          mode: 0o600,
        },
      );
      const allocation = terminalResourceRequirement(frozenProfile.resourcePreset);
      const args = [
        'create',
        '--interactive',
        '--pull',
        'never',
        '--init',
        '--name',
        String(operation.args.containerName),
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '256',
        '--memory',
        `${allocation.memoryMiB}m`,
        '--cpus',
        String(allocation.cpus),
        '--network',
        profile.network,
        '--user',
        '1000:1000',
        '--workdir',
        '/workspace',
        '--mount',
        `type=bind,source=${task.workspace},target=/workspace`,
        '--mount',
        `type=bind,source=${home},target=/home/agent`,
        '--env-file',
        envFile,
        '--env',
        'HOME=/home/agent',
        '--env',
        'CODEX_HOME=/home/agent/.codex',
        '--env',
        'DSH_HOME=/home/agent/.dsh',
        ...Object.entries(this.labels(task, operation)).flatMap(([key, value]) => [
          '--label',
          `${key}=${value}`,
        ]),
      ];
      // Worktree .git points at the host. A read-only file mask hides that pointer;
      // git diff and integration continue exclusively through the host gateway.
      if (task.baseline) args.push('--mount', `type=bind,source=${guard},target=/workspace/.git,readonly`);
      args.push(check.imageId!, ...(configuration?.command ?? profile.command));
      invariant(!this.closed, 'TERMINAL_CLOSED', '终端服务正在退出，请稍后重试');
      this.runtimePhase(task, 'starting', operation.id);
      entry.creating = true;
      await this.markStateStopped(task, operation, false);
      let created: DockerCommandResult;
      try {
        created = await this.command(args, { signal });
      } finally {
        entry.creating = false;
      }
      await this.clearEnvironmentFile(operation);
      invariant(
        created.exitCode === 0 &&
          !created.timedOut &&
          !created.truncated &&
          /^[a-f0-9]{12,64}$/i.test(created.stdout.trim()),
        'TERMINAL_CREATE_FAILED',
        '无法创建 Agent 容器，请检查镜像、挂载权限与 Docker 状态',
      );
      entry.created = true;
      operation.args.containerCreated = true;
      this.store.put('tool_operations', {
        ...this.store.require<Operation>('tool_operations', operation.id),
        args: operation.args,
      });
      if (signal.aborted || this.closed) {
        entry.stopping = this.stopOwned(task, operation);
        await entry.stopping;
        signal.throwIfAborted();
        invariant(!this.closed, 'TERMINAL_CLOSED', '终端服务正在退出，请稍后重试');
      }
      const prompt = this.store.tx(() => {
        // Snapshot stdin once. Later arrivals stay PENDING for an explicit continuation.
        // A continuation consumes only the items selected in its preparation command.
        if (!pending) {
          const inboxIds = this.kernel.pendingTerminalInbox(run.id).map((message) => message.id);
          this.kernel.applyTerminalInbox(task, inboxIds, operation.id);
          if (inboxIds.length) {
            operation.args.inboxIds = inboxIds;
            this.store.put('tool_operations', {
              ...this.store.require<Operation>('tool_operations', operation.id),
              args: operation.args,
            });
          }
        }
        const taskInput =
          pending?.mode === 'resume'
            ? pending.text
            : `${run.objective}\n\nTask contract: ${stable(run.contract)}\nTask specification: ${stable(task.spec)}\nUser follow-ups: ${stable(
                this.kernel
                  .history(task)
                  .filter((message) => message.role === 'user')
                  .map((message) => message.text),
              )}\n`;
        const input = terminalHarnessPrompt(taskInput);
        invariant(
          Buffer.byteLength(input) <= 1024 * 1024,
          'TERMINAL_INPUT_LIMIT',
          '终端任务输入超过 1 MiB，请拆分任务后重试',
        );
        return input;
      });
      started = true;
      this.runtimePhase(task, 'running', operation.id);
      const controller = new AbortController();
      const relay = () => controller.abort(signal.reason);
      signal.addEventListener('abort', relay, { once: true });
      const timer = setTimeout(
        () => {
          controller.abort(new AppError('TERMINAL_TIMEOUT', 'Agent 终端达到运行时限'));
          abort();
        },
        Math.min(
          profile.timeoutMs,
          Math.max(1000, run.limits.maxMinutes * 60000 - (Date.now() - (run.startedAt ?? Date.now()))),
        ),
      );
      let result: DockerCommandResult;
      try {
        result = await this.command(
          ['start', '--attach', '--interactive', String(operation.args.containerName)],
          {
            input: prompt,
            signal: controller.signal,
            timeoutMs: profile.timeoutMs + 1000,
            outputLimit: profile.outputLimit,
            onStdout: (text) => projection.write(text),
          },
        );
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', relay);
      }
      const transcript = projection.finish();
      this.runtimePhase(task, 'finalizing', operation.id);
      const artifact = this.gateway.artifact(
        task,
        'agent-terminal.txt',
        transcript || '终端未产生公开输出。',
        'Docker Agent · ' + profile.label,
      );
      terminalResult = {
        operationId: operation.id,
        containerName: String(operation.args.containerName),
        transcriptArtifactId: artifact.id,
        diffArtifactId: null,
        summary: projection.summary,
        exitCode: result.exitCode,
        sessionId: projection.sessionId,
        truncated: projection.truncated || result.truncated,
      };
      invariant(
        !this.closed &&
          !signal.aborted &&
          !controller.signal.aborted &&
          !result.timedOut &&
          result.exitCode === 0 &&
          projection.completed &&
          !projection.failed &&
          !projection.malformed,
        'TERMINAL_RESULT_UNCERTAIN',
        'Agent 终端未可靠完成；已保留公开输出，请核验工作区后决定下一步',
      );
      if (task.baseline) terminalResult.diffArtifactId = (await this.gateway.diff(task, signal)).id;
      else {
        const files = await this.workspaceManifest(task.workspace!, signal);
        invariant(
          files.files.length > 0,
          'TERMINAL_WORKSPACE_EMPTY',
          '终端未产生可核验的工作区文件，请检查交付物',
        );
        terminalResult.workspaceManifestArtifactId = this.gateway.artifact(
          task,
          'task-workspace-manifest.json',
          stable(files),
          '任务工作区文件 SHA-256 清单',
        ).id;
      }
      await (entry.stopping ??= this.stopOwned(task, operation));
      signal.throwIfAborted();
      const completedSession: TerminalSessionRecord = {
        ...readTerminalSession(this.store, task.id)!,
        revision: readTerminalSession(this.store, task.id)!.revision + 1,
        ready: true,
        sessionId: projection.sessionId ?? (pending?.mode === 'resume' ? session!.sessionId : undefined),
        state: undefined,
      };
      if (profile.agent === 'codex') {
        try {
          completedSession.state = this.sessionSeal(completedSession);
        } catch {
          /* A reliable turn may still lack resumable private state; explicit new-session remains available. */
        }
      }
      this.store.tx(() => {
        this.store.put('tool_operations', {
          ...this.store.require<Operation>('tool_operations', operation.id),
          status: 'DONE',
          result: terminalResult,
        });
        writeTerminalSession(this.store, completedSession);
        const current = this.store.require<Task>('tasks', task.id);
        if (current.status !== 'RUNNING') {
          this.runtimePhase(current, 'stopped', operation.id);
          return;
        }
        this.kernel.appendMessage(
          current,
          'assistant',
          projection.summary || 'Agent 终端已退出，请核验公开日志与工作区变更。',
        );
        this.kernel.updateTask(current, 'RUNNING', { result: { terminal: terminalResult } });
        this.kernel.wait(this.store.require<Task>('tasks', task.id), 'terminal_review');
        this.kernel.event(run.id, 'terminal.completed', terminalResult, task.id, attempt.id);
        this.runtimePhase(task, 'review', operation.id);
      });
    } catch (error) {
      this.runtimePhase(task, 'finalizing', operation.id);
      let stopped = false;
      try {
        await entry.stopping;
        // A stop made during create cannot prove that a late create response left no container.
        await this.stopOwned(task, operation);
        stopped = true;
      } catch {
        /* Do not turn a failed stop into a successful task. */
      }
      if (!stopped || (signal.aborted && !entry.created)) this.resources.hold(task.id);
      if (!terminalResult) {
        const artifact = this.gateway.artifact(
          task,
          'agent-terminal.txt',
          projection.finish() || '终端未产生公开输出。',
          'Docker Agent · ' + profile.label,
        );
        terminalResult = {
          operationId: operation.id,
          containerName: String(operation.args.containerName),
          transcriptArtifactId: artifact.id,
          diffArtifactId: null,
          summary: projection.summary,
          exitCode: null,
          truncated: projection.truncated,
        };
      }
      const uncertain = started || signal.aborted;
      let restorePending = false;
      if (pending && session && !uncertain && stopped && session.ready && session.state) {
        try {
          this.sessionHome(session, true);
          const currentSource = this.store.require<Operation>('tool_operations', pending.sourceOperationId);
          restorePending =
            currentSource.status === 'DONE' &&
            currentSource.runId === run.id &&
            currentSource.taskId === task.id &&
            currentSource.args.imageId === session.imageId &&
            stable(
              terminalSessionIdentity(
                this.store.require<Run>('runs', run.id),
                this.store.require<Task>('tasks', task.id),
              ),
            ) === stable(identity);
        } catch {
          /* Modified or unknown private state never falls back to a different continuation mode. */
        }
      }
      this.store.tx(() => {
        const message = error instanceof AppError ? error.message : 'Agent 终端连接中断，请核验工作区';
        this.store.put('tool_operations', {
          ...this.store.require<Operation>('tool_operations', operation.id),
          status: uncertain ? 'UNCERTAIN' : 'FAILED',
          result: terminalResult,
          error: message,
        });
        if (restorePending)
          writeTerminalSession(this.store, {
            ...session!,
            revision: readTerminalSession(this.store, task.id)!.revision + 1,
            pending,
          });
        const current = this.store.require<Task>('tasks', task.id);
        if (current.status !== 'CANCELLED' && current.status !== 'DONE') {
          this.kernel.updateTask(current, current.status, {
            result: { terminal: { ...terminalResult, message } },
          });
          this.kernel.wait(
            this.store.require<Task>('tasks', task.id),
            uncertain ? 'terminal_verification' : 'terminal_unavailable',
          );
        }
        this.kernel.event(
          run.id,
          'terminal.failed',
          { operationId: operation.id, uncertain, message },
          task.id,
          attempt.id,
        );
        this.runtimePhase(task, uncertain ? 'verification' : 'unavailable', operation.id);
      });
    } finally {
      signal.removeEventListener('abort', abort);
      this.active.delete(task.id);
      try {
        if (ownedState) await this.clearEnvironmentFile(operation);
      } finally {
        this.kernel.checkpoint(attempt.id);
      }
    }
  }
  /** 校验运行版本及待处理消息，准备终端交付验收操作。 */
  async prepareAcceptance(runId: string, expectedRevision: number): Promise<() => unknown> {
    const run = this.store.require<Run>('runs', runId);
    invariant(run.revision === expectedRevision, 'REVISION_CONFLICT', '对话已更新，请刷新后再验收');
    invariant(
      this.kernel.pendingTerminalInbox(runId).length === 0,
      'TERMINAL_INBOX_PENDING',
      '终端仍有待处理消息，请先选择消息继续执行后再验收',
    );
    invariant(
      run.execution?.kind === 'docker-agent' && !run.archived && run.status === 'WAITING',
      'TERMINAL_REVIEW_STATE',
      '当前终端任务不可验收',
    );
    const task = this.store.require<Task>('tasks', run.rootTaskId);
    invariant(
      task.status === 'WAITING' && task.waitReason === 'terminal_review' && !this.active.has(task.id),
      'TERMINAL_REVIEW_STATE',
      '请等待终端完成并进入验收',
    );
    const operation = this.store
      .all<Operation>('tool_operations', run.id)
      .filter((op) => op.taskId === task.id && op.name === 'terminal_agent')
      .at(-1);
    invariant(operation?.status === 'DONE', 'TERMINAL_REVIEW_STATE', '终端执行结果尚未确认');
    const result = operation.result as TerminalResult;
    const references = [
      result.transcriptArtifactId,
      ...(result.diffArtifactId ? [result.diffArtifactId] : []),
      ...(result.workspaceManifestArtifactId ? [result.workspaceManifestArtifactId] : []),
    ];
    for (const ref of references) {
      const artifact = this.store.require<Artifact>('artifacts', ref);
      invariant(
        artifact.runId === run.id &&
          artifact.taskId === task.id &&
          hash(this.store.readObject(artifact.objectRef)) === artifact.hash,
        'EVIDENCE_MISMATCH',
        '终端产物完整性核验失败',
      );
    }
    if (result.diffArtifactId) {
      const current = await this.gateway.diff(task, new AbortController().signal);
      invariant(
        current.hash === this.store.require<Artifact>('artifacts', result.diffArtifactId).hash,
        'TERMINAL_WORKSPACE_CHANGED',
        '终端结束后工作区已变化，请检查新差异后重新执行',
      );
    }
    if (!task.baseline) {
      invariant(
        result.workspaceManifestArtifactId,
        'TERMINAL_WORKSPACE_EVIDENCE',
        '无 Git 任务缺少实际文件清单，不能只凭终端日志验收',
      );
      const files = await this.workspaceManifest(task.workspace!, new AbortController().signal);
      invariant(
        hash(stable(files)) ===
          this.store.require<Artifact>('artifacts', result.workspaceManifestArtifactId).hash,
        'TERMINAL_WORKSPACE_CHANGED',
        '终端结束后工作区文件已变化，请核验后重新执行',
      );
    }
    const evidenceHash = this.store.require<Artifact>(
      'artifacts',
      result.diffArtifactId ?? result.workspaceManifestArtifactId!,
    ).hash;
    const workspaceSignature = this.workspaceSignature(task, evidenceHash);
    return () =>
      this.store.tx(() => {
        const currentRun = this.store.require<Run>('runs', run.id),
          currentTask = this.store.require<Task>('tasks', task.id);
        invariant(
          currentRun.revision === expectedRevision,
          'REVISION_CONFLICT',
          '对话已更新，请刷新后再验收',
        );
        invariant(
          this.kernel.pendingTerminalInbox(runId).length === 0,
          'TERMINAL_INBOX_PENDING',
          '验收准备期间收到新消息，请先处理待收消息后再验收',
        );
        invariant(
          !currentRun.archived &&
            currentRun.status === 'WAITING' &&
            currentTask.status === 'WAITING' &&
            currentTask.waitReason === 'terminal_review' &&
            !this.active.has(task.id) &&
            this.store.require<Operation>('tool_operations', operation.id).status === 'DONE',
          'TERMINAL_REVIEW_STATE',
          '终端任务状态已变化，请刷新后重试',
        );
        invariant(
          this.workspaceSignature(currentTask, evidenceHash) === workspaceSignature,
          'TERMINAL_WORKSPACE_CHANGED',
          '验收准备后工作区已变化，请重新检查',
        );
        invariant(
          this.store
            .all<Task>('tasks', run.id)
            .filter(
              (child) =>
                child.parentTaskId === task.id &&
                child.spec.required &&
                child.contractVersion === run.contract.version,
            )
            .every((child) => child.status === 'DONE'),
          'CHILDREN_INCOMPLETE',
          '必需子任务尚未通过验收',
        );
        const evidence = currentTask.spec.acceptanceCriteria.map((_criterion, index) => ({
          criterion: index,
          type: 'artifact' as const,
          ref: result.diffArtifactId ?? result.workspaceManifestArtifactId ?? result.transcriptArtifactId,
        }));
        invariant(evidence.length > 0, 'ACCEPTANCE_MISSING', '每个验收项都需要证据');
        for (const ref of references) {
          const artifact = this.store.require<Artifact>('artifacts', ref);
          invariant(
            artifact.runId === run.id &&
              artifact.taskId === task.id &&
              hash(this.store.readObject(artifact.objectRef)) === artifact.hash,
            'EVIDENCE_MISMATCH',
            '终端产物完整性核验失败',
          );
          this.store.put('artifacts', { ...artifact, verified: true });
        }
        this.kernel.updateTask(currentTask, 'VERIFYING');
        const accepted = {
          summary: result.summary || '用户已核验 Agent 终端结果',
          evidence,
          verifiedAt: now(),
          limitation: '已核验产物与工作区差异；每条验收内容由用户确认',
          terminal: result,
        };
        this.kernel.updateTask(this.store.require<Task>('tasks', task.id), 'DONE', {
          result: accepted,
          waitReason: undefined,
        });
        const attempt = this.store.require<Attempt>('attempts', operation.attemptId);
        this.store.put('attempts', { ...attempt, status: 'DONE', lease: null });
        this.kernel.updateRun(currentRun, { status: 'DONE', reason: undefined });
        this.kernel.event(
          run.id,
          'terminal.accepted',
          { operationId: operation.id, evidence },
          task.id,
          attempt.id,
        );
        return accepted;
      });
  }
  async accept(runId: string, expectedRevision: number) {
    return (await this.prepareAcceptance(runId, expectedRevision))();
  }
  /** 校验运行版本及核验参数，准备对指定操作结果的核验。 */
  async prepareVerification(
    runId: string,
    expectedRevision: number,
    operationId: string,
    outcome: 'confirmed' | 'not_applied',
    note: string,
  ): Promise<() => unknown> {
    const run = this.store.require<Run>('runs', runId);
    invariant(run.revision === expectedRevision, 'REVISION_CONFLICT', '对话已更新，请刷新后再核验');
    invariant(
      run.execution?.kind === 'docker-agent' && !run.archived && run.status === 'WAITING',
      'TERMINAL_VERIFICATION_STATE',
      '当前任务不可核验',
    );
    const task = this.store.require<Task>('tasks', run.rootTaskId);
    const operation = this.store.require<Operation>('tool_operations', operationId);
    invariant(
      task.status === 'WAITING' &&
        task.waitReason === 'terminal_verification' &&
        operation.runId === run.id &&
        operation.taskId === task.id &&
        operation.name === 'terminal_agent' &&
        operation.status === 'UNCERTAIN' &&
        !this.active.has(task.id),
      'TERMINAL_VERIFICATION_STATE',
      '请等待终端停止，并选择本任务待核验的终端操作',
    );
    invariant(
      ['confirmed', 'not_applied'].includes(outcome) && note.trim().length > 0 && note.length <= 4000,
      'TERMINAL_VERIFICATION_NOTE',
      '请填写核验依据，最多 4000 字',
    );
    // Never unblock an uncertain attempt while its agent can still modify files.
    await this.stopOwned(task, operation);
    const previous = operation.result as Partial<TerminalResult> | undefined;
    let result = previous as TerminalResult | undefined;
    if (outcome === 'confirmed') {
      const report = this.gateway.artifact(
        task,
        'agent-terminal-verification.txt',
        `用户核验：已发生\n\n${note.trim()}\n\n原始退出码：${previous?.exitCode ?? '未知'}\n此报告记录用户核验意见，不代表 CLI 成功退出。`,
        '用户手工核验 Agent 终端',
      );
      result = {
        operationId: operation.id,
        containerName: String(operation.args.containerName),
        transcriptArtifactId: report.id,
        diffArtifactId: task.baseline
          ? (await this.gateway.diff(task, new AbortController().signal)).id
          : null,
        summary: note.trim(),
        exitCode: previous?.exitCode ?? null,
        truncated: previous?.truncated ?? false,
      };
      if (!task.baseline) {
        const files = await this.workspaceManifest(task.workspace!, new AbortController().signal);
        invariant(
          files.files.length > 0,
          'TERMINAL_WORKSPACE_EMPTY',
          '工作区没有可核验文件，请补齐交付物再确认已发生',
        );
        result.workspaceManifestArtifactId = this.gateway.artifact(
          task,
          'task-workspace-manifest.json',
          stable(files),
          '用户核验时工作区文件 SHA-256 清单',
        ).id;
      }
    }
    const evidenceHash =
      outcome === 'confirmed'
        ? this.store.require<Artifact>(
            'artifacts',
            result!.diffArtifactId ?? result!.workspaceManifestArtifactId!,
          ).hash
        : undefined;
    const workspaceSignature = this.workspaceSignature(task, evidenceHash);
    return () =>
      this.store.tx(() => {
        const currentRun = this.store.require<Run>('runs', run.id),
          currentTask = this.store.require<Task>('tasks', task.id),
          currentOperation = this.store.require<Operation>('tool_operations', operation.id);
        invariant(
          currentRun.revision === expectedRevision,
          'REVISION_CONFLICT',
          '对话已更新，请刷新后再核验',
        );
        invariant(
          !currentRun.archived &&
            currentRun.status === 'WAITING' &&
            currentTask.status === 'WAITING' &&
            currentTask.waitReason === 'terminal_verification' &&
            currentOperation.status === 'UNCERTAIN' &&
            !this.active.has(task.id),
          'TERMINAL_VERIFICATION_STATE',
          '终端核验状态已变化，请刷新后重试',
        );
        invariant(
          this.workspaceSignature(currentTask, evidenceHash) === workspaceSignature,
          'TERMINAL_WORKSPACE_CHANGED',
          '核验准备后工作区已变化，请重新检查',
        );
        if (outcome === 'confirmed') {
          for (const ref of [
            result!.transcriptArtifactId,
            ...(result!.diffArtifactId ? [result!.diffArtifactId] : []),
            ...(result!.workspaceManifestArtifactId ? [result!.workspaceManifestArtifactId] : []),
          ]) {
            const artifact = this.store.require<Artifact>('artifacts', ref);
            invariant(
              artifact.runId === run.id &&
                artifact.taskId === task.id &&
                hash(this.store.readObject(artifact.objectRef)) === artifact.hash,
              'EVIDENCE_MISMATCH',
              '核验产物完整性检查失败',
            );
          }
        }
        const verified = {
          ...result,
          userVerified: outcome,
          verificationNote: note.trim(),
          verifiedAt: now(),
        };
        this.store.put('tool_operations', {
          ...currentOperation,
          status: outcome === 'confirmed' ? 'DONE' : 'FAILED',
          result: verified,
        });
        this.kernel.updateTask(currentTask, 'WAITING', { result: { terminal: verified } });
        this.kernel.wait(
          this.store.require<Task>('tasks', task.id),
          outcome === 'confirmed' ? 'terminal_review' : 'paused',
        );
        this.kernel.event(
          run.id,
          'terminal.verified',
          { operationId: operation.id, outcome, note: note.trim() },
          task.id,
          operation.attemptId,
        );
        return this.store.require<Run>('runs', run.id);
      });
  }
}
