import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError, invariant, type Project } from '../../../packages/contracts/src/index.js';
import { isBinaryFile } from '../../../packages/contracts/src/files.js';
import type { Store } from '../../../packages/storage/src/index.js';
import type { Processes } from '../../../packages/tools/src/index.js';

const excluded = (name: string) =>
  ['.git', 'node_modules', '.elysia-runtime', '.local-tests', '.local-qa'].includes(name.toLowerCase()) ||
  /^\.env(?:\.|$)/i.test(name);
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
export const projectTextEncodings = ['auto', 'utf-8', 'utf-16le', 'utf-16be', 'gb18030'] as const;
type ProjectTextEncoding = (typeof projectTextEncodings)[number];
function decodeProjectText(content: Uint8Array, requested: ProjectTextEncoding) {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => content[index] === byte);
  if (starts(0xff, 0xfe, 0, 0) || starts(0, 0, 0xfe, 0xff))
    throw new AppError('PROJECT_FILE_ENCODING', '暂不支持 UTF-32 文本预览，请将文件另存为 UTF-8 后重试。');
  const bom = starts(0xef, 0xbb, 0xbf)
    ? 'utf-8'
    : starts(0xff, 0xfe)
      ? 'utf-16le'
      : starts(0xfe, 0xff)
        ? 'utf-16be'
        : undefined;
  if (bom && requested !== 'auto' && requested !== bom)
    throw new AppError(
      'PROJECT_FILE_ENCODING',
      '所选编码与文件 BOM 不一致，请选择自动或对应的 Unicode 编码。',
    );
  const encoding = requested === 'auto' ? bom || 'utf-8' : requested;
  try {
    return {
      text: new TextDecoder(encoding, { fatal: true }).decode(content),
      encoding,
      encodingSource: requested === 'auto' ? (bom ? 'bom' : 'default') : 'manual',
    };
  } catch {
    throw new AppError(
      'PROJECT_FILE_ENCODING',
      '无法按当前编码读取文本，请选择文件实际编码；Windows 中文旧文件可尝试 GB18030 / GBK。',
    );
  }
}
export async function projectFiles(
  store: Store,
  id: string,
  input = '.',
  encoding: ProjectTextEncoding = 'auto',
) {
  const project = store.require<Project>('projects', id);
  invariant(!path.isAbsolute(input) && !input.split(/[\\/]/).some(excluded), 'PROJECT_PATH', '文件路径无效');
  const root = await fs.realpath(project.workspaceRoot);
  const target = await fs.realpath(path.resolve(root, input));
  const relative = path.relative(root, target);
  invariant(
    relative !== '..' &&
      !relative.startsWith('..' + path.sep) &&
      !path.isAbsolute(relative) &&
      !relative.split(/[\\/]/).some(excluded),
    'PROJECT_PATH',
    '文件超出项目目录',
  );
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
  invariant(
    stat.isFile() && stat.size <= 1024 * 1024,
    'PROJECT_FILE_SIZE',
    '当前文件预览支持 1 MB 以内的文本文件',
  );
  // Read a bounded handle so files growing during preview cannot exhaust memory.
  const handle = await fs.open(target, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    invariant(bytesRead <= 1024 * 1024, 'PROJECT_FILE_SIZE', '当前文件预览支持 1 MB 以内的文本文件');
    invariant(!isBinaryFile(target, new Uint8Array()), 'PROJECT_FILE_TYPE', '此文件不是可预览的文本文件');
    const decoded = decodeProjectText(buffer.subarray(0, bytesRead), encoding);
    // UTF-16 text contains zero bytes on disk; only decoded NUL characters are binary here.
    invariant(
      !isBinaryFile(target, Buffer.from(decoded.text, 'utf8')),
      'PROJECT_FILE_TYPE',
      '此文件不是可预览的文本文件',
    );
    return { path: relative, directory: false, ...decoded };
  } finally {
    await handle.close();
  }
}
