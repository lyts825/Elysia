/**
 * 检查项目目录并读取项目文件资源。
 * 限定注册目录内的列表、文本和资源读取，词法/真实路径及每段链接共同检查；Git 探测不扩大文件访问权限。
 * EN: Validates project directories and reads project file resources. Bounds listing/text/resource reads to registered roots using lexical/realpath/component link checks; Git inspection never widens access.
 */
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

/**
 * 识别项目内部、依赖、验证材料、环境及私钥路径段，供目录列举和读取共同排除。
 * EN: Identifies internal, dependency, QA, environment and private-key path segments excluded from listing/reads.
 */
const excluded = (name: string) =>
  ['.git', 'node_modules', '.elysia-runtime', '.local-tests', '.local-qa'].includes(name.toLowerCase()) ||
  /^\.env(?:\.|$)/i.test(name) ||
  /\.(?:pem|key|p12|pfx)$/i.test(name);
/**
 * 按平台比较已规范目录，Windows 忽略大小写，用于 realpath 一致性验证。
 * EN: Compares normalized directories with Windows case-insensitivity for realpath validation.
 */
export const sameDirectory = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
/**
 * 解析绝对路径并检查目录，通过 Git 探测仓库根目录和当前提交。
 * EN: Resolves an absolute directory and probes its Git root and current commit.
 */
export async function inspectFolder(input: string, processes: Processes) {
  invariant(path.isAbsolute(input), 'PROJECT_PATH', '请选择文件夹或填写绝对路径');
  const root = await fs.realpath(input);
  invariant((await fs.stat(root)).isDirectory(), 'PROJECT_PATH', '项目路径必须是文件夹');
  /**
   * 以有界 Git 子进程探测注册目录；进程启动异常转换为失败结果，让目录检查可给出统一说明。
   * EN: Probes registration directories with bounded Git processes, mapping spawn failures to failed results for consistent directory diagnostics.
   */
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
/**
 * 将项目相对路径解析为真实文件。词法路径和真实路径都排除敏感/依赖目录， 每个现有路径段拒绝 symlink/junction，不能借项目内部链接读取授权目录之外的资料。
 * EN: Resolves a project-relative file with both lexical and real-path exclusions. Rejects symlinks/junctions in existing path segments so project links cannot escape the authorized directory.
 */
async function projectFilename(store: Store, id: string, input: string) {
  const project = store.require<Project>('projects', id);
  invariant(
    !path.isAbsolute(input) && !input.includes('\0') && !input.split(/[\\/]/).some(excluded),
    'PROJECT_PATH',
    '文件路径无效',
  );
  const root = await fs.realpath(project.workspaceRoot);
  const lexical = path.resolve(root, input);
  /**
   * 核对解析目标的词法包含关系及每段排除规则，返回相对路径；链接另由主读取流程检查。
   * EN: Checks lexical containment and excluded segments, returning the relative path; the main reader separately validates links.
   */
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
/**
 * 为项目和可选目录生成逐段编码的资源路由基址，保持路径分隔语义且不执行文件读取。
 * EN: Builds segment-encoded project resource base URLs while preserving separators and performing no file reads.
 */
const projectResourceBase = (id: string, directory = '', prefix = '') =>
  `${prefix}/api/projects/${encodeURIComponent(id)}/resources/${directory ? directory.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/') + '/' : ''}`;
/**
 * 在项目范围内打开资源流，并在打开后再次核对路径。
 * EN: Opens a resource stream inside the project and rechecks its path after opening.
 */
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
/**
 * 目录返回排序后的有界元数据，超出 300 条显式标记截断；文本以版本化字节分页读取。 图片/PDF/二进制只返回资源 URL，文本解码完成后再次核验路径，防止读取期间被重定向。
 * EN: Returns sorted directory metadata with an explicit 300-entry truncation marker; text uses revisioned byte paging. Images, PDFs and binary files expose resource URLs, and decoded text is path-checked again against redirects during the read.
 */
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
    /**
     * UTF-16 文件在磁盘上含零字节；这里只将解码后的 NUL 字符判为二进制。
     * EN: UTF-16 text contains zero bytes on disk; only decoded NUL characters are binary here.
     */
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
