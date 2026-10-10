import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { AppError, invariant, type Run, type Task } from '../../../packages/contracts/src/index.js';
import type {
  PreviewEntry,
  PreviewFile,
  PreviewResourceIssue,
  PreviewSnapshot,
} from '../../../packages/contracts/src/preview.js';
import {
  fileMediaType,
  isBinaryFile,
  type TextFileEncoding,
  type TextPageOptions,
} from '../../../packages/contracts/src/files.js';
import { Store, hash } from '../../../packages/storage/src/index.js';
import { ToolGateway } from '../../../packages/tools/src/index.js';
import { inspectFile, readTextPage, streamFile } from './file-reader.js';
import { FileLocator } from './file-location.js';
import type { FileLocationOptions } from '../../../packages/contracts/src/file-location.js';

const textLimit = 1024 * 1024,
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
  resources: Map<
    string,
    {
      version: string;
      observation: number;
      issue?: PreviewResourceIssue['reason'];
      issueObservation?: number;
    }
  >;
};
const capabilityKey = (taskId: string, scope: string, page: string) => JSON.stringify([taskId, scope, page]);
const resourceVersion = (stat: { size: number; mtimeMs: number; ctimeMs: number; isFile: () => boolean }) =>
  stat.isFile() ? JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs]) : 'unavailable:NOT_FILE';

export class PreviewService {
  private locator = new FileLocator();
  private capabilities = new Map<string, Capability>();
  private tokens = new Map<string, string>();
  constructor(
    private store: Store,
    private gateway: ToolGateway,
    private prefix = '',
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
    issue?: PreviewResourceIssue['reason'] | null,
  ) {
    if (observation < capability.generation) return;
    const previous = capability.resources.get(name);
    if (previous && previous.observation > observation) {
      // A newer stat need not hide a completed read of the same observed file version.
      if (
        previous.version === version &&
        issue !== undefined &&
        observation >= (previous.issueObservation || 0)
      ) {
        previous.issue = issue || undefined;
        previous.issueObservation = observation;
      }
      return;
    }
    if (!previous && capability.resources.size >= listLimit) {
      capability.truncated = true;
      return;
    }
    if (invalidate && previous && previous.version !== version) capability.revision++;
    capability.resources.set(name, {
      version,
      observation,
      issue: issue === undefined ? previous?.issue : issue || undefined,
      issueObservation: issue === undefined ? previous?.issueObservation : observation,
    });
  }
  private renderSummary(capability: Capability) {
    const issues: PreviewResourceIssue[] = [];
    for (const [name, resource] of capability.resources)
      if (resource.issue) issues.push({ ...(name ? { path: name } : {}), reason: resource.issue });
    issues.sort((a, b) => (a.path || '').localeCompare(b.path || ''));
    return {
      renderRevision: capability.revision,
      renderTruncated: capability.truncated,
      renderIssues: issues.slice(0, 10),
      renderIssueCount: issues.length,
    };
  }
  private async renderState(task: Task, name: string, active: boolean, signal?: AbortSignal) {
    const scope = path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name);
    const token = this.tokens.get(capabilityKey(task.id, scope, name));
    const capability = token ? this.capabilities.get(token) : undefined;
    if (!capability) return { renderRevision: 0 };
    if (!active) return this.renderSummary(capability);
    capability.touched = Date.now();
    for (const resource of capability.resources.keys()) {
      signal?.throwIfAborted();
      // Invalid request paths share one safe diagnostic; they never enter filesystem observation.
      if (!resource) continue;
      const observation = ++capability.observation;
      let version: string;
      let issue: PreviewResourceIssue['reason'] | undefined;
      try {
        const stat = await fs.stat(await this.filename(task, resource));
        version = resourceVersion(stat);
        if (!stat.isFile()) issue = 'not-file';
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        version = code === 'ENOENT' ? 'missing' : 'unavailable:' + (code || 'UNKNOWN');
        issue =
          code === 'ENOENT'
            ? 'missing'
            : ['PREVIEW_LINK', 'PREVIEW_PATH'].includes(code || '')
              ? 'restricted'
              : 'unreadable';
      }
      this.observe(capability, resource, version, observation, resource !== capability.page, issue);
    }
    return this.renderSummary(capability);
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
  private async git(task: Task, args: string[], limit = 1024 * 1024, signal?: AbortSignal) {
    const result = await this.gateway.processes.run(
      'preview:' + task.id,
      'git',
      ['-c', 'core.fsmonitor=false', ...args],
      task.workspace!,
      8000,
      limit,
      signal,
    );
    signal?.throwIfAborted();
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
      renderBase: `${this.prefix}/preview/${token}/`,
    };
  }
  async locate(runId: string, taskId: string, input: string, options: FileLocationOptions) {
    const task = this.task(runId, taskId);
    const name = normalized(input);
    const filename = await this.filename(task, name);
    return this.locator.locate(filename, JSON.stringify([runId, taskId, name]), options);
  }
  async entry(runId: string, taskId: string, input: string, signal?: AbortSignal): Promise<PreviewEntry> {
    signal?.throwIfAborted();
    const task = this.task(runId, taskId),
      name = normalized(input);
    try {
      const filename = await this.filename(task, name),
        stat = await fs.stat(filename);
      signal?.throwIfAborted();
      invariant(stat.isFile(), 'PREVIEW_NOT_FILE', '此路径不是普通文件');
      invariant(Number.isSafeInteger(stat.size), 'FILE_SIZE', '文件大小超出安全读取范围');
      let change: PreviewEntry['change'] = task.baseline ? '' : 'A';
      if (task.baseline) {
        const pathspec = ':(literal)' + name;
        const [tracked, changed] = await Promise.all([
          this.git(task, ['ls-files', '-z', '--cached', '--', pathspec], 4096, signal),
          this.git(
            task,
            [
              'diff',
              '--no-ext-diff',
              '--no-textconv',
              '--no-renames',
              '--name-status',
              '-z',
              task.baseline,
              '--',
              pathspec,
            ],
            4096,
            signal,
          ),
        ]);
        const status = changed.stdout.split('\0')[0];
        change = !tracked.stdout ? 'A' : status ? (status === 'A' ? 'A' : 'M') : '';
      }
      const render = /\.html?$/i.test(name) ? await this.renderState(task, name, true, signal) : {};
      invariant((await this.filename(task, name)) === filename, 'PREVIEW_PATH', '文件路径在读取时改变');
      signal?.throwIfAborted();
      return { path: name, size: stat.size, modifiedAt: stat.mtimeMs, change, ...render };
    } catch (error) {
      signal?.throwIfAborted();
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || ''))
        throw new AppError('PREVIEW_MISSING', '文件不存在', false, null, 404);
      if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code || ''))
        throw new AppError('PREVIEW_UNREADABLE', '此文件无法读取');
      throw error;
    }
  }
  async file(
    runId: string,
    taskId: string,
    input: string,
    encoding: TextFileEncoding = 'auto',
    options: TextPageOptions = {},
  ): Promise<PreviewFile> {
    const task = this.task(runId, taskId),
      name = normalized(input);
    const ext = path.extname(name).toLowerCase(),
      mediaType = fileMediaType(name);
    let bytes: Buffer | null = null,
      contentHash: string | null = null,
      deleted = false,
      page: PreviewFile['page'] = null,
      resolvedEncoding: PreviewFile['encoding'] = null,
      encodingSource: PreviewFile['encodingSource'] = null,
      text: string | null = null,
      version = '',
      binary = false,
      largeDiff = false,
      baselineRecord = '';
    try {
      const filename = await this.filename(task, name),
        info = await inspectFile(filename, options.signal);
      version = info.version;
      largeDiff = info.stat.size > textLimit;
      if (options.version && options.version !== version)
        throw new AppError(
          'FILE_CHANGED',
          '文件已改变，请重新从第一页读取。',
          false,
          { version, totalBytes: info.stat.size },
          409,
        );
      const unicode16 =
        encoding.startsWith('utf-16') ||
        (info.prefix[0] === 0xff && info.prefix[1] === 0xfe) ||
        (info.prefix[0] === 0xfe && info.prefix[1] === 0xff);
      binary = !unicode16 && isBinaryFile(name, info.prefix);
      if (!mediaType.startsWith('image/') && !binary) {
        const result = await readTextPage(filename, encoding, { ...options, version });
        invariant((await this.filename(task, name)) === filename, 'PREVIEW_PATH', '文件路径在读取时改变');
        bytes = result.bytes;
        text = result.text;
        page = result.page;
        resolvedEncoding = result.encoding;
        encodingSource = result.encodingSource;
        binary = isBinaryFile(name, Buffer.from(text, 'utf8'));
        if (binary) {
          text = null;
          page = null;
          resolvedEncoding = null;
          encodingSource = null;
        } else if (['.html', '.htm'].includes(ext)) {
          // The iframe renders the whole document, so its update key must include
          // bytes beyond the source page. Stream against the same file version.
          const resource = await streamFile(filename, mediaType, { version, signal: options.signal });
          const digest = createHash('sha256');
          for await (const chunk of resource.stream) digest.update(chunk);
          options.signal?.throwIfAborted();
          contentHash = digest.digest('hex');
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !task.baseline) throw error;
      const existed = await this.git(task, ['ls-tree', '-l', '-z', task.baseline, '--', name]);
      invariant(existed.stdout.length > 0, 'PREVIEW_MISSING', '文件不存在');
      baselineRecord = existed.stdout;
      deleted = true;
    }
    const kind: PreviewFile['kind'] = mediaType.startsWith('image/')
      ? 'image'
      : binary
        ? 'binary'
        : ['.html', '.htm'].includes(ext)
          ? 'html'
          : ['.md', '.markdown'].includes(ext)
            ? 'markdown'
            : 'text';
    let diff = '',
      diffTruncated = !!page?.paged;
    if (task.baseline && !(options.offset && options.offset > 0) && !baselineRecord)
      baselineRecord = (await this.git(task, ['ls-tree', '-l', '-z', task.baseline, '--', name])).stdout;
    const baselineBytes = baselineRecord
      ? Number(/^\d+\s+\w+\s+[a-f0-9]+\s+(\d+)\t/.exec(baselineRecord)?.[1] ?? Infinity)
      : 0;
    if (task.baseline && (largeDiff || baselineBytes > textLimit)) diffTruncated = true;
    else if (task.baseline && !(options.offset && options.offset > 0)) {
      const result = await this.git(
        task,
        ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=3', task.baseline, '--', name],
        textLimit,
      );
      diff = result.stdout;
      diffTruncated ||= result.truncated;
      if (!diff && bytes) {
        if (!baselineRecord && text !== null)
          diff =
            `--- /dev/null\n+++ b/${name}\n` +
            text
              .split('\n')
              .map((line) => '+' + line)
              .join('\n');
      }
    } else if (!task.baseline && text !== null)
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
    const scope = path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name);
    const resourceBase = !deleted
      ? `${this.prefix}/preview/${this.capability(runId, taskId)}/${scope ? scope.split('/').map(encodeURIComponent).join('/') + '/' : ''}`
      : null;
    const resourceUrl = !deleted
      ? `${this.prefix}/preview/${this.capability(runId, taskId, scope)}/` +
        encodeURIComponent(path.posix.basename(name)) +
        (version ? '?version=' + version : '')
      : null;
    return {
      path: name,
      text,
      hash: contentHash ?? (bytes ? hash(bytes) : null),
      mediaType,
      kind,
      diff,
      diffTruncated,
      deleted,
      page,
      encoding: resolvedEncoding,
      encodingSource,
      resourceBase,
      resourceUrl,
      renderUrl:
        kind === 'html' && !deleted
          ? `${this.prefix}/preview/${this.capability(runId, taskId, scope, name)}/${encodeURIComponent(path.posix.basename(name))}`
          : null,
    };
  }
  async resource(
    token: string,
    input: string,
    document = false,
    options: { range?: string; version?: string; signal?: AbortSignal } = {},
  ) {
    const capability = this.capabilities.get(token);
    invariant(
      capability && Date.now() - capability.touched < 30 * 60000,
      'PREVIEW_EXPIRED',
      '预览已过期，请刷新预览面板',
    );
    const task = this.task(capability.runId, capability.taskId);
    const observation = ++capability.observation;
    let name = '',
      version = '';
    let filename: string;
    try {
      const relative = normalized(input || 'index.html');
      name = capability.scope ? capability.scope + '/' + relative : relative;
      if (document && name === capability.page) {
        capability.generation = observation;
        capability.resources.clear();
        capability.truncated = false;
      }
      filename = await this.filename(task, name);
      const stat = await fs.stat(filename);
      version = resourceVersion(stat);
      invariant(stat.isFile(), 'PREVIEW_NOT_FILE', '页面资源不是文件');
      if (capability.page) this.observe(capability, name, version, observation, false, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const reason: PreviewResourceIssue['reason'] =
        code === 'ENOENT'
          ? 'missing'
          : code === 'PREVIEW_SIZE'
            ? 'too-large'
            : code === 'PREVIEW_NOT_FILE'
              ? 'not-file'
              : ['PREVIEW_LINK', 'PREVIEW_PATH'].includes(code || '')
                ? 'restricted'
                : 'unreadable';
      if (capability.page)
        this.observe(
          capability,
          name,
          version || (code === 'ENOENT' ? 'missing' : 'unavailable:' + (code || 'UNKNOWN')),
          observation,
          false,
          reason,
        );
      if (code === 'ENOENT') throw new AppError('PREVIEW_MISSING', '页面资源不存在', false, null, 404);
      if (error instanceof AppError) throw error;
      throw new AppError(
        'PREVIEW_READ',
        '页面资源无法读取，请检查本地文件后刷新页面',
        false,
        null,
        ['EACCES', 'EPERM'].includes(code || '') ? 403 : 500,
      );
    }
    const result = await streamFile(filename, fileMediaType(filename), {
      ...options,
      rewritePrefix: `${this.prefix}/preview/${token}/`,
    });
    try {
      invariant((await this.filename(task, name)) === filename, 'PREVIEW_PATH', '文件路径在读取时改变');
    } catch (error) {
      result.stream.destroy();
      throw error;
    }
    result.stream.once('error', () => {
      if (capability.page) this.observe(capability, name, version, observation, false, 'unreadable');
    });
    return result;
  }
}
