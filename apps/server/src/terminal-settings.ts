import type { FastifyInstance } from 'fastify';
import { AppError, Command, SurfaceTerminalSettings } from '../../../packages/contracts/src/index.js';
import { type Store, stable } from '../../../packages/storage/src/index.js';

const settingsKey = 'surface:terminal:settings:v1';
export function initialTerminalSettings() {
  return SurfaceTerminalSettings.parse({
    revision: 0,
    defaultProfileId: '3a7481a1-b068-4b0d-ae5d-887f5d1f3b65',
    profiles: [
      {
        id: '3a7481a1-b068-4b0d-ae5d-887f5d1f3b65',
        label: 'DSH · Docker',
        agent: 'dsh',
        image: 'elysia-agents:0.13.0',
        command: ['dsh', '--profile', 'headless', '--json', '-'],
        protocol: 'dsh-jsonl',
        environment: ['DEEPSEEK_API_KEY'],
      },
      {
        id: 'fceec6bc-f890-4e9e-ae1c-af63e40e606b',
        label: 'Codex CLI · Docker',
        agent: 'codex',
        image: 'elysia-agents:0.13.0',
        command: [
          'codex',
          'exec',
          '--json',
          '--skip-git-repo-check',
          '--dangerously-bypass-approvals-and-sandbox',
          '--ignore-user-config',
          '-',
        ],
        protocol: 'codex-jsonl',
        environment: ['OPENAI_API_KEY'],
      },
    ],
  });
}
export function terminalSettings(store: Store): SurfaceTerminalSettings {
  const row = store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(settingsKey) as
    | { value: string }
    | undefined;
  return row ? SurfaceTerminalSettings.parse(JSON.parse(row.value)) : initialTerminalSettings();
}
export function registerTerminalSettings(app: FastifyInstance, store: Store) {
  app.get('/api/terminal/settings', () => terminalSettings(store));
  app.put('/api/terminal/settings', (request) => {
    const body = Command.extend({
      profiles: SurfaceTerminalSettings.shape.profiles,
      defaultProfileId: SurfaceTerminalSettings.shape.defaultProfileId,
    }).parse(request.body);
    const desired = SurfaceTerminalSettings.parse({
      revision: 0,
      profiles: body.profiles,
      defaultProfileId: body.defaultProfileId,
    });
    return store.command(body.commandId, { route: request.url, body: request.body }, () => {
      const previous = terminalSettings(store);
      if (!Number.isInteger(body.expectedRevision) || body.expectedRevision !== previous.revision)
        throw new AppError(
          'REVISION_CONFLICT',
          '终端配置已更新，请刷新后重试',
          false,
          { currentRevision: previous.revision },
          409,
        );
      const saved = { ...desired, revision: previous.revision + 1 };
      store.db
        .prepare(
          'INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        )
        .run(settingsKey, stable(saved));
      return saved;
    });
  });
}
