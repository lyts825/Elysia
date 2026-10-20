import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  invariant,
  type Artifact,
  type Run,
  type Task,
  type Operation,
} from '../../../contracts/src/index.js';
import { id, hash } from '../../../storage/src/index.js';
import { isBinaryFile } from '../../../contracts/src/files.js';
import { unicodeBoundary } from '../catalogue.js';
import { contained } from '../path-policy.js';
import { defineTool, type ToolServices, type ToolInvocation, type ToolContribution } from '../tool-plugin.js';
import type { PluginContributions } from '../../../plugins/src/index.js';
const text = z.string().max(2 * 1024 * 1024);
const fileHash = z
  .string()
  .regex(
    /^[a-f0-9]{64}$/,
    'expectedHash 必须为 64 位小写 SHA-256 哈希；新文件请在 write / materialize_artifact 中传 JSON null（不加引号），不能传字符串 "null"。',
  )
  .describe('已有文件的 64 位小写 SHA-256 哈希，必须使用 read 或上次写入返回的真实哈希。');
const newOrExistingFileHash = fileHash
  .nullable()
  .describe(
    '已有文件使用真实的 64 位小写 SHA-256 哈希；新文件传 JSON null（不加引号），不能传字符串 "null"。',
  );

const schemas = {
  list: z.object({ path: z.string().default('.') }),
  read: z.object({ path: z.string() }),
  search: z.object({ path: z.string().default('.'), query: z.string().min(1).max(200) }),
  read_artifact: z.object({
    artifactId: z.string(),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.number().int().min(2).max(30000).default(30000),
  }),
  write: z.object({ path: z.string(), content: text, expectedHash: newOrExistingFileHash }),
  apply_patch: z.object({
    path: z.string(),
    expectedHash: fileHash,
    oldText: z.string().min(1),
    newText: text,
  }),
  materialize_artifact: z.object({
    artifactId: z.string(),
    path: z.string().min(1),
    expectedHash: newOrExistingFileHash,
  }),
  exec: z.object({
    program: z.string().min(1),
    args: z.array(z.string()).max(100),
    cwd: z.string().default('.'),
    timeout: z.number().int().min(100).max(120000).default(60000),
    outputLimit: z.number().int().min(1000).max(200000).default(40000),
  }),
  artifact: z.object({ path: z.string(), name: z.string().min(1).max(150) }),
  diff: z.object({}),
  integrate_worktrees: z.object({ taskIds: z.array(z.string()).min(1).max(11) }),
};
export function workspaceTools(
  context: Pick<
    ToolServices,
    'store' | 'kernel' | 'path' | 'snapshot' | 'artifact' | 'diff' | 'definitions' | 'processes'
  >,
): PluginContributions<ToolContribution> {
  async function execute_list({ task }: ToolInvocation, args: z.output<typeof schemas.list>) {
    let result: unknown;

    const p = await context.path(task, args.path);
    const entries = await fs.readdir(p, { withFileTypes: true });
    result = {
      source: p,
      entries: entries
        .filter((e) => e.name !== '.git')
        .slice(0, 200)
        .map((e) => ({ name: e.name, directory: e.isDirectory(), symlink: e.isSymbolicLink() })),
    };

    return result;
  }
  function execute_read_artifact({ task }: ToolInvocation, args: z.output<typeof schemas.read_artifact>) {
    let result: unknown;

    const artifact = context.store.require<Artifact>('artifacts', args.artifactId);
    const source = context.store.require<Run>('runs', task.runId).source;
    const selectedInput =
      source?.bundleArtifactId === artifact.id ||
      source?.artifacts.some((item) => item.importedId === artifact.id) === true;
    invariant(
      artifact.runId === task.runId && (artifact.verified || artifact.taskId === task.id || selectedInput),
      'ARTIFACT_SCOPE',
      '产物越界或尚未通过验收',
    );
    const bytes = context.store.readObject(artifact.objectRef);
    const binary = isBinaryFile(artifact.name, bytes);
    const content = binary ? null : bytes.toString('utf8');
    const offset = content === null ? 0 : unicodeBoundary(content, args.offset);
    const end = content === null ? 0 : unicodeBoundary(content, offset + args.limit);
    const materializeAvailable =
      selectedInput &&
      bytes.length <= 8 * 1024 * 1024 &&
      context.definitions(task).some((definition) => definition.name === 'materialize_artifact');
    result = {
      artifactId: artifact.id,
      hash: artifact.hash,
      source: artifact.source,
      binary,
      mediaType: artifact.mediaType,
      content: content?.slice(offset, end) ?? null,
      offset,
      nextOffset: content !== null && end < content.length ? end : null,
      totalCharacters: content?.length ?? null,
      bytes: bytes.length,
      truncated: content !== null && end < content.length,
      materialize:
        binary || (content !== null && content.length > args.limit)
          ? {
              available: materializeAvailable,
              tool: materializeAvailable ? 'materialize_artifact' : null,
              reason: materializeAvailable
                ? '可显式复制原始字节到本任务允许写入的目录；执行仍需原命令权限。'
                : '复制仅限用户选中的来源输入，且需要执行阶段的读取与写入授权（最多8MiB）。',
            }
          : undefined,
      trust: 'untrusted',
    };

    return result;
  }
  async function execute_read({ task }: ToolInvocation, args: z.output<typeof schemas.read>) {
    let result: unknown;

    const p = await context.path(task, args.path);
    const stat = await fs.stat(p);
    invariant(stat.size <= 2 * 1024 * 1024, 'FILE_TOO_LARGE', '资料超过 2 MiB');
    const content = await fs.readFile(p);
    const snapshot = context.snapshot(task, p, content);
    const binary = isBinaryFile(p, content);
    const decoded = binary ? null : content.toString('utf8');
    result = {
      source: p,
      hash: snapshot.hash,
      snapshotId: snapshot.id,
      objectRef: snapshot.objectRef,
      trust: 'untrusted',
      binary,
      content: decoded?.slice(0, 30000) ?? null,
      bytes: content.length,
      truncated: decoded !== null && decoded.length > 30000,
    };

    return result;
  }
  async function execute_search({ task }: ToolInvocation, args: z.output<typeof schemas.search>) {
    let result: unknown;

    const root = await context.path(task, args.path);
    const matches: unknown[] = [];
    let inspected = 0;
    const walk = async (p: string, depth: number) => {
      if (depth > 8 || inspected >= 500 || matches.length >= 100) return;
      for (const e of await fs.readdir(p, { withFileTypes: true })) {
        if (e.isSymbolicLink() || ['.git', 'node_modules', 'dist'].includes(e.name)) continue;
        const file = await context.path(task, path.join(p, e.name));
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

    return result;
  }
  async function execute_write({ task, operation, signal }: ToolInvocation, args: any, name: string) {
    let result: unknown;

    const p = await context.path(task, args.path, true);
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
    let content: string | Buffer = args.content;
    if (name === 'materialize_artifact') {
      const artifact = context.store.require<Artifact>('artifacts', args.artifactId);
      const source = context.store.require<Run>('runs', task.runId).source;
      invariant(
        artifact.runId === task.runId &&
          (source?.bundleArtifactId === artifact.id ||
            source?.artifacts.some((item) => item.importedId === artifact.id)),
        'ARTIFACT_SCOPE',
        '仅能复制当前任务中用户明确选中的来源输入',
      );
      invariant(context.kernel.permissions(task).read, 'PERMISSION_DENIED', '来源读取未授权');
      content = context.store.readObject(artifact.objectRef);
      invariant(content.length <= 8 * 1024 * 1024, 'ARTIFACT_TOO_LARGE', '来源文件超过8MiB');
      invariant(hash(content) === artifact.hash, 'OBJECT_CORRUPT', '来源产物哈希与内容不一致');
    }
    if (name === 'apply_patch') {
      const oldText = old!.toString('utf8');
      invariant(oldText.split(args.oldText).length === 2, 'PATCH_AMBIGUOUS', '原文必须唯一匹配');
      content = oldText.replace(args.oldText, () => args.newText);
    }
    const expectedNewHash = hash(content);
    const op = context.store.require<Operation>('tool_operations', operation.id);
    context.store.put('tool_operations', {
      ...op,
      evidence: {
        path: p,
        beforeHash: args.expectedHash,
        afterHash: expectedNewHash,
        ...(name === 'materialize_artifact' ? { artifactId: args.artifactId } : {}),
      },
    });
    await fs.mkdir(path.dirname(p), { recursive: true });
    const temp = p + '.elysia-' + id() + '.tmp';
    try {
      await fs.writeFile(temp, content, { flag: 'wx' });
      signal.throwIfAborted();
      await context.path(task, args.path, true);
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

    return result;
  }
  async function execute_exec({ task, signal }: ToolInvocation, args: z.output<typeof schemas.exec>) {
    let result: unknown;

    invariant(context.kernel.permissions(task).exec, 'EXEC_DENIED', '命令未授权');
    const cwd = await context.path(task, args.cwd);
    invariant(contained(await fs.realpath(task.workspace!), cwd), 'EXEC_SCOPE', '命令 cwd 必须在任务目录');
    result = await context.processes.run(
      task.id,
      args.program,
      args.args,
      cwd,
      args.timeout,
      args.outputLimit,
      signal,
    );

    return result;
  }
  async function execute_artifact({ task }: ToolInvocation, args: z.output<typeof schemas.artifact>) {
    let result: unknown;

    const p = await context.path(task, args.path);
    invariant(contained(await fs.realpath(task.workspace!), p), 'ARTIFACT_SCOPE', '只能注册本任务文件');
    const stat = await fs.stat(p);
    invariant(stat.size <= 8 * 1024 * 1024, 'ARTIFACT_TOO_LARGE', '产物超过 8 MiB');
    result = context.artifact(task, args.name, await fs.readFile(p), p);

    return result;
  }
  async function execute_diff({ task, signal }: ToolInvocation) {
    return await context.diff(task, signal);
  }
  async function execute_integrate_worktrees(
    { task, operation, signal }: ToolInvocation,
    args: z.output<typeof schemas.integrate_worktrees>,
  ) {
    let result: unknown;

    invariant(
      task.baseline && context.kernel.permissions(task).write,
      'INTEGRATE_DENIED',
      'Git 工作区写入未授权',
    );
    for (const key of args.taskIds) {
      const child = context.store.require<Task>('tasks', key);
      invariant(
        child.runId === task.runId &&
          child.status === 'DONE' &&
          child.baseline === task.baseline &&
          child.workspace &&
          context.kernel.ancestors(child).some((a) => a.id === task.id),
        'INTEGRATE_SCOPE',
        '只能集成已完成且基线相同的 Git 后代工作区',
      );
      const run = async (args: string[], cwd: string) =>
        context.processes.run(task.id, 'git', args, cwd, 60000, 200000, signal);
      const add = await run(['add', '--all'], child.workspace!);
      invariant(add.exitCode === 0, 'GIT_STAGE_FAILED', add.stderr);
      const patch = await run(['diff', '--cached', child.baseline!, '--binary'], child.workspace!);
      invariant(patch.exitCode === 0 && !patch.truncated, 'DIFF_FAILED', '子任务 diff 失败或过大');
      if (patch.stdout) {
        const patchFile = path.join(
          context.store.directory,
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
    result = await context.diff(task, signal);

    return result;
  }
  return {
    manifest: { id: 'tools.workspace', version: '1.0.0', apiVersion: 1 },
    contributions: {
      list: defineTool(
        'list',
        schemas.list,
        '列出授权路径的目录项及来源；用于定位目标，不等于已读取文件正文。',
        { transaction: false, serial: false, mutating: false, progress: false },
        execute_list,
      ),
      read_artifact: defineTool(
        'read_artifact',
        schemas.read_artifact,
        '读取本任务、已验收或用户选中的同 run 来源产物。文字按offset/limit分页（UTF-16位置，最多30000），用返回nextOffset继续，不拆开Unicode字符。二进制返回元信息；已选来源文件可在有写入授权时用materialize_artifact复制到任务目录。',
        { transaction: false, serial: false, mutating: false, progress: false },
        execute_read_artifact,
      ),
      read: defineTool(
        'read',
        schemas.read,
        '读取最多2MiB的授权文件，记录来源快照和哈希；二进制只返回元信息，修改已有文件时保留实际哈希。',
        { transaction: false, serial: false, mutating: false, progress: false },
        execute_read,
      ),
      search: defineTool(
        'search',
        schemas.search,
        '在授权路径内按字面 query 搜索文本文件，返回命中位置；不是正则或互联网搜索。',
        { transaction: false, serial: false, mutating: false, progress: false },
        execute_search,
      ),
      write: defineTool(
        'write',
        schemas.write,
        '原子写文件。已有文件的 expectedHash 必须使用 read 或上次写入返回的64位小写SHA-256哈希；新文件传 JSON null（不加引号），不能传字符串"null"。',
        { transaction: false, serial: true, mutating: true, progress: true },
        (invocation, args) => execute_write(invocation, args, 'write'),
      ),
      apply_patch: defineTool(
        'apply_patch',
        schemas.apply_patch,
        '用唯一原文修改已有文件，expectedHash 必须使用 read 或上次写入返回的64位小写SHA-256哈希；不接受 null 或字符串"null"。',
        { transaction: false, serial: true, mutating: true, progress: true },
        (invocation, args) => execute_write(invocation, args, 'apply_patch'),
      ),
      materialize_artifact: defineTool(
        'materialize_artifact',
        schemas.materialize_artifact,
        '将用户明确选中的不可变来源产物复制到当前任务允许写入的路径，最多8MiB，支持二进制。expectedHash为目标现有文件的64位小写SHA-256哈希，新文件传JSON null（不加引号），不能传字符串"null"；需要读取和写入权限，执行文件或程序仍需单独命令授权。',
        { transaction: false, serial: true, mutating: true, progress: true },
        (invocation, args) => execute_write(invocation, args, 'materialize_artifact'),
      ),
      exec: defineTool(
        'exec',
        schemas.exec,
        '执行 program 与 args，cwd 必须在本任务工作区，不隐式使用 shell。隔离密钥环境，超时清理进程树；检查 exitCode、timedOut 和实际输出后判断是否成功。',
        { transaction: false, serial: true, mutating: true, progress: true },
        execute_exec,
      ),
      artifact: defineTool(
        'artifact',
        schemas.artifact,
        '将本任务已有文件登记为版本化产物，最多8MiB，返回真实 artifact ID；登记成功不代替内容或视觉验证。',
        { transaction: false, serial: true, mutating: true, progress: true },
        execute_artifact,
      ),
      diff: defineTool(
        'diff',
        schemas.diff,
        '记录当前任务 Git worktree 的差异，包含未跟踪文件；用于核对变更，不代表已提交或集成。',
        { transaction: false, serial: false, mutating: true, progress: false },
        execute_diff,
      ),
      integrate_worktrees: defineTool(
        'integrate_worktrees',
        schemas.integrate_worktrees,
        '将已完成且基线相同的后代任务 worktree 变更集成到本任务 worktree，返回差异；先取得真实 taskId，集成后核对结果，冲突时保留现场并处理核验。',
        { transaction: false, serial: true, mutating: true, progress: true },
        execute_integrate_worktrees,
      ),
    },
  };
}
