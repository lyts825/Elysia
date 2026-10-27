/** 检查项目目录并读取项目文件资源。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError, invariant, type Project } from '../../../packages/contracts/src/index.js';
import {
  fileMediaType,
  isBinaryFile,
  textFileEncodings,
  type TextFileEncoding,
  type TextPageOptions,
} from '../../../packages/contracts/src/files.js';
import type { Store } from '../../../packages/storage/src/index.js';
import type { Processes } from '../../../packages/tools/src/index.js';
import { fileVersion, readTextPage, streamFile } from './file-reader.js';

const excluded = (name: string) =>
  ['.git', 'node_modules', '.elysia-runtime', '.local-tests', '.local-qa'].includes(name.toLowerCase()) ||
  /^\.env(?:\.|$)/i.test(name) ||
  /\.(?:pem|key|p12|pfx)$/i.test(name);
export const sameDirectory = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export async function inspectFolder(input: string, processes: Processes) {
  invariant(path.isAbsolute(input), 'PROJECT_PATH', '请选择文件夹或填写绝对路径');
  const root = await fs.realpath(input);
  invariant((await fs.stat(root)).isDirectory(), 'PROJECT_PATH', '项目路径必须是文件夹');
  const probe = async (args: string[]) => {
    try {
      return await processes.run('registration', 'git', ['-C', root, ...args], root, 10000, 3000);
    } catch {
      return { exitCode: 1, stdout: '' };
    }
  };
  const commit = await probe(['rev-parse', '--verify', 'HEAD^{commit}']);
  const gitRoot = await probe(['rev-parse', '--show-toplevel']);
  const baseline = commit.exitCode === 0 ? commit.stdout.trim() : null;
  const repoRoot = gitRoot.exitCode === 0 ? await fs.realpath(gitRoot.stdout.trim()) : null;
  return {
    name: path.basename(root) || root,
    workspaceRoot: root,
    baseline,
    gitRoot: repoRoot,
    gitAvailable: !!baseline && !!repoRoot && sameDirectory(root, repoRoot),
    entries: (await fs.readdir(root, { withFileTypes: true }))
      .filter((e) => !excluded(e.name) && !e.isSymbolicLink())
      .slice(0, 24)
      .map((e) => ({ name: e.name, directory: e.isDirectory() })),
  };
}
export const projectTextEncodings = textFileEncodings;
async function projectFilename(store: Store, id: string, input: string) {
  const project = store.require<Project>('projects', id);
  invariant(
    !path.isAbsolute(input) && !input.includes('\0') && !input.split(/[\\/]/).some(excluded),
    'PROJECT_PATH',
    '文件路径无效',
  );
  const root = await fs.realpath(project.workspaceRoot);
  const lexical = path.resolve(root, input);
  const check = (target: string) => {
    const relative = path.relative(root, target);
    invariant(
      relative !== '..' &&
        !relative.startsWith('..' + path.sep) &&
        !path.isAbsolute(relative) &&
        !relative.split(/[\\/]/).some(excluded),
      'PROJECT_PATH',
      '文件超出项目目录',
    );
    return relative;
  };
  const relative = check(lexical);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    invariant(
      !(await fs.lstat(current)).isSymbolicLink(),
      'PROJECT_PATH',
      '项目资料不跟随符号链接或 junction',
    );
  }
  const target = await fs.realpath(lexical);
  check(target);
  return { target, relative };
}
const projectResourceBase = (id: string, directory = '', prefix = '') =>
  `${prefix}/api/projects/${encodeURIComponent(id)}/resources/${directory ? directory.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/') + '/' : ''}`;
export async function projectResource(
  store: Store,
  id: string,
  input: string,
  options: { range?: string; version?: string; signal?: AbortSignal } = {},
) {
  const { target } = await projectFilename(store, id, input);
  const resource = await streamFile(target, fileMediaType(target), options);
  try {
    invariant(
      (await projectFilename(store, id, input)).target === target,
      'PROJECT_PATH',
      '文件路径在读取时改变',
    );
  } catch (error) {
    resource.stream.destroy();
    throw error;
  }
  return resource;
}
export async function projectFiles(
  store: Store,
  id: string,
  input = '.',
  encoding: TextFileEncoding = 'auto',
  options: TextPageOptions = {},
  prefix = '',
) {
  options.signal?.throwIfAborted();
  const { target, relative } = await projectFilename(store, id, input);
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    const entries = (await fs.readdir(target, { withFileTypes: true }))
      .filter((e) => !excluded(e.name) && !e.isSymbolicLink())
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    return {
      path: relative || '.',
      directory: true,
      truncated: entries.length > 300,
      entries: entries
        .slice(0, 300)
        .map((e) => ({ name: e.name, directory: e.isDirectory(), path: path.join(relative, e.name) })),
    };
  }
  invariant(stat.isFile(), 'PROJECT_FILE_TYPE', '此路径不是可预览的文件');
  const mediaType = fileMediaType(target),
    kind = mediaType.startsWith('image/')
      ? 'image'
      : mediaType === 'application/pdf'
        ? 'pdf'
        : isBinaryFile(target, new Uint8Array())
          ? 'binary'
          : /\.(?:md|markdown)$/i.test(target)
            ? 'markdown'
            : /\.html?$/i.test(target)
              ? 'html'
              : 'text';
  const directory = path.dirname(relative) === '.' ? '' : path.dirname(relative);
  const resourceBase = projectResourceBase(id, directory, prefix);
  const resourceUrl =
    projectResourceBase(id, '', prefix) +
    relative.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
  if (kind === 'image' || kind === 'pdf' || kind === 'binary')
    return {
      path: relative,
      directory: false,
      text: null,
      encoding: null,
      encodingSource: null,
      page: null,
      kind,
      mediaType,
      resourceBase,
      resourceUrl: resourceUrl + '?version=' + fileVersion(stat),
    };
  try {
    const { bytes: _bytes, ...decoded } = await readTextPage(target, encoding, options);
    invariant(
      (await projectFilename(store, id, input)).target === target,
      'PROJECT_PATH',
      '文件路径在读取时改变',
    );
    // UTF-16 text contains zero bytes on disk; only decoded NUL characters are binary here.
    invariant(
      !isBinaryFile(target, Buffer.from(decoded.text, 'utf8')),
      'PROJECT_FILE_TYPE',
      '此文件不是可预览的文本文件',
    );
    return { path: relative, directory: false, ...decoded, kind, mediaType, resourceBase, resourceUrl };
  } catch (error) {
    if (error instanceof AppError && error.code === 'FILE_ENCODING')
      throw new AppError('PROJECT_FILE_ENCODING', error.message, false, null, error.httpStatus);
    throw error;
  }
}
