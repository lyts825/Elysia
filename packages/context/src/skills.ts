import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AppError } from '../../contracts/src/index.js';

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
}

export interface LoadedSkill extends SkillSummary {
  version: string;
  instructions: string;
  hash: string;
}

export const SKILL_CATALOG_VERSION = '1';
// Only application-maintained entrypoints can become instructions. Metadata lives in SKILL.md.
const skillIds = [
  'data-analysis',
  'documents',
  'office-writing',
  'pdf',
  'presentations',
  'research',
  'spreadsheets',
] as const;

function readSkill(id: string): LoadedSkill {
  if (!(skillIds as readonly string[]).includes(id))
    throw new AppError('SKILL_NOT_FOUND', `未注册的技能：${id}`);
  let source: string;
  try {
    const root = realpathSync(path.resolve(process.cwd(), 'skills'));
    const file = realpathSync(path.join(root, id, 'SKILL.md'));
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new AppError('SKILL_NOT_FOUND', `技能入口超出本地注册目录：${id}`);
    source = readFileSync(file, 'utf8')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n')
      .trim();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('SKILL_NOT_FOUND', `无法读取已注册技能：${id}`);
  }
  const header = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(source);
  if (!header) throw new AppError('SKILL_INVALID', `技能缺少标准 frontmatter 或正文：${id}`);
  // Our trusted catalog uses simple scalars, with metadata.version as its only nested field.
  const scalar = (key: string, indent = '') => {
    const value = new RegExp(`^${indent}${key}:\\s*(.+)$`, 'm').exec(header[1])?.[1]?.trim();
    if (!value) throw new AppError('SKILL_INVALID', `技能缺少 ${key}：${id}`);
    if (value.startsWith("'")) {
      if (value.endsWith("'") && value.length > 2) return value.slice(1, -1).replace(/''/g, "'");
      throw new AppError('SKILL_INVALID', `技能 ${key} 无效：${id}`);
    }
    if (value.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed === 'string' && parsed.trim()) return parsed;
      } catch {}
      throw new AppError('SKILL_INVALID', `技能 ${key} 无效：${id}`);
    }
    return value;
  };
  const name = scalar('name');
  if (name !== id) throw new AppError('SKILL_INVALID', `技能名称与注册 id 不符：${id}`);
  return {
    id,
    name,
    description: scalar('description'),
    version: scalar('version', '  '),
    instructions: header[2].trim(),
    hash: createHash('sha256').update(source).digest('hex'),
  };
}

export function listSkills(): SkillSummary[] {
  return skillIds.map((id) => {
    const { name, description } = readSkill(id);
    return { id, name, description };
  });
}

export function loadSkill(id: string): LoadedSkill {
  return readSkill(id);
}
