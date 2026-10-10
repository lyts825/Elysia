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
const projectKey = (id: string) => `surface:terminal:control:project:${id}`;
type PreferredProfiles = Partial<Record<TerminalAppId, string>>;
const preferredSchema = z.partialRecord(TerminalAppId, z.string().uuid());
function read<T>(store: Store, key: string, schema: z.ZodType<T>): T | undefined {
  const row = store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(key) as
    | { value: string }
    | undefined;
  return row ? schema.parse(JSON.parse(row.value)) : undefined;
}
function write(store: Store, key: string, value: unknown) {
  store.db
    .prepare(
      'INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(key, stable(value));
}
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
export function initialTerminalSettings(): SurfaceTerminalSettings {
  return SurfaceTerminalSettings.parse({
    revision: 0,
    defaultProfileId: 'fceec6bc-f890-4e9e-ae1c-af63e40e606b',
    profiles: initialTerminalProfiles(),
  });
}
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
function preferredProfiles(store: Store, profiles: AgentTerminalProfile[]): PreferredProfiles {
  const saved = read(store, preferredKey, preferredSchema) ?? {};
  return validPreferredProfiles(saved, profiles);
}
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
function sameSettings(a: SurfaceTerminalSettings, b: SurfaceTerminalSettings) {
  return (
    stable({ profiles: a.profiles, defaultProfileId: a.defaultProfileId }) ===
    stable({ profiles: b.profiles, defaultProfileId: b.defaultProfileId })
  );
}
function sameApps(a: TerminalControlApps, b: TerminalControlApps) {
  return (
    stable({ defaultAppId: a.defaultAppId, entries: a.entries }) ===
    stable({ defaultAppId: b.defaultAppId, entries: b.entries })
  );
}
/** Saved apps express the selected CLI. Preserve an existing exact template for that adapter.
 * Compatibility reads never write or drop templates; at the cap or a preset-ID collision,
 * restore the available settings default and hide CLI entries that cannot obtain a template.
 */
function configuration(store: Store) {
  const settings = read(store, settingsKey, SurfaceTerminalSettings) ?? initialTerminalSettings();
  const preferred = preferredProfiles(store, settings.profiles);
  const storedApps = read(store, appsKey, TerminalControlApps);
  const apps = storedApps ?? defaultApps(settings);
  const profiles = [...settings.profiles];
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
export function terminalSettings(store: Store): SurfaceTerminalSettings {
  return configuration(store).settings;
}
export function terminalControlApps(store: Store): TerminalControlApps {
  return configuration(store).apps;
}
function remember(preferred: PreferredProfiles, settings: SurfaceTerminalSettings) {
  const selected = settings.profiles.find((profile) => profile.id === settings.defaultProfileId)!;
  return { ...preferred, [terminalAppForProfile(selected)]: selected.id };
}
function cleanProjectPreferences(store: Store, settings: SurfaceTerminalSettings) {
  const connections = read(store, connectionsKey, z.array(TerminalConnectionBinding)) ?? [];
  for (const project of store.all<Project>('projects')) {
    const previous = read(store, projectKey(project.id), TerminalProjectPreferences);
    if (!previous) continue;
    const profile = settings.profiles.find((entry) => entry.id === previous.defaultProfileId);
    const connection = connections.find((entry) => entry.id === previous.connectionId);
    const defaultProfileId = previous.defaultProfileId && !profile ? null : previous.defaultProfileId;
    // A removed template clears only its selection; an existing project API remains usable.
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
/** Applying an installed image cannot alter API bindings or other configuration. */
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
