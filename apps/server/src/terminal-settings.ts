/**
 * 管理终端设置、配置和相关接口。
 * 兼容模板/应用选择并清理失效项目引用，纯读取不写回；相关写入同事务核对版本，只影响未来任务的冻结配置。
 * EN: Manages terminal settings, templates and related endpoints. Normalizes template/app choices and invalid references through pure reads and atomic revisioned writes, affecting future execution snapshots only.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  Command,
  SurfaceTerminalSettings,
  AgentTerminalProfile,
  type Project,
} from '../../../packages/contracts/src/index.js';
import {
  TerminalAppId,
  TerminalControlApps,
  TerminalProjectPreferences,
  TerminalConnectionBinding,
} from '../../../packages/contracts/src/terminal-control.js';
import { type Store, stable } from '../../../packages/storage/src/index.js';
import {
  initialTerminalProfiles,
  terminalAppCatalog,
  terminalAppForProfile,
  terminalProtocols,
} from './terminal-catalog.js';

const settingsKey = 'surface:terminal:settings:v1';
const appsKey = 'surface:terminal:control:apps:v1';
const connectionsKey = 'surface:terminal:control:connections:v1';
const preferredKey = 'surface:terminal:control:preferred-profiles:v1';
/**
 * 生成项目终端偏好的独立元数据键，供失效选择清理复用。
 * EN: Builds independent project terminal-preference keys reused for invalid-selection cleanup.
 */
const projectKey = (id: string) => `surface:terminal:control:project:${id}`;
type PreferredProfiles = Partial<Record<TerminalAppId, string>>;
const preferredSchema = z.partialRecord(TerminalAppId, z.string().uuid());
/**
 * 读取并按 schema 校验保存的设置，缺失返回 undefined；损坏不自动替换默认值。
 * EN: Reads saved settings through schema validation, returning undefined only when absent rather than replacing damage with defaults.
 */
function read<T>(store: Store, key: string, schema: z.ZodType<T>): T | undefined {
  const row = store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  const value = JSON.parse(row.value);
  // 旧五项目录只在内存中补充隐藏的新入口；保留默认项、连接和修订，不覆盖用户选择。
  // EN: Expand legacy five-entry catalogs only in memory, preserving defaults, bindings and revisions.
  if (key === appsKey && Array.isArray(value?.entries) && value.entries.length === 5) {
    const ids = new Set(value.entries.map((entry: { id?: string } | null) => entry?.id));
    if (['codex', 'dsh', 'claude', 'gemini', 'custom'].every((id) => ids.has(id)))
      value.entries.push({ id: 'antigravity', visible: false, connectionId: null });
  }
  return schema.parse(value);
}
/**
 * 稳定序列化设置并 upsert 元数据；调用方负责将关联设置写入同一事务。
 * EN: Stable-serializes/upserts settings; callers place related writes in one transaction.
 */
function write(store: Store, key: string, value: unknown) {
  store.db
    .prepare(
      'INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(key, stable(value));
}
/**
 * 要求整数预期版本精确匹配，不匹配时返回当前版本冲突。
 * EN: Requires an integer expected revision matching exactly and reports current revision on conflict.
 */
function assertRevision(expected: number, actual: number) {
  if (!Number.isInteger(expected) || expected !== actual)
    throw new AppError(
      'REVISION_CONFLICT',
      '终端配置已更新，请刷新后重试',
      false,
      { currentRevision: actual },
      409,
    );
}
/**
 * 构造初始终端配置，默认选中 Codex 预设。
 * EN: Builds initial terminal configuration with the Codex preset selected.
 */
export function initialTerminalSettings(): SurfaceTerminalSettings {
  return SurfaceTerminalSettings.parse({
    revision: 0,
    defaultProfileId: 'fceec6bc-f890-4e9e-ae1c-af63e40e606b',
    profiles: initialTerminalProfiles(),
  });
}
/**
 * 从已校验模板和默认模板派生初始应用显示/选择，不带连接覆盖，输出再经 schema 校验。
 * EN: Derives initial app visibility/selection from validated templates/default without connection overrides and validates the result.
 */
function defaultApps(settings: SurfaceTerminalSettings): TerminalControlApps {
  const defaultAppId = terminalAppForProfile(
    settings.profiles.find((profile) => profile.id === settings.defaultProfileId)!,
  );
  return TerminalControlApps.parse({
    revision: 0,
    defaultAppId,
    entries: TerminalAppId.options.map((id) => ({
      id,
      visible: settings.profiles.some((profile) => profile.agent === id),
      connectionId: null,
    })),
  });
}
/**
 * 读取各应用上次模板偏好后过滤无效引用，仅返回当前仍兼容的选择。
 * EN: Reads per-app previous-template preferences and filters invalid references to current compatible choices.
 */
function preferredProfiles(store: Store, profiles: AgentTerminalProfile[]): PreferredProfiles {
  const saved = read(store, preferredKey, preferredSchema) ?? {};
  return validPreferredProfiles(saved, profiles);
}
/**
 * 仅保留模板 ID 和代理类型同时匹配的偏好，不改变输入对象。
 * EN: Retains preferences matching both template ID and adapter type without mutating input.
 */
function validPreferredProfiles(
  saved: PreferredProfiles,
  profiles: AgentTerminalProfile[],
): PreferredProfiles {
  return Object.fromEntries(
    Object.entries(saved).filter(([appId, id]) =>
      profiles.some((profile) => profile.id === id && profile.agent === appId),
    ),
  );
}
/**
 * 按当前默认、应用记忆、首个同类模板依次选取，不存在返回 undefined。
 * EN: Chooses current default, remembered app template, then first matching template, returning undefined if none.
 */
function preferredProfile(
  settings: SurfaceTerminalSettings,
  appId: TerminalAppId,
  preferred: PreferredProfiles,
) {
  const current = settings.profiles.find(
    (profile) => profile.id === settings.defaultProfileId && profile.agent === appId,
  );
  return (
    current ??
    settings.profiles.find((profile) => profile.id === preferred[appId] && profile.agent === appId) ??
    settings.profiles.find((profile) => profile.agent === appId)
  );
}
/**
 * 比较影响模板选择的稳定内容，排除纯版本字段，判断是否需要实际写入。
 * EN: Compares stable template-selection content excluding revision-only fields to determine whether writes are needed.
 */
function sameSettings(a: SurfaceTerminalSettings, b: SurfaceTerminalSettings) {
  return (
    stable({ profiles: a.profiles, defaultProfileId: a.defaultProfileId }) ===
    stable({ profiles: b.profiles, defaultProfileId: b.defaultProfileId })
  );
}
/**
 * 比较应用默认项和条目的稳定内容，版本变化本身不算配置变化。
 * EN: Compares stable default/entry content without treating revision alone as configuration change.
 */
function sameApps(a: TerminalControlApps, b: TerminalControlApps) {
  return (
    stable({ defaultAppId: a.defaultAppId, entries: a.entries }) ===
    stable({ defaultAppId: b.defaultAppId, entries: b.entries })
  );
}
/**
 * 保存的应用表示选中的 CLI；保留该适配器已有的精确模板。兼容读取不写入或丢弃模板；达到数量上限或预设 ID 冲突时，恢复可用的设置默认项，并隐藏无法取得模板的 CLI 入口。
 * EN: Saved apps express the selected CLI. Preserve an existing exact template for that adapter. Compatibility reads never write or drop templates; at the cap or a preset-ID collision, restore the available settings default and hide CLI entries that cannot obtain a template.
 */
function configuration(store: Store) {
  const settings = read(store, settingsKey, SurfaceTerminalSettings) ?? initialTerminalSettings();
  const preferred = preferredProfiles(store, settings.profiles);
  const storedApps = read(store, appsKey, TerminalControlApps);
  const apps = storedApps ?? defaultApps(settings);
  const profiles = [...settings.profiles];
  /**
   * 仅在无同类模板且容量/ID 允许时补入内置预设；冲突保留既有内容，不覆盖用户模板。
   * EN: Adds an app preset only when missing and count/ID permit, preserving existing templates on collision.
   */
  const ensure = (appId: TerminalAppId) => {
    if (profiles.some((profile) => profile.agent === appId)) return;
    const preset = terminalAppCatalog().find((entry) => entry.id === appId)!.preset;
    if (profiles.length < 20 && !profiles.some((profile) => profile.id === preset.id))
      profiles.push(AgentTerminalProfile.parse(preset));
  };
  if (storedApps) {
    ensure(apps.defaultAppId);
    for (const entry of apps.entries) if (entry.visible) ensure(entry.id);
  }
  const selected = preferredProfile({ ...settings, profiles }, apps.defaultAppId, preferred);
  const canonicalSettings = SurfaceTerminalSettings.parse({
    ...settings,
    profiles,
    defaultProfileId: selected?.id ?? settings.defaultProfileId,
  });
  const defaultAppId = terminalAppForProfile(
    canonicalSettings.profiles.find((profile) => profile.id === canonicalSettings.defaultProfileId)!,
  );
  const canonicalApps = TerminalControlApps.parse({
    ...apps,
    defaultAppId,
    entries: apps.entries.map((entry) => ({
      ...entry,
      visible:
        entry.id === defaultAppId ||
        (entry.visible && profiles.some((profile) => profile.agent === entry.id)),
    })),
  });
  return { settings: canonicalSettings, apps: canonicalApps, preferred };
}
/**
 * 读取规范化后的模板配置；旧设置与应用选择由 configuration 同步为一致视图。
 * EN: Reads normalized template configuration with legacy settings and app choices aligned by configuration.
 */
export function terminalSettings(store: Store): SurfaceTerminalSettings {
  return configuration(store).settings;
}
/**
 * 返回兼容规范化配置中的应用视图，读取不会自动写回迁移结果。
 * EN: Returns app view from compatibility-normalized configuration without writing migration results during reads.
 */
export function terminalControlApps(store: Store): TerminalControlApps {
  return configuration(store).apps;
}
/**
 * 从当前默认模板更新其所属应用的上次选择，返回新偏好映射。
 * EN: Returns a new preference map remembering the current default template for its app.
 */
function remember(preferred: PreferredProfiles, settings: SurfaceTerminalSettings) {
  const selected = settings.profiles.find((profile) => profile.id === settings.defaultProfileId)!;
  return { ...preferred, [terminalAppForProfile(selected)]: selected.id };
}
/**
 * 删除或换类型的模板不再被项目选用；仅清理失效选择，不删除仍兼容的项目连接。
 * EN: Clears project selections for removed/type-changed templates without deleting still-compatible connections.
 */
function cleanProjectPreferences(store: Store, settings: SurfaceTerminalSettings) {
  const connections = read(store, connectionsKey, z.array(TerminalConnectionBinding)) ?? [];
  for (const project of store.all<Project>('projects')) {
    const previous = read(store, projectKey(project.id), TerminalProjectPreferences);
    if (!previous) continue;
    const profile = settings.profiles.find((entry) => entry.id === previous.defaultProfileId);
    const connection = connections.find((entry) => entry.id === previous.connectionId);
    const defaultProfileId = previous.defaultProfileId && !profile ? null : previous.defaultProfileId;
    /**
     * 移除模板仅清除其选择；已有项目 API 仍可使用。
     * EN: A removed template clears only its selection; an existing project API remains usable.
     */
    const connectionId =
      previous.connectionId &&
      (!connection || (profile && !terminalProtocols[profile.agent].includes(connection.protocol)))
        ? null
        : previous.connectionId;
    if (defaultProfileId !== previous.defaultProfileId || connectionId !== previous.connectionId)
      write(store, projectKey(project.id), {
        ...previous,
        defaultProfileId,
        connectionId,
        revision: previous.revision + 1,
      });
  }
}
/**
 * 比较设置版本后同步保存模板、默认应用、可见入口和各应用偏好的模板。 不兼容/已删除的连接选择退回环境模式，项目偏好仅清理失效引用；旧任务冻结配置不受影响。
 * EN: Synchronously saves templates, default app, visible entries and per-app template choices after revision comparison. Invalid connection choices fall back to environment mode; project preferences clear only invalid references, leaving old run snapshots unchanged.
 */
export function writeTerminalSettings(
  store: Store,
  input: { expectedRevision: number; profiles: AgentTerminalProfile[]; defaultProfileId: string },
): SurfaceTerminalSettings {
  return store.tx(() => {
    const previous = configuration(store);
    assertRevision(input.expectedRevision, previous.settings.revision);
    const requested = SurfaceTerminalSettings.parse({
      revision: previous.settings.revision + 1,
      profiles: input.profiles,
      defaultProfileId: input.defaultProfileId,
    });
    const connections = read(store, connectionsKey, z.array(TerminalConnectionBinding)) ?? [];
    const profiles = requested.profiles.map((profile) => {
      const selected = profile.connectionId
        ? connections.find((connection) => connection.id === profile.connectionId)
        : undefined;
      const incompatible =
        (profile.connectionId &&
          (!selected || !terminalProtocols[profile.agent].includes(selected.protocol))) ||
        (profile.connection && !terminalProtocols[profile.agent].includes(profile.connection.protocol));
      if (!incompatible) return profile;
      const { connection: _binding, ...clean } = profile;
      return { ...clean, connectionId: null };
    });
    const saved = SurfaceTerminalSettings.parse({
      revision: previous.settings.revision + 1,
      profiles,
      defaultProfileId: input.defaultProfileId,
    });
    const defaultProfile = saved.profiles.find((profile) => profile.id === saved.defaultProfileId)!;
    const desiredApps = TerminalControlApps.parse({
      ...previous.apps,
      defaultAppId: defaultProfile.agent,
      entries: previous.apps.entries.map((entry) => ({
        ...entry,
        visible:
          saved.profiles.some((profile) => profile.agent === entry.id) &&
          (entry.visible ||
            entry.id === defaultProfile.agent ||
            !previous.settings.profiles.some((profile) => profile.agent === entry.id)),
      })),
    });
    const apps = {
      ...desiredApps,
      revision: previous.apps.revision + (sameApps(previous.apps, desiredApps) ? 0 : 1),
    };
    write(store, settingsKey, saved);
    write(store, appsKey, apps);
    write(
      store,
      preferredKey,
      validPreferredProfiles(
        remember(remember(previous.preferred, previous.settings), saved),
        saved.profiles,
      ),
    );
    cleanProjectPreferences(store, saved);
    return saved;
  });
}
/**
 * 应用已安装镜像不能改变 API 绑定或其他配置。
 * EN: Applying an installed image cannot alter API bindings or other configuration.
 */
export function writeTerminalProfileImage(
  store: Store,
  input: { expectedRevision: number; profileId: string; image: string },
): SurfaceTerminalSettings {
  return store.tx(() => {
    const previous = terminalSettings(store);
    assertRevision(input.expectedRevision, previous.revision);
    const profile = previous.profiles.find((entry) => entry.id === input.profileId);
    if (!profile)
      throw new AppError('TERMINAL_PROFILE_MISSING', '所选终端模板已删除，请刷新后重试', false, {}, 404);
    const updated = AgentTerminalProfile.parse({ ...profile, image: input.image });
    const saved = SurfaceTerminalSettings.parse({
      ...previous,
      revision: previous.revision + 1,
      profiles: previous.profiles.map((entry) => (entry.id === profile.id ? updated : entry)),
    });
    write(store, settingsKey, saved);
    return saved;
  });
}
/**
 * 切换应用入口时按需补齐预设模板，并恢复该应用上次选择的有效模板，相关设置同事务提交。
 * EN: Switches app entry, adds needed presets and restores its last valid selected template in one transaction.
 */
export function writeTerminalControlApps(
  store: Store,
  input: { expectedRevision: number; defaultAppId: TerminalAppId; entries: TerminalControlApps['entries'] },
): TerminalControlApps {
  return store.tx(() => {
    const previous = configuration(store);
    assertRevision(input.expectedRevision, previous.apps.revision);
    const desired = TerminalControlApps.parse({
      revision: previous.apps.revision + 1,
      defaultAppId: input.defaultAppId,
      entries: input.entries,
    });
    const profiles = [...previous.settings.profiles];
    for (const entry of desired.entries) {
      if (!entry.visible || profiles.some((profile) => profile.agent === entry.id)) continue;
      if (profiles.length >= 20)
        throw new AppError('TERMINAL_PROFILE_LIMIT', '最多保存 20 个终端模板，请删除不用的模板后启用应用');
      const preset = terminalAppCatalog().find((app) => app.id === entry.id)!.preset;
      profiles.push(
        AgentTerminalProfile.parse({
          ...preset,
          id: profiles.some((profile) => profile.id === preset.id) ? randomUUID() : preset.id,
        }),
      );
    }
    const preferred = remember(previous.preferred, previous.settings);
    const target = preferredProfile({ ...previous.settings, profiles }, desired.defaultAppId, preferred)!;
    const candidate = SurfaceTerminalSettings.parse({
      ...previous.settings,
      profiles,
      defaultProfileId: target.id,
    });
    const settings = {
      ...candidate,
      revision: previous.settings.revision + (sameSettings(previous.settings, candidate) ? 0 : 1),
    };
    write(store, settingsKey, settings);
    write(store, appsKey, desired);
    write(store, preferredKey, remember(preferred, settings));
    return desired;
  });
}
/**
 * 注册终端设置读取与幂等保存接口，校验模板结构并由统一写入器执行版本检查及关联配置同步。
 * EN: Registers terminal settings reads/idempotent saves with schema validation and shared revision/synchronized-setting writes.
 */
export function registerTerminalSettings(app: FastifyInstance, store: Store) {
  app.get('/api/terminal/settings', () => terminalSettings(store));
  app.put('/api/terminal/settings', (request) => {
    const body = Command.extend({
      profiles: SurfaceTerminalSettings.shape.profiles,
      defaultProfileId: SurfaceTerminalSettings.shape.defaultProfileId,
    }).parse(request.body);
    return store.command(body.commandId, { route: request.url, body: request.body }, () =>
      writeTerminalSettings(store, {
        expectedRevision: body.expectedRevision!,
        profiles: body.profiles,
        defaultProfileId: body.defaultProfileId,
      }),
    );
  });
}
