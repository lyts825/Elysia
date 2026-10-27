// 发现和加载内置及本地技能内容。
import { readFileSync, realpathSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AppError } from '../../contracts/src/index.js';
import { Store } from '../../storage/src/index.js';
import {
  capabilitySnapshot,
  scopedLocalItems,
  localItem,
  localItemText,
  loadLocalSkillFile,
  pageLocalText,
} from './local-library.js';
import type { CapabilityScope, CapturedSkill } from '../../contracts/src/project-intelligence.js';
import { parseDocument } from 'yaml';
import { builtinResourcePath } from './resources.js';

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  source?: string;
  resourcePaths?: string[];
}

export interface LoadedSkill extends SkillSummary {
  version: string;
  instructions: string;
  hash: string;
}

export const SKILL_CATALOG_VERSION = '3';
// Only application-maintained entrypoints can become instructions. Metadata lives in SKILL.md.
const builtinResources: Record<string, readonly string[]> = {
  'data-analysis': ['references/joins-and-missing.md'],
  documents: ['references/preservation.md'],
  'office-writing': [],
  pdf: ['references/forms-and-redaction.md'],
  presentations: ['references/visual-review.md'],
  research: ['references/evidence.md'],
  'software-engineering': ['references/verification.md'],
  spreadsheets: ['references/formulas.md'],
};
const skillIds = Object.keys(builtinResources);
const BUILTIN_RESOURCE_BYTES = 64 * 1024;

function resourceFile(id: string, relativePath: string) {
  const root = realpathSync(builtinResourcePath('skills'));
  const skillRoot = realpathSync(path.join(root, id));
  const file = realpathSync(path.join(skillRoot, relativePath));
  for (const [parent, child] of [
    [root, skillRoot],
    [skillRoot, file],
  ]) {
    const relative = path.relative(parent, child);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new AppError('SKILL_RESOURCE_PATH', '技能资源超出注册目录');
  }
  if (!statSync(file).isFile() || statSync(file).size > BUILTIN_RESOURCE_BYTES)
    throw new AppError('SKILL_RESOURCE_LIMIT', '内置技能资源必须是 64 KiB 以内的文本文件');
  return file;
}

function readResource(id: string, relativePath: string) {
  let bytes: Buffer;
  try {
    bytes = readFileSync(resourceFile(id, relativePath));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('SKILL_RESOURCE_NOT_FOUND', `无法读取内置技能资源：${id}/${relativePath}`);
  }
  const text = bytes.toString('utf8');
  if (bytes.length > BUILTIN_RESOURCE_BYTES || !Buffer.from(text).equals(bytes))
    throw new AppError('SKILL_RESOURCE_INVALID', '技能资源不是有界 UTF-8 文本');
  return {
    path: relativePath,
    text,
    bytes: bytes.length,
    hash: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function parseSkillMetadata(source: string, id: string) {
  const normalized = source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim();
  const header = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalized);
  if (!header) throw new AppError('SKILL_INVALID', `技能缺少标准 frontmatter：${id}`);
  const document = parseDocument(header[1], { uniqueKeys: true, schema: 'core', strict: true });
  let metadata: Record<string, unknown>;
  try {
    if (document.errors.length || document.warnings.length) throw new Error('invalid');
    metadata = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('invalid');
  } catch {
    throw new AppError('SKILL_INVALID', `技能 frontmatter 无效：${id}`);
  }
  const scalar = (key: string, indent = '', required = true) => {
    const nested = indent ? metadata.metadata : metadata;
    const entry = nested && typeof nested === 'object' ? (nested as Record<string, unknown>)[key] : undefined;
    const value =
      typeof entry === 'string' || (key === 'version' && typeof entry === 'number')
        ? String(entry).trim()
        : '';
    if (!value && required) throw new AppError('SKILL_INVALID', `技能缺少 ${key}：${id}`);
    return value;
  };
  const name = scalar('name'),
    description = scalar('description');
  if (!name.trim() || name.length > 160 || !description.trim() || description.length > 4000)
    throw new AppError('SKILL_INVALID', `技能名称或说明长度无效：${id}`);
  const flag = (key: string, defaultValue: boolean) => {
    const value = metadata[key];
    if (value === undefined) return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && (value === 0 || value === 1)) return Boolean(value);
    if (typeof value === 'string' && /^(true|yes|on|1|false|no|off|0)$/i.test(value))
      return /^(true|yes|on|1)$/i.test(value);
    throw new AppError('SKILL_INVALID', `技能 ${key} 必须是布尔值：${id}`);
  };
  return {
    name,
    description,
    version: scalar('version', '  ', false) || '1',
    instructions: header[2].trim(),
    modelInvocable: !flag('disable-model-invocation', false),
    userInvocable: flag('user-invocable', true),
  };
}

function readSkill(id: string, metadataOnly = false): LoadedSkill {
  if (!(skillIds as readonly string[]).includes(id))
    throw new AppError('SKILL_NOT_FOUND', `未注册的技能：${id}`);
  let source: string;
  try {
    const root = realpathSync(builtinResourcePath('skills'));
    const file = realpathSync(path.join(root, id, 'SKILL.md'));
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new AppError('SKILL_NOT_FOUND', `技能入口超出本地注册目录：${id}`);
    if (metadataOnly) {
      const fd = openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(16384);
        source = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
      } finally {
        closeSync(fd);
      }
    } else source = readFileSync(file, 'utf8');
    source = source
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n')
      .trim();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('SKILL_NOT_FOUND', `无法读取已注册技能：${id}`);
  }
  const { name, description, version, instructions } = parseSkillMetadata(source, id);
  if (name !== id) throw new AppError('SKILL_INVALID', `技能名称与注册 id 不符：${id}`);
  if (!metadataOnly && !instructions) throw new AppError('SKILL_INVALID', `技能正文为空：${id}`);
  return {
    id,
    name,
    description,
    version,
    instructions,
    hash: createHash('sha256').update(source).digest('hex'),
    resourcePaths: [...builtinResources[id]],
  };
}

/** Capture resources with the entrypoint, but never inject their bodies into skill discovery. */
export function captureBuiltinSkill(id: string): CapturedSkill {
  const skill = readSkill(id);
  return { ...skill, resources: skill.resourcePaths!.map((resource) => readResource(id, resource)) };
}

export function loadSkillFile(
  store: Store | undefined,
  id: string,
  resourcePath: string,
  options: { offset?: number; limit?: number } = {},
  scope?: CapabilityScope,
) {
  if (id.startsWith('local:')) {
    if (!store) throw new AppError('SKILL_NOT_FOUND', '导入技能需要本地存储');
    return loadLocalSkillFile(store, id, resourcePath, options, scope);
  }
  const normalized = resourcePath.replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /[:\u0000-\u001f]/.test(normalized) ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new AppError('SKILL_RESOURCE_PATH', '技能资源路径无效');
  const snapshot = capabilitySnapshot(scope);
  let resource: NonNullable<CapturedSkill['resources']>[number];
  if (snapshot) {
    const skill = snapshot.builtinSkills.find((entry) => entry.id === id);
    if (!skill) throw new AppError('SKILL_NOT_FOUND', '此技能不在任务创建时冻结的能力范围内');
    const captured = skill.resources?.find((entry) => entry.path === normalized);
    // A legacy snapshot must not silently acquire a newer built-in reference.
    if (!captured) throw new AppError('SKILL_RESOURCE_NOT_FOUND', '此参考资料未在任务创建时冻结');
    resource = captured;
  } else {
    if (!skillIds.includes(id) || !builtinResources[id].includes(normalized))
      throw new AppError('SKILL_RESOURCE_NOT_FOUND', '此参考资料不在内置技能注册清单中');
    resource = readResource(id, normalized);
  }
  if (
    Buffer.byteLength(resource.text) !== resource.bytes ||
    createHash('sha256').update(resource.text).digest('hex') !== resource.hash
  )
    throw new AppError('SKILL_RESOURCE_INVALID', '技能参考资料哈希不一致');
  return pageLocalText({ id, contentHash: resource.hash }, resource.text, { ...options, path: normalized });
}

export function listSkills(store?: Store, scope?: CapabilityScope): SkillSummary[] {
  const snapshot = capabilitySnapshot(scope);
  const builtin = snapshot
    ? snapshot.builtinSkills.map(({ id, name, description }) => ({ id, name, description }))
    : skillIds.map((id) => {
        const { name, description } = readSkill(id, true);
        return { id, name, description };
      });
  return [
    ...builtin,
    ...(store
      ? scopedLocalItems(store, scope)
          .filter((item) => item.kind === 'skill' && item.enabled && item.modelInvocable !== false)
          .map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description,
            source: item.sourceKind,
            resourcePaths: item.resourcePaths,
          }))
      : []),
  ];
}

export function loadSkill(id: string, store?: Store, scope?: CapabilityScope): LoadedSkill {
  if (id.startsWith('local:')) {
    if (!store) throw new AppError('SKILL_NOT_FOUND', `未注册的技能：${id}`);
    const item = localItem(store, id, 'skill', false, scope);
    if (item.modelInvocable === false) throw new AppError('SKILL_NOT_INVOCABLE', '来源技能禁止由模型调用');
    const source = localItemText(store, item),
      metadata = parseSkillMetadata(source, id);
    if (!metadata.instructions) throw new AppError('SKILL_INVALID', `技能正文为空：${id}`);
    return {
      id,
      ...metadata,
      hash: item.contentHash,
      source: item.sourceKind,
      resourcePaths: item.resourcePaths,
    };
  }
  const snapshot = capabilitySnapshot(scope);
  if (snapshot) {
    const skill = snapshot.builtinSkills.find((entry) => entry.id === id);
    if (!skill)
      throw new AppError('SKILL_NOT_FOUND', '此技能不在任务创建时冻结的能力范围内', false, null, 404);
    const { resources: _resources, ...entrypoint } = skill;
    return structuredClone(entrypoint);
  }
  return readSkill(id);
}
