import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { invariant, type Run, type Task } from '../../../packages/contracts/src/index.js';
import type { PreviewEntry, PreviewFile, PreviewSnapshot } from '../../../packages/contracts/src/preview.js';
import { fileMediaType, isBinaryFile } from '../../../packages/contracts/src/files.js';
import { Store, hash } from '../../../packages/storage/src/index.js';
import { ToolGateway } from '../../../packages/tools/src/index.js';

const textLimit = 1024 * 1024,
  assetLimit = 12 * 1024 * 1024,
  listLimit = 1500;
const excluded = new Set(['.git', 'node_modules', '.local-tests', '.local-qa', '.tmp', '.elysia-runtime']);
const sensitive = (segment: string) =>
  excluded.has(segment.toLowerCase()) ||
  /^\.env(?:\.|$)/i.test(segment) ||
  /\.(?:pem|key|p12|pfx)$/i.test(segment);
function normalized(input: string) {
  invariant(
    typeof input === 'string' && input.length > 0 && input.length <= 1000,
    'PREVIEW_PATH',
    '需要工作区内的相对文件路径',
  );
  const value = input.replace(/\\/g, '/');
  invariant(
    !value.startsWith('/') &&
      !value.includes(':') &&
      !value.includes('\0') &&
      value.split('/').every((s) => s && s !== '.' && s !== '..' && !/[. ]$/.test(s) && !sensitive(s)),
    'PREVIEW_PATH',
    '此路径不能预览',
  );
  return value;
}
const within = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return (
    relative !== '' &&
    !relative.startsWith('..' + path.sep) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
};
type Capability = {
  runId: string;
  taskId: string;
  scope: string;
  page: string;
  touched: number;
  revision: number;
  observation: number;
  generation: number;
  truncated: boolean;
  resources: Map<string, { version: string; observation: number }>;
};
const capabilityKey = (taskId: string, scope: string, page: string) => JSON.stringify([taskId, scope, page]);
const resourceVersion = (stat: { size: number; mtimeMs: number; ctimeMs: number }) =>
  JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs]);

export class PreviewService {
  private capabilities = new Map<string, Capability>();
  private tokens = new Map<string, string>();
  constructor(
    private store: Store,
    private gateway: ToolGateway,
  ) {}
  private capability(runId: string, taskId: string, scope = '', page = '') {
    const key = capabilityKey(taskId, scope, page);
    for (const [token, value] of this.capabilities)
      if (Date.now() - value.touched > 30 * 60000) {
        this.capabilities.delete(token);
        this.tokens.delete(capabilityKey(value.taskId, value.scope, value.page));
      }
    let token = this.tokens.get(key);
    if (!token) {
      token = randomBytes(24).toString('hex');
      this.tokens.set(key, token);
    }
    const previous = this.capabilities.get(token);
    if (previous) previous.touched = Date.now();
    else
      this.capabilities.set(token, {
        runId,
        taskId,
        scope,
        page,
        touched: Date.now(),
        revision: 0,
        observation: 0,
        generation: 0,
        truncated: false,
        resources: new Map(),
      });
    return token;
  }
  private observe(
    capability: Capability,
    name: string,
    version: string,
    observation: number,
    invalidate = false,
  ) {
    if (observation < capability.generation) return;
    const previous = capability.resources.get(name);
    if (previous && previous.observation > observation) return;
    if (!previous && capability.resources.size >= listLimit) {
      capability.truncated = true;
      return;
    }
    if (invalidate && previous && previous.version !== version) capability.revision++;
    capability.resources.set(name, { version, observation });
  }
  private async renderState(task: Task, name: string, active: boolean) {
    const scope = path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name);
    const token = this.tokens.get(capabilityKey(task.id, scope, name));
    const capability = token ? this.capabilities.get(token) : undefined;
    if (!capability) return { renderRevision: 0 };
    if (!active) return { renderRevision: capability.revision, renderTruncated: capability.truncated };
    capability.touched = Date.now();
    for (const resource of capability.resources.keys()) {
      const observation = ++capability.observation;
      let version: string;
      try {
        const stat = await fs.stat(await this.filename(task, resource));
        version = stat.isFile() ? resourceVersion(stat) : 'unavailable:NOT_FILE';
      } catch (error) {
        version =
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'missing'
            : 'unavailable:' + ((error as NodeJS.ErrnoException).code || 'UNKNOWN');
      }
      this.observe(capability, resource, version, observation, resource !== capability.page);
    }
    return { renderRevision: capability.revision, renderTruncated: capability.truncated };
  }
  private task(runId: string, taskId: string) {
    const run = this.store.require<Run>('runs', runId),
      task = this.store.require<Task>('tasks', taskId);
    invariant(task.runId === run.id, 'PREVIEW_TASK', '代理不属于当前任务');
    invariant(run.contract.permissionProfile.read, 'PREVIEW_DENIED', '当前任务未授权读取文件');
    return task;
  }
  private async filename(task: Task, input: string) {
    const relative = normalized(input);
    invariant(task.workspace, 'WORKSPACE_MISSING', '代理尚未创建工作区');
    const root = await fs.realpath(task.workspace),
      target = path.resolve(root, relative);
    invariant(within(root, target), 'PREVIEW_PATH', '文件超出当前代理工作区');
    // Reject junctions and symlinks, including links to another agent's workspace.
    let current = root;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      invariant(!stat.isSymbolicLink(), 'PREVIEW_LINK', '预览不跟随符号链接或 junction');
    }
    invariant(within(root, await fs.realpath(target)), 'PREVIEW_PATH', '文件超出当前代理工作区');
    return target;
  }
  private async git(task: Task, args: string[], limit = 1024 * 1024) {
    const result = await this.gateway.processes.run(
      'preview:' + task.id,
      'git',
      ['-c', 'core.fsmonitor=false', ...args],
      task.workspace!,
      8000,
      limit,
    );
    invariant(
      result.exitCode === 0 && !result.timedOut,
      'PREVIEW_GIT',
      '无法读取工作区差异：' + result.stderr.slice(0, 300),
    );
    return result;
  }
  async snapshot(runId: string, taskId: string, selected?: string): Promise<PreviewSnapshot> {
    const task = this.task(runId, taskId);
    if (selected !== undefined) normalized(selected);
    if (!task.workspace)
      return {
        taskId,
        workspace: null,
        baseline: task.baseline,
        files: [],
        revision: '',
        truncated: false,
        renderBase: null,
      };
    const token = this.capability(runId, taskId);
    const changes = new Map<string, PreviewEntry['change']>();
    let names: string[] = [],
      truncated = false;
    if (task.baseline) {
      const [listing, changed] = await Promise.all([
        this.git(task, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
        this.git(task, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--name-status',
          '-z',
          task.baseline,
          '--',
        ]),
      ]);
      const records = changed.stdout.split('\0');
      for (let i = 0; i + 1 < records.length; i += 2)
        changes.set(records[i + 1], records[i][0] as PreviewEntry['change']);
      const untracked = await this.git(task, ['ls-files', '-z', '--others', '--exclude-standard']);
      for (const name of untracked.stdout.split('\0').filter(Boolean)) changes.set(name, 'A');
      names = [...new Set([...changes.keys(), ...listing.stdout.split('\0').filter(Boolean)])];
      truncated = listing.truncated || changed.truncated || untracked.truncated;
      // Built pages are intentionally ignored by Git, but remain useful preview inputs.
      const collect = async (directory: string, depth = 0) => {
        if (names.length >= listLimit || depth > 10) {
          truncated = true;
          return;
        }
        for (const entry of await fs.readdir(await this.filename(task, directory), { withFileTypes: true })) {
          if (sensitive(entry.name) || entry.isSymbolicLink()) continue;
          if (names.length >= listLimit) {
            truncated = true;
            break;
          }
          const name = directory + '/' + entry.name;
          if (entry.isDirectory()) await collect(name, depth + 1);
          else if (entry.isFile() && !names.includes(name)) names.push(name);
        }
      };
      for (const directory of ['dist', 'build', 'out', 'apps/web/dist', 'public']) {
        try {
          await this.filename(task, directory + '/index.html');
          await collect(directory);
        } catch (error) {
          if (!['ENOENT', 'PREVIEW_LINK'].includes((error as any).code)) truncated = true;
        }
      }
    } else {
      let visited = 0;
      const walk = async (directory: string, prefix = '', depth = 0) => {
        if (depth > 12 || visited++ > 2000) {
          truncated = true;
          return;
        }
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (sensitive(entry.name) || entry.isSymbolicLink()) continue;
          if (names.length >= listLimit) {
            truncated = true;
            break;
          }
          const name = prefix + entry.name;
          if (entry.isDirectory()) await walk(path.join(directory, entry.name), name + '/', depth + 1);
          else if (entry.isFile()) {
            names.push(name);
            changes.set(name, 'A');
          }
        }
      };
      await walk(task.workspace);
    }
    if (names.length > listLimit) truncated = true;
    const files: PreviewEntry[] = [];
    for (const name of names.slice(0, listLimit)) {
      try {
        normalized(name);
        if (changes.get(name) === 'D') files.push({ path: name, size: 0, modifiedAt: 0, change: 'D' });
        else {
          const stat = await fs.stat(await this.filename(task, name));
          if (stat.isFile())
            files.push({
              path: name,
              size: stat.size,
              modifiedAt: stat.mtimeMs,
              change: changes.get(name) || '',
              ...(/\.html?$/i.test(name)
                ? await this.renderState(task, name, selected === undefined || selected === name)
                : {}),
            });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EACCES') truncated = true;
        // A file can disappear during an atomic write. The next poll will pick it up.
      }
    }
    files.sort(
      (a, b) => Number(Boolean(b.change)) - Number(Boolean(a.change)) || a.path.localeCompare(b.path),
    );
    return {
      taskId,
      workspace: task.workspace,
      baseline: task.baseline,
      files,
      revision: hash(JSON.stringify(files)),
      truncated,
      renderBase: `/preview/${token}/`,
    };
  }
  async file(runId: string, taskId: string, input: string): Promise<PreviewFile> {
    const task = this.task(runId, taskId),
      name = normalized(input);
    const ext = path.extname(name).toLowerCase(),
      mediaType = fileMediaType(name);
    const maxSize = mediaType.startsWith('image/') ? assetLimit : textLimit;
    let bytes: Buffer | null = null,
      deleted = false;
    try {
      const filename = await this.filename(task, name),
        stat = await fs.stat(filename);
      invariant(
        stat.isFile() && stat.size <= maxSize,
        'PREVIEW_SIZE',
        '源文件预览上限为 1 MiB，图片上限为 12 MiB',
      );
      bytes = await fs.readFile(filename);
      invariant(bytes.length <= maxSize, 'PREVIEW_SIZE', '文件超过预览上限');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !task.baseline) throw error;
      const existed = await this.git(task, ['ls-tree', '-z', task.baseline, '--', name]);
      invariant(existed.stdout.length > 0, 'PREVIEW_MISSING', '文件不存在');
      deleted = true;
    }
    const kind: PreviewFile['kind'] = mediaType.startsWith('image/')
      ? 'image'
      : bytes && isBinaryFile(name, bytes)
        ? 'binary'
        : ['.html', '.htm'].includes(ext)
          ? 'html'
          : ['.md', '.markdown'].includes(ext)
            ? 'markdown'
            : 'text';
    const text = bytes && !['image', 'binary'].includes(kind) ? bytes.toString('utf8') : null;
    let diff = '',
      diffTruncated = false;
    if (task.baseline) {
      const result = await this.git(
        task,
        ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=3', task.baseline, '--', name],
        textLimit,
      );
      diff = result.stdout;
      diffTruncated = result.truncated;
      if (!diff && bytes) {
        const tracked = await this.git(task, ['ls-tree', '-z', task.baseline, '--', name]);
        if (!tracked.stdout && text !== null)
          diff =
            `--- /dev/null\n+++ b/${name}\n` +
            text
              .split('\n')
              .map((line) => '+' + line)
              .join('\n');
      }
    } else if (text !== null)
      diff =
        `--- /dev/null\n+++ b/${name}\n` +
        text
          .split('\n')
          .map((line) => '+' + line)
          .join('\n');
    const lines = diff.split('\n');
    if (lines.length > 12000 || Buffer.byteLength(diff) > textLimit) {
      diff = Buffer.from(lines.slice(0, 12000).join('\n')).subarray(0, textLimit).toString('utf8');
      diffTruncated = true;
    }
    return {
      path: name,
      text,
      hash: bytes ? hash(bytes) : null,
      mediaType,
      kind,
      diff,
      diffTruncated,
      deleted,
      renderUrl:
        kind === 'html' && !deleted
          ? `/preview/${this.capability(runId, taskId, path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name), name)}/${encodeURIComponent(path.posix.basename(name))}`
          : null,
    };
  }
  async resource(token: string, input: string, document = false) {
    const capability = this.capabilities.get(token);
    invariant(
      capability && Date.now() - capability.touched < 30 * 60000,
      'PREVIEW_EXPIRED',
      '预览已过期，请刷新预览面板',
    );
    const task = this.task(capability.runId, capability.taskId);
    const relative = normalized(input || 'index.html');
    const name = capability.scope ? capability.scope + '/' + relative : relative;
    const observation = ++capability.observation;
    if (document && name === capability.page) {
      capability.generation = observation;
      capability.resources.clear();
      capability.truncated = false;
    }
    let filename: string, bytes: Buffer;
    try {
      filename = await this.filename(task, name);
      const stat = await fs.stat(filename);
      invariant(stat.isFile() && stat.size <= assetLimit, 'PREVIEW_SIZE', '预览资源上限为 12 MiB');
      if (capability.page) this.observe(capability, name, resourceVersion(stat), observation);
      bytes = await fs.readFile(filename);
    } catch (error) {
      if (capability.page && (error as NodeJS.ErrnoException).code === 'ENOENT')
        this.observe(capability, name, 'missing', observation);
      throw error;
    }
    invariant(bytes.length <= assetLimit, 'PREVIEW_SIZE', '预览资源超过大小上限');
    const mediaType = fileMediaType(filename);
    const prefix = `/preview/${token}/`;
    // Preserve the file on disk; scope root-relative static asset URLs to this page root.
    if (mediaType === 'text/html')
      bytes = Buffer.from(
        bytes.toString('utf8').replace(/(\b(?:src|href|poster)\s*=\s*["'])\/(?!\/)/gi, '$1' + prefix),
      );
    if (mediaType === 'text/css')
      bytes = Buffer.from(bytes.toString('utf8').replace(/(url\(\s*["']?)\/(?!\/)/gi, '$1' + prefix));
    return { bytes, mediaType };
  }
}
