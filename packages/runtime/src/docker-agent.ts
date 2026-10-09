import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
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
} from '../../contracts/src/index.js';
import { Kernel } from '../../kernel/src/index.js';
import { hash, id, now, stable } from '../../storage/src/index.js';
import { cleanEnv, ToolGateway } from '../../tools/src/index.js';

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
  return [];
};

/** Persist only public text and coarse tool activity, never private thinking or raw vendor stderr. */
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
  agentAvailable: null;
  missingEnvironment?: string[];
  code?: string;
  message: string;
}

/** External agent execution beside the native API loop; scheduling remains in NativeExecutor. */
export class DockerAgentService {
  private transport: DockerTransport;
  private active = new Map<string, { task: Task; operation: Operation; stopping?: Promise<void> }>();
  private owner: string;
  private environment: (names: string[]) => Record<string, string>;
  constructor(
    public kernel: Kernel,
    public gateway: ToolGateway,
    options: { transport?: DockerTransport; environment?: (names: string[]) => Record<string, string> } = {},
  ) {
    this.transport = options.transport ?? new DockerCliTransport();
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
  async check(raw?: AgentTerminalProfile): Promise<DockerAgentCheck> {
    const profile = raw ? AgentTerminalProfile.parse(raw) : undefined;
    try {
      const probe = await this.command(['version', '--format', '{{json .Server}}']);
      if (
        probe.exitCode !== 0 ||
        probe.timedOut ||
        probe.truncated ||
        !probe.stdout.trim() ||
        probe.stdout.trim() === 'null'
      )
        return {
          available: false,
          agentAvailable: null,
          code: 'DOCKER_UNAVAILABLE',
          message: 'Docker Linux 引擎未就绪，请启动 Docker Desktop 后重试',
        };
      const server = JSON.parse(probe.stdout);
      invariant(
        server && typeof server === 'object' && typeof server.Version === 'string',
        'DOCKER_UNAVAILABLE',
        'Docker 返回信息不完整，请检查 Docker Desktop',
      );
      if (server.Os !== 'linux')
        return {
          available: false,
          agentAvailable: null,
          code: 'DOCKER_PLATFORM',
          message: 'Agent 终端需要 Docker Linux 容器模式',
        };
      if (profile) {
        const image = await this.command(['image', 'inspect', '--format', '{{.Id}}', profile.image]);
        if (image.exitCode !== 0 || image.timedOut || image.truncated)
          return {
            available: false,
            version: server.Version,
            imageAvailable: false,
            agentAvailable: null,
            code: 'DOCKER_IMAGE_MISSING',
            message: '尚未安装指定 Agent 镜像，请先构建或导入镜像；不会自动拉取',
          };
        const values = this.environment(profile.environment);
        const missingEnvironment = profile.environment.filter((name) => !values[name]);
        if (missingEnvironment.length)
          return {
            available: false,
            version: server.Version,
            imageAvailable: true,
            agentAvailable: null,
            missingEnvironment,
            code: 'TERMINAL_ENVIRONMENT_MISSING',
            message: `服务进程缺少环境变量：${missingEnvironment.join('、')}；配置后重启服务`,
          };
      }
      return {
        available: true,
        version: server.Version,
        ...(profile ? { imageAvailable: true } : {}),
        agentAvailable: null,
        message: 'Docker 已就绪；Agent 命令和认证将在实际运行时检查',
      };
    } catch (error) {
      return {
        available: false,
        agentAvailable: null,
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
      if (/No such (object|container)/i.test(inspected.stderr)) return;
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
  }
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
    await Promise.all(
      [...new Set([...this.active.values()].map((entry) => entry.task.runId))].map((runId) =>
        this.interrupt(runId),
      ),
    );
  }
  private async clearEnvironmentFile(operation: Operation) {
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
  async recover() {
    for (const operation of this.store
      .all<Operation>('tool_operations')
      .filter((op) => op.name === 'terminal_agent')) {
      if (!/^[a-f0-9-]{36}$/.test(operation.id)) continue;
      try {
        await this.clearEnvironmentFile(operation);
      } catch (error: any) {
        if (error.code !== 'ENOENT')
          this.kernel.event(
            operation.runId,
            'terminal.environment_cleanup_failed',
            { operationId: operation.id, message: '已知终端临时环境文件尚未清理，请检查数据目录权限' },
            operation.taskId,
            operation.attemptId,
          );
      }
    }
    for (const operation of this.store
      .all<Operation>('tool_operations')
      .filter((op) => op.name === 'terminal_agent' && ['INTENT', 'UNCERTAIN'].includes(op.status))) {
      const task = this.store.require<Task>('tasks', operation.taskId);
      try {
        await this.stopOwned(task, operation);
      } catch {
        /* Keep uncertain state even when Docker is unavailable. */
      }
      this.store.tx(() => {
        this.store.put('tool_operations', {
          ...this.store.require<Operation>('tool_operations', operation.id),
          status: 'UNCERTAIN',
          error: '服务曾中断；终端副作用需要核验，不会自动重跑',
        });
        const current = this.store.require<Task>('tasks', task.id);
        if (!['DONE', 'CANCELLED'].includes(current.status))
          this.kernel.wait(current, 'terminal_verification');
      });
    }
  }
  async run(task: Task, signal: AbortSignal) {
    task = this.store.require<Task>('tasks', task.id);
    let run = this.store.require<Run>('runs', task.runId);
    invariant(run.execution?.kind === 'docker-agent', 'TERMINAL_EXECUTION', '当前任务不是 Agent 终端执行');
    const profile = AgentTerminalProfile.parse(run.execution.profile);
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
    if (completed?.status === 'DONE' && completed.args.contractVersion === task.contractVersion) {
      this.kernel.updateTask(task, task.status, { result: { terminal: completed.result } });
      this.kernel.wait(this.store.require<Task>('tasks', task.id), 'terminal_review');
      return;
    }
    const check = await this.check(profile);
    signal.throwIfAborted();
    task = this.store.require<Task>('tasks', task.id);
    if (task.status !== 'READY') return;
    if (!check.available) {
      this.store.tx(() => {
        this.kernel.updateTask(task, 'READY', {
          result: { terminal: { code: check.code, message: check.message } },
        });
        this.kernel.wait(this.store.require<Task>('tasks', task.id), 'terminal_unavailable');
        this.kernel.event(run.id, 'terminal.unavailable', check, task.id);
      });
      return;
    }
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
      },
      status: 'INTENT',
    };
    const entry = { task, operation, stopping: undefined as Promise<void> | undefined };
    const state = path.join(this.store.directory, 'terminal-state', operation.id);
    const home = path.join(state, 'home');
    const guard = path.join(state, 'git-hidden');
    const envFile = path.join(state, 'environment');
    const values = this.environment(profile.environment);
    invariant(
      profile.environment.every((name) => !!values[name] && !/[\r\n\0]/.test(values[name])),
      'TERMINAL_ENVIRONMENT',
      '终端环境变量缺失或包含无效换行，请检查配置',
    );
    const projection = new TerminalProjection(
      profile.protocol,
      profile.outputLimit,
      Object.values(values),
      (text) =>
        this.kernel.event(
          run.id,
          'terminal.output',
          { operationId: operation.id, text },
          task.id,
          attempt.id,
        ),
    );
    this.store.tx(() => {
      this.store.put('tool_operations', operation);
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
      await fs.mkdir(home, { mode: 0o700 });
      await fs.writeFile(guard, 'gitdir: /elysia-hidden-git\n', { mode: 0o600 });
      // The durable operation exists before any temporary credential file.
      await fs.writeFile(envFile, profile.environment.map((name) => `${name}=${values[name]}`).join('\n'), {
        mode: 0o600,
      });
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
        '2g',
        '--cpus',
        '2',
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
      args.push(profile.image, ...profile.command);
      const created = await this.command(args, { signal });
      await this.clearEnvironmentFile(operation);
      invariant(
        created.exitCode === 0 &&
          !created.timedOut &&
          !created.truncated &&
          /^[a-f0-9]{12,64}$/i.test(created.stdout.trim()),
        'TERMINAL_CREATE_FAILED',
        '无法创建 Agent 容器，请检查镜像、挂载权限与 Docker 状态',
      );
      if (signal.aborted) {
        entry.stopping = this.stopOwned(task, operation);
        await entry.stopping;
        signal.throwIfAborted();
      }
      const prompt = `${run.objective}\n\n任务契约：${stable(run.contract)}\n任务规格：${stable(task.spec)}\n用户补充：${stable(
        this.kernel
          .history(task)
          .filter((message) => message.role === 'user')
          .map((message) => message.text),
      )}\n\n仅在 /workspace 完成本任务，不修改隐藏的 Git 元数据。请提供最终结果摘要；完成状态由 Elysia 用户验收决定。\n`;
      invariant(
        Buffer.byteLength(prompt) <= 1024 * 1024,
        'TERMINAL_INPUT_LIMIT',
        '终端任务输入超过 1 MiB，请拆分任务后重试',
      );
      started = true;
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
      this.store.tx(() => {
        this.store.put('tool_operations', {
          ...this.store.require<Operation>('tool_operations', operation.id),
          status: 'DONE',
          result: terminalResult,
        });
        const current = this.store.require<Task>('tasks', task.id);
        if (current.status !== 'RUNNING') return;
        this.kernel.appendMessage(
          current,
          'assistant',
          projection.summary || 'Agent 终端已退出，请核验公开日志与工作区变更。',
        );
        this.kernel.updateTask(current, 'RUNNING', { result: { terminal: terminalResult } });
        this.kernel.wait(this.store.require<Task>('tasks', task.id), 'terminal_review');
        this.kernel.event(run.id, 'terminal.completed', terminalResult, task.id, attempt.id);
      });
    } catch (error) {
      try {
        await (entry.stopping ?? this.stopOwned(task, operation));
      } catch {
        /* Do not turn a failed stop into a successful task. */
      }
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
      this.store.tx(() => {
        const message = error instanceof AppError ? error.message : 'Agent 终端连接中断，请核验工作区';
        this.store.put('tool_operations', {
          ...this.store.require<Operation>('tool_operations', operation.id),
          status: uncertain ? 'UNCERTAIN' : 'FAILED',
          result: terminalResult,
          error: message,
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
  async prepareAcceptance(runId: string, expectedRevision: number): Promise<() => unknown> {
    const run = this.store.require<Run>('runs', runId);
    invariant(run.revision === expectedRevision, 'REVISION_CONFLICT', '对话已更新，请刷新后再验收');
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
