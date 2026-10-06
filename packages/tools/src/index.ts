import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  AppError,
  Contract,
  Plan,
  TaskSpec,
  Evidence,
  invariant,
  type Task,
  type Run,
  type Project,
  type Operation,
  type Attempt,
  type Artifact,
  type Snapshot,
  type ToolCall,
} from '../../contracts/src/index.js';
import { Store, id, hash, stable, now } from '../../storage/src/index.js';
import { Kernel } from '../../kernel/src/index.js';
import type { ToolDefinition } from '../../context/src/index.js';
const text = z.string().max(2 * 1024 * 1024);
const schemas = {
  list: z.object({ path: z.string().default('.') }),
  read: z.object({ path: z.string() }),
  read_artifact: z.object({ artifactId: z.string() }),
  search: z.object({ path: z.string().default('.'), query: z.string().min(1).max(200) }),
  write: z.object({ path: z.string(), content: text, expectedHash: z.string().nullable() }),
  apply_patch: z.object({
    path: z.string(),
    expectedHash: z.string(),
    oldText: z.string().min(1),
    newText: text,
  }),
  exec: z.object({
    program: z.string().min(1),
    args: z.array(z.string()).max(100),
    cwd: z.string().default('.'),
    timeout: z.number().int().min(100).max(120000).default(60000),
    outputLimit: z.number().int().min(1000).max(200000).default(40000),
  }),
  fetch_url: z.object({ url: z.string().url() }),
  artifact: z.object({ path: z.string(), name: z.string().min(1).max(150) }),
  diff: z.object({}),
  integrate_worktrees: z.object({ taskIds: z.array(z.string()).min(1).max(11) }),
  clarify: z.object({ questions: z.array(z.string().min(1)).min(1).max(6) }),
  propose_plan: z.object({ contract: Contract, plan: Plan }),
  spawn_task: TaskSpec,
  join_tasks: z.object({ taskIds: z.array(z.string()).min(1).max(11) }),
  submit_result: z.object({
    summary: z.string().min(1),
    evidence: z.array(Evidence).min(1),
    incomplete: z.array(z.string()),
  }),
};
type ToolName = keyof typeof schemas;
const descriptions: Record<ToolName, string> = {
  list: '浏览授权目录，返回来源。',
  read: '读取文件并记录不可变来源快照和哈希。',
  read_artifact: '读取本任务或已验收的同 run 产物，取得不可变内容与来源。',
  search: '按字面文本搜索授权项目文件。',
  write: '原子写文件，expectedHash 为当前哈希，新文件为 null。',
  apply_patch: '用唯一原文与预期哈希修改文件。',
  exec: '执行明确的程序和参数，cwd 必须在本任务工作区；无密钥环境，超时清理进程树。',
  fetch_url: '抓取明确授权 URL，防止访问私网，记录快照。',
  artifact: '登记本任务文件为版本化产物，返回 artifact ID。',
  diff: '登记本任务 Git diff 含未跟踪文件。',
  integrate_worktrees:
    '把已完成子任务的独立 worktree 变更集成到自己的 worktree，返回差异；冲突时保留待解决工作区。',
  clarify: '一次汇总关键问题并等待用户。',
  propose_plan: '总代理提出具体版本的约定和计划，等待接受。',
  spawn_task: '创建有界子任务，返回任务和 Agent ID。',
  join_tasks: '等待指定子任务，释放调用槽位；已完成则立即返回结果。',
  submit_result:
    '提交结果，证据 criterion 为验收项下标；file 使用工作区路径和真实哈希，artifact 使用 ID，command 使用成功工具 operationId。不能有未完成项，内核核验后决定完成。',
};
const mutating = new Set(['write', 'apply_patch', 'exec', 'artifact', 'diff', 'integrate_worktrees']);
export function cleanEnv() {
  const keys = [
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'LANG',
    'LC_ALL',
  ];
  return Object.fromEntries(keys.filter((k) => process.env[k]).map((k) => [k, process.env[k]!]));
}
export class Processes {
  children = new Map<number, { taskId: string; child: ReturnType<typeof spawn> }>();
  async kill(pid: number) {
    const record = this.children.get(pid);
    if (!record) return;
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const p = spawn(
          path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore', env: cleanEnv() },
        );
        p.on('error', () => resolve());
        p.on('exit', () => resolve());
      });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }
  }
  async cancel(taskIds?: Set<string>) {
    await Promise.all(
      [...this.children.entries()]
        .filter(([, r]) => !taskIds || taskIds.has(r.taskId))
        .map(([pid]) => this.kill(pid)),
    );
  }
  run(
    taskId: string,
    program: string,
    args: string[],
    cwd: string,
    timeout: number,
    outputLimit: number,
    signal?: AbortSignal,
  ): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
    timedOut: boolean;
  }> {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const child = spawn(program, args, {
        cwd,
        env: cleanEnv(),
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      let stdout = '',
        stderr = '',
        bytes = 0,
        truncated = false,
        timedOut = false;
      if (child.pid) this.children.set(child.pid, { taskId, child });
      const record = (target: 'stdout' | 'stderr', data: Buffer) => {
        const remaining = Math.max(0, outputLimit - bytes);
        bytes += data.length;
        const chunk = data.subarray(0, remaining).toString('utf8');
        if (target === 'stdout') stdout += chunk;
        else stderr += chunk;
        if (bytes > outputLimit) truncated = true;
      };
      child.stdout?.on('data', (data) => record('stdout', data));
      child.stderr?.on('data', (data) => record('stderr', data));
      const abort = () => {
        if (child.pid) void this.kill(child.pid);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        abort();
      }, timeout);
      signal?.addEventListener('abort', abort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (child.pid) this.children.delete(child.pid);
      };
      child.on('error', (error) => {
        cleanup();
        reject(new AppError('PROCESS_START', error.message));
      });
      child.on('close', (exitCode) => {
        cleanup();
        resolve({ exitCode, stdout, stderr, truncated, timedOut });
      });
    });
  }
}
function contained(root: string, target: string) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
async function resolved(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    const parent = path.dirname(target);
    if (parent === target) throw e;
    return path.join(await resolved(parent), path.basename(target));
  }
}
export interface SandboxBackend {
  run(
    taskId: string,
    program: string,
    args: string[],
    cwd: string,
    timeout: number,
    outputLimit: number,
    signal?: AbortSignal,
  ): ReturnType<Processes['run']>;
}
export class ToolGateway {
  processes = new Processes();
  constructor(public kernel: Kernel) {}
  get store() {
    return this.kernel.store;
  }
  async recoverOperations() {
    for (const operation of this.store
      .all<Operation>('tool_operations')
      .filter((o) => o.status === 'UNCERTAIN' && ['write', 'apply_patch'].includes(o.name))) {
      const task = this.store.require<Task>('tasks', operation.taskId),
        evidence = operation.evidence;
      if (!evidence || typeof evidence.path !== 'string' || typeof evidence.afterHash !== 'string') continue;
      try {
        const file = await this.path(task, evidence.path);
        let actualHash: string | null = null;
        try {
          actualHash = hash(await fs.readFile(file));
        } catch (error: any) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (actualHash !== evidence.afterHash && actualHash !== evidence.beforeHash) continue;
        const applied = actualHash === evidence.afterHash;
        this.store.tx(() => {
          const updated = this.store.put('tool_operations', {
            ...operation,
            status: applied ? ('DONE' as const) : ('FAILED' as const),
            result: applied
              ? { source: file, hash: actualHash, recovered: true }
              : { error: '核验原文哈希，写入未应用', recovered: true },
          });
          this.kernel.event(task.runId, 'tool.completed', updated, task.id, operation.attemptId);
          if (
            !this.store
              .all<Operation>('tool_operations', task.runId)
              .some((o) => o.taskId === task.id && o.status === 'UNCERTAIN') &&
            task.status === 'WAITING' &&
            task.waitReason === 'verification'
          )
            this.kernel.updateTask(task, 'WAITING', { waitReason: 'interrupted' });
        });
      } catch {
        /* 无法证明结果，保留用户核验入口。 */
      }
    }
  }
  definitions(task: Task): ToolDefinition[] {
    const permission = this.kernel.permissions(task);
    let names: ToolName[] = ['clarify'];
    if (task.spec.role === 'coordinator' && task.phase === 'planning') names.push('propose_plan');
    if (permission.read) names.push('list', 'read', 'read_artifact', 'search');
    if (permission.urls.length) names.push('fetch_url');
    if (task.phase === 'executing') {
      names.push('join_tasks', 'submit_result');
      if (task.spec.role !== 'reviewer') {
        names.push('spawn_task');
        if (permission.write) {
          names.push('write', 'apply_patch', 'artifact');
          if (task.spec.mode === 'code') names.push('diff', 'integrate_worktrees');
        }
        if (permission.exec) names.push('exec');
      }
    }
    return names.map((name) => ({
      name,
      description: descriptions[name],
      parameters: z.toJSONSchema(schemas[name], { target: 'draft-7' }) as Record<string, unknown>,
    }));
  }
  async path(task: Task, input: string, write = false) {
    const permission = this.kernel.permissions(task),
      project = this.store.require<Project>(
        'projects',
        this.store.require<Run>('runs', task.runId).projectId,
      );
    invariant(
      write ? permission.write : permission.read,
      'PERMISSION_DENIED',
      write ? '写入未授权' : '读取未授权',
    );
    invariant(task.workspace, 'WORKSPACE_MISSING', '任务工作区尚未创建');
    const absolute = path.resolve(task.workspace, input);
    invariant(
      !absolute.split(/[\\/]/).some((segment) => segment.toLowerCase() === '.git'),
      'PATH_DENIED',
      '禁止访问 .git 内部目录',
    );
    const real = await resolved(absolute);
    invariant(
      !real.split(/[\\/]/).some((segment) => segment.toLowerCase() === '.git'),
      'PATH_DENIED',
      '禁止通过链接访问 .git 内部目录',
    );
    const own = await fs.realpath(task.workspace),
      source = await fs.realpath(project.workspaceRoot);
    invariant(
      contained(own, real) || (!write && contained(source, real)),
      'PATH_ESCAPE',
      '目标路径超出授权目录',
    );
    if (write) {
      invariant(contained(own, real), 'PATH_ESCAPE', '写入必须在本任务目录');
      const allowed = await Promise.all(permission.writePaths.map((p) => resolved(path.resolve(own, p))));
      invariant(
        allowed.some((root) => contained(own, root) && contained(root, real)),
        'WRITE_SCOPE',
        '写入超出指定目录',
      );
    }
    return real;
  }
  async prepare(task: Task, signal: AbortSignal) {
    if (task.workspace) {
      await fs.access(task.workspace);
      return task;
    }
    const directory = path.join(this.store.directory, 'workspaces', task.runId, task.id);
    await fs.mkdir(path.dirname(directory), { recursive: true });
    const project = this.store.require<Project>(
      'projects',
      this.store.require<Run>('runs', task.runId).projectId,
    );
    if (task.spec.mode === 'code') {
      invariant(project.baseline, 'GIT_BASELINE_MISSING', '混合 Code 任务需要注册 Git 项目和基线');
      try {
        await fs.access(path.join(directory, '.git'));
      } catch {
        const r = await this.processes.run(
          task.id,
          'git',
          ['-C', project.workspaceRoot, 'worktree', 'add', '--detach', directory, project.baseline],
          project.workspaceRoot,
          60000,
          20000,
          signal,
        );
        invariant(r.exitCode === 0, 'WORKTREE_FAILED', '创建 worktree 失败：' + r.stderr);
      }
    } else await fs.mkdir(directory, { recursive: true });
    return this.store.tx(() => {
      const current = this.store.require<Task>('tasks', task.id);
      const next = this.store.put('tasks', {
        ...current,
        workspace: directory,
        baseline: task.spec.mode === 'code' ? project.baseline : null,
      });
      this.kernel.event(task.runId, 'task.updated', next, task.id);
      return next;
    });
  }
  async call(task: Task, attempt: Attempt, call: ToolCall, signal: AbortSignal): Promise<unknown> {
    task = this.store.require<Task>('tasks', task.id);
    const name = call.name as ToolName;
    invariant(
      this.definitions(task).some((t) => t.name === name),
      'TOOL_DENIED',
      `工具 ${name} 未授权`,
    );
    let args: any;
    try {
      args = schemas[name].parse(JSON.parse(call.arguments));
    } catch (e) {
      throw new AppError('TOOL_ARGUMENTS', '工具参数无效：' + (e instanceof Error ? e.message : String(e)));
    }
    const previous = this.store
      .all<Operation>('tool_operations', task.runId)
      .find((o) => o.attemptId === attempt.id && o.toolCallId === call.id);
    if (previous?.status === 'DONE' || previous?.status === 'FAILED')
      return { operationId: previous.id, result: previous.result };
    if (previous) throw new AppError('OPERATION_UNCERTAIN', '副作用结果待核验，请在决定面板处理');
    invariant(task.status === 'RUNNING', 'TASK_STOPPED', '任务已停止，不能开始新工具操作');
    const operation: Operation = {
      id: id(),
      revision: 0,
      runId: task.runId,
      taskId: task.id,
      attemptId: attempt.id,
      toolCallId: call.id,
      name,
      args,
      status: 'INTENT',
    };
    const begin = () => {
      this.store.put('tool_operations', operation);
      this.kernel.event(
        task.runId,
        'tool.started',
        { operationId: operation.id, name, args },
        task.id,
        attempt.id,
      );
    };
    const finish = (result: unknown) => {
      const op = this.store.require<Operation>('tool_operations', operation.id);
      this.store.put('tool_operations', { ...op, status: 'DONE', result });
      this.kernel.event(
        task.runId,
        'tool.completed',
        { operationId: op.id, name, result },
        task.id,
        attempt.id,
      );
      return { operationId: operation.id, result };
    };
    // 内核动作与操作结果在同一事务中落盘，避免重复委派或接受。
    if (
      !['list', 'read', 'read_artifact', 'search', 'fetch_url', 'submit_result', ...mutating].includes(name)
    )
      return this.store.tx(() => {
        begin();
        let result: unknown;
        if (name === 'clarify') {
          result = this.kernel.wait(task, 'user');
          this.kernel.event(
            task.runId,
            'decision.required',
            { taskId: task.id, reason: 'user', questions: args.questions },
            task.id,
          );
        } else if (name === 'propose_plan')
          result = this.kernel.propose(this.store.require('tasks', task.id), args.contract, args.plan);
        else if (name === 'spawn_task') result = this.kernel.spawn(task, args);
        else if (name === 'join_tasks') {
          const children = args.taskIds.map((key: string) => this.store.require<Task>('tasks', key));
          invariant(
            children.every((t: Task) => t.runId === task.runId),
            'TASK_SCOPE',
            '任务越界',
          );
          result = children.every((t: Task) => ['DONE', 'FAILED', 'CANCELLED'].includes(t.status))
            ? children.map((t: Task) => ({ id: t.id, status: t.status, result: t.result }))
            : this.kernel.wait(task, 'children', args.taskIds);
        } else throw new AppError('TOOL_UNKNOWN', '未知内核工具');
        return finish(result);
      });
    this.store.tx(begin);
    try {
      signal.throwIfAborted();
      let result: unknown;
      if (name === 'list') {
        const p = await this.path(task, args.path);
        const entries = await fs.readdir(p, { withFileTypes: true });
        result = {
          source: p,
          entries: entries
            .filter((e) => e.name !== '.git')
            .slice(0, 200)
            .map((e) => ({ name: e.name, directory: e.isDirectory(), symlink: e.isSymbolicLink() })),
        };
      } else if (name === 'read_artifact') {
        const artifact = this.store.require<Artifact>('artifacts', args.artifactId);
        invariant(
          artifact.runId === task.runId && (artifact.verified || artifact.taskId === task.id),
          'ARTIFACT_SCOPE',
          '产物越界或尚未通过验收',
        );
        const content = this.store.readObject(artifact.objectRef).toString('utf8');
        result = {
          artifactId: artifact.id,
          hash: artifact.hash,
          source: artifact.source,
          content: content.slice(0, 30000),
          truncated: content.length > 30000,
          trust: 'untrusted',
        };
      } else if (name === 'read') {
        const p = await this.path(task, args.path);
        if (task.spec.mode === 'work')
          invariant(
            /\.(txt|md|markdown|json|csv)$/i.test(p),
            'FILE_FORMAT',
            'Work 首版只支持 TXT、Markdown、JSON、CSV',
          );
        const stat = await fs.stat(p);
        invariant(stat.size <= 2 * 1024 * 1024, 'FILE_TOO_LARGE', '资料超过 2 MiB');
        const content = await fs.readFile(p);
        const snapshot = this.snapshot(task, p, content);
        result = {
          source: p,
          hash: snapshot.hash,
          snapshotId: snapshot.id,
          objectRef: snapshot.objectRef,
          trust: 'untrusted',
          content: content.toString('utf8').slice(0, 30000),
          truncated: content.length > 30000,
        };
      } else if (name === 'search') {
        const root = await this.path(task, args.path);
        const matches: unknown[] = [];
        let inspected = 0;
        const walk = async (p: string, depth: number) => {
          if (depth > 8 || inspected >= 500 || matches.length >= 100) return;
          for (const e of await fs.readdir(p, { withFileTypes: true })) {
            if (e.isSymbolicLink() || ['.git', 'node_modules', 'dist'].includes(e.name)) continue;
            const file = await this.path(task, path.join(p, e.name));
            if (e.isDirectory()) await walk(file, depth + 1);
            else {
              inspected++;
              if ((await fs.stat(file)).size > 200000) continue;
              const content = await fs.readFile(file, 'utf8');
              if (content.includes('\0')) continue;
              content.split(/\r?\n/).forEach((line, i) => {
                if (line.includes(args.query) && matches.length < 100)
                  matches.push({ source: file, line: i + 1, text: line.slice(0, 500), hash: hash(content) });
              });
            }
          }
        };
        await walk(root, 0);
        result = { matches, inspected, truncated: inspected >= 500 || matches.length >= 100 };
      } else if (name === 'write' || name === 'apply_patch') {
        const p = await this.path(task, args.path, true);
        let old: Buffer | null = null;
        try {
          old = await fs.readFile(p);
        } catch (e: any) {
          if (e.code !== 'ENOENT') throw e;
        }
        invariant(
          (old ? hash(old) : null) === args.expectedHash,
          'FILE_CONFLICT',
          '文件内容已变化，重新读取后再修改',
        );
        let content = args.content;
        if (name === 'apply_patch') {
          const oldText = old!.toString('utf8');
          invariant(oldText.split(args.oldText).length === 2, 'PATCH_AMBIGUOUS', '原文必须唯一匹配');
          content = oldText.replace(args.oldText, args.newText);
        }
        const expectedNewHash = hash(content);
        const op = this.store.require<Operation>('tool_operations', operation.id);
        this.store.put('tool_operations', {
          ...op,
          evidence: { path: p, beforeHash: args.expectedHash, afterHash: expectedNewHash },
        });
        await fs.mkdir(path.dirname(p), { recursive: true });
        const temp = p + '.elysia-' + id() + '.tmp';
        try {
          await fs.writeFile(temp, content, { flag: 'wx' });
          signal.throwIfAborted();
          await this.path(task, args.path, true);
          let latest: Buffer | null = null;
          try {
            latest = await fs.readFile(p);
          } catch (e: any) {
            if (e.code !== 'ENOENT') throw e;
          }
          invariant((latest ? hash(latest) : null) === args.expectedHash, 'FILE_CONFLICT', '写入前文件变化');
          await fs.rename(temp, p);
        } finally {
          await fs.rm(temp, { force: true });
        }
        result = { source: p, hash: expectedNewHash, bytes: Buffer.byteLength(content) };
      } else if (name === 'exec') {
        invariant(this.kernel.permissions(task).exec, 'EXEC_DENIED', '命令未授权');
        const cwd = await this.path(task, args.cwd);
        invariant(
          contained(await fs.realpath(task.workspace!), cwd),
          'EXEC_SCOPE',
          '命令 cwd 必须在任务目录',
        );
        result = await this.processes.run(
          task.id,
          args.program,
          args.args,
          cwd,
          args.timeout,
          args.outputLimit,
          signal,
        );
      } else if (name === 'fetch_url') result = await this.fetch(task, args.url, signal);
      else if (name === 'artifact') {
        const p = await this.path(task, args.path);
        invariant(contained(await fs.realpath(task.workspace!), p), 'ARTIFACT_SCOPE', '只能注册本任务文件');
        const stat = await fs.stat(p);
        invariant(stat.size <= 8 * 1024 * 1024, 'ARTIFACT_TOO_LARGE', '产物超过 8 MiB');
        result = this.artifact(task, args.name, await fs.readFile(p), p);
      } else if (name === 'diff') result = await this.diff(task, signal);
      else if (name === 'integrate_worktrees') {
        invariant(
          task.spec.mode === 'code' && this.kernel.permissions(task).write,
          'INTEGRATE_DENIED',
          'Code 写入未授权',
        );
        for (const key of args.taskIds) {
          const child = this.store.require<Task>('tasks', key);
          invariant(
            child.runId === task.runId &&
              child.status === 'DONE' &&
              child.spec.mode === 'code' &&
              child.workspace &&
              this.kernel.ancestors(child).some((a) => a.id === task.id),
            'INTEGRATE_SCOPE',
            '只能集成已完成的 Code 后代',
          );
          const run = async (args: string[], cwd: string) =>
            this.processes.run(task.id, 'git', args, cwd, 60000, 200000, signal);
          const add = await run(['add', '--all'], child.workspace!);
          invariant(add.exitCode === 0, 'GIT_STAGE_FAILED', add.stderr);
          const patch = await run(['diff', '--cached', child.baseline!, '--binary'], child.workspace!);
          invariant(patch.exitCode === 0 && !patch.truncated, 'DIFF_FAILED', '子任务 diff 失败或过大');
          if (patch.stdout) {
            const patchFile = path.join(
              this.store.directory,
              'workspaces',
              task.runId,
              operation.id + '.patch',
            );
            await fs.writeFile(patchFile, patch.stdout);
            try {
              const applied = await run(['apply', '--3way', patchFile], task.workspace!);
              invariant(
                applied.exitCode === 0,
                'INTEGRATION_CONFLICT',
                '集成冲突，检查并修复工作区：' + applied.stderr,
              );
            } finally {
              await fs.rm(patchFile, { force: true });
            }
          }
        }
        result = await this.diff(task, signal);
      } else if (name === 'submit_result') result = await this.submit(task, args, signal);
      else throw new AppError('TOOL_UNKNOWN', '未知工具');
      return this.store.tx(() => finish(result));
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      this.store.tx(() => {
        const op = this.store.require<Operation>('tool_operations', operation.id);
        const uncertainty =
          mutating.has(name) &&
          (signal.aborted || (e instanceof AppError && e.code === 'INTEGRATION_CONFLICT'));
        this.store.put('tool_operations', {
          ...op,
          status: uncertainty ? 'UNCERTAIN' : 'FAILED',
          result: { error: e.message, code: e instanceof AppError ? e.code : 'TOOL_FAILED' },
          error: e.message,
        });
        this.kernel.event(
          task.runId,
          'tool.completed',
          { operationId: op.id, name, error: e.message, uncertain: uncertainty },
          task.id,
        );
        if (uncertainty) this.kernel.wait(this.store.require('tasks', task.id), 'verification');
      });
      throw error;
    }
  }
  snapshot(task: Task, source: string, content: Buffer) {
    const object = this.store.object(content),
      previous = this.store.all<Snapshot>('snapshots', task.runId).filter((s) => s.source === source);
    const same = previous.find((s) => s.hash === object.hash && s.taskId === task.id);
    if (same) return same;
    return this.store.put<Snapshot>('snapshots', {
      id: id(),
      revision: 0,
      runId: task.runId,
      taskId: task.id,
      source,
      ...object,
      fetchedAt: now(),
      trust: 'untrusted',
      version: previous.length + 1,
    });
  }
  artifact(task: Task, name: string, content: Buffer | string, source: string) {
    const object = this.store.object(content);
    return this.store.tx(() => {
      const artifact = this.store.put<Artifact>('artifacts', {
        id: id(),
        revision: 0,
        runId: task.runId,
        taskId: task.id,
        name,
        ...object,
        source,
        version:
          this.store
            .all<Artifact>('artifacts', task.runId)
            .filter((a) => a.taskId === task.id && a.name === name).length + 1,
        verified: false,
        mediaType: /\.json$/i.test(name) ? 'application/json' : 'text/plain; charset=utf-8',
      });
      this.kernel.event(task.runId, 'artifact.created', artifact, task.id);
      return artifact;
    });
  }
  async diff(task: Task, signal: AbortSignal) {
    invariant(task.spec.mode === 'code', 'MODE_DENIED', '只有 Code 任务可生成 diff');
    const added = await this.processes.run(
      task.id,
      'git',
      ['add', '--all'],
      task.workspace!,
      10000,
      10000,
      signal,
    );
    invariant(added.exitCode === 0, 'DIFF_FAILED', added.stderr);
    const diff = await this.processes.run(
      task.id,
      'git',
      ['diff', '--cached', task.baseline!, '--binary'],
      task.workspace!,
      10000,
      200000,
      signal,
    );
    invariant(diff.exitCode === 0 && !diff.truncated, 'DIFF_FAILED', 'diff 失败或超过输出上限');
    return this.artifact(task, 'changes.diff', diff.stdout, 'git diff ' + task.baseline);
  }
  async submit(
    task: Task,
    args: { summary: string; evidence: Evidence[]; incomplete: string[] },
    signal: AbortSignal,
  ) {
    task = this.store.require<Task>('tasks', task.id);
    const run = this.store.require<Run>('runs', task.runId);
    invariant(!args.incomplete.length, 'ACCEPTANCE_INCOMPLETE', '仍有未完成事项，不能验收');
    const children = this.store
      .all<Task>('tasks', run.id)
      .filter(
        (t) => t.parentTaskId === task.id && t.spec.required && t.contractVersion === run.contract.version,
      );
    invariant(
      children.every((c) => c.status === 'DONE'),
      'CHILDREN_INCOMPLETE',
      '必需子任务尚未通过验收',
    );
    const checked = new Set<number>();
    for (const e of args.evidence) {
      invariant(e.criterion < task.spec.acceptanceCriteria.length, 'CRITERION_SCOPE', '验收项下标无效');
      if (e.type === 'file') {
        const p = await this.path(task, e.ref);
        invariant(
          e.hash && hash(await fs.readFile(p)) === e.hash,
          'EVIDENCE_MISMATCH',
          '文件哈希缺失或不匹配',
        );
      } else if (e.type === 'artifact') {
        const a = this.store.require<Artifact>('artifacts', e.ref);
        invariant(
          a.runId === run.id &&
            (a.taskId === task.id || children.some((c) => c.id === a.taskId && c.status === 'DONE')),
          'EVIDENCE_SCOPE',
          '产物越界',
        );
        this.store.readObject(a.objectRef);
      } else {
        const operation = this.store.require<Operation>('tool_operations', e.ref);
        invariant(
          operation.runId === run.id &&
            operation.taskId === task.id &&
            operation.name === 'exec' &&
            operation.status === 'DONE' &&
            (operation.result as any)?.exitCode === 0 &&
            !(operation.result as any)?.timedOut,
          'COMMAND_EVIDENCE',
          '命令证据必须来自本任务成功执行',
        );
      }
      checked.add(e.criterion);
    }
    invariant(
      checked.size === task.spec.acceptanceCriteria.length,
      'ACCEPTANCE_MISSING',
      '每个验收项都需要证据',
    );
    signal.throwIfAborted();
    return this.store.tx(() => {
      task = this.store.require<Task>('tasks', task.id);
      invariant(task.status === 'RUNNING', 'STOPPED', '任务已停止');
      this.kernel.updateTask(task, 'VERIFYING');
      const result = {
        summary: args.summary,
        evidence: args.evidence,
        verifiedAt: now(),
        limitation: '已核验文件、引用与命令结果；结论内容需用户复核',
      };
      this.kernel.updateTask(this.store.require('tasks', task.id), 'DONE', { result });
      for (const e of args.evidence.filter((e) => e.type === 'artifact')) {
        const a = this.store.require<Artifact>('artifacts', e.ref);
        this.store.put('artifacts', { ...a, verified: true });
      }
      const a = this.store
        .all<Attempt>('attempts', run.id)
        .find((a) => a.taskId === task.id && a.status === 'ACTIVE');
      if (a) this.store.put('attempts', { ...a, status: 'DONE', lease: null });
      if (task.id === run.rootTaskId)
        this.kernel.updateRun(this.store.require('runs', run.id), { status: 'DONE', reason: undefined });
      return result;
    });
  }
  async fetch(task: Task, input: string, signal: AbortSignal) {
    const allowed = this.kernel.permissions(task).urls.map((u) => new URL(u).href);
    let url = new URL(input);
    const initial = url.href;
    invariant(allowed.includes(initial), 'URL_DENIED', 'URL 未明确授权');
    for (let redirects = 0; redirects <= 3; redirects++) {
      invariant(url.protocol === 'https:' || url.protocol === 'http:', 'URL_SCHEME', '只允许 HTTP(S)');
      invariant(
        !url.username && !url.password && (!url.port || ['80', '443'].includes(url.port)),
        'URL_DENIED',
        '禁止凭据与非标准端口',
      );
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
      invariant(
        addresses.length && addresses.every(({ address }) => isPublicAddress(address)),
        'URL_PRIVATE',
        '禁止访问本机、私网或保留地址',
      ); // 每个跳转必须重新获得 URL 授权，fetch 不自动重定向。
      invariant(allowed.includes(url.href), 'REDIRECT_DENIED', '跳转 URL 未授权，请追加到授权列表');
      // 固定到已经检查的 DNS 地址，避免检查与连接之间的 DNS rebinding。
      const pinned = addresses.find((a) => isIP(a.address) === 4) ?? addresses[0];
      const response = await pinnedRequest(url, pinned.address, signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.location;
        invariant(location && redirects < 3, 'REDIRECT_LIMIT', '跳转次数超限或缺少地址');
        url = new URL(location, url);
        continue;
      }
      invariant(
        response.status >= 200 && response.status < 300,
        'FETCH_FAILED',
        '网页返回 HTTP ' + response.status,
      );
      const body = response.body;
      const snapshot = this.snapshot(task, url.href, body);
      return {
        source: url.href,
        fetchedAt: snapshot.fetchedAt,
        trust: 'untrusted',
        snapshotId: snapshot.id,
        hash: snapshot.hash,
        content: body.toString('utf8').slice(0, 30000),
        truncated: body.length > 30000,
      };
    }
    throw new AppError('REDIRECT_LIMIT', '跳转超限');
  }
}
function pinnedRequest(
  url: URL,
  address: string,
  signal: AbortSignal,
): Promise<{ status: number; location?: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        headers: {
          Accept: 'text/plain, text/html, application/json, text/csv',
          'Accept-Encoding': 'identity',
        },
        family: isIP(address),
        lookup: (_host, _options, callback) => callback(null, address, isIP(address)),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy();
          resolve({ status, location: response.headers.location, body: Buffer.alloc(0) });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            response.destroy(new AppError('FETCH_TOO_LARGE', '网页超过 2 MiB'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => resolve({ status, body: Buffer.concat(chunks) }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}
export function isPublicAddress(address: string) {
  const a = address.toLowerCase();
  if (a.includes(':'))
    return !(/^(::|fc|fd|fe[89ab]|ff)/.test(a) || a.startsWith('2001:db8') || a.startsWith('::ffff:'));
  const parts = a.split('.').map(Number),
    [first, second] = parts;
  return (
    parts.length === 4 &&
    !(
      [0, 10, 127].includes(first) ||
      first >= 224 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && [0, 168].includes(second)) ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 198 && [18, 19, 51].includes(second)) ||
      (first === 203 && second === 0)
    )
  );
}
