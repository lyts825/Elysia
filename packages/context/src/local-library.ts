import { AppError } from '../../contracts/src/index.js';
import type {
  LocalAgentItem,
  LocalAgentSource,
  LocalContentPage,
  LocalMcpConfig,
} from '../../contracts/src/local-integrations.js';
import { Store, hash, stable } from '../../storage/src/index.js';

export const LOCAL_LIBRARY_KEY = 'local-agents:v1';
export interface LocalStoredItem extends LocalAgentItem {
  configOverridden?: boolean;
  contentRef?: string;
  resourceRefs?: { path: string; objectRef: string; hash: string; bytes: number }[];
}
export interface LocalLibrary {
  version: 1;
  revision: number;
  sources: LocalAgentSource[];
  items: LocalStoredItem[];
}
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
export function publicLocalItem(item: LocalStoredItem): LocalAgentItem {
  const {
    contentRef: _contentRef,
    resourceRefs: _resourceRefs,
    configOverridden: _configOverridden,
    ...safe
  } = item;
  return safe;
}
export function localItem(store: Store, id: string, kind?: LocalAgentItem['kind'], allowDisabled = false) {
  const item = importedLibrary(store).items.find(
    (value) => value.id === id && (!kind || value.kind === kind),
  );
  if (!item || (!allowDisabled && !item.enabled))
    throw new AppError('LOCAL_ITEM_NOT_FOUND', '同步项不存在或尚未启用', false, null, 404);
  return item;
}
export function localItemText(store: Store, item: LocalStoredItem) {
  if (!item.contentRef) throw new AppError('LOCAL_CONTENT_MISSING', '同步项正文不存在', false, null, 404);
  const bytes = store.readObject(item.contentRef);
  if (bytes.length > 512 * 1024 || hash(bytes) !== item.contentHash)
    throw new AppError('LOCAL_CONTENT_CHANGED', '同步项正文哈希不一致，请重新同步', false, null, 409);
  return bytes.toString('utf8');
}
export function listLocalMemories(store: Store) {
  return importedLibrary(store)
    .items.filter((item) => item.kind === 'memory' && item.enabled)
    .map(publicLocalItem);
}
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
) {
  const item = localItem(store, id, 'memory');
  return pageLocalText(item, localItemText(store, item), options);
}
export function loadLocalSkillFile(
  store: Store,
  id: string,
  resourcePath: string,
  options: { offset?: number; limit?: number } = {},
) {
  const item = localItem(store, id, 'skill');
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
export function readLocalMcpConfig(store: Store, id: string): LocalMcpConfig {
  const item = localItem(store, id, 'mcp');
  if (!item.config) throw new AppError('MCP_CONFIG_MISSING', 'MCP 配置不存在');
  return structuredClone(item.config);
}
