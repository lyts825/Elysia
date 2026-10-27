// 管理导入的本地代理能力及其按作用域读取。
import { AppError } from '../../contracts/src/index.js';
import type {
  LocalAgentItem,
  LocalAgentSource,
  LocalContentPage,
  LocalMcpConfig,
} from '../../contracts/src/local-integrations.js';
import { Store, hash, stable } from '../../storage/src/index.js';
import {
  PROJECT_INTELLIGENCE_LIMITS,
  type CapabilityScope,
  type ProjectCapabilitySnapshot,
} from '../../contracts/src/project-intelligence.js';

export const LOCAL_LIBRARY_KEY = 'local-agents:v1';
export interface LocalStoredItem extends LocalAgentItem {
  configOverridden?: boolean;
  contentRef?: string;
  resourceRefs?: { path: string; objectRef: string; hash: string; bytes: number }[];
  frozenContent?: string;
  frozenResources?: { path: string; text: string; hash: string; bytes: number }[];
}
export interface LocalLibrary {
  version: 1;
  revision: number;
  sources: LocalAgentSource[];
  items: LocalStoredItem[];
}
// 未导入过本地资源时返回空库及修订 0；其余数据由持久化记录提供。
export function importedLibrary(store: Store): LocalLibrary {
  const row = store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(LOCAL_LIBRARY_KEY) as
    | { value: string }
    | undefined;
  if (!row) return { version: 1, revision: 0, sources: [], items: [] };
  try {
    const value = JSON.parse(row.value) as LocalLibrary;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      !Array.isArray(value.sources) ||
      !Array.isArray(value.items) ||
      value.items.length > 500
    )
      throw new Error('invalid');
    return value;
  } catch {
    throw new AppError('LOCAL_LIBRARY_INVALID', '本机同步目录损坏，请恢复备份', false, null, 409);
  }
}
export function writeImportedLibrary(store: Store, library: LocalLibrary) {
  store.db
    .prepare('INSERT OR REPLACE INTO storage_meta(key,value) VALUES(?,?)')
    .run(LOCAL_LIBRARY_KEY, stable(library));
}
// 返回目录信息时剔除内部对象引用及冻结正文，避免把存储细节暴露给调用方。
export function publicLocalItem(item: LocalStoredItem): LocalAgentItem {
  const {
    contentRef: _contentRef,
    resourceRefs: _resourceRefs,
    configOverridden: _configOverridden,
    frozenContent: _frozenContent,
    frozenResources: _frozenResources,
    ...safe
  } = item;
  return safe;
}
// 按项目、版本、大小和摘要校验快照；校验失败不使用当前资源替代。
export function capabilitySnapshot(scope?: CapabilityScope): ProjectCapabilitySnapshot | undefined {
  const snapshot = scope?.capabilities;
  if (snapshot == null) return undefined;
  const { hash: capturedHash, ...captured } = snapshot;
  if (
    snapshot.version !== 1 ||
    !scope?.projectId ||
    snapshot.projectId !== scope.projectId ||
    !Array.isArray(snapshot.builtinSkills) ||
    !Array.isArray(snapshot.localItems) ||
    Buffer.byteLength(stable(snapshot)) > PROJECT_INTELLIGENCE_LIMITS.snapshotBytes ||
    hash(stable(captured)) !== capturedHash
  )
    throw new AppError('CAPABILITY_SCOPE', '任务能力快照无效或不属于当前项目', false, null, 409);
  return snapshot;
}
// 冻结内容仍受当前启用状态约束；已停用项目不会从旧快照重新启用。
export function scopedLocalItems(store: Store, scope?: CapabilityScope): LocalStoredItem[] {
  const current = importedLibrary(store).items;
  const snapshot = capabilitySnapshot(scope);
  if (!snapshot) return current;
  return snapshot.localItems.flatMap(({ content, resources, ...captured }) => {
    const live = current.find((item) => item.id === captured.id && item.kind === captured.kind);
    if (!live?.enabled || !captured.enabled) return [];
    return [
      {
        ...captured,
        ...(live.modelInvocable === false ? { modelInvocable: false } : {}),
        frozenContent: content,
        frozenResources: resources,
      },
    ];
  });
}
export function localItem(
  store: Store,
  id: string,
  kind?: LocalAgentItem['kind'],
  allowDisabled = false,
  scope?: CapabilityScope,
) {
  const item = scopedLocalItems(store, scope).find(
    (value) => value.id === id && (!kind || value.kind === kind),
  );
  if (!item || (!allowDisabled && !item.enabled))
    throw new AppError('LOCAL_ITEM_NOT_FOUND', '同步项不存在或尚未启用', false, null, 404);
  return item;
}
// 优先读取冻结正文，否则读取对象引用；两种路径都验证内容大小和摘要。
export function localItemText(store: Store, item: LocalStoredItem) {
  if (item.frozenContent !== undefined) {
    if (
      Buffer.byteLength(item.frozenContent) > 512 * 1024 ||
      hash(Buffer.from(item.frozenContent)) !== item.contentHash
    )
      throw new AppError('LOCAL_CONTENT_CHANGED', '冻结的同步项正文哈希不一致', false, null, 409);
    return item.frozenContent;
  }
  if (!item.contentRef) throw new AppError('LOCAL_CONTENT_MISSING', '同步项正文不存在', false, null, 404);
  const bytes = store.readObject(item.contentRef);
  if (bytes.length > 512 * 1024 || hash(bytes) !== item.contentHash)
    throw new AppError('LOCAL_CONTENT_CHANGED', '同步项正文哈希不一致，请重新同步', false, null, 409);
  return bytes.toString('utf8');
}
export function listLocalMemories(store: Store, scope?: CapabilityScope) {
  return scopedLocalItems(store, scope)
    .filter((item) => item.kind === 'memory' && item.enabled)
    .map(publicLocalItem);
}
// 按字符偏移返回有界内容，查询时从匹配位置附近开始；分页边界保留完整代理对。
export function pageLocalText(
  item: { id: string; contentHash: string },
  text: string,
  options: { offset?: number; limit?: number; query?: string; path?: string } = {},
): LocalContentPage {
  const limit = Math.min(32768, Math.max(1, Math.trunc(options.limit ?? 16000)));
  let offset = Math.min(text.length, Math.max(0, Math.trunc(options.offset ?? 0)));
  if (options.query) {
    const found = text.toLocaleLowerCase().indexOf(options.query.slice(0, 240).toLocaleLowerCase(), offset);
    if (found < 0)
      return {
        id: item.id,
        text: '',
        offset,
        nextOffset: null,
        totalCharacters: text.length,
        hash: item.contentHash,
        trust: 'untrusted',
      };
    offset = Math.max(0, found - 240);
  }
  // Keep UTF-16 surrogate pairs together at page boundaries.
  if (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? '')) offset--;
  let end = Math.min(text.length, offset + limit);
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--;
  if (end === offset && offset < text.length) end = Math.min(text.length, offset + 2);
  return {
    id: item.id,
    text: text.slice(offset, end),
    offset,
    nextOffset: end < text.length ? end : null,
    totalCharacters: text.length,
    hash: item.contentHash,
    ...(options.path ? { path: options.path } : {}),
    trust: 'untrusted',
  };
}
export function readLocalMemory(
  store: Store,
  id: string,
  options: { offset?: number; limit?: number; query?: string } = {},
  scope?: CapabilityScope,
) {
  const item = localItem(store, id, 'memory', false, scope);
  return pageLocalText(item, localItemText(store, item), options);
}
export function loadLocalSkillFile(
  store: Store,
  id: string,
  resourcePath: string,
  options: { offset?: number; limit?: number } = {},
  scope?: CapabilityScope,
) {
  const item = localItem(store, id, 'skill', false, scope);
  if (item.modelInvocable === false) throw new AppError('SKILL_NOT_INVOCABLE', '来源技能禁止由模型调用');
  const normalized = resourcePath.replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..') ||
    /[:\u0000-\u001F]/.test(normalized)
  )
    throw new AppError('SKILL_RESOURCE_PATH', '技能资源路径无效');
  if (normalized === 'SKILL.md')
    return pageLocalText(item, localItemText(store, item), { ...options, path: normalized });
  if (item.frozenResources) {
    const resource = item.frozenResources.find((entry) => entry.path === normalized);
    if (!resource)
      throw new AppError('SKILL_RESOURCE_NOT_FOUND', '此资源未在任务创建时冻结', false, null, 404);
    if (
      Buffer.byteLength(resource.text) !== resource.bytes ||
      hash(Buffer.from(resource.text)) !== resource.hash
    )
      throw new AppError('LOCAL_CONTENT_CHANGED', '冻结的技能资源哈希不一致', false, null, 409);
    return pageLocalText({ id, contentHash: resource.hash }, resource.text, { ...options, path: normalized });
  }
  const ref = item.resourceRefs?.find((resource) => resource.path === normalized);
  if (!ref) throw new AppError('SKILL_RESOURCE_NOT_FOUND', '此资源未作为文本同步', false, null, 404);
  const bytes = store.readObject(ref.objectRef);
  if (bytes.length !== ref.bytes || hash(bytes) !== ref.hash)
    throw new AppError('LOCAL_CONTENT_CHANGED', '技能资源哈希不一致', false, null, 409);
  return pageLocalText({ id, contentHash: ref.hash }, bytes.toString('utf8'), {
    ...options,
    path: normalized,
  });
}
export function readLocalMcpConfig(store: Store, id: string, scope?: CapabilityScope): LocalMcpConfig {
  const item = localItem(store, id, 'mcp', false, scope);
  if (!item.config) throw new AppError('MCP_CONFIG_MISSING', 'MCP 配置不存在');
  return structuredClone(item.config);
}
